import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { io } from 'socket.io-client';
import { LocalSourceDiscovery } from '../src/codelync/discovery.mjs';
import { CodelyncMacDaemon } from '../src/codelync/mac-daemon.mjs';
import { AntigravityBackend } from '../src/adapters/antigravity-backend.mjs';
import { CodelyncSessionTransport, encryptRecord, decryptRecord } from '../src/codelync/session-transport.mjs';
import { sourceKey } from '../src/codelync/source-registry.mjs';

/** @typedef {Record<string,any>} Value */
/** @param {()=>Promise<boolean>} condition @param {number} [timeout] */
async function until(condition, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 200)); }
  throw Error('The isolated native Codelync verification did not reach its expected state.');
}

// Explicit opt-in sends one bounded test prompt to the copied desktop. It never
// sends a prompt to Codex or the installed original Antigravity application.
test('real isolated Antigravity over sealed Codelync: dual discovery, native admission, once and encrypted projection',
  { skip: process.env.CODELYNC_ANTIGRAVITY_LIVE !== '1', timeout: 120000 }, async () => {
    const root = process.env.CODELYNC_ANTIGRAVITY_PROBE;
    assert.ok(root && root.startsWith('/'), 'Choose the prepared private probe directory.');
    const runtimePath = join(root, 'runtime.json');
    const runtime = JSON.parse(await readFile(runtimePath, 'utf8'));
    assert.equal(runtime.home, join(root, 'home'));
    assert.equal(runtime.binary, join(root, 'Antigravity Probe.app/Contents/Resources/bin/language_server'));
    const qa = JSON.parse(await readFile(join(root, 'qa-session.json'), 'utf8'));
    const origin = process.env.CODELYNC_ANTIGRAVITY_RELAY ?? 'http://127.0.0.1:57071';
    const url = new URL(origin);
    assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port);
    const seed = new Uint8Array(randomBytes(32)), signer = nacl.sign.keyPair.fromSeed(seed), challenge = randomBytes(32);
    const auth = await fetch(origin + '/v1/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey: Buffer.from(signer.publicKey).toString('base64'), challenge: challenge.toString('base64'), signature: Buffer.from(nacl.sign.detached(challenge, signer.secretKey)).toString('base64') }) });
    assert.equal(auth.status, 200);
    const account = { serverUrl: origin, secret: Buffer.from(seed).toString('base64url'), token: (await auth.json()).token };
    const agy = new AntigravityBackend({ runtimePath });
    const discovery = new LocalSourceDiscovery({ antigravityBackend: agy });
    const directory = await mkdtemp(join(root, 'sealed-qa-'));
    const codexId = process.env.CODELYNC_ANTIGRAVITY_CODEX_ID;
    const daemon = new CodelyncMacDaemon({ directory, leaseDirectory: join(directory, 'leases'), account, discovery,
      only: source => source.app === 'antigravity' && source.id === qa.cascadeId || source.app === 'codex' && source.id === codexId });
    const socket = io(origin, { path: '/v1/updates', auth: { token: account.token, clientType: 'user-scoped' }, transports: ['websocket'], autoConnect: false });
    /** @type {CodelyncSessionTransport|null} */ let peer = null;
    /** @param {string} method @param {Value} params */
    const machineCall = async (method, params) => {
      const reply = await socket.timeout(15000).emitWithAck('rpc-call', { method: `${daemon.machine?.id}:${method}`, params: encryptRecord(params, seed, 'legacy') });
      assert.equal(reply.ok, true); return /** @type {Value} */ (decryptRecord(reply.result, seed, 'legacy'));
    };
    try {
      await daemon.start();
      const entries = [...daemon.sources.values()];
      assert.ok(entries.some(e => e.source.app === 'antigravity'));
      if (codexId) assert.ok(entries.some(e => e.source.app === 'codex'), 'The selected real Codex source must also be discovered.');
      await new Promise((resolve, reject) => { socket.once('connect', () => resolve(undefined)); socket.once('connect_error', reject); socket.connect(); });
      const entry = entries.find(e => e.source.app === 'antigravity'); assert.ok(entry);
      const selected = await machineCall('codelync-select-source', { sourceKey: sourceKey(entry.source), commandId: 'live-select-' + randomUUID(), selectionClient: 'isolated-native-qa', selectionSeq: 1 });
      assert.equal(selected.receipt.status, 'complete');
      assert.equal(selected.receipt.result.desktopSwitchRequested, false);
      const key = new Uint8Array(Buffer.from(entry.binding.sessionKey, 'base64'));
      peer = new CodelyncSessionTransport({ serverOrigin: origin, token: account.token, sessionId: entry.binding.happySessionId,
        encryptionKey: key, statePath: join(directory, 'phone-transport.json'), pollMs: 0 });
      await peer.start();
      const localId = 'live-sealed-input-' + randomUUID();
      const marker = 'CODELYNC_SEALED_OK_' + randomUUID().slice(0, 8);
      const message = { role: 'user', content: { type: 'text', text: `This is the final bounded isolated Codelync sealed-transport check. Reply exactly ${marker}. Do not use any tools or change files.` } };
      const ack = await peer.publish(localId, message);
      await until(async () => { await peer?.catchUp(); return !!peer?.listInbox().some((/** @type {Value} */ incoming) => incoming.record?.content?.ev?.t === 'user-message-accepted' && incoming.record.content.ev.ref === ack.id); });
      const accepted = peer.listInbox().find((/** @type {Value} */ incoming) => incoming.record?.content?.ev?.t === 'user-message-accepted' && incoming.record.content.ev.ref === ack.id);
      assert.ok(accepted);
      await until(async () => { await peer?.catchUp(); return !!peer?.listInbox().some((/** @type {Value} */ incoming) => incoming.record?.content?.role === 'agent' && incoming.record.content.turn === accepted.record.content.ev.runId && incoming.record.content.ev?.t === 'text' && incoming.record.content.ev.text.includes(marker)); });
      const before = await agy.snapshot(qa.cascadeId);
      const commandId = before.rows.find(row => row.role === 'user' && row.turnId === accepted.record.content.ev.runId)?.commandId;
      assert.ok(typeof commandId === 'string' && before.rows.some(row => row.role === 'user' && row.commandId === commandId));
      await peer.publish(localId, message);
      await new Promise(resolve => setTimeout(resolve, 1000));
      const after = await agy.snapshot(qa.cascadeId);
      assert.equal(after.rows.filter(row => row.role === 'user' && row.commandId === commandId).length, 1);
      const raw = await fetch(origin + '/v1/sessions/' + entry.binding.happySessionId + '/messages', { headers: { Authorization: 'Bearer ' + account.token } });
      assert.equal(raw.status, 200);
      assert.equal((await raw.text()).includes(message.content.text), false);
      const report = { realNativeOwner: true, registeredApps: entries.map(e => e.source.app).sort(), exactNativeAdmission: true,
        duplicateDispatches: 0, sealedResultObserved: true, relayPlaintextAbsent: true, desktopSwitchRequested: false,
        originalCodexModelPrompts: 0, originalAntigravityModelPrompts: 0 };
      await writeFile(join(root, 'sealed-verification.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
      console.log(JSON.stringify(report));
    } finally {
      socket.disconnect(); await peer?.close(); await daemon.close(); signer.secretKey.fill(0); seed.fill(0);
    }
  });
