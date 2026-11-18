import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import {
  compressNativeImage,
  MAX_NATIVE_IMAGE_BYTES,
  MAX_NATIVE_IMAGE_PIXELS,
  readNativeImage,
} from '../src/codelync/native-image.mjs';

/**
 * Dynamically load TypeScript helper with Node 24 strip-types while keeping root checkJs clean.
 * @returns {Promise<{
 *   MAX_CAPPED_ATTACHMENT_BYTES: number,
 *   readLocalAttachment: (fullPath: string) => Promise<Buffer>,
 *   readCappedLocalAttachment: (fullPath: string, maxBytes: number) => Promise<Buffer>,
 *   statCappedLocalAttachment: (fullPath: string, maxBytes: number) => Promise<number>,
 * }>}
 */
async function loadCappedAttachments() {
  const url = new URL('../packages/relay/sources/storage/cappedAttachments.ts', import.meta.url).href;
  return import(url);
}

/** @param {number} width @param {number} height */
function makeMinimalPngHeader(width, height) {
  const buf = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

test('R041: readLocalAttachment performs bounded async non-symlink reads and enforces size/file gates', async t => {
  const { MAX_CAPPED_ATTACHMENT_BYTES, readLocalAttachment, readCappedLocalAttachment } = await loadCappedAttachments();
  const dir = await mkdtemp(join(tmpdir(), 'codelync-r041-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const emptyPath = join(dir, 'empty.enc');
  await writeFile(emptyPath, Buffer.alloc(0));
  assert.deepEqual(await readLocalAttachment(emptyPath), Buffer.alloc(0));

  const validPath = join(dir, 'blob.enc');
  const payload = Buffer.from('opaque-encrypted-attachment-bytes');
  await writeFile(validPath, payload);
  assert.deepEqual(await readLocalAttachment(validPath), payload);

  const linkPath = join(dir, 'link.enc');
  await symlink(validPath, linkPath);
  await assert.rejects(readLocalAttachment(linkPath), err => /** @type {any} */ (err).status === 404);

  const dirPath = join(dir, 'folder.enc');
  await mkdir(dirPath);
  await assert.rejects(readLocalAttachment(dirPath), err => /** @type {any} */ (err).status === 503);

  await assert.rejects(readLocalAttachment(join(dir, 'missing.enc')), err => /** @type {any} */ (err).status === 404);

  const hugePath = join(dir, 'huge.enc');
  const fh = await open(hugePath, 'w');
  await fh.truncate(MAX_CAPPED_ATTACHMENT_BYTES + 1);
  await fh.close();
  await assert.rejects(readLocalAttachment(hugePath), err => /** @type {any} */ (err).status === 413);
  await assert.rejects(readCappedLocalAttachment(validPath, 0), err => /** @type {any} */ (err).status === 400);
});

test('R046: readNativeImage and compressNativeImage enforce the 64 MP pixel limit and map to native-image-too-large', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codelync-r046-mp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // Exact 64 MP boundary (8000 x 8000 = 64,000,000 pixels) passes readNativeImage header check.
  const exactPath = join(dir, 'exact-64mp.png');
  await writeFile(exactPath, makeMinimalPngHeader(8000, 8000));
  const exact = await readNativeImage(exactPath);
  assert.deepEqual(exact.image, { width: 8000, height: 8000 });
  assert.equal(exact.image.width * exact.image.height, MAX_NATIVE_IMAGE_PIXELS);

  // Real > 64 MP PNG (8001 x 8000 = 64,008,000 pixels, compact in bytes < 64 MiB).
  const overMpPng = await sharp(
    { create: { width: 8001, height: 8000, channels: 3, background: { r: 0, g: 0, b: 0 } }, limitInputPixels: false },
  ).png().toBuffer();
  assert.ok(overMpPng.length < MAX_NATIVE_IMAGE_BYTES);

  const overMpPath = join(dir, 'over-64mp.png');
  await writeFile(overMpPath, overMpPng);

  await assert.rejects(readNativeImage(overMpPath), { code: 'native-image-too-large' });
  await assert.rejects(compressNativeImage({ bytes: overMpPng, name: 'over-64mp.png' }), { code: 'native-image-too-large' });

  // Byte-limit overshoot in compressNativeImage also maps to native-image-too-large.
  const oversizeBuf = Buffer.concat([makeMinimalPngHeader(1, 1), Buffer.alloc(MAX_NATIVE_IMAGE_BYTES)]);
  await assert.rejects(compressNativeImage({ bytes: oversizeBuf, name: 'giant.png' }), { code: 'native-image-too-large' });
  await assert.rejects(compressNativeImage({ bytes: Buffer.from('garbage'), name: 'bad.png' }), { code: 'native-image-compression-failed' });
});

test('R046: compressNativeImage preserves .png dotfiles and compound names cleanly', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codelync-r046-name-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const tinyPng = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
  const dotPath = join(dir, '.png');
  await writeFile(dotPath, tinyPng);

  const readDot = await readNativeImage(dotPath);
  assert.equal(readDot.name, '.png');
  const dotPreview = await compressNativeImage(readDot);
  assert.equal(dotPreview.name, '.png.jpg');

  const hiddenWithExt = await compressNativeImage({ bytes: tinyPng, name: '.hidden.png' });
  assert.equal(hiddenWithExt.name, '.hidden.jpg');

  const noExt = await compressNativeImage({ bytes: tinyPng, name: 'screenshot' });
  assert.equal(noExt.name, 'screenshot.jpg');

  const emptyName = await compressNativeImage({ bytes: tinyPng, name: '' });
  assert.equal(emptyName.name, 'image.jpg');
});

test('R046: readNativeImage extracts dimensions for VP8 lossy, VP8L lossless, and VP8X WebP and rejects malformed WebP headers', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codelync-r046-webp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const lossy = await sharp({ create: { width: 123, height: 45, channels: 3, background: { r: 20, g: 40, b: 60 } } })
    .webp({ lossless: false })
    .toBuffer();
  assert.equal(lossy.toString('ascii', 12, 16), 'VP8 ');
  const lossyPath = join(dir, 'lossy.webp');
  await writeFile(lossyPath, lossy);
  const readLossy = await readNativeImage(lossyPath);
  assert.deepEqual(readLossy.image, { width: 123, height: 45 });

  const lossless = await sharp({ create: { width: 234, height: 56, channels: 3, background: { r: 70, g: 80, b: 90 } } })
    .webp({ lossless: true })
    .toBuffer();
  assert.equal(lossless.toString('ascii', 12, 16), 'VP8L');
  const losslessPath = join(dir, 'lossless.webp');
  await writeFile(losslessPath, lossless);
  const readLossless = await readNativeImage(losslessPath);
  assert.deepEqual(readLossless.image, { width: 234, height: 56 });

  const vp8x = await sharp({ create: { width: 64, height: 32, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0.5 } } })
    .webp({ lossless: false })
    .toBuffer();
  assert.equal(vp8x.toString('ascii', 12, 16), 'VP8X');
  const vp8xPath = join(dir, 'alpha.webp');
  await writeFile(vp8xPath, vp8x);
  assert.deepEqual((await readNativeImage(vp8xPath)).image, { width: 64, height: 32 });

  // Malformed VP8 start code / VP8L signature / truncated header must fail format check.
  const badVp8 = Buffer.from(lossy);
  badVp8[23] = 0x00;
  await writeFile(join(dir, 'bad-vp8.webp'), badVp8);
  await assert.rejects(readNativeImage(join(dir, 'bad-vp8.webp')), { code: 'native-image-format' });

  const badVp8l = Buffer.from(lossless);
  badVp8l[20] = 0x00;
  await writeFile(join(dir, 'bad-vp8l.webp'), badVp8l);
  await assert.rejects(readNativeImage(join(dir, 'bad-vp8l.webp')), { code: 'native-image-format' });

  await writeFile(join(dir, 'trunc.webp'), Buffer.from('RIFF\x10\0\0\0WEBP', 'ascii'));
  await assert.rejects(readNativeImage(join(dir, 'trunc.webp')), { code: 'native-image-format' });
});
