import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BridgeError } from '../errors.mjs';
import { writeDurablePrivateJson } from './discovery-persistence.mjs';
import { decryptRecord } from './session-transport.mjs';

/** @typedef {Record<string,any>} Value */
/** @param {unknown} identity */
function identityText(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) throw new BridgeError('observer-history-invalid', 'The observer identity is invalid.');
  const value = /** @type {Value} */ (identity);
  return JSON.stringify([value.happySessionId, value.nativeId, value.bindingId,
    value.source?.app, value.source?.id, value.source?.hostId, value.keyFingerprint]);
}
/** @param {string} path */
async function readArchiveText(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') throw new BridgeError('observer-history-unavailable', 'The retained observer history is unavailable.');
    throw error;
  }
}
/** @param {Value} reference */
function validReference(reference) {
  return !!reference && typeof reference === 'object' && !Array.isArray(reference)
    && typeof reference.digest === 'string' && Number.isSafeInteger(reference.count) && reference.count >= 0
    && Number.isSafeInteger(reference.rowCount) && reference.rowCount >= 0 && reference.count + reference.rowCount >= 1;
}
/** @param {Value} identity @param {Value[]} events @param {Value[]} rows @param {Uint8Array} key */
function digestOf(identity, events, rows, key) {
  return createHmac('sha256', key).update(identityText(identity)).update('\n').update(JSON.stringify(events)).update('\n').update(JSON.stringify(rows)).digest('hex');
}
/** @param {string} statePath @param {unknown} digest */
function archivePath(statePath, digest) {
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest)) throw new BridgeError('observer-history-invalid', 'The observer history reference is invalid.');
  return join(statePath + '.history', digest + '.json');
}
/** Local historical checkpoints use their own bounded envelope, never the smaller network message limit.
 * @param {Value} payload @param {Uint8Array} key */
function encodeArchive(payload, key) {
  const plain = Buffer.from(JSON.stringify(payload));
  if (plain.length > 128 * 1024 * 1024) throw new BridgeError('observer-history-capacity', 'The observer history segment exceeds its explicit size bound.');
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from([0]), nonce, encrypted, cipher.getAuthTag()]).toString('base64');
}
/** @param {string} text @param {Value} identity @param {Value} reference @param {Uint8Array} key @returns {{events:Value[],rows:Value[]}} */
function decodeArchive(text, identity, reference, key) {
  if (!validReference(reference)) throw new BridgeError('observer-history-invalid', 'The observer history index is invalid.');
  let envelope, payload;
  try { envelope = JSON.parse(text); payload = /** @type {Value|null} */ (decryptRecord(envelope?.ciphertext, key)); } catch { /* Reject unreadable history below. */ }
  if (envelope?.format !== 'codelync-observer-history-v1' || !payload || identityText(payload.identity) !== identityText(identity)
    || !Array.isArray(payload.events) || payload.events.length !== reference.count
    || !Array.isArray(payload.rows) || payload.rows.length !== reference.rowCount
    || !payload.events.every((/** @type {Value} */ event) => event && typeof event.id === 'string' && event.id && event.sent === true && typeof event.ciphertext === 'string')
    || !payload.rows.every((/** @type {Value} */ row) => row && typeof row.id === 'string' && row.id)
    || digestOf(payload.identity, payload.events, payload.rows, key) !== reference.digest) throw new BridgeError('observer-history-invalid', 'The observer history could not authenticate its original source and bodies.');
  return { events: payload.events, rows: payload.rows };
}
/** Checks the small reference index without loading old message bodies into the active observer.
 * @param {Value} state @param {string} statePath */
export async function validateObserverHistoryReferences(state, statePath) {
  const references = state.observerHistoryArchives ?? [];
  if (!Array.isArray(references)) throw new BridgeError('observer-history-invalid', 'The observer history index is invalid.');
  const digests = new Set();
  for (const reference of references) {
    if (!validReference(reference) || digests.has(reference.digest)) throw new BridgeError('observer-history-invalid', 'The observer history index is invalid.');
    const path = archivePath(statePath, reference.digest); digests.add(reference.digest);
    try { await access(path); } catch { throw new BridgeError('observer-history-unavailable', 'The retained observer history is unavailable.'); }
  }
}
/** Only the checkpoint owner calls this inside its serialized writer.
 * @param {Value} state @param {string} statePath @param {Uint8Array} key @param {number} [minimumBytes] @returns {Promise<boolean>} */
export async function archiveObserverCheckpointPayload(state, statePath, key, minimumBytes = 4 * 1024 * 1024) {
  const events = state.events.filter((/** @type {Value} */ event) => event.sent === true && typeof event.ciphertext === 'string');
  const active = Array.isArray(state.activeRowIds) ? new Set(state.activeRowIds) : null;
  const rows = active ? state.rows.filter((/** @type {Value} */ row) => !active.has(row.id) &&
    (typeof row.text === 'string' && row.text.length || typeof row.output === 'string' && row.output.length)) : [];
  const bytes = events.reduce((/** @type {number} */ total, /** @type {Value} */ event) => total + event.ciphertext.length, 0)
    + rows.reduce((/** @type {number} */ total, /** @type {Value} */ row) => total + Buffer.byteLength(row.text ?? '') + Buffer.byteLength(row.output ?? ''), 0);
  if (!events.length && !rows.length || bytes < minimumBytes) return false;
  const reference = { digest: digestOf(state.identity, events, rows, key), count: events.length, rowCount: rows.length }, path = archivePath(statePath, reference.digest);
  let existing = null;
  try { existing = await readFile(path, 'utf8'); } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error; }
  if (existing !== null) decodeArchive(existing, state.identity, reference, key);
  else await writeDurablePrivateJson(path, { format: 'codelync-observer-history-v1', ciphertext: encodeArchive({ identity: state.identity, events, rows }, key) });
  // 旧长会话把已确认正文永久塞在活动检查点，新增投影撞容量后反复被标成断连。先 fsync 历史，才替换正文。
  state.observerHistoryArchives ??= [];
  if (!state.observerHistoryArchives.some((/** @type {Value} */ saved) => saved.digest === reference.digest)) state.observerHistoryArchives.push(reference);
  for (const event of events) { delete event.ciphertext; event.archive = reference.digest; }
  for (const row of rows) { delete row.text; delete row.output; row.historyRef = reference.digest; }
  return true;
}
/** Read-only historical audit/recovery; never feeds archived records into native admission.
 * @param {Value} state @param {string} statePath @param {Uint8Array} key @returns {Promise<{events:Value[],rows:Value[]}>} */
export async function readObserverHistoryArchives(state, statePath, key) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new BridgeError('observer-history-invalid', 'The observer checkpoint is invalid.');
  identityText(state.identity);
  await validateObserverHistoryReferences(state, statePath);
  const events = [], rows = [], ids = new Set();
  for (const reference of state.observerHistoryArchives ?? []) {
    const records = decodeArchive(await readArchiveText(archivePath(statePath, reference.digest)), state.identity, reference, key);
    rows.push(...records.rows);
    for (const event of records.events) {
      if (ids.has(event.id)) throw new BridgeError('observer-history-invalid', 'The retained observer history has duplicate event identities.');
      ids.add(event.id); events.push(event);
    }
  }
  return { events, rows };
}

/** Restores only an archived prefix that actually re-enters the current native observation window.
 * @param {Value} state @param {string} statePath @param {Uint8Array} key @param {Set<string>} activeIds @returns {Promise<Map<string,Value>>} */
export async function readArchivedObserverRows(state, statePath, key, activeIds) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || !Array.isArray(state.rows) || !(activeIds instanceof Set)) throw new BridgeError('observer-history-invalid', 'The observer checkpoint rows are invalid.');
  identityText(state.identity);
  const result = new Map();
  if (!activeIds.size) return result;
  /** @type {Map<string, Value[]>} */ const byDigest = new Map();
  for (const row of state.rows) {
    if (!row || typeof row.id !== 'string' || !activeIds.has(row.id) || !row.historyRef) continue;
    if (typeof row.historyRef !== 'string') throw new BridgeError('observer-history-invalid', 'The archived row reference is invalid.');
    let group = byDigest.get(row.historyRef);
    if (!group) { group = []; byDigest.set(row.historyRef, group); }
    group.push(row);
  }
  if (!byDigest.size) return result;
  const references = state.observerHistoryArchives ?? [];
  if (!Array.isArray(references)) throw new BridgeError('observer-history-invalid', 'The observer history index is invalid.');
  /** @type {Map<string, Value>} */ const refByDigest = new Map();
  for (const reference of references) {
    if (!validReference(reference) || refByDigest.has(reference.digest)) throw new BridgeError('observer-history-invalid', 'The observer history index is invalid.');
    refByDigest.set(reference.digest, reference);
  }
  for (const [digest, rows] of byDigest) {
    const reference = refByDigest.get(digest);
    if (!reference) throw new BridgeError('observer-history-invalid', 'The archived row reference is missing.');
    const archive = decodeArchive(await readArchiveText(archivePath(statePath, digest)), state.identity, reference, key);
    /** @type {Map<string, Value>} */ const archivedById = new Map();
    for (const saved of archive.rows) {
      if (archivedById.has(saved.id)) throw new BridgeError('observer-history-invalid', 'The observer history has duplicate archived rows.');
      archivedById.set(saved.id, saved);
    }
    for (const row of rows) {
      const saved = archivedById.get(row.id);
      if (!saved) throw new BridgeError('observer-history-invalid', 'The archived native prefix is missing.');
      const restored = { ...saved };
      delete restored.historyRef;
      result.set(row.id, restored);
    }
  }
  return result;
}
