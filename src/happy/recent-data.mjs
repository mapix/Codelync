import { BridgeError } from '../errors.mjs';
import { isCodeLightNativeSource } from './source-scope.mjs';
import { sourceCatalogVisible } from './source-catalog-scope.mjs';
import { createHash, randomUUID } from 'node:crypto';

/** @typedef {Record<string,any>} Value */
const OLD_MS = 72 * 60 * 60 * 1000;
/** @param {unknown} value */
function timestamp(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0; }
/** @param {unknown} cursor @param {string} kind @param {string|null} [sessionId] @returns {Value|null} */
function decode(cursor, kind, sessionId = null) {
  if (cursor == null || cursor === '') return null;
  if (typeof cursor !== 'string' || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new BridgeError('invalid-history-cursor', 'The recent-data cursor is invalid.');
  let value; try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw new BridgeError('invalid-history-cursor', 'The recent-data cursor is invalid.'); }
  if (!value || value.v !== 1 || value.kind !== kind || value.sessionId !== sessionId || typeof value.id !== 'string' || !value.id || value.id.length > 1000) throw new BridgeError('invalid-history-cursor', 'The recent-data cursor does not match this read.');
  return /** @type {Value} */ (value);
}
/** @param {Value} value */
function encode(value) { return Buffer.from(JSON.stringify({ v: 1, ...value })).toString('base64url'); }
/** @param {unknown} cursor @param {string} sessionId @returns {Value} */
export function nativeHistoryBoundary(cursor, sessionId) { return decode(cursor, 'rows', sessionId) ?? {}; }

/** Saved Desktop data uses its verified byte boundary, not a live-owner cursor.
 * @param {string} sessionId @param {Value} view @param {{limit?:unknown}} [options] */
export function nativeSavedHistoryPage(sessionId, view, options = {}) {
  const count = limit(options.limit, 50, 100), proof = view.historicalRead, boundary = proof?.byteBoundary;
  if (!proof || proof.available !== true || !boundary || !Number.isSafeInteger(boundary.start) || boundary.start < 0 ||
      typeof proof.sourceStamp !== 'string' || !/^[a-f0-9]{64}$/u.test(proof.sourceStamp)) throw new BridgeError('native-history-unverified', 'The saved-history page boundary is unavailable.', 503);
  const visible = (view.rows ?? []).filter((/** @type {Value} */ row) => typeof row.id === 'string' && row.id && ['user', 'assistant', 'reasoning', 'tool'].includes(row.role));
  const selected = visible.slice(-count).map((/** @type {Value} */ row) => ({ ...row,
    turnId: typeof row.turnId === 'string' && row.turnId ? row.turnId : row.displayTurnId || `saved-history:${proof.nativeId}:unrooted`, readOnlyHistory: true }));
  const first = selected[0], beforeByte = visible.length > selected.length && Number.isSafeInteger(first?.order) ? first.order : boundary.start;
  const hasMore = visible.length > selected.length || view.historyComplete !== true && beforeByte > 0;
  return { rows: selected, hasMore, nextCursor: hasMore ? encode({ kind: 'rows', sessionId, id: first?.id ?? '@saved-start', nativeSavedHistory: { beforeByte, sourceStamp: proof.sourceStamp } }) : null };
}
/** @param {unknown} value @param {number} fallback @param {number} cap */
function limit(value, fallback, cap) {
  const selected = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > cap) throw new BridgeError('invalid-page-limit', 'The recent-data page limit is invalid.');
  return selected;
}

/** @param {{source:Value,binding:Value,actor?:Value}} entry @param {number} now @param {boolean} [forceFull] */
export function recentDescriptor(entry, now, forceFull = false) {
  const { source, binding, actor } = entry, nativeUpdatedAt = timestamp(source.updatedAt);
  const basicOnly = !forceFull && nativeUpdatedAt < now - OLD_MS;
  let checkpoint = /** @type {Value} */ ({});
  try { checkpoint = actor?.transport?.peerSnapshot?.() ?? {}; }
  catch { if (forceFull) throw new BridgeError('source-unavailable', 'The selected observer checkpoint is unavailable.', 503); }
  const original = checkpoint.metadata ?? binding.metadata ?? {};
  const nativeSession = { title: source.title || source.id, updatedAt: nativeUpdatedAt, parentId: source.parentId ?? null, agentName: source.agentName ?? '',
    isSubagent: source.isSubagent === true,
    archived: source.archived === true || original.nativeSession?.archived === true,
    catalogueAvailable: sourceCatalogVisible(source, original),
    ...(source.project ? { projectKey: source.project.key, projectPath: source.project.path, projectLabel: source.project.label }
      : original.nativeSession?.projectKey && original.nativeSession?.projectPath ? {
        projectKey: original.nativeSession.projectKey, projectPath: original.nativeSession.projectPath, projectLabel: original.nativeSession.projectLabel,
      } : {}) };
  const metadata = basicOnly ? { path: source.workspace ?? '', host: original.host ?? 'CodeLight Mac', flavor: source.app, machineId: binding.machineId,
    client: original.client ?? { id: 'noninvasive-bridge' }, bridge: original.bridge, nativeSession, summary: { text: nativeSession.title, updatedAt: nativeUpdatedAt },
    ...(actor && checkpoint.metadata ? { capabilities: original.capabilities } : {}) }
    : { ...original, path: source.workspace ?? original.path ?? '', nativeSession: { ...original.nativeSession, ...nativeSession, preview: source.preview ?? '' },
      summary: { ...original.summary, text: nativeSession.title, updatedAt: nativeUpdatedAt } };
  return { id: binding.happySessionId, nativeUpdatedAt, basicOnly, metadata,
    metadataVersion: checkpoint.metadataVersion ?? binding.metadataVersion ?? 0,
    agentState: basicOnly ? null : forceFull ? checkpoint.agentState ?? null : directoryAgentState(checkpoint.agentState), agentStateVersion: checkpoint.agentStateVersion ?? 0,
    seq: checkpoint.seq ?? 0, createdAt: timestamp(source.createdAt), updatedAt: nativeUpdatedAt,
    // 在线描述的是已有观察链路；原生 running/idle 仍由独立 owner 状态投影决定。
    active: actor?.status?.().sourceStatus === 'connected', activeAt: checkpoint.observedAt ?? 0,
    ...(forceFull ? { sessionKey: binding.sessionKey } : {}) };
}

/** Query task rosters belong to selected-session reads. Directory deltas use
 * aggregate attention without transferring every observer's task envelope.
 * @param {Value|null|undefined} value */
function directoryAgentState(value) {
  if (!value) return null;
  const directory = { ...value };
  delete directory.nativeTasks;
  delete directory.nativeTaskSignal;
  return directory;
}

/** Directory reads are index-only and never activate sources.
 * @param {{source:Value,binding:Value,actor?:Value}[]} entries @param {{cursor?:unknown,limit?:unknown,now?:number}} [options] */
export function recentCatalogPage(entries, options = {}) {
  const now = options.now ?? Date.now(), cursor = decode(options.cursor, 'catalog'), count = limit(options.limit, cursor ? 1000 : 200, 2000);
  const rows = catalogEntries(entries);
  if (cursor && (typeof cursor.time !== 'number' || !Number.isFinite(cursor.time))) throw new BridgeError('invalid-history-cursor', 'The catalog cursor is invalid.');
  const eligible = cursor ? rows.filter(row => row.time < cursor.time || row.time === cursor.time && row.id < cursor.id) : rows;
  const selected = eligible.slice(0, count), last = selected.at(-1), hasMore = eligible.length > selected.length;
  return { version: 1, sessions: selected.map(row => recentDescriptor(row.entry, now)), hasMore,
    nextCursor: hasMore && last ? encode({ kind: 'catalog', sessionId: null, id: last.id, time: last.time }) : null, scannedAt: now };
}

/** @param {{source:Value,binding:Value,actor?:Value}[]} entries */
function catalogEntries(entries) {
  return entries.filter(entry => isCodeLightNativeSource(entry.source, entry.binding.metadata) && sourceCatalogVisible(entry.source, entry.binding.metadata) && typeof entry.binding.happySessionId === 'string')
    .map(entry => ({ entry, time: timestamp(entry.source.updatedAt), id: entry.binding.happySessionId }))
    .sort((a, b) => b.time - a.time || (a.id === b.id ? 0 : a.id < b.id ? 1 : -1));
}

/** Metadata-only, source-version catalog snapshots. Neither constructing a
 * snapshot nor comparing it starts observers or reads conversation histories. */
export class NativeCatalogDeltas {
  /** @param {{now?:()=>number,ttlMs?:number,maxSnapshots?:number}} [options] */
  constructor(options = {}) {
    this.now = options.now ?? Date.now; this.ttlMs = options.ttlMs ?? 10 * 60 * 1000; this.maxSnapshots = options.maxSnapshots ?? 32;
    this.epoch = randomUUID(); this.sequence = 0;
    /** @type {Map<string,Value>} */ this.snapshots = new Map();
  }
  /** @param {{source:Value,binding:Value,actor?:Value}[]} entries @param {Value} params @param {string|null} [machineId] */
  page(entries, params = {}, machineId = null) {
    const count = limit(params.limit, 200, 2000), now = this.now();
    for (const [key, value] of this.snapshots) if (now - (value.lastUsedAt ?? value.at) >= this.ttlMs) this.snapshots.delete(key);
    let snapshot, offset = 0;
    if (params.cursor) {
      const cursor = decode(params.cursor, 'catalog-delta');
      snapshot = cursor && this.snapshots.get(cursor.id); offset = cursor?.offset;
      if (!snapshot || !Number.isSafeInteger(offset) || offset < 0 || offset > snapshot.changed.length ||
          (params.since ?? null) !== snapshot.requestedSince || snapshot.ownerMachineId !== machineId) throw new BridgeError('stale-catalog-cursor', 'The native directory snapshot expired or changed.', 409);
      this.touch(snapshot.watermark, snapshot, now);
    } else {
      if (params.since !== undefined && (typeof params.since !== 'string' || params.since.length > 512)) throw new BridgeError('invalid-catalog-watermark', 'A bounded opaque directory watermark is required.');
      const candidate = this.snapshots.get(params.since);
      // A watermark belongs to the emitting machine even when the catalog has
      // no rows whose metadata could otherwise reveal a scope change.
      const previous = candidate?.ownerMachineId === machineId ? candidate : null;
      if (previous) this.touch(params.since, previous, now);
      const indexed = catalogEntries(entries);
      if (indexed.length > 10000) throw new BridgeError('catalog-too-large', 'The native directory exceeds its snapshot bound.', 503);
      const rows = indexed.map(row => recentDescriptor(row.entry, now));
      const byId = new Set(rows.map(row => row.id));
      const signatures = new Map(rows.map(row => [row.id, createHash('sha256').update(JSON.stringify({
        nativeUpdatedAt: row.nativeUpdatedAt, basicOnly: row.basicOnly, metadataVersion: row.metadataVersion, metadata: row.metadata,
        createdAt: row.createdAt, aggregateDigest: row.agentState?.aggregateActivity?.digest ?? null,
      })).digest('hex')]));
      const mode = previous ? 'delta' : 'full';
      const changed = previous ? rows.filter(row => previous.signatures.get(row.id) !== signatures.get(row.id)) : rows;
      const removedIds = previous ? [...previous.byId.keys()].filter(id => !byId.has(id)) : [];
      if (previous && !changed.length && !removedIds.length) {
        return { version: 2, mode: 'delta', watermark: params.since, baseWatermark: params.since, machineIds: previous.machineIds, sessions: [], removedIds: [], hasMore: false, nextCursor: null, scannedAt: now };
      }
      const watermark = `${this.epoch}:${++this.sequence}`;
      const machineIds = [...new Set([machineId, ...rows.map(row => row.metadata?.machineId)].filter(id => typeof id === 'string' && id))];
      snapshot = { at: now, lastUsedAt: now, watermark, mode, machineIds, ownerMachineId: machineId, requestedSince: params.since ?? null, baseWatermark: previous ? params.since : null,
        changed: structuredClone(changed), removedIds, byId, signatures };
      this.snapshots.set(watermark, snapshot);
      while (this.snapshots.size > this.maxSnapshots) { const oldest = this.snapshots.keys().next().value; if (oldest === undefined) break; this.snapshots.delete(oldest); }
    }
    const rows = snapshot.changed.slice(offset, offset + count), next = offset + rows.length, hasMore = next < snapshot.changed.length;
    return { version: 2, mode: snapshot.mode, watermark: snapshot.watermark, baseWatermark: snapshot.baseWatermark, machineIds: snapshot.machineIds,
      sessions: structuredClone(rows), removedIds: offset === 0 ? [...snapshot.removedIds] : [], hasMore,
      nextCursor: hasMore ? encode({ kind: 'catalog-delta', sessionId: null, id: snapshot.watermark, offset: next }) : null,
      scannedAt: snapshot.at };
  }
  /** Refresh retention without changing immutable page capture time.
   * @param {string} key @param {Value} snapshot @param {number} now */
  touch(key, snapshot, now) {
    snapshot.lastUsedAt = now;
    this.snapshots.delete(key); this.snapshots.set(key, snapshot);
  }
}

/** Public rows are complete original-row values, not the last N protocol fragments.
 * @param {string} sessionId @param {Value[]} rows @param {{cursor?:unknown,limit?:unknown,historyComplete?:boolean,nativeStepOffset?:number,ownerGeneration?:string|null}} [options] */
export function recentRowsPage(sessionId, rows, options = {}) {
  const cursor = decode(options.cursor, 'rows', sessionId), count = limit(options.limit, 50, 100);
  const visible = rows.filter(row => typeof row.id === 'string' && row.id && typeof row.turnId === 'string' && ['user', 'assistant', 'reasoning', 'tool'].includes(row.role));
  const boundary = cursor && cursor.empty !== true ? visible.findIndex(row => row.id === cursor.id) : visible.length;
  if (boundary < 0) throw new BridgeError('stale-history-cursor', 'The earlier native row is no longer present in the current owner view.', 409);
  const start = Math.max(0, boundary - count), selected = visible.slice(start, boundary);
  const hasMore = start > 0 || options.historyComplete === false && options.nativeStepOffset !== 0;
  return { rows: structuredClone(selected), hasMore,
    nextCursor: hasMore ? encode({ kind: 'rows', sessionId, id: selected[0]?.id ?? '@native-start', ...(selected[0] ? {} : { empty: true }),
      ...(typeof options.ownerGeneration === 'string' ? { ownerGeneration: options.ownerGeneration } : {}),
      ...(Number.isSafeInteger(options.nativeStepOffset) ? { nativeStepOffset: options.nativeStepOffset } : {}) }) : null };
}

/** Coalesces selected source preparation/fresh reads; no directory history walks.
 * @param {{sources:()=>{source:Value,binding:Value,actor?:Value}[],resolveSource:(sessionId:string)=>Promise<{source:Value,binding:Value,actor:Value}>,available?:()=>boolean,readAvailable?:()=>boolean,machineId?:()=>string|null,now?:()=>number}} options */
export class CodeLightRecentService {
  /** @type {Map<string,Promise<Value>>} */ flights = new Map();
  /** @param {{sources:()=>{source:Value,binding:Value,actor?:Value}[],resolveSource:(sessionId:string)=>Promise<{source:Value,binding:Value,actor:Value}>,available?:()=>boolean,readAvailable?:()=>boolean,machineId?:()=>string|null,now?:()=>number}} options */
  constructor(options) { this.options = options; this.now = options.now ?? Date.now; this.catalogDeltas = new NativeCatalogDeltas({ now: this.now }); }
  /** @param {Value} [params] */
  catalog(params = {}) { this.assertAvailable(); return Number(params.catalogVersion) === 2 ? this.catalogDeltas.page(this.options.sources(), params, this.options.machineId?.() ?? null) : recentCatalogPage(this.options.sources(), { ...params, now: this.now() }); }
  assertAvailable() { if (this.options.available?.() === false) throw new BridgeError('source-unavailable', 'The current native directory is unavailable.', 503); }
  assertReadAvailable() { if ((this.options.readAvailable ?? this.options.available)?.() === false) throw new BridgeError('source-unavailable', 'The selected native read service is unavailable.', 503); }
  /** @param {string} sessionId @param {Value} [params] @returns {Promise<Value>} */
  recent(sessionId, params = {}) {
    this.assertReadAvailable();
    const count = limit(params.limit, 50, 100), key = JSON.stringify([sessionId, count]);
    const pending = this.flights.get(key); if (pending) return pending.then(value => structuredClone(value));
    const flight = this.read(sessionId, { limit: count }, true).finally(() => { if (this.flights.get(key) === flight) this.flights.delete(key); });
    this.flights.set(key, flight); return flight.then(value => structuredClone(value));
  }
  /** @param {string} sessionId @param {Value} params */
  history(sessionId, params) { this.assertReadAvailable(); if (!params.cursor) throw new BridgeError('invalid-history-cursor', 'An earlier-history cursor is required.'); return this.read(sessionId, params, false); }
  /** @param {string} sessionId @param {Value} params @param {boolean} fresh */
  async read(sessionId, params, fresh) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) throw new BridgeError('invalid-session', 'A selected session identity is required.');
    const entry = await this.options.resolveSource(sessionId); this.assertReadAvailable();
    if (entry.binding.happySessionId !== sessionId || typeof entry.actor.connector?.readRecent !== 'function') throw new BridgeError('source-unavailable', 'The selected native observer is unavailable.', 503);
    const snapshot = await entry.actor.connector.readRecent({ ...params, fresh }); this.assertReadAvailable();
    return { version: 1, session: recentDescriptor(entry, this.now(), true), ...snapshot, observedAt: this.now() };
  }
}
