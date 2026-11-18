import { createHash, randomUUID } from 'node:crypto';
import { BridgeError } from '../errors.mjs';

/** @typedef {Record<string,any>} Value */
const KEYS = new Set(['clientId', 'requestSeq', 'groups', 'activityProtocol', 'interestToken', 'since']);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const bad = () => new BridgeError('invalid-activity-interest', 'A bounded activity request is required.');
/** @param {unknown} value @param {number} max */
function text(value, max) { return typeof value === 'string' && !!value.trim() && value.length <= max; }
/** @param {string} left @param {string} right */
function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
/** @param {unknown} value @param {Set<object>} [seen] @param {number} [depth] @returns {boolean} */
function isSafePlainJson(value, seen = new Set(), depth = 0) {
  if (depth > 32) return false;
  if (value === null || typeof value !== 'object') return true;
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) if (!isSafePlainJson(item, seen, depth + 1)) return false;
      return true;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    for (const key of Object.getOwnPropertyNames(value)) {
      if (UNSAFE_KEYS.has(key)) return false;
      if (!isSafePlainJson(/** @type {Value} */ (value)[key], seen, depth + 1)) return false;
    }
    return true;
  } finally {
    seen.delete(value);
  }
}
/** @param {unknown} value @returns {string} */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(item => canonicalJson(item)).join(',') + ']';
  const record = /** @type {Record<string, unknown>} */ (value);
  if (typeof record.toJSON === 'function') return canonicalJson(record.toJSON());
  const parts = [];
  for (const key of Object.keys(record).sort(compareText)) {
    const entry = record[key];
    if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol') continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(entry)}`);
  }
  return '{' + parts.join(',') + '}';
}
/** @param {string} serialized */
function hashText(serialized) { return createHash('sha256').update(serialized).digest('hex'); }
/** @param {unknown} value */
function hash(value) { return hashText(canonicalJson(value)); }
/** @param {unknown[]} groups */
function hashCanonicalGroups(groups) {
  return hashText('[' + groups.map(group => canonicalJson(group)).sort(compareText).join(',') + ']');
}
/** Strip future/private fields before anything enters the public transport.
 * @param {Value} reply */
function publicReply(reply) {
  if (!reply || reply.ok !== true || reply.version !== 1 || !text(reply.epoch, 512)
    || !Number.isSafeInteger(reply.sequence) || reply.sequence < 0 || !Number.isSafeInteger(reply.observedAt) || reply.observedAt < 0
    || !Array.isArray(reply.groups) || reply.groups.length > 16) throw bad();
  const ids = new Set(); let count = 0;
  const groups = reply.groups.map((/** @type {Value} */ group) => {
    if (!group || typeof group !== 'object' || Array.isArray(group) || !text(group.id, 8192) || ids.has(group.id)
      || !['ready', 'refreshing', 'unavailable'].includes(group.status)) throw bad();
    ids.add(group.id);
    for (const field of ['total', 'active', 'waiting', 'unknown']) if (!Number.isSafeInteger(group[field]) || group[field] < 0 || group[field] > 1000000) throw bad();
    if (group.active + group.unknown > group.total || group.waiting + group.unknown > group.total) throw bad();
    if (group.sessions !== undefined && !Array.isArray(group.sessions)) throw bad();
    const rows = group.sessions?.map((/** @type {Value} */ row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row) || !text(row.id, 8192) || ['known', 'active', 'waiting'].some(field => typeof row[field] !== 'boolean')
        || !row.known && (row.active || row.waiting) || ++count > 64) throw bad();
      return { id: row.id, known: row.known, active: row.active, waiting: row.waiting };
    });
    return { id: group.id, total: group.total, active: group.active, waiting: group.waiting, unknown: group.unknown,
      status: group.status, observedAt: reply.observedAt, ...(rows ? { sessions: rows } : {}) };
  });
  return { ok: true, version: 1, epoch: reply.epoch, sequence: reply.sequence, observedAt: reply.observedAt, groups };
}

/** Sealed HTTP projection only: no native reads, histories or command replay.
 * Each approved device/client gets independent routing and delta state. */
export class NativeActivityTransport {
  /** @param {{poll:(request:Value)=>Value,machineId:()=>string|null,now?:()=>number,ttlMs?:number,maxClients?:number}} options */
  constructor(options) {
    this.options = options; this.now = options.now ?? Date.now; this.ttlMs = options.ttlMs ?? 300000; this.maxClients = options.maxClients ?? 64;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1 || this.ttlMs > 600000 || !Number.isSafeInteger(this.maxClients) || this.maxClients < 1 || this.maxClients > 256) throw bad();
    /** @type {Map<string,Value>} */ this.clients = new Map();
  }
  /** @param {string} device @param {unknown} input @returns {Value} */
  request(device, input) {
    if (!text(device, 256) || !input || typeof input !== 'object' || Array.isArray(input) || !isSafePlainJson(input)) throw bad();
    const body = /** @type {Value} */ (input);
    if (Object.keys(body).some(key => !KEYS.has(key)) || !text(body.clientId, 256) || !Number.isSafeInteger(body.requestSeq) || body.requestSeq < 0
      || body.activityProtocol !== undefined && body.activityProtocol !== 2 || body.since !== undefined && !text(body.since, 512)
      || body.interestToken !== undefined && !text(body.interestToken, 128)) throw bad();
    let bytes; try { bytes = Buffer.byteLength(JSON.stringify(body)); } catch { throw bad(); }
    if (bytes > 256 * 1024) throw bad();
    const client = 'peer:' + hash([device, body.clientId]), v2 = body.activityProtocol === 2, now = this.now();
    for (const [key, entry] of this.clients) if (now - entry.at >= this.ttlMs) this.clients.delete(key);
    const previous = this.clients.get(client);
    if (body.groups === undefined && (!v2 || !previous || previous.token !== body.interestToken)) {
      throw new BridgeError('stale-activity-interest', 'Resend the current bounded activity descriptors.', 409);
    }
    const groups = body.groups === undefined ? previous?.groups : body.groups;
    if (!Array.isArray(groups)) throw bad();
    // poll validates descriptors and ordering before transport state is changed.
    const reply = publicReply(this.options.poll({ clientId: client, requestSeq: body.requestSeq, groups }));
    if (!v2) return reply;
    const interest = hashCanonicalGroups(groups), sameInterest = previous?.interest === interest && previous?.epoch === reply.epoch;
    const semantic = new Map(reply.groups.map(group => { const value = /** @type {Value} */ ({ ...group }); delete value.observedAt; return [group.id, hash(value)]; }));
    const signature = hash([...semantic.entries()].sort((left, right) => compareText(left[0], right[0])));
    const delta = sameInterest && body.since === previous?.watermark;
    const unchanged = delta && signature === previous?.signature;
    const token = sameInterest ? previous.token : randomUUID();
    const watermark = unchanged ? previous.watermark : randomUUID();
    const changed = delta ? reply.groups.filter(group => previous.semantic.get(group.id) !== semantic.get(group.id)) : reply.groups;
    const removedIds = delta ? [...previous.semantic.keys()].filter(id => !semantic.has(id)) : [];
    let storedGroups;
    try { storedGroups = structuredClone(groups); } catch { throw bad(); }
    this.clients.delete(client);
    this.clients.set(client, { at: now, groups: storedGroups, interest, epoch: reply.epoch, token, watermark, semantic, signature });
    while (this.clients.size > this.maxClients) { const oldest = this.clients.keys().next().value; if (oldest === undefined) break; this.clients.delete(oldest); }
    return { ...reply, version: 2, machineId: this.options.machineId(), interestToken: token, watermark,
      baseWatermark: delta ? body.since : null, mode: unchanged ? 'unchanged' : delta ? 'delta' : 'full', groups: unchanged ? [] : changed, removedIds };
  }
  close() { this.clients.clear(); }
}
