import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { existingClaudeRendererApi } from '../src/adapters/claude-existing-renderer-api.mjs';

/** @param {Record<string,any>} native @param {string} [url] */
function renderer(native, url = 'app://localhost/new') {
  /** @type {string[]} */ const scripts = [];
  return { scripts, isDestroyed: () => false, getURL: () => url,
    mainFrame: { executeJavaScript: async (/** @type {string} */ script) => {
      scripts.push(script);
      return runInNewContext(script, { location: new URL(url), window: { 'claude.web': native } });
    } } };
}

test('existing native renderer API preserves optional arguments and never initializes a new native surface', async () => {
  /** @type {unknown[][]} */ const calls = [];
  const wc = renderer({ LocalSessions: { sendMessage: async (/** @type {unknown[]} */ ...args) => { calls.push(args); } } });
  const api = existingClaudeRendererApi(wc, 'code'), text = '`quoted` ${literal}\nnot executable';
  await api.sendMessage('native-session', text, undefined, null, { personSent: true });
  assert.deepEqual(calls[0].slice(0, 4), ['native-session', text, undefined, null]);
  assert.equal(/** @type {Record<string,any>} */ (calls[0][4]).personSent, true);
  assert.equal(wc.scripts.length, 1);
  assert.equal(wc.scripts[0].includes('addEventListener'), false);
  assert.equal(wc.scripts[0].includes('createLocalSessionsApi'), false);
  assert.equal(wc.scripts[0].includes('dispatchEvent'), false);
});

test('outer window, missing native route and unsupported method cannot invoke native code', async () => {
  let calls = 0;
  const wc = renderer({ LocalSessions: { getSession: () => { calls++; } } }, 'file:///outer.html');
  await assert.rejects(existingClaudeRendererApi(wc, 'code').getSession('id'), { message: 'native-window-unavailable', effectMayHaveOccurred: false });
  assert.equal(calls, 0); assert.equal(wc.scripts.length, 0);
  const empty = existingClaudeRendererApi(renderer({}), 'code');
  await assert.rejects(empty.getSession('id'), { message: 'native-renderer-unavailable', effectMayHaveOccurred: false });
  assert.equal(empty.start, undefined); assert.equal(empty.getAgents, undefined);
});

test('native operation errors keep uncertainty and never return raw native error text', async () => {
  const wc = renderer({ LocalAgentModeSessions: { sendMessage: () => { throw Error('synthetic-provider-secret'); } } });
  await assert.rejects(existingClaudeRendererApi(wc, 'cowork').sendMessage('id', 'hello'), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'native-renderer-operation-failed');
    assert.equal(/** @type {any} */ (error).effectMayHaveOccurred, true);
    assert.equal(JSON.stringify(error).includes('synthetic-provider-secret'), false);
    return true;
  });
});

test('functions and foreign prototype values are refused before renderer invocation', async () => {
  const wc = renderer({ LocalSessions: {} }), api = existingClaudeRendererApi(wc, 'code');
  await assert.rejects(api.getSession('id', () => {}), { message: 'invalid-native-arguments', effectMayHaveOccurred: false });
  assert.equal(wc.scripts.length, 0);
});
