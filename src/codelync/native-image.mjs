import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename, extname, isAbsolute } from 'node:path';
import { BridgeError } from '../errors.mjs';

export const MAX_NATIVE_IMAGE_BYTES = 64 * 1024 * 1024;
export const MAX_NATIVE_IMAGE_PIXELS = 64_000_000;
export const MAX_NATIVE_PREVIEW_BYTES = 500000 - 40;
export const NATIVE_PREVIEW_POLICY = 'jpeg-500000-v1';

/** Read only the local image path explicitly supplied by the original imageView item.
 * @param {unknown} path @returns {Promise<{bytes:Buffer,name:string,image?:{width:number,height:number}}>} */
export async function readNativeImage(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new BridgeError('native-image-unavailable', 'The original image path is unavailable.');
  // 不跟随符号链接或打开 FIFO；原图片已删除/替换时保留错误消息，不能读取其他文件代替。
  const before = await lstat(path);
  if (!before.isFile()) throw new BridgeError('native-image-unavailable', 'The original image is not a regular file.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino) throw new BridgeError('native-image-unavailable', 'The original image changed during read.');
    if (info.size > MAX_NATIVE_IMAGE_BYTES) throw new BridgeError('native-image-too-large', 'The original image exceeds the attachment limit.');
    const buffer = Buffer.alloc(Math.min(info.size + 1, MAX_NATIVE_IMAGE_BYTES + 1));
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const after = await file.stat();
    if (size !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new BridgeError('native-image-unavailable', 'The original image changed during read.');
    const bytes = buffer.subarray(0, size), dimensions = imageDimensions(bytes);
    if (dimensions === null) throw new BridgeError('native-image-format', 'The original file is not a supported image.');
    if (dimensions && dimensions.width * dimensions.height > MAX_NATIVE_IMAGE_PIXELS) {
      throw new BridgeError('native-image-too-large', 'The original image exceeds the pixel limit.');
    }
    return { bytes, name: basename(path), ...(dimensions ? { image: dimensions } : {}) };
  } finally { await file.close(); }
}

/** The original file remains intact. Only an explicit image read invokes decoding/compression.
 * @param {{bytes:Buffer,name:string}} source @returns {Promise<{bytes:Buffer,name:string,image:{width:number,height:number}}>} */
export async function compressNativeImage(source) {
  if (!Buffer.isBuffer(source?.bytes)) throw new BridgeError('native-image-compression-failed', 'The original image could not be prepared.');
  if (source.bytes.length > MAX_NATIVE_IMAGE_BYTES) throw new BridgeError('native-image-too-large', 'The original image exceeds the attachment limit.');
  const dimensions = imageDimensions(source.bytes);
  if (dimensions === null) throw new BridgeError('native-image-compression-failed', 'The original image could not be prepared.');
  if (dimensions && dimensions.width * dimensions.height > MAX_NATIVE_IMAGE_PIXELS) {
    throw new BridgeError('native-image-too-large', 'The original image exceeds the pixel limit.');
  }
  try {
    const { default: sharp } = await import('sharp');
    const pipeline = sharp(source.bytes, { limitInputPixels: MAX_NATIVE_IMAGE_PIXELS, failOn: 'error' }).rotate().flatten({ background: '#ffffff' });
    let edge = 2560, quality = 85;
    for (let attempt = 0; attempt < 8; attempt++) {
      const { data, info } = await pipeline.clone().resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality, progressive: true, chromaSubsampling: '4:4:4' }).toBuffer({ resolveWithObject: true });
      if (data.length <= MAX_NATIVE_PREVIEW_BYTES) return { bytes: data, name: previewFilename(source.name), image: { width: info.width, height: info.height } };
      // 先降低画质，再缩小尺寸；每次校验实际字节数，不能以编码参数冒充 500KB 保证。
      if (quality > 50) quality = Math.max(50, quality - 15);
      else edge = Math.floor(edge * 0.7);
    }
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    if (error instanceof Error && /pixel limit/iu.test(error.message)) {
      throw new BridgeError('native-image-too-large', 'The original image exceeds the pixel limit.');
    }
    throw new BridgeError('native-image-compression-failed', 'The original image could not be prepared.');
  }
  throw new BridgeError('native-image-compression-failed', 'The image could not fit the preview limit.');
}

/** @param {unknown} name @returns {string} */
function previewFilename(name) {
  const base = typeof name === 'string' && name.length > 0 ? basename(name) : 'image';
  const ext = extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  return `${stem || 'image'}.jpg`;
}

/** Header-only format/dimension check; no untrusted image decoding in the bridge.
 * @param {Buffer} bytes @returns {{width:number,height:number}|undefined|null} */
function imageDimensions(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    return dimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  }
  if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return dimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    if (bytes.length < 16) return null;
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return bytes.length >= 30 ? dimensions(bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1) : null;
    if (chunk === 'VP8 ') {
      if (bytes.length < 30 || (bytes[20] & 1) !== 0 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
      return dimensions(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
    }
    if (chunk === 'VP8L') {
      if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
      const bits = bytes.readUInt32LE(21);
      return dimensions((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
    }
    return undefined;
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    for (let offset = 2; offset + 3 < bytes.length;) {
      if (bytes[offset++] !== 255) return null;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (offset + 2 > bytes.length) return null;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return null;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 7) return dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
      offset += length;
    }
    return undefined;
  }
  return null;
}
/** @param {number} width @param {number} height */
function dimensions(width, height) { return width > 0 && height > 0 && width <= 65535 && height <= 65535 ? { width, height } : null; }
