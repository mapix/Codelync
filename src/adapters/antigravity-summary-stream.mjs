import { randomUUID } from 'node:crypto';
import { BridgeError } from '../errors.mjs';
import { antigravityHostId } from './antigravity-rpc.mjs';

/** @typedef {Record<string,any>} Value */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_HEADERS = 20000;
const invalid = () => new BridgeError('antigravity-invalid-summary-stream', 'The native summary stream is unavailable.', 503);
/** @param {unknown} value */
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
/** @param {unknown} id @returns {string} */
function identity(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,511}$/u.test(id) || ['constructor', 'prototype', '__proto__'].includes(id)) throw invalid();
  return id;
}

/** Bounded linear-copy Connect framing, independent of network chunk boundaries. */
export class AntigravitySummaryFrameDecoder {
  /** @param {number} [maxBytes] */
  constructor(maxBytes = MAX_FRAME_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_FRAME_BYTES) throw invalid();
    this.maxBytes = maxBytes; this.header = Buffer.alloc(5); this.headerUsed = 0;
    /** @type {Buffer|null} */ this.payload = null;
    this.payloadUsed = 0; this.flags = 0;
  }
  /** @param {Uint8Array} chunk @returns {{flags:number,payload:Buffer}[]} */
  feed(chunk) {
    if (!(chunk instanceof Uint8Array) || chunk.length > MAX_FRAME_BYTES + 5) throw invalid();
    const frames = []; let at = 0;
    while (at < chunk.length) {
      if (!this.payload) {
        const take = Math.min(5 - this.headerUsed, chunk.length - at);
        this.header.set(chunk.subarray(at, at + take), this.headerUsed); this.headerUsed += take; at += take;
        if (this.headerUsed < 5) break;
        this.flags = this.header[0]; const length = this.header.readUInt32BE(1);
        if (![0, 2].includes(this.flags) || length < 1 || length > this.maxBytes) throw invalid();
        this.payload = Buffer.alloc(length); this.payloadUsed = 0;
      }
      const take = Math.min(this.payload.length - this.payloadUsed, chunk.length - at);
      this.payload.set(chunk.subarray(at, at + take), this.payloadUsed); this.payloadUsed += take; at += take;
      if (this.payloadUsed === this.payload.length) {
        frames.push({ flags: this.flags, payload: this.payload }); this.payload = null; this.payloadUsed = 0; this.headerUsed = 0;
        if (frames.length > 4096) throw invalid();
      }
    }
    return frames;
  }
  finish() { if (this.headerUsed || this.payload) throw invalid(); }
}

/** @param {unknown} root */
function validateTree(root) {
  const stack = [{ value: root, depth: 0 }]; let nodes = 0;
  while (stack.length) {
    const item = stack.pop(); if (!item) break;
    const { value, depth } = item;
    if (++nodes > 200000 || depth > 64) throw invalid();
    if (typeof value === 'number' && !Number.isFinite(value) || typeof value === 'string' && value.length > 1024 * 1024) throw invalid();
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw invalid();
        stack.push({ value: child, depth: depth + 1 });
      }
    }
  }
}

/** Full native message replacement; omitted protobuf scalar fields use defaults.
 * @param {unknown} value @returns {Value} */
export function validateAntigravityStreamSummary(value) {
  if (!record(value)) throw invalid(); validateTree(value);
  const summary = /** @type {Value} */ (value);
  for (const name of ['notFullyIdle', 'hasRunningSubagents', 'hasActiveChildren', 'killed', 'interrupted', 'hasActivity', 'cloud']) {
    if (summary[name] !== undefined && typeof summary[name] !== 'boolean') throw invalid();
  }
  for (const name of ['backgroundTaskCount', 'stepCount', 'lastUserInputStepIndex']) {
    if (summary[name] !== undefined && (!Number.isSafeInteger(summary[name]) || summary[name] < 0 || summary[name] > 0xffffffff)) throw invalid();
  }
  if (summary.status !== undefined && !(Number.isSafeInteger(summary.status) && summary.status >= 0 && summary.status <= 0xffffffff)
      && !(typeof summary.status === 'string' && /^CASCADE_(?:RUN_)?STATUS_[A-Z_]{1,80}$/u.test(summary.status))) throw invalid();
  for (const name of ['trajectoryId', 'forkParentConversationId']) if (summary[name] !== undefined && typeof summary[name] !== 'string') throw invalid();
  for (const name of ['waitingSteps', 'workspaces', 'codeReviewIds']) if (summary[name] !== undefined && (!Array.isArray(summary[name]) || summary[name].length > MAX_HEADERS)) throw invalid();
  for (const name of ['annotations', 'trajectoryMetadata']) if (summary[name] !== undefined && !record(summary[name])) throw invalid();
  for (const name of ['parentConversationId', 'rootConversationId', 'rootParentConversationId']) {
    const id = summary.trajectoryMetadata?.[name];
    if (id !== undefined && (typeof id !== 'string' || id.length > 512 || /[\x00-\x1f]/u.test(id))) throw invalid();
  }
  const reduced = Object.create(null);
  reduced.status = summary.status ?? 0;
  reduced.nativeSubagentSpecPresent = record(summary.trajectoryMetadata?.subagentSpec) && Object.keys(summary.trajectoryMetadata.subagentSpec).length > 0;
  for (const name of ['status', 'source', 'trajectoryId', 'stepCount', 'killed', 'interrupted', 'hasActivity', 'latestExecutorTerminationReason', 'forkParentConversationId']) {
    if (summary[name] !== undefined) reduced[name] = summary[name];
  }
  if (summary.trajectoryMetadata) {
    reduced.trajectoryMetadata = Object.create(null);
    for (const name of ['parentConversationId', 'rootConversationId', 'rootParentConversationId']) {
      if (typeof summary.trajectoryMetadata[name] === 'string') reduced.trajectoryMetadata[name] = summary.trajectoryMetadata[name];
    }
    if (record(summary.trajectoryMetadata.subagentSpec)) {
      reduced.nativeSubagentSpecPresent = Object.keys(summary.trajectoryMetadata.subagentSpec).length > 0;
      reduced.trajectoryMetadata.subagentSpec = Object.create(null);
      for (const name of ['role', 'typeName']) if (typeof summary.trajectoryMetadata.subagentSpec[name] === 'string') reduced.trajectoryMetadata.subagentSpec[name] = summary.trajectoryMetadata.subagentSpec[name].slice(0, 160);
    }
  }
  if (summary.waitingSteps) reduced.waitingSteps = summary.waitingSteps.map((/** @type {Value} */ step) => {
    if (!record(step)) throw invalid();
    const value = Object.create(null);
    for (const name of ['type', 'stepId', 'stepIndex']) if (typeof step[name] === 'string' || Number.isSafeInteger(step[name])) value[name] = step[name];
    return value;
  });
  return { ...reduced, notFullyIdle: summary.notFullyIdle ?? false,
    hasRunningSubagents: summary.hasRunningSubagents ?? false, hasActiveChildren: summary.hasActiveChildren ?? false,
    backgroundTaskCount: summary.backgroundTaskCount ?? 0 };
}

/** @param {Buffer} payload @returns {Value} */
function decode(payload) {
  let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)); } catch { throw invalid(); }
  if (!record(value)) throw invalid(); validateTree(value); return value;
}

/** One backend-owned, owner-scoped source of live header authority. */
export class AntigravitySummaryStream {
  /** @param {{rpc:Value,expectedHostId:string,generation:string,now?:()=>number,reconnectMs?:number,maxFrameBytes?:number}} options */
  constructor(options) {
    if (!options.rpc || typeof options.rpc.subscribeSummaries !== 'function' || typeof options.rpc.runtime !== 'function' || typeof options.expectedHostId !== 'string' || !options.expectedHostId || typeof options.generation !== 'string' || !options.generation) throw invalid();
    this.rpc = options.rpc; this.scope = { hostId: options.expectedHostId, generation: options.generation };
    this.now = options.now ?? Date.now; this.reconnectMs = options.reconnectMs ?? 2000; this.maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
    if (!Number.isSafeInteger(this.maxFrameBytes) || this.maxFrameBytes < 1 || this.maxFrameBytes > MAX_FRAME_BYTES) throw invalid();
    if (!Number.isSafeInteger(this.reconnectMs) || this.reconnectMs < 10 || this.reconnectMs > 60000) throw invalid();
    /** @type {Map<string,{summary:Value,capturedAt:number,epoch:string,stamp:string}>} */ this.headers = new Map();
    /** @type {Set<string>} */ this.deleted = new Set();
    /** @type {Set<(change:Value)=>void>} */ this.listeners = new Set();
    /** @type {Set<()=>void>} */ this.waiters = new Set();
    /** @type {AbortController|null} */ this.controller = null;
    /** @type {ReadableStreamDefaultReader<Uint8Array>|null} */ this.reader = null;
    /** @type {Value|null} */ this.connection = null;
    /** @type {Promise<void>|null} */ this.running = null;
    /** @type {Promise<void>|null} */ this.runtimeFlight = null;
    /** @type {ReturnType<typeof setTimeout>|null} */ this.reconnect = null;
    this.disposed = false; this.available = false; this.epoch = null; this.revision = 0; this.observedAt = 0; this.stopReconnect = false;
  }
  /** @param {{expectedHostId:string,generation:string}} context */
  matches(context) { return context.expectedHostId === this.scope.hostId && context.generation === this.scope.generation; }
  validateOwner() {
    if (!this.runtimeFlight) {
      const flight = Promise.resolve().then(async () => {
        const runtime = await this.rpc.runtime();
        if (runtime.generation !== this.scope.generation || antigravityHostId(runtime) !== this.scope.hostId) throw new BridgeError('source-epoch-changed', 'The native summary owner changed.', 409);
      }).finally(() => { if (this.runtimeFlight === flight) this.runtimeFlight = null; });
      this.runtimeFlight = flight;
    }
    return this.runtimeFlight;
  }
  /** @param {(change:Value)=>void} listener */
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  /** @param {string[]} ids @param {{expectedHostId:string,generation:string}} context */
  getReplica(ids, context) {
    if (!Array.isArray(ids) || ids.length > MAX_HEADERS) throw invalid(); ids.forEach(identity);
    const current = !this.disposed && this.available && this.matches(context);
    const headers = Object.create(null), states = Object.create(null), captures = Object.create(null);
    for (const id of ids) {
      const entry = current ? this.headers.get(id) : null;
      if (entry?.epoch === this.epoch) { headers[id] = structuredClone(entry.summary); states[id] = 'ready'; captures[id] = entry.capturedAt; }
      else states[id] = current && this.deleted.has(id) ? 'deleted' : 'unknown';
    }
    const liveProof = current ? { version: 1, ...this.scope, streamEpoch: this.epoch, currentAlive: true,
      fullReplacement: true, proto3Defaults: true } : null;
    return { available: current, complete: current && ids.every(id => states[id] !== 'unknown'), scope: { ...this.scope },
      headers, states, captures, liveProof, streamEpoch: this.epoch, revision: this.revision, observedAt: this.observedAt };
  }
  /** @param {string[]} ids @param {{expectedHostId:string,generation:string,waitMs?:number}} context */
  async read(ids, context) {
    this.getReplica(ids, context);
    const waitMs = context.waitMs ?? 1000;
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 15000) throw invalid();
    if (!this.matches(context) || this.disposed) return this.getReplica(ids, context);
    try { await this.validateOwner(); } catch (error) {
      if (error instanceof BridgeError && error.code === 'source-epoch-changed') this.stopReconnect = true;
      this.invalidate(); return this.getReplica(ids, context);
    }
    this.start(); const current = this.getReplica(ids, context);
    if (current.complete || waitMs === 0 || this.stopReconnect) return current;
    return new Promise(resolve => {
      /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer;
      const finish = () => { clearTimeout(timer); this.waiters.delete(changed); resolve(this.getReplica(ids, context)); };
      const changed = () => { const next = this.getReplica(ids, context); if (next.complete || !next.available || this.disposed) finish(); };
      this.waiters.add(changed); timer = setTimeout(finish, waitMs);
    });
  }
  /** @param {string[]} [changedIds] @param {string[]} [deletedIds] */
  publish(changedIds = [], deletedIds = []) {
    this.revision++;
    const change = { scope: { ...this.scope }, available: this.available, streamEpoch: this.epoch,
      revision: this.revision, observedAt: this.observedAt, changedIds, deletedIds };
    for (const listener of this.listeners) { try { listener(change); } catch { /* An observer cannot stop the native stream. */ } }
    for (const listener of this.waiters) listener();
  }
  invalidate() {
    const affected = [...this.headers.keys()], changed = this.available || this.headers.size > 0 || this.deleted.size > 0;
    this.available = false; this.headers.clear(); this.deleted.clear();
    this.controller?.abort(); if (this.reconnect) { clearTimeout(this.reconnect); this.reconnect = null; }
    if (changed) this.publish(affected); else for (const listener of this.waiters) listener();
  }
  start() {
    if (this.running || this.reconnect || this.disposed || this.stopReconnect) return;
    const controller = new AbortController(); this.controller = controller; this.epoch = randomUUID();
    this.headers.clear(); this.deleted.clear(); this.available = false;
    this.publish();
    const epoch = this.epoch;
    const flight = this.pump(controller, epoch).catch(error => {
      if (error instanceof BridgeError && error.code === 'source-epoch-changed') this.stopReconnect = true;
      this.invalidate();
    }).finally(() => {
      if (this.running === flight) this.running = null;
      if (!this.disposed && !this.stopReconnect) this.reconnect = setTimeout(() => { this.reconnect = null; this.start(); }, this.reconnectMs);
    });
    this.running = flight;
  }
  /** @param {AbortController} controller @param {string} epoch */
  async pump(controller, epoch) {
    const connection = await this.rpc.subscribeSummaries({ expectedHostId: this.scope.hostId, expectedGeneration: this.scope.generation, signal: controller.signal });
    this.connection = connection;
    if (this.disposed || controller.signal.aborted || connection.scope.hostId !== this.scope.hostId || connection.scope.generation !== this.scope.generation) {
      await connection.close();
      throw new BridgeError('source-epoch-changed', 'The native summary stream scope changed.', 409);
    }
    const reader = connection.response.body.getReader(); this.reader = reader;
    const decoder = new AntigravitySummaryFrameDecoder(this.maxFrameBytes);
    try {
      while (!controller.signal.aborted && !this.disposed) {
        const part = await reader.read();
        if (part.done) { decoder.finish(); throw invalid(); }
        const frames = decoder.feed(part.value);
        if (frames.length) await this.validateOwner();
        for (const frame of frames) {
          if (this.disposed || controller.signal.aborted || epoch !== this.epoch) return;
          const value = decode(frame.payload);
          if (frame.flags === 2) throw invalid();
          if (Object.keys(value).some(key => !['updates', 'deletes'].includes(key)) || value.updates !== undefined && !record(value.updates)
              || value.deletes !== undefined && !Array.isArray(value.deletes)) throw invalid();
          const updates = Object.entries(value.updates ?? {}), deletes = /** @type {string[]} */ (value.deletes ?? []);
          if (updates.length > MAX_HEADERS || deletes.length > MAX_HEADERS) throw invalid();
          const validated = updates.map(([id, summary]) => /** @type {[string,Value]} */ ([identity(id), validateAntigravityStreamSummary(summary)]));
          deletes.forEach(identity);
          const removeSet = new Set(deletes), updateSet = new Set(validated.map(([id]) => id));
          const added = validated.filter(([id]) => !this.headers.has(id) && !removeSet.has(id)).length;
          const removedExisting = [...removeSet].filter(id => this.headers.has(id)).length;
          const newDeletes = [...removeSet].filter(id => !this.deleted.has(id)).length;
          const revived = [...updateSet].filter(id => this.deleted.has(id) && !removeSet.has(id)).length;
          if (this.headers.size + added - removedExisting > MAX_HEADERS || this.deleted.size + newDeletes - revived > MAX_HEADERS) throw invalid();
          const at = this.now(), changed = [], removed = [];
          for (const [id, summary] of validated) {
            if (removeSet.has(id)) continue;
            const stamp = JSON.stringify(summary), previous = this.headers.get(id);
            this.deleted.delete(id);
            if (!previous || previous.stamp !== stamp) { this.headers.set(id, { summary, capturedAt: at, epoch, stamp }); changed.push(id); }
          }
          for (const id of removeSet) { this.headers.delete(id); this.deleted.add(id); removed.push(id); }
          const newlyAvailable = !this.available; this.available = true; this.observedAt = at;
          if (newlyAvailable || changed.length || removed.length) this.publish(changed, removed);
        }
      }
    } finally {
      if (epoch === this.epoch) this.invalidate();
      controller.abort(); await reader.cancel().catch(() => {}); reader.releaseLock(); await connection.close();
      if (this.reader === reader) this.reader = null; if (this.connection === connection) this.connection = null;
    }
  }
  async dispose() {
    if (this.disposed) return; this.disposed = true; this.stopReconnect = true; this.invalidate();
    await this.reader?.cancel().catch(() => {}); await this.connection?.close(); this.listeners.clear();
  }
}
