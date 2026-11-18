import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDaemonFlags } from '../scripts/codelync-daemon.mjs';
import { parseConnectFlags, runConnectCli } from '../scripts/codelync-connect.mjs';
import { readSettings } from '../deploy/self-host/configure.mjs';
import { buildHttpsEndpoint, checkMedia, checkNetwork, readBoundedResponseText } from '../deploy/self-host/check.mjs';

const lockfile = createRequire(import.meta.url)('proper-lockfile');

/** @param {Uint8Array[]} chunks @param {Record<string,string>} [headers] @param {number} [status] @returns {Response} */
function streamResponse(chunks, headers = {}, status = 200) {
  let index = 0;
  let canceled = false;
  const stream = new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]);
      } else {
        controller.close();
      }
    },
    cancel() {
      canceled = true;
    }
  });
  const response = new Response(stream, { status, headers });
  Object.defineProperty(response, '_streamCanceled', { get: () => canceled });
  return response;
}

test('R075: parseDaemonFlags and parseConnectFlags enforce strict allowlist, arity, and no duplicates', () => {
  assert.throws(() => parseDaemonFlags(['inspect']), /Unknown Codelync option/);
  assert.throws(() => parseDaemonFlags(['--unknown=1']), /Unknown Codelync option/);
  assert.throws(() => parseDaemonFlags(['--only=codex:a', '--only=codex:b']), /Duplicate Codelync option: --only/);
  assert.throws(() => parseDaemonFlags(['--help=1']), /--help does not accept a value/);
  assert.throws(() => parseDaemonFlags(['--inspect=true']), /--inspect does not accept a value/);
  assert.throws(() => parseDaemonFlags(['--server']), /--server requires an explicit value/);
  assert.throws(() => parseDaemonFlags(['--profile=   ']), /--profile requires an explicit value/);
  assert.throws(() => parseDaemonFlags(['--only=zcode:win-1']), /Unsupported native Desktop session scope/);

  const daemonParsed = parseDaemonFlags([
    '--server=https://relay.example.invalid',
    '--profile=/tmp/codelync-prof',
    '--only=codex:thread-42',
    '--inspect'
  ]);
  assert.equal(daemonParsed.get('--only'), 'codex:thread-42');
  assert.equal(daemonParsed.get('--inspect'), '1');

  assert.throws(() => parseConnectFlags(['--account=/a.json']), /Usage:/);
  assert.throws(() => parseConnectFlags(['--account=/a.json', '--binding=/b.json', '--extra=1']), /Unknown Codelync connect option/);
  assert.throws(() => parseConnectFlags(['--account=/a.json', '--account=/c.json', '--binding=/b.json']), /Duplicate Codelync connect option/);
  assert.throws(() => parseConnectFlags(['--account=/a.json', '--binding=/b.json', '--state-dir=  ']), /--state-dir requires an explicit value/);
  const connectParsed = parseConnectFlags(['--account=/a.json', '--binding=/b.json', '--state-dir=/tmp/state']);
  assert.deepEqual(connectParsed, { accountPath: '/a.json', bindingPath: '/b.json', stateDir: '/tmp/state' });
});

test('R075: runConnectCli releases source lockfile lease on startup failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codelync-connect-cleanup-'));
  const stateDir = join(dir, 'state');
  const nativeId = 'thread-lease-cleanup';
  const scope = createHash('sha256').update(`codex:local:${nativeId}`).digest('hex');
  try {
    const accountPath = join(dir, 'account.json');
    const bindingPath = join(dir, 'binding.json');
    await writeFile(accountPath, JSON.stringify({
      serverUrl: 'https://relay.example.invalid',
      token: 'tok-test',
      secret: randomBytes(32).toString('base64url')
    }));
    await writeFile(bindingPath, JSON.stringify({
      happySessionId: 'happy-session-1',
      sessionKey: randomBytes(32).toString('base64'),
      source: { app: 'codex', hostId: 'local', id: nativeId },
      metadata: { machineId: 'machine-expected' }
    }));
    await writeFile(join(dir, 'machine.json'), JSON.stringify({
      id: 'machine-existing',
      accountFingerprint: 'mismatched-fingerprint'
    }));

    await assert.rejects(
      runConnectCli([`--account=${accountPath}`, `--binding=${bindingPath}`, `--state-dir=${stateDir}`]),
      /belongs to another Codelync account/
    );

    const marker = join(stateDir, `${scope}.source`);
    const stillLocked = await lockfile.check(marker, { realpath: false });
    assert.equal(stillLocked, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('R080: readSettings rejects unknown keys, symlinks, oversized .env, control chars, and .local domains', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codelync-selfhost-env-'));
  try {
    await writeFile(join(dir, '.env'), 'MEDIA_DOMAIN=media.deployment.dev\nRELAI_DOMAIN=typo.deployment.dev\n');
    await assert.rejects(readSettings(dir), /Unknown setting in \.env: RELAI_DOMAIN/);

    await writeFile(join(dir, '.env'), 'MEDIA_DOMAIN=media.deployment.local\n');
    await assert.rejects(readSettings(dir), /real DNS hostname/);

    await writeFile(join(dir, '.env'), `MEDIA_DOMAIN=media.deployment.dev\nLIVEKIT_API_KEY="bad\0key"\n`);
    await assert.rejects(readSettings(dir), /unsupported control characters/);

    await writeFile(join(dir, '.env'), `MEDIA_DOMAIN=media.deployment.dev\n#${'a'.repeat(70_000)}\n`);
    await assert.rejects(readSettings(dir), /maximum supported size/);

    await writeFile(join(dir, 'real.env'), 'MEDIA_DOMAIN=media.deployment.dev\n');
    await rm(join(dir, '.env'));
    await symlink(join(dir, 'real.env'), join(dir, '.env'));
    await assert.rejects(readSettings(dir), /regular file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('R080: endpoint checks validate HTTPS origin, bound response sizes, and validate JSON objects', async () => {
  assert.equal(
    buildHttpsEndpoint('media.deployment.dev', '/twirp/livekit.RoomService/ListRooms'),
    'https://media.deployment.dev/twirp/livekit.RoomService/ListRooms'
  );
  assert.throws(() => buildHttpsEndpoint('evil.test@media.deployment.dev', '/healthz'), /HTTPS on the configured domain/);

  const tooLongHeader = streamResponse([new Uint8Array([1, 2])], { 'content-length': '99999' });
  await assert.rejects(readBoundedResponseText(tooLongHeader, 16), /exceeded byte limit/);

  const chunkedOverflow = streamResponse([new Uint8Array(10), new Uint8Array(10)]);
  await assert.rejects(readBoundedResponseText(chunkedOverflow, 16), /exceeded byte limit/);
  assert.equal(/** @type {Response & {_streamCanceled: boolean}} */ (chunkedOverflow)._streamCanceled, true);

  const settings = {
    MEDIA_DOMAIN: 'media.deployment.dev',
    RELAY_DOMAIN: 'relay.deployment.dev',
    LIVEKIT_API_KEY: 'codelync_key',
    LIVEKIT_API_SECRET: 'a'.repeat(32)
  };

  /** @type {typeof fetch} */
  const badArrayMedia = async () => new Response('[]', { status: 200 });
  await assert.rejects(checkMedia(settings, badArrayMedia), /Invalid RoomService response/);

  /** @type {typeof fetch} */
  const okMedia = async (url, init) => {
    assert.equal(url, 'https://media.deployment.dev/twirp/livekit.RoomService/ListRooms');
    assert.equal(init?.redirect, 'error');
    return new Response(JSON.stringify({ rooms: [] }), { status: 200 });
  };
  await checkMedia(settings, okMedia);

  /** @type {typeof fetch} */
  const badHealthOverflow = async (url) => {
    if (String(url).endsWith('/relay/v1/info')) {
      return new Response(JSON.stringify({
        service: 'codelync-network-relay',
        version: 1,
        http: true,
        websocket: true,
        requiresToken: true
      }), { status: 200 });
    }
    return new Response('ok'.repeat(1000), { status: 200 });
  };
  await assert.rejects(checkNetwork(settings, badHealthOverflow), /exceeded byte limit/);

  /** @type {typeof fetch} */
  const okNetwork = async (url) => {
    if (String(url).endsWith('/relay/v1/info')) {
      return new Response(JSON.stringify({
        service: 'codelync-network-relay',
        version: 1,
        http: true,
        websocket: true,
        requiresToken: true
      }), { status: 200 });
    }
    return new Response('ok\n', { status: 200 });
  };
  await checkNetwork(settings, okNetwork);
});
