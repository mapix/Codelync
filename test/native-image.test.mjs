import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink, open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readNativeImage, compressNativeImage, MAX_NATIVE_IMAGE_BYTES } from '../src/happy/native-image.mjs';
import sharp from 'sharp';
import { randomBytes } from 'node:crypto';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ioAAAAASUVORK5CYII=', 'base64');
test('bounded original image reads preserve bytes and dimensions, reject nonimages and symlinks', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'native-image-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'image.png'); await writeFile(path, png);
  assert.deepEqual(await readNativeImage(path), { bytes: png, name: 'image.png', image: { width: 1, height: 1 } });
  await writeFile(join(directory, 'not-image.png'), 'private configuration');
  await assert.rejects(readNativeImage(join(directory, 'not-image.png')), { code: 'native-image-format' });
  await symlink(path, join(directory, 'link.png'));
  await assert.rejects(readNativeImage(join(directory, 'link.png')), { code: 'native-image-unavailable' });
  await assert.rejects(readNativeImage('relative.png'), { code: 'native-image-unavailable' });
  await assert.rejects(readNativeImage(directory), { code: 'native-image-unavailable' });
  const large = await open(join(directory, 'large.png'), 'w'); await large.truncate(MAX_NATIVE_IMAGE_BYTES + 1); await large.close();
  await assert.rejects(readNativeImage(join(directory, 'large.png')), { code: 'native-image-too-large' });
});

test('a noisy original above 10 MiB is decoded only on demand and fits the 500000-byte encrypted preview limit', async () => {
  const original = await sharp(randomBytes(3072 * 1536 * 3), { raw: { width: 3072, height: 1536, channels: 3 } }).png().toBuffer();
  assert.ok(original.length > 10 * 1024 * 1024);
  const preview = await compressNativeImage({ bytes: original, name: 'large.png' });
  assert.ok(preview.bytes.length + 40 <= 500000); assert.equal(preview.name, 'large.jpg');
  const metadata = await sharp(preview.bytes).metadata();
  assert.equal(metadata.format, 'jpeg'); assert.deepEqual(preview.image, { width: metadata.width, height: metadata.height });
  assert.equal(metadata.exif, undefined);
  await assert.rejects(compressNativeImage({ bytes: Buffer.from('not an image'), name: 'invalid.png' }), { code: 'native-image-compression-failed' });
});
