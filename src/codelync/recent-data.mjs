import { BridgeError } from '../errors.mjs';
import { isCodelyncNativeSource } from './source-scope.mjs';
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
  const metadata = basicOnly ? { path: source.workspace ?? '', host: original.host ?? 'Codelync Mac', flavor: source.app, machineId: binding.machineId,
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
  return entries.filter(entry => isCodelyncNativeSource(entry.source, entry.binding.metadata) && sourceCatalogVisible(entry.source, entry.binding.metadata) && typeof entry.binding.happySessionId === 'string')
    .map(entry => ({ entry, time: timestamp(entry.source.updatedAt), id: entry.binding.happySessionId }))
    .sort((a, b) => b.time - a.time || (a.id === b.id ? 0 : a.id < b.id ? 1 : -1));
}

/** Metadata-only, source-version catalog snapshots. Neither constructing a
 * snapshot nor comparing it starts observers or reads conversation histories. */
export class NativeCatalogDeltas {
  /** @param {{now?:()=>number,ttlMs?:number,maxSnapshots?:number,maintained?:boolean}} [options] */
  constructor(options = {}) {
    this.now = options.now ?? Date.now; this.ttlMs = options.ttlMs ?? 10 * 60 * 1000; this.maxSnapshots = options.maxSnapshots ?? 32;
    this.maintained = options.maintained === true;
    /** @type {Value|null} */ this.current = null;
    this.epoch = randomUUID(); this.sequence = 0;
    /** @type {Map<string,Value>} */ this.snapshots = new Map();
  }
  /** Background-only preparation; no native reads or observer activation.
   * @param {{source:Value,binding:Value,actor?:Value}[]} entries @param {string|null} machineId */
  capture(entries, machineId) {
    const at = this.now(), indexed = catalogEntries(entries);
    if (indexed.length > 10000) throw new BridgeError('catalog-too-large', 'The native directory exceeds its snapshot bound.', 503);
    const rows = structuredClone(indexed.map(row => recentDescriptor(row.entry, at)));
    const byId = new Set(rows.map(row => row.id));
    const signatures = new Map(rows.map(row => [row.id, createHash('sha256').update(JSON.stringify({
      nativeUpdatedAt: row.nativeUpdatedAt, basicOnly: row.basicOnly, metadataVersion: row.metadataVersion, metadata: row.metadata,
      createdAt: row.createdAt, aggregateDigest: row.agentState?.aggregateActivity?.digest ?? null,
    })).digest('hex')]));
    const machineIds = [...new Set([machineId, ...rows.map(row => row.metadata?.machineId)].filter(id => typeof id === 'string' && id))];
    const signature = createHash('sha256').update(JSON.stringify([machineId, [...signatures]])).digest('hex');
    return { at, rows, byId, signatures, signature, machineIds, ownerMachineId: machineId };
  }
  /** Publish atomically after successful preparation. @param {{source:Value,binding:Value,actor?:Value}[]} entries @param {string|null} machineId */
  refresh(entries, machineId) { this.current = this.capture(entries, machineId); }
  /** Older phones also page prepared headers without reading checkpoints.
   * @param {Value} params @param {string|null} machineId */
  legacyPage(params, machineId) {
    const current = this.current;
    if (!current || current.ownerMachineId !== machineId) throw new BridgeError('source-unavailable', 'The maintained native directory is not ready for this Mac.', 503);
    const cursor = decode(params.cursor, 'catalog'), count = limit(params.limit, cursor ? 1000 : 200, 2000);
    if (cursor && (typeof cursor.time !== 'number' || !Number.isFinite(cursor.time))) throw new BridgeError('invalid-history-cursor', 'The catalog cursor is invalid.');
    const eligible = cursor ? current.rows.filter((/** @type {Value} */ row) => row.nativeUpdatedAt < cursor.time || row.nativeUpdatedAt === cursor.time && row.id < cursor.id) : current.rows;
    const selected = eligible.slice(0, count), last = selected.at(-1), hasMore = eligible.length > selected.length;
    return { version: 1, sessions: structuredClone(selected), hasMore,
      nextCursor: hasMore && last ? encode({ kind: 'catalog', sessionId: null, id: last.id, time: last.nativeUpdatedAt }) : null, scannedAt: current.at };
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
      const current = this.maintained ? this.current : this.capture(entries, machineId);
      if (!current || current.ownerMachineId !== machineId) throw new BridgeError('source-unavailable', 'The maintained native directory is not ready for this Mac.', 503);
      const { rows, byId, signatures, machineIds } = current;
      if (previous && previous.signature === current.signature) {
        return { version: 2, mode: 'delta', watermark: params.since, baseWatermark: params.since, machineIds: previous.machineIds, sessions: [], removedIds: [], hasMore: false, nextCursor: null, scannedAt: current.at };
      }
      const mode = previous ? 'delta' : 'full';
      const changed = previous ? rows.filter((/** @type {Value} */ row) => previous.signatures.get(row.id) !== signatures.get(row.id)) : rows;
      const removedIds = previous ? [...previous.byId.keys()].filter(id => !byId.has(id)) : [];
      if (previous && !changed.length && !removedIds.length) {
        return { version: 2, mode: 'delta', watermark: params.since, baseWatermark: params.since, machineIds: previous.machineIds, sessions: [], removedIds: [], hasMore: false, nextCursor: null, scannedAt: current.at };
      }
      const watermark = `${this.epoch}:${++this.sequence}`;
      snapshot = { at: current.at, lastUsedAt: now, watermark, mode, machineIds, ownerMachineId: machineId, requestedSince: params.since ?? null, baseWatermark: previous ? params.since : null,
        changed: structuredClone(changed), removedIds, byId, signatures, signature: current.signature };
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
  close() { this.current = null; this.snapshots.clear(); }
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

/** A cached body cannot borrow current runtime state or mutation permission.
 * This response-only descriptor never changes stored metadata or receipts.
 * @param {Value} descriptor */
export function cachedRecentDescriptor(descriptor) {
  const result = structuredClone(descriptor), metadata = result.metadata ?? {};
  result.active = false;
  metadata.bridge = { ...metadata.bridge, currentTurnId: null };
  const capabilities = { ...metadata.capabilities, readOnly: true, abort: false, send: false, steering: false,
    modelSelection: false, reasoningSelection: false, permissionModeSelection: false, resume: false, rpcMethods: ['bridge-receipt'] };
  if (capabilities.files) capabilities.files = { ...capabilities.files, write: false };
  delete capabilities.nativeTaskControls;
  metadata.capabilities = capabilities;
  delete metadata.nativeControls; delete metadata.nativeObservedModel;
  result.metadata = metadata;
  const state = result.agentState;
  if (state && typeof state === 'object') {
    delete state.nativeQuery; delete state.nativeTaskSignal; delete state.nativeTasks;
    if (state.nativeInput) state.nativeInput = { ...state.nativeInput, available: false };
    delete state.subagents; // Unknown activity is a small marker, not a repeated stale roster.
    state.subagentsAvailable = false; state.subagentsComplete = false;
    if (state.aggregateActivity) {
      const aggregate = { ...state.aggregateActivity, ownStatus: 'unknown', ownKnown: false, known: false, active: false, waiting: false,
        status: 'unknown', rosterAvailable: false, rosterComplete: false, unknownChildren: state.aggregateActivity.childCount ?? 0 };
      delete aggregate.digest; aggregate.digest = createHash('sha256').update(JSON.stringify(aggregate)).digest('hex');
      state.aggregateActivity = aggregate;
    }
  }
  return result;
}

/** Coalesces selected source preparation/fresh reads; no directory history walks.
 * @param {{sources:()=>{source:Value,binding:Value,actor?:Value}[],resolveSource:(sessionId:string)=>Promise<{source:Value,binding:Value,actor:Value}>,available?:()=>boolean,readAvailable?:()=>boolean,retainSource?:(id:string,execute:()=>Promise<Value>)=>Promise<Value>,machineId?:()=>string|null,now?:()=>number}} options */
export class CodelyncRecentService {
  /** @type {Map<string,Promise<Value>>} */ flights = new Map();
  /** @type {Map<string,Promise<void>>} */ revalidations = new Map();
  /** @param {{sources:()=>{source:Value,binding:Value,actor?:Value}[],resolveSource:(sessionId:string)=>Promise<{source:Value,binding:Value,actor:Value}>,available?:()=>boolean,readAvailable?:()=>boolean,retainSource?:(id:string,execute:()=>Promise<Value>)=>Promise<Value>,machineId?:()=>string|null,now?:()=>number,catalogRefreshMs?:number}} options */
  constructor(options) {
    this.options = options; this.now = options.now ?? Date.now; this.catalogRefreshMs = options.catalogRefreshMs ?? 0;
    if (!Number.isSafeInteger(this.catalogRefreshMs) || this.catalogRefreshMs !== 0 && (this.catalogRefreshMs < 1000 || this.catalogRefreshMs > 60000)) throw new BridgeError('invalid-catalog-refresh', 'Directory maintenance must fit its timer bound.');
    this.catalogDeltas = new NativeCatalogDeltas({ now: this.now, maintained: this.catalogRefreshMs > 0 });
    /** @type {ReturnType<typeof setInterval>|null} */ this.catalogTimer = null;
    this.catalogReady = false; this.closed = false;
  }
  startCatalogMaintenance() {
    if (this.closed || !this.catalogRefreshMs || this.catalogTimer) return;
    this.refreshCatalog();
    this.catalogTimer = setInterval(() => this.refreshCatalog(), this.catalogRefreshMs); this.catalogTimer.unref();
  }
  refreshCatalog() {
    if (this.closed) return;
    try { this.assertAvailable(); this.catalogDeltas.refresh(this.options.sources(), this.options.machineId?.() ?? null); this.catalogReady = true; }
    catch { this.catalogReady = false; }
  }
  close() {
    this.closed = true; this.catalogReady = false;
    if (this.catalogTimer) clearInterval(this.catalogTimer); this.catalogTimer = null; this.catalogDeltas.close();
  }
  /** @param {Value} [params] @returns {Value} */
  catalog(params = {}) {
    this.assertAvailable();
    if (this.closed || this.catalogRefreshMs && !this.catalogReady) throw new BridgeError('source-unavailable', 'The maintained native directory is unavailable.', 503);
    return Number(params.catalogVersion) === 2 ? this.catalogDeltas.page(this.catalogRefreshMs ? [] : this.options.sources(), params, this.options.machineId?.() ?? null)
      : this.catalogRefreshMs ? this.catalogDeltas.legacyPage(params, this.options.machineId?.() ?? null) : recentCatalogPage(this.options.sources(), { ...params, now: this.now() });
  }
  assertAvailable() { if (this.closed || this.options.available?.() === false) throw new BridgeError('source-unavailable', 'The current native directory is unavailable.', 503); }
  assertReadAvailable() { if (this.closed || (this.options.readAvailable ?? this.options.available)?.() === false) throw new BridgeError('source-unavailable', 'The selected native read service is unavailable.', 503); }
  /** @param {string} sessionId @param {Value} [params] @returns {Promise<Value>} */
  recent(sessionId, params = {}) {
    this.assertReadAvailable();
    if (params.readPolicy !== undefined && !['fresh', 'cache-first'].includes(params.readPolicy) || params.cursor !== undefined) throw new BridgeError('invalid-recent-policy', 'A recent request must use a current message-window policy.');
    const count = limit(params.limit, 50, 100);
    return params.readPolicy === 'cache-first' ? this.cachedRecent(sessionId, count) : this.freshRecent(sessionId, count);
  }
  /** Fresh HTTP and background readers reuse the exact same result flight.
   * @param {string} sessionId @param {number} count */
  freshRecent(sessionId, count) {
    this.assertReadAvailable();
    const key = JSON.stringify([sessionId, count]);
    const pending = this.flights.get(key); if (pending) return pending.then(value => structuredClone(value));
    const flight = this.read(sessionId, { limit: count }, true).finally(() => { if (this.flights.get(key) === flight) this.flights.delete(key); });
    this.flights.set(key, flight); return flight.then(value => structuredClone(value));
  }
  /** Only an already-existing observer is eligible; cold startup remains fresh.
   * @param {string} sessionId @param {number} count */
  async cachedRecent(sessionId, count) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) throw new BridgeError('invalid-session', 'A selected session identity is required.');
    const entry = this.options.sources().find(value => value.binding.happySessionId === sessionId);
    if (!entry || !isCodelyncNativeSource(entry.source, entry.binding.metadata) || !sourceCatalogVisible(entry.source, entry.binding.metadata)
      || typeof entry.actor?.connector?.readCachedRecent !== 'function') return this.freshRecent(sessionId, count);
    const snapshot = await entry.actor.connector.readCachedRecent({ limit: count }); this.assertReadAvailable();
    if (!snapshot) return this.freshRecent(sessionId, count);
    const descriptor = recentDescriptor(entry, this.now(), true), source = descriptor.metadata?.bridge?.source;
    if (snapshot.freshness?.version !== 1 || snapshot.freshness.mode !== 'cached' || snapshot.freshness.currentControlAuthority !== false
      || !Number.isFinite(snapshot.freshness.capturedAt) || snapshot.freshness.capturedAt < 0 || snapshot.freshness.revalidationPending !== true
      || snapshot.ownerGeneration !== snapshot.freshness.ownerGeneration || typeof snapshot.ownerGeneration !== 'string'
      || source?.app !== entry.source.app || source?.id !== entry.source.id || source?.hostId !== entry.source.hostId
      || source?.runtimeGeneration !== snapshot.ownerGeneration || !Array.isArray(snapshot.rows)
      || snapshot.rows.some((/** @type {Value} */ row) => row.ownerGeneration !== snapshot.ownerGeneration)) return this.freshRecent(sessionId, count);
    this.revalidate(sessionId, count);
    return { version: 1, session: cachedRecentDescriptor(descriptor), ...snapshot, observedAt: this.now() };
  }
  /** Background work holds the same source-interest pin as the selected route.
   * @param {string} sessionId @param {number} count */
  revalidate(sessionId, count) {
    const key = JSON.stringify([sessionId, count]);
    if (this.revalidations.has(key)) return;
    const read = () => this.freshRecent(sessionId, count);
    const flight = Promise.resolve().then(() => this.options.retainSource ? this.options.retainSource(sessionId, read) : read())
      .then(() => {}).catch(() => {}).finally(() => { if (this.revalidations.get(key) === flight) this.revalidations.delete(key); });
    this.revalidations.set(key, flight);
  }
  /** @param {string} sessionId @param {Value} params */
  history(sessionId, params) { this.assertReadAvailable(); if (!params.cursor) throw new BridgeError('invalid-history-cursor', 'An earlier-history cursor is required.'); return this.read(sessionId, params, false); }
  /** @param {string} sessionId @param {Value} params @param {boolean} fresh */
  async read(sessionId, params, fresh) {
    this.assertReadAvailable();
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) throw new BridgeError('invalid-session', 'A selected session identity is required.');
    const entry = await this.options.resolveSource(sessionId); this.assertReadAvailable();
    if (entry.binding.happySessionId !== sessionId || typeof entry.actor.connector?.readRecent !== 'function') throw new BridgeError('source-unavailable', 'The selected native observer is unavailable.', 503);
    const snapshot = await entry.actor.connector.readRecent({ ...params, fresh }); this.assertReadAvailable();
    return { version: 1, session: recentDescriptor(entry, this.now(), true), ...snapshot, observedAt: this.now() };
  }
}
