import { createHash } from 'node:crypto';
import { BridgeError } from '../errors.mjs';
import { antigravitySubagentIdentity } from './antigravity-subagents.mjs';

/** @typedef {Record<string,any>} Value */
/** @param {unknown} value @returns {value is Value} */
function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
/** @param {unknown} value */
function identity(value) { return typeof value === 'string' && !!value.trim() && value.length <= 512 && !/[\x00-\x1f]/.test(value); }
function unavailable() { return new BridgeError('antigravity-history-index-unavailable', 'The native conversation history index is unavailable.', 503); }

/** Directory identity changes independently of conversation content/recency.
 * @param {Value} summaries @param {unknown} scope */
export function antigravityCatalogueSemanticStamp(summaries, scope) {
  const rows = Object.entries(summaries).sort(([a], [b]) => a.localeCompare(b)).map(([id, value]) => {
    const metadata = value.trajectoryMetadata ?? {}, annotations = value.annotations ?? {};
    const child = antigravitySubagentIdentity({ source: value.source, trajectoryMetadata: metadata });
    return [id, value.lastModifiedTime ?? null, annotations.title || value.summary || '', annotations.archived === true,
      annotations.pinned === true || annotations.starred === true, value.workspaces ?? metadata.workspaces ?? metadata.workspaceUris ?? [],
      metadata.parentConversationId ?? null, value.forkParentConversationId ?? null, value.source ?? null,
      child.isSubagent, child.name, metadata.subagentSpec?.typeName ?? null];
  });
  return createHash('sha256').update(JSON.stringify([scope, rows])).digest('hex');
}

/** Native archive annotations and their parent relationships are directory
 * visibility evidence, never an instruction to stop the original runtime.
 * @param {Value} summaries @param {string[]} [confirmedArchived] */
export function antigravityArchivedIds(summaries, confirmedArchived = []) {
  const hidden = new Set(confirmedArchived);
  const parents = new Map(Object.entries(summaries).map(([id, value]) => {
    if (value.annotations?.archived === true) hidden.add(id);
    return [id, value.trajectoryMetadata?.parentConversationId || value.forkParentConversationId || null];
  }));
  const checked = new Set();
  for (const id of parents.keys()) {
    const path = [], seen = new Set(); let current = id;
    while (current && !hidden.has(current) && !checked.has(current) && !seen.has(current)) {
      seen.add(current); path.push(current); current = parents.get(current);
    }
    if (current && hidden.has(current)) for (const descendant of path) hidden.add(descendant);
    for (const checkedId of path) checked.add(checkedId);
  }
  return hidden;
}

/** Native history indices supply IDs; filenames and snippets are not evidence.
 * The cache contains only metadata, never conversation steps.
 */
export class AntigravityHistoryCatalog {
  /** @param {{rpc:Value,now?:()=>number,limit?:number,maxMetadataReads?:number,refreshMs?:number}} options */
  constructor(options) {
    this.rpc = options.rpc; this.now = options.now ?? Date.now;
    this.limit = options.limit ?? 1000; this.maxMetadataReads = options.maxMetadataReads ?? 128;
    this.refreshMs = options.refreshMs ?? 20000;
    if (!Number.isSafeInteger(this.limit) || this.limit < 1 || this.limit > 20000 ||
        !Number.isSafeInteger(this.maxMetadataReads) || this.maxMetadataReads < 1 || this.maxMetadataReads > 1024 ||
        !Number.isSafeInteger(this.refreshMs) || this.refreshMs < 1000) throw new BridgeError('invalid-history-budget', 'A bounded native history read budget is required.');
    /** @type {Map<string,Value>} */ this.metadata = new Map();
    /** @type {Value|null} */ this.cached = null;
    /** @type {Promise<Value>|null} */ this.flight = null;
  }

  /** @param {Value} resident @param {{generation:string,hostId:string,force?:boolean}} options @returns {Promise<Value>} */
  merge(resident, options) {
    const scope = JSON.stringify([options.hostId, options.generation]);
    if (this.flight) return this.flight.then(() => this.cached?.scope === scope ? this.combine(resident, this.cached) : this.merge(resident, options));
    const cached = this.cached;
    if (!options.force && cached?.scope === scope && this.now() - cached.at < this.refreshMs) return Promise.resolve(this.combine(resident, cached));
    const flight = this.refresh(resident, options, scope).catch(error => { this.cached = null; throw error; }).finally(() => { if (this.flight === flight) this.flight = null; });
    this.flight = flight; return flight;
  }

  /** @param {Value} resident @param {Value} cached */
  combine(resident, cached) {
    const summaries = { ...cached.summaries, ...resident };
    // A resident result can omit default-valued annotations. Current native
    // search archive flags must not disappear when that result overlays it.
    for (const id of cached.archivedIds ?? []) if (summaries[id]) summaries[id] = { ...summaries[id], annotations: { ...summaries[id].annotations, archived: true } };
    const stamp = antigravityCatalogueSemanticStamp(summaries, cached.scope);
    return { summaries, complete: cached.complete, stamp, indexedCount: cached.indexedCount, archivedIds: cached.archivedIds ?? [] };
  }

  /** @param {Value} resident @param {{generation:string,hostId:string}} options @param {string} scope */
  async refresh(resident, options, scope) {
    const replies = await Promise.all([false, true].map(archivedOnly => this.rpc.call('SearchConversations', { query: '', limit: this.limit, filters: { archivedOnly } }, { expectedGeneration: options.generation, expectedHostId: options.hostId })));
    /** @type {Map<string,Value>} */ const indexed = new Map();
    /** @type {Set<string>} */ const archivedIds = new Set();
    let complete = true;
    for (const reply of replies) {
      if (!record(reply) || reply.indexStale === true || reply.diskFull === true ||
          reply.results !== undefined && !Array.isArray(reply.results)) throw unavailable();
      const results = reply.results ?? [];
      if (results.length > this.limit) throw unavailable();
      if (results.length === this.limit) complete = false;
      for (const result of results) {
        if (!record(result) || !identity(result.cascadeId) || result.title !== undefined && typeof result.title !== 'string' ||
            result.lastModifiedTime !== undefined && typeof result.lastModifiedTime !== 'string') throw unavailable();
        if (result.archived === true) archivedIds.add(result.cascadeId);
        const previous = indexed.get(result.cascadeId);
        indexed.set(result.cascadeId, { ...previous, ...result, ...(archivedIds.has(result.cascadeId) ? { archived: true } : {}) });
      }
    }
    /** @type {Value} */ const summaries = {};
    /** @type {Value[]} */ const pending = [];
    for (const [id, result] of indexed) {
      if (archivedIds.has(id)) {
        // Exclusion evidence needs no trajectory metadata or body hydration.
        if (!resident[id]) summaries[id] = { summary: result.title ?? '', lastModifiedTime: result.lastModifiedTime, annotations: { title: result.title ?? '', archived: true } };
        continue;
      }
      if (resident[id]) continue;
      const key = JSON.stringify([options.hostId, id]), hint = JSON.stringify([result.lastModifiedTime, result.title, result.archived]);
      const saved = this.metadata.get(key);
      if (saved?.hint === hint) summaries[id] = saved.summary;
      else pending.push({ id, result, key, hint });
    }
    if (pending.length > this.maxMetadataReads) complete = false;
    for (let offset = 0; offset < Math.min(pending.length, this.maxMetadataReads); offset += 4) {
      await Promise.all(pending.slice(offset, Math.min(offset + 4, this.maxMetadataReads)).map(async candidate => {
        try {
          const reply = await this.rpc.call('GetConversationMetadata', { conversationId: candidate.id }, { expectedGeneration: options.generation, expectedHostId: options.hostId });
          if (!record(reply.metadata) || !identity(reply.trajectoryId) || reply.numSteps !== undefined && (!Number.isSafeInteger(reply.numSteps) || reply.numSteps < 0)) { complete = false; return; }
          const result = candidate.result, metadata = reply.metadata;
          const summary = { summary: result.title ?? '', trajectoryId: reply.trajectoryId, stepCount: reply.numSteps ?? 0,
            lastModifiedTime: result.lastModifiedTime, createdTime: metadata.createdAt, workspaces: metadata.workspaces,
            trajectoryMetadata: metadata, annotations: { title: result.title ?? '', archived: result.archived === true } };
          this.metadata.set(candidate.key, { hint: candidate.hint, summary }); summaries[candidate.id] = summary;
        } catch (error) {
          if (error instanceof BridgeError && error.code === 'source-epoch-changed') throw error;
          complete = false;
        }
      }));
    }
    // Never retain another instance's metadata or metadata for index-absent IDs.
    const currentKeys = new Set([...indexed.keys()].map(id => JSON.stringify([options.hostId, id])));
    for (const key of this.metadata.keys()) if (!currentKeys.has(key)) this.metadata.delete(key);
    const cached = { scope, summaries, complete, indexedCount: indexed.size - archivedIds.size, archivedIds: [...archivedIds], at: this.now() };
    this.cached = cached; return this.combine(resident, cached);
  }

  dispose() { this.metadata.clear(); this.cached = null; }
}

/** Local paging of the authenticated catalogue prefix; never an invented native
 * cursor. The caller must refresh a changed stamp before continuing.
 * @param {Value[]} sources @param {{offset?:number,limit?:number,stamp?:string}} options @param {string} stamp */
export function pageAntigravityHistory(sources, options, stamp) {
  const offset = options.offset ?? 0, limit = options.limit ?? 50;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200 || offset > 0 && options.stamp !== stamp || options.stamp !== undefined && options.stamp !== stamp) throw new BridgeError('stale-history-page', 'The native history page changed or its bounds are invalid.', 409);
  return { sources: sources.slice(offset, offset + limit), stamp, nextOffset: offset + limit < sources.length ? offset + limit : null };
}
