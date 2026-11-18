import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverAntigravityRuntime, antigravityOwnerRows } from '../src/adapters/antigravity-discovery.mjs';

const appPath = '/Applications/Antigravity.app';
const binary = appPath + '/Contents/Resources/bin/language_server';
const processIdentity = async (/** @type {number} */ pid) => ({ pid, parentPid: pid === 42 ? 40 : 1,
  executable: pid === 42 ? binary : appPath + '/Contents/MacOS/Antigravity', startTime: 'Fri Nov 13 10:00:00 2026' });
const options = { appPath, home: '/private/probe-home', processIdentity,
  processes: async () => `42 ${binary} --standalone --csrf_token=fixture --app_data_dir antigravity\n`,
  resolvePath: async (/** @type {string} */ path) => path,
  readLog: async () => 'Starting language server process with pid 42\nLanguage server listening on random port at 49231 for HTTP\n' };

test('discovers only a verified original desktop-owned loopback endpoint', async () => {
  const runtime = await discoverAntigravityRuntime(options);
  assert.ok(runtime);
  assert.equal(runtime.origin, 'http://127.0.0.1:49231');
  assert.equal(runtime.pid, 42);
  assert.equal(runtime.parentPid, 40);
  assert.match(runtime.generation, /^antigravity:[a-f0-9]{64}$/);
});

test('absent desktop returns no source while stale logs and multiple owners refuse', async () => {
  assert.equal(await discoverAntigravityRuntime({ ...options, processes: async () => '' }), null);
  await assert.rejects(discoverAntigravityRuntime({ ...options, readLog: async () => 'Starting language server process with pid 41' }), { code: 'antigravity-discovery-unavailable' });
  await assert.rejects(discoverAntigravityRuntime({ ...options, processes: async () => (await options.processes()).repeat(2) }), { code: 'antigravity-discovery-unavailable' });
});

test('standalone language server and prefix lookalikes cannot become a desktop source', async () => {
  assert.deepEqual(antigravityOwnerRows(`43 ${binary}-other --csrf_token=fixture\n44 python ${binary} --csrf_token=fixture`, binary), []);
  await assert.rejects(discoverAntigravityRuntime({ ...options, processIdentity: async pid => ({ ...await processIdentity(pid), ...(pid === 40 ? { executable: '/usr/bin/python3' } : {}) }) }), { code: 'antigravity-discovery-unavailable' });
});

test('multicall CLI helper subprocesses are ignored alongside the verified language server owner', async () => {
  const mixed = [
    `42 ${binary} --standalone --csrf_token=fixture --app_data_dir antigravity`,
    `99 ${binary} multicall schedule CRON_TZ=Asia/Shanghai 0 */6 * * * agentapi new-conversation`,
  ].join('\n');
  assert.deepEqual(antigravityOwnerRows(mixed, binary), [{ pid: 42, csrfToken: 'fixture', appDataDir: 'antigravity' }]);
  const runtime = await discoverAntigravityRuntime({ ...options, processes: async () => mixed });
  assert.equal(runtime?.pid, 42);
  await assert.rejects(discoverAntigravityRuntime({
    ...options,
    processes: async () => [
      `42 ${binary} --standalone --csrf_token=fixture --app_data_dir antigravity`,
      `45 ${binary} --standalone --csrf_token=other --app_data_dir antigravity`,
    ].join('\n'),
  }), { code: 'antigravity-discovery-unavailable' });
});
