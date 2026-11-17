import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configure } from '../deploy/self-host/configure.mjs';

test('self-host setup keeps private independent credentials across a domain change', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codelync-self-host-'));
  try {
    await writeFile(join(directory, '.env'), 'MEDIA_DOMAIN=media.deployment.dev\nRELAY_DOMAIN=relay.deployment.dev\n');
    const initial = await configure(directory);
    assert.notEqual(initial.LIVEKIT_API_SECRET, initial.REGISTRATION_TOKEN);
    assert.ok(initial.LIVEKIT_API_SECRET.length >= 32 && initial.REGISTRATION_TOKEN.length >= 32);
    for (const name of ['.env', 'livekit.yaml', 'Caddyfile']) assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600);
    const media = JSON.parse(await readFile(join(directory, 'livekit.yaml'), 'utf8'));
    assert.equal(media.keys[initial.LIVEKIT_API_KEY], initial.LIVEKIT_API_SECRET);
    const saved = (await readFile(join(directory, '.env'), 'utf8')).replace('media.deployment.dev', 'new-media.deployment.dev');
    await writeFile(join(directory, '.env'), saved);
    const changed = await configure(directory);
    assert.equal(changed.LIVEKIT_API_SECRET, initial.LIVEKIT_API_SECRET);
    assert.equal(changed.REGISTRATION_TOKEN, initial.REGISTRATION_TOKEN);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('network-only setup produces no media proxy and needs no media hostname', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codelync-network-only-'));
  try {
    await writeFile(join(directory, '.env'), 'MEDIA_DOMAIN=\nRELAY_DOMAIN=relay.deployment.dev\n');
    await configure(directory);
    const proxy = await readFile(join(directory, 'Caddyfile'), 'utf8');
    assert.ok(proxy.includes('127.0.0.1:8081'));
    assert.equal(proxy.includes('7880'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('invalid or shared credentials do not replace a working configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codelync-config-refusal-'));
  try {
    await writeFile(join(directory, '.env'), 'MEDIA_DOMAIN=media.deployment.dev\n');
    const initial = await configure(directory);
    const original = await readFile(join(directory, 'livekit.yaml'), 'utf8');
    await writeFile(join(directory, '.env'), `MEDIA_DOMAIN=media.deployment.dev\nLIVEKIT_API_SECRET=${initial.LIVEKIT_API_SECRET}\nREGISTRATION_TOKEN=${initial.LIVEKIT_API_SECRET}\n`);
    await assert.rejects(configure(directory), /independent/);
    assert.equal(await readFile(join(directory, 'livekit.yaml'), 'utf8'), original);
    await writeFile(join(directory, '.env'), 'MEDIA_DOMAIN=media.example.com\n');
    await assert.rejects(configure(directory), /real DNS hostname/);
    assert.equal(await readFile(join(directory, 'livekit.yaml'), 'utf8'), original);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
