import { DatabaseSync } from 'node:sqlite';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative } from 'node:path';
import { BridgeError } from '../errors.mjs';

/** @typedef {Record<string,any>} Value */
/** @typedef {{nativeId:string,rolloutPath:string,parentNativeId:string|null,isSubagent:boolean,agentPath?:string|null,archived?:boolean,indexStamp?:string}} Metadata */
/** @typedef {{root:string,loadMetadata?:(id:string)=>Promise<Metadata|null>,maxPageBytes?:number,maxHeaderBytes?:number}} Options */
/** @typedef {{offset:number,bytes:number,hash:string}} CapturedRange */
/** @typedef {{baseStamp:string,sourceStamp:string,fingerprint:string,size:number,ranges:CapturedRange[]}} Capture */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** @param {unknown} value @returns {value is Value} */
function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
/** @param {unknown} value */
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
/** @param {string} code @param {number} [status] */
function failure(code, status = 503) { return new BridgeError(code, 'Verified original Desktop saved history is unavailable.', status); }
/** @param {unknown} value */
function nativeId(value) { if (typeof value !== 'string' || !UUID.test(value)) throw failure('codex-history-identity-invalid', 400); return value; }
/** @param {string} root @param {string} path */
function contained(root, path) { const suffix = relative(root, path); return suffix !== '' && !suffix.startsWith('..') && !isAbsolute(suffix); }
/** @param {import('node:fs').BigIntStats} value */
function fileIdentity(value) { return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].map(String); }
/** Native activity timestamps may advance on append; membership cannot.
 * @param {Metadata} value */
function membership(value) { return [value.nativeId, value.rolloutPath, value.parentNativeId, value.isSubagent, value.agentPath ?? null, value.archived ?? false]; }
/** @param {Buffer} value */
function bytesHash(value) { return createHash('sha256').update(value).digest('hex'); }
/** @param {unknown} value */
function text(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.filter(record).filter(part => ['input_text', 'output_text', 'summary_text', 'text'].includes(part.type) && typeof part.text === 'string').map(part => part.text).join('\n');
}

/** Original app index metadata only. No runtime or full-history status read.
 * @param {string} root @param {string} id @returns {Promise<Metadata|null>} */
export async function readCodexSavedMetadata(root, id) {
  nativeId(id);
  let db = /** @type {DatabaseSync|null} */ (null);
  try {
    db = new DatabaseSync(join(root, 'state_5.sqlite'), { readOnly: true });
    db.exec('PRAGMA query_only=ON; BEGIN');
    const fields = new Set(db.prepare('PRAGMA table_info(threads)').all().map(row => row.name));
    if (!['id', 'rollout_path', 'source'].every(field => fields.has(field))) throw failure('codex-history-index-unsupported');
    const names = ['id', 'rollout_path', 'source', 'agent_path', 'attached_thread_parent_id', 'archived', 'updated_at_ms', 'updated_at'].filter(field => fields.has(field));
    const row = /** @type {Value|undefined} */ (db.prepare(`SELECT ${names.join(',')} FROM threads WHERE id=?`).get(id));
    if (!row) return null;
    let source = /** @type {Value} */ ({});
    try { if (typeof row.source === 'string' && row.source.length <= 16384) source = JSON.parse(row.source); }
    catch { if (typeof row.source !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(row.source)) throw failure('codex-history-index-invalid'); }
    const spawn = source?.subagent?.thread_spawn;
    const parent = row.attached_thread_parent_id || spawn?.parent_thread_id || null;
    return { nativeId: row.id, rolloutPath: row.rollout_path, parentNativeId: parent, isSubagent: record(spawn), agentPath: row.agent_path || spawn?.agent_path || null,
      archived: row.archived === 1, indexStamp: digest([row.id, row.rollout_path, parent, row.agent_path, row.source, row.archived, row.updated_at_ms ?? row.updated_at]) };
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw failure('codex-history-index-unavailable');
  } finally { db?.close(); }
}

/** Bounded original saved data; its provenance never becomes a native control owner. */
export class CodexSavedHistoryReader {
  /** @param {Options} options */
  constructor(options) {
    if (!isAbsolute(options.root)) throw failure('codex-history-namespace-invalid', 400);
    this.options = options; this.maxPageBytes = options.maxPageBytes ?? 256 * 1024; this.maxHeaderBytes = options.maxHeaderBytes ?? 256 * 1024;
    if (!Number.isSafeInteger(this.maxPageBytes) || this.maxPageBytes < 1024 || this.maxPageBytes > 4 * 1024 * 1024
      || !Number.isSafeInteger(this.maxHeaderBytes) || this.maxHeaderBytes < 1024 || this.maxHeaderBytes > 1024 * 1024) throw failure('codex-history-bounds-invalid', 400);
    this.versions = /** @type {Map<string,number>} */ (new Map()); this.captures = /** @type {Map<string,Capture>} */ (new Map()); this.closed = false;
  }
  /** @param {string} id */
  release(id) { this.versions.set(id, (this.versions.get(id) ?? 0) + 1); this.captures.delete(id); }
  close() { this.closed = true; this.versions.clear(); this.captures.clear(); }
  /** @param {string} id @param {number} version */
  check(id, version) { if (this.closed || (this.versions.get(id) ?? 0) !== version) throw failure('codex-history-read-released', 409); }
  /** @param {string} root @param {string} id */
  async metadata(root, id) {
    const value = await (this.options.loadMetadata?.(id) ?? readCodexSavedMetadata(root, id));
    if (!value || value.nativeId !== id || typeof value.rolloutPath !== 'string' || !isAbsolute(value.rolloutPath)) throw failure('codex-history-membership-unverified');
    return value;
  }
  /** @param {string} root @param {Metadata} metadata */
  async file(root, metadata) {
    const path = await realpath(metadata.rolloutPath);
    if (![join(root, 'sessions'), join(root, 'archived_sessions')].some(directory => contained(directory, path))) throw failure('codex-history-foreign-path');
    const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await descriptor.stat({ bigint: true });
      if (!stat.isFile() || process.getuid && stat.uid !== BigInt(process.getuid()) || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw failure('codex-history-file-unverified');
      return { descriptor, path, stat };
    } catch (error) { await descriptor.close(); throw error; }
  }
  /** @param {import('node:fs/promises').FileHandle} descriptor @param {string} id */
  async header(descriptor, id) {
    const parts = /** @type {Buffer[]} */ ([]); let at = 0, ended = false, bytesRead = 0;
    while (at < this.maxHeaderBytes) {
      const buffer = Buffer.alloc(Math.min(4096, this.maxHeaderBytes - at));
      const read = await descriptor.read(buffer, 0, buffer.length, at); bytesRead += read.bytesRead;
      if (!read.bytesRead) break;
      const chunk = buffer.subarray(0, read.bytesRead), newline = chunk.indexOf(10);
      parts.push(newline < 0 ? chunk : chunk.subarray(0, newline)); at += read.bytesRead;
      if (newline >= 0) { ended = true; break; }
    }
    if (!ended) throw failure('codex-history-header-too-large');
    let value = /** @type {Value} */ ({});
    try { value = JSON.parse(Buffer.concat(parts).toString('utf8')); }
    catch { throw failure('codex-history-header-invalid'); }
    if (value.type !== 'session_meta' || value.payload?.id !== id || value.payload?.originator !== 'Codex Desktop') throw failure('codex-history-desktop-membership-unverified');
    return { metadata: value.payload, bytesRead, stamp: bytesHash(Buffer.concat(parts)) };
  }
  /** Revalidate only retained captured ranges, never a full-file status scan.
   * @param {import('node:fs/promises').FileHandle} descriptor @param {CapturedRange[]} ranges */
  async verifyRanges(descriptor, ranges) {
    let bytesRead = 0;
    for (const range of ranges) {
      const buffer = Buffer.alloc(range.bytes), result = await descriptor.read(buffer, 0, buffer.length, range.offset);
      bytesRead += result.bytesRead;
      if (result.bytesRead !== buffer.length || bytesHash(buffer) !== range.hash) return { matches: false, bytesRead };
    }
    return { matches: true, bytesRead };
  }
  /** @param {string} id @param {{beforeByte?:number,sourceStamp?:string,limit?:number,expectedParentNativeId?:string}} [boundary] */
  async readPage(id, boundary = {}) {
    nativeId(id); const version = this.versions.get(id) ?? 0; this.check(id, version);
    const limit = boundary.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || boundary.beforeByte !== undefined && (!Number.isSafeInteger(boundary.beforeByte) || boundary.beforeByte < 0 || boundary.sourceStamp === undefined)
      || boundary.sourceStamp !== undefined && (typeof boundary.sourceStamp !== 'string' || !/^[a-f0-9]{64}$/u.test(boundary.sourceStamp))) throw failure('codex-history-boundary-invalid', 400);
    try {
      const root = await realpath(this.options.root), namespaceHash = digest(root), metadata = await this.metadata(root, id);
      if (!metadata.isSubagent || !metadata.parentNativeId || metadata.parentNativeId === id) throw failure('codex-history-subagent-unverified');
      nativeId(metadata.parentNativeId);
      if (boundary.expectedParentNativeId !== undefined && metadata.parentNativeId !== boundary.expectedParentNativeId) throw failure('codex-history-parent-mismatch', 409);
      const child = await this.file(root, metadata);
      try {
        const header = await this.header(child.descriptor, id), spawn = header.metadata.source?.subagent?.thread_spawn;
        if (!record(spawn) || spawn.parent_thread_id !== metadata.parentNativeId || metadata.agentPath && spawn.agent_path !== metadata.agentPath) throw failure('codex-history-parent-mismatch', 409);
        const parentMetadata = await this.metadata(root, metadata.parentNativeId), parent = await this.file(root, parentMetadata);
        let parentBytes = 0, parentHeaderStamp = '';
        try { const value = await this.header(parent.descriptor, metadata.parentNativeId); parentBytes = value.bytesRead; parentHeaderStamp = value.stamp; }
        finally { await parent.descriptor.close(); }
        const total = Number(child.stat.size), fingerprint = fileIdentity(child.stat).join(':'), baseStamp = digest([namespaceHash, membership(metadata), child.path,
          String(child.stat.dev), String(child.stat.ino), header.stamp, membership(parentMetadata), parentHeaderStamp]);
        let previous = this.captures.get(id), validationBytes = 0;
        if (previous?.baseStamp !== baseStamp) previous = undefined;
        if (previous && previous.fingerprint !== fingerprint) {
          const checked = total > previous.size ? await this.verifyRanges(child.descriptor, previous.ranges) : { matches: false, bytesRead: 0 };
          validationBytes += checked.bytesRead;
          if (!checked.matches) previous = undefined;
        }
        const sourceStamp = previous?.sourceStamp ?? digest([baseStamp, fingerprint]);
        if (boundary.sourceStamp !== undefined && boundary.sourceStamp !== sourceStamp) throw failure('codex-history-source-changed', 409);
        const end = boundary.beforeByte ?? total;
        if (end > total) throw failure('codex-history-boundary-invalid', 400);
        const start = Math.max(0, end - this.maxPageBytes), buffer = Buffer.alloc(end - start);
        const read = await child.descriptor.read(buffer, 0, buffer.length, start);
        if (read.bytesRead !== buffer.length) throw failure('codex-history-source-changed', 409);
        let cursor = start ? buffer.indexOf(10) + 1 : 0;
        if (start && cursor === 0) throw failure('codex-history-record-too-large');
        const records = /** @type {Array<{offset:number,value:Value}>} */ ([]);
        const committedEnd = buffer.lastIndexOf(10) + 1;
        if (boundary.beforeByte !== undefined && committedEnd !== buffer.length) throw failure('codex-history-boundary-invalid', 400);
        while (cursor < committedEnd) {
          const newline = buffer.indexOf(10, cursor);
          if (newline < 0) break;
          const line = buffer.subarray(cursor, newline); const offset = start + cursor; cursor = newline + 1;
          if (!line.length) continue;
          let value;
          try { value = JSON.parse(line.toString('utf8')); }
          catch { throw failure('codex-history-record-invalid'); }
          if (record(value)) records.push({ offset, value });
        }
        let rows = projectSavedRows(records, id);
        const trimmed = rows.length > limit; if (trimmed) rows = rows.slice(-limit);
        const byteStart = trimmed && rows.length ? rows[0].order : records[0]?.offset ?? start;
        const captured = { offset: start, bytes: committedEnd, hash: bytesHash(buffer.subarray(0, committedEnd)) };
        const nextMetadata = await this.metadata(root, id), nextStat = await child.descriptor.stat({ bigint: true });
        if (digest(membership(nextMetadata)) !== digest(membership(metadata))) throw failure('codex-history-source-changed', 409);
        if (fileIdentity(nextStat).join(':') !== fingerprint) {
          if (nextStat.dev !== child.stat.dev || nextStat.ino !== child.stat.ino || nextStat.size <= child.stat.size) throw failure('codex-history-source-changed', 409);
          const checked = await this.verifyRanges(child.descriptor, [...previous?.ranges ?? [], captured]); validationBytes += checked.bytesRead;
          if (!checked.matches) throw failure('codex-history-source-changed', 409);
        }
        const currentFile = await this.file(root, nextMetadata);
        try { if (fileIdentity(currentFile.stat).join(':') !== fileIdentity(nextStat).join(':')) throw failure('codex-history-source-changed', 409); }
        finally { await currentFile.descriptor.close(); }
        this.check(id, version);
        const ranges = [...previous?.ranges ?? []].filter(range => range.offset !== captured.offset || range.bytes !== captured.bytes);
        ranges.push(captured); this.captures.delete(id); this.captures.set(id, { baseStamp, sourceStamp, fingerprint: fileIdentity(nextStat).join(':'), size: Number(nextStat.size), ranges: ranges.slice(-8) });
        while (this.captures.size > 32) { const oldest = this.captures.keys().next().value; if (oldest === undefined) break; this.captures.delete(oldest); }
        const lastLifecycle = savedLifecycle(records, id, committedEnd < buffer.length);
        const historicalRead = { version: 1, available: true, app: 'codex', originator: 'Codex Desktop', nativeId: id, hostId: 'local', namespaceHash, sourceStamp,
          parentNativeId: metadata.parentNativeId, bytesRead: header.bytesRead + parentBytes + read.bytesRead + validationBytes,
          byteBoundary: { start: byteStart, end: start + committedEnd, total }, trailingIncomplete: committedEnd < buffer.length,
          appendProof: 'retained-captured-ranges', retainedRanges: ranges.slice(-8).length, lastLifecycle };
        const view = { rows, requests: [], status: 'history-only', currentTurnId: null, ownerGeneration: null,
          historyComplete: start === 0 && !trimmed, historicalRead };
        return { ...view, contentStamp: digest([rows, historicalRead.sourceStamp, historicalRead.byteBoundary]) };
      } finally { await child.descriptor.close(); }
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw failure('codex-history-read-unavailable');
    }
  }
}

/** Native lifecycle evidence only; never infer turn completion from visible rows.
 * @param {Array<{offset:number,value:Value}>} records @param {string} id @param {boolean} incomplete */
function savedLifecycle(records, id, incomplete) {
  let result = /** @type {Value|null} */ (null);
  for (const { offset, value } of records) {
    const payload = value.payload;
    if (value.type !== 'event_msg' || !record(payload) || typeof payload.type !== 'string' || !/^(?:task_|turn_)/u.test(payload.type)
      || typeof payload.thread_id === 'string' && payload.thread_id !== id) continue;
    const turnId = typeof payload.turn_id === 'string' && payload.turn_id.trim() ? payload.turn_id : null;
    const timestamp = typeof value.timestamp === 'string' ? Date.parse(value.timestamp) : NaN;
    result = { type: payload.type, turnId, recordByteOffset: offset, at: Number.isFinite(timestamp) ? timestamp : null,
      terminalObserved: !incomplete && turnId !== null && ['task_complete', 'turn_aborted'].includes(payload.type) };
  }
  return result;
}

/** @param {Array<{offset:number,value:Value}>} records @param {string} id */
function projectSavedRows(records, id) {
  const turns = new Map(), rows = /** @type {Map<string,Value>} */ (new Map());
  for (const { value } of records) if (value.type === 'event_msg' && value.payload?.type === 'item_completed'
    && typeof value.payload.item?.id === 'string' && typeof value.payload.turn_id === 'string') turns.set(value.payload.item.id, value.payload.turn_id);
  let currentTurn = /** @type {string|null} */ (null);
  for (const { offset, value } of records) {
    const payload = value.payload;
    if (!record(payload)) continue;
    if (value.type === 'event_msg' && payload.type === 'task_started' && typeof payload.turn_id === 'string') currentTurn = payload.turn_id;
    if (value.type !== 'response_item') continue;
    const originalId = typeof payload.id === 'string' && payload.id.length > 0 && payload.id.length <= 512 ? payload.id : null;
    const callId = typeof payload.call_id === 'string' && payload.call_id.length > 0 && payload.call_id.length <= 512 ? payload.call_id : null;
    const rowId = ['function_call', 'function_call_output'].includes(payload.type) ? callId ?? originalId ?? `saved:${offset}` : originalId ?? `saved:${offset}`;
    const turnId = turns.get(originalId) ?? currentTurn;
    const timestamp = typeof value.timestamp === 'string' ? Date.parse(value.timestamp) : NaN;
    const base = { id: rowId, text: '', tools: [], turnId, status: 'history-only', at: Number.isFinite(timestamp) ? timestamp : null, order: offset,
      ...(turnId ? {} : { displayTurnId: `saved-unrooted:${id}` }) };
    if (payload.type === 'message' && ['user', 'assistant'].includes(payload.role)) {
      const content = text(payload.content); if (content) rows.set(rowId, { ...base, role: payload.role, text: content });
    } else if (payload.type === 'reasoning') {
      const summary = text(payload.summary); if (summary) rows.set(rowId, { ...base, role: 'reasoning', text: summary });
    } else if (['function_call', 'function_call_output'].includes(payload.type)) {
      const previous = rows.get(rowId), tool = previous?.tools[0];
      rows.set(rowId, { ...(previous ?? base), role: 'tool', tools: [{ id: rowId,
        name: payload.type === 'function_call' && typeof payload.name === 'string' ? payload.name.slice(0, 256) : tool?.name ?? 'Tool',
        output: payload.type === 'function_call_output' ? text(payload.output) : tool?.output ?? '',
        status: payload.type === 'function_call_output' ? 'completed' : tool?.status ?? 'unknown' }] });
    }
  }
  return [...rows.values()].sort((a, b) => a.order - b.order);
}
