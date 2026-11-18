import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeDesktopBackend } from '../src/adapters/claude-backend.mjs';
import { claudeDesktopHostId } from '../src/adapters/claude-desktop-rpc.mjs';
import { CodexBackend } from '../src/adapters/codex-backend.mjs';
import { BridgeError } from '../src/errors.mjs';

/** @typedef {Record<string, any>} Value */

const claudeRuntime = {
  generation: 'main-b2',
  storagePath: '/fixture/claude-b2',
  profileNamespace: 'fixture-b2',
};

/** @param {string} [expectedHost] */
function createClaudeRpcFixture(expectedHost = claudeDesktopHostId(claudeRuntime, 'claude-code-sessions')) {
  let cursor = 0;
  let ownerGeneration = 'owner-1';
  let executionToken = 'query-1';
  /** @type {Value[]} */ let messages = [{ type: 'user', uuid: 'u1', message: { content: 'hello' } }];
  let failAll = false;
  /** @type {(() => void)|null} */ let releaseDeferredEvents = null;
  let deferNextEvents = false;

  const rpc = /** @type {any} */ ({
    latestRuntime: claudeRuntime,
    generation: () => claudeRuntime.generation,
    dispose: async () => {},
    /** @param {string} method @param {Value} _params @param {Value} [options] */
    call: async (method, _params, options = {}) => {
      if (failAll) throw new BridgeError('claude-desktop-unavailable', 'Owner unavailable', 503);
      if (options.expectedHostId && options.expectedHostId !== expectedHost) {
        throw new BridgeError('host-mismatch', 'Host mismatch', 409);
      }
      if (method === 'code.events') {
        if (deferNextEvents) {
          deferNextEvents = false;
          await new Promise(resolve => { releaseDeferredEvents = () => resolve(undefined); });
        }
        return { ownerGeneration, executionToken, cursor, events: [] };
      }
      if (method === 'code.snapshot') {
        return {
          sessionId: 'sess-1',
          ownerGeneration,
          executionToken,
          header: { sessionId: 'sess-1', sessionType: 'code', isRunning: false, turnRunning: false, queryPresent: true },
          messages,
          hasMore: false,
        };
      }
      if (method === 'code.taskFeed') throw new BridgeError('unsupported-native-action', 'No task feed');
      return {};
    },
  });

  return {
    rpc,
    hostId: expectedHost,
    setMessages(/** @type {Value[]} */ next) {
      messages = next;
      cursor++;
    },
    setFail(/** @type {boolean} */ value) {
      failAll = value;
    },
    deferEventsOnce() {
      deferNextEvents = true;
    },
    releaseEvents() {
      const fn = releaseDeferredEvents;
      releaseDeferredEvents = null;
      fn?.();
    },
  };
}

test('R012: subsequent and in-flight subscribers receive cached initial view without re-notifying existing subscribers', async () => {
  const f = createClaudeRpcFixture();
  const backend = new ClaudeDesktopBackend({ rpc: f.rpc, pollMs: 60_000, taskFeedNegativeTtlMs: 60_000 });
  /** @type {Value[]} */ const sub1Views = [];
  /** @type {Value[]} */ const sub2Views = [];
  /** @type {Value[]} */ const sub3Views = [];
  /** @type {Value[]} */ const sub4Views = [];
  let unsub1 = () => {};
  let unsub2 = () => {};
  let unsub3 = () => {};
  let unsub4 = () => {};

  try {
    unsub1 = await backend.subscribe('sess-1', view => sub1Views.push(view), { expectedHostId: f.hostId });
    assert.equal(sub1Views.length, 1);
    assert.equal(sub1Views[0].rows.length, 1);

    // Sub 2 joins when stamp is unchanged -> gets initial cached view immediately, Sub 1 is not re-notified.
    unsub2 = await backend.subscribe('sess-1', view => sub2Views.push(view), { expectedHostId: f.hostId });
    assert.equal(sub2Views.length, 1);
    assert.equal(sub2Views[0].rows[0].text, 'hello');
    assert.equal(sub1Views.length, 1);

    // Sub 3 joins while a poll is mid-flight (`current.running === true`) -> gets cached view immediately.
    const sessionKey = JSON.stringify([f.hostId, 'sess-1']);
    const session = backend.sessions.get(sessionKey);
    assert.ok(session);
    session.running = true;
    try {
      unsub3 = await backend.subscribe('sess-1', view => sub3Views.push(view), { expectedHostId: f.hostId });
      assert.equal(sub3Views.length, 1);
      assert.equal(sub3Views[0].rows[0].text, 'hello');
    } finally {
      session.running = false;
    }

    // Error state: Sub 4 joins while owner is already unavailable -> receives cached owner-unavailable frame.
    unsub1();
    unsub2();
    unsub3();
    f.setFail(true);
    unsub1 = await backend.subscribe('sess-1', view => sub4Views.push(view), { expectedHostId: f.hostId });
    assert.equal(sub4Views.at(-1)?.status, 'owner-unavailable');
    /** @type {Value[]} */ const sub5Views = [];
    const unsub5 = await backend.subscribe('sess-1', view => sub5Views.push(view), { expectedHostId: f.hostId });
    assert.equal(sub5Views.length, 1);
    assert.equal(sub5Views[0].status, 'owner-unavailable');
    unsub5();
  } finally {
    unsub1();
    unsub2();
    unsub3();
    unsub4();
    await backend.dispose();
  }
});

test('R012: subscribe() isolates session pollers by [expectedHostId, id] so mismatched host does not poison valid host', async () => {
  const f = createClaudeRpcFixture();
  const backend = new ClaudeDesktopBackend({ rpc: f.rpc, pollMs: 60_000, taskFeedNegativeTtlMs: 60_000 });
  /** @type {Value[]} */ const validViews = [];
  /** @type {Value[]} */ const foreignViews = [];
  let unsubValid = () => {};
  let unsubForeign = () => {};

  try {
    unsubValid = await backend.subscribe('sess-1', view => validViews.push(view), { expectedHostId: f.hostId });
    assert.equal(validViews.length, 1);
    assert.equal(validViews[0].status, 'idle');

    unsubForeign = await backend.subscribe('sess-1', view => foreignViews.push(view), { expectedHostId: 'foreign-host-id' });
    assert.equal(backend.sessions.size, 2);
    assert.equal(foreignViews.length, 1);
    assert.equal(foreignViews[0].status, 'owner-unavailable');
    assert.equal(validViews.length, 1);
    assert.equal(validViews[0].status, 'idle');

    unsubForeign();
    assert.equal(backend.sessions.size, 1);
    assert.equal(backend.sessions.has(JSON.stringify([f.hostId, 'sess-1'])), true);
  } finally {
    unsubValid();
    unsubForeign();
    await backend.dispose();
  }
});

test('R017: CodexBackend projectHistory records candidate.sourceId in seen so items matching prior sourceId are deduplicated', async () => {
  const listeners = /** @type {Map<string, Set<(frame: Value) => void>>} */ (new Map());
  const ipc = /** @type {any} */ ({
    hostId: 'local',
    generation: () => 'codex-owner-1',
    connect: async () => {},
    dispose: () => {},
    /** @param {string} id @param {(frame: Value) => void} callback */
    subscribe: async (id, callback) => {
      let set = listeners.get(id);
      if (!set) {
        set = new Set();
        listeners.set(id, set);
      }
      set.add(callback);
      callback({
        type: 'broadcast',
        method: 'thread-stream-state-changed',
        params: {
          change: {
            type: 'snapshot',
            revision: 1,
            conversationState: {
              threadRuntimeStatus: { type: 'idle', activeFlags: [] },
              requests: [],
              turns: [
                {
                  turnId: 'turn-1',
                  status: 'completed',
                  items: [
                    {
                      type: 'steeringUserMessage',
                      id: 'steer-raw-1',
                      serverUserMessageId: 'srv-msg-1',
                      clientUserMessageId: 'cmd-steer-1',
                      input: [{ type: 'text', text: 'steer once' }],
                    },
                    {
                      type: 'userMessage',
                      id: 'steer-raw-1',
                      content: [{ type: 'text', text: 'steer once duplicate emission' }],
                    },
                  ],
                },
              ],
            },
          },
        },
      });
      return () => { set?.delete(callback); };
    },
    refreshSnapshot: async () => {},
  });

  const backend = new CodexBackend({ ipc });
  try {
    const view = await backend.snapshot('thread-r017');
    assert.equal(view.rows.length, 1, 'second candidate whose row.id matches first candidate sourceId must be deduplicated');
    assert.equal(view.rows[0].id, 'srv-msg-1');
    assert.equal(view.rows[0].text, 'steer once');
  } finally {
    backend.dispose();
  }
});
