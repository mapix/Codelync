import { SessionStorage } from '../storage.mjs';
import { CodexBackend } from '../adapters/codex-backend.mjs';
import { CodexSavedHistoryReader } from '../adapters/codex-history.mjs';
import { AntigravityBackend } from '../adapters/antigravity-backend.mjs';
import { ClaudeDesktopBackend } from '../adapters/claude-backend.mjs';
import { ClaudeDesktopRpcClient } from '../adapters/claude-desktop-rpc.mjs';
import { discoverLocalAgents, createLocalAgentAdapter } from '../adapters/local-agent-discovery.mjs';
import { isCodelyncCodexSource, isCodelyncAntigravitySource, isCodelyncClaudeSource } from './source-scope.mjs';
import { sourceArchived } from './source-catalog-scope.mjs';
import { DESKTOP_SOURCE_APPS } from './source-subscriptions.mjs';
import { BridgeError } from '../errors.mjs';
import { isAbsolute, basename } from 'node:path';

/** @typedef {Record<string,any>} Value */
/** @typedef {{isEnabled:(app:string)=>boolean,readonly revision:number}} Subscriptions */
/** @typedef {{sources:Value[],errors:string[],inventoryApps:string[],activityInventoryApps:string[],hiddenSources:Value[],enabledApps:string[],stale?:boolean}} DiscoveryResult */

/** Local discovery returns descriptions only; it never opens or starts any Agent. */
export class LocalSourceDiscovery {
  /** @param {{storage?:Pick<SessionStorage,'list'>,localWindows?:()=>Promise<Value[]>,createWindowAdapter?:(app:string)=>Value,codexBackend?:CodexBackend,codexBackendFactory?:()=>Value,antigravityBackend?:Value|false,antigravityBackendFactory?:()=>Value|null,antigravityRuntimePath?:string,claudeBackends?:Value[]|false,claudeBackendsFactory?:()=>Value[],claudeRuntimePath?:string,allowDeferredSources?:boolean,sourceSubscriptions?:Subscriptions}} [options] */
  constructor(options = {}) {
    this.storage = options.storage ?? new SessionStorage(); this.windows = options.localWindows ?? (() => discoverLocalAgents());
    this.sourceSubscriptions = options.sourceSubscriptions; this.closed = false;
    const nativeRoot = /** @type {Value} */ (this.storage).roots?.codex;
    this.codexFactory = options.codexBackendFactory ?? (() => options.codexBackend ?? new CodexBackend({
      savedHistoryReader: typeof nativeRoot === 'string' && isAbsolute(nativeRoot) ? new CodexSavedHistoryReader({ root: nativeRoot }) : undefined }));
    this.antigravityFactory = options.antigravityBackendFactory ?? (() => options.antigravityBackend === false ? null : options.antigravityBackend ?? new AntigravityBackend({ runtimePath: options.antigravityRuntimePath }));
    this.antigravityConfigured = !!options.antigravityRuntimePath || !!process.env.CODELYNC_ANTIGRAVITY_RUNTIME;
    const claudeRuntimePath = options.claudeRuntimePath ?? process.env.CODELYNC_CLAUDE_DESKTOP_RUNTIME;
    this.claudeFactory = options.claudeBackendsFactory ?? (() => options.claudeBackends === false ? [] : options.claudeBackends ?? (claudeRuntimePath ? ['code', 'chat'].map(appMode => new ClaudeDesktopBackend({
      appMode: /** @type {'code'|'chat'} */ (appMode), rpc: new ClaudeDesktopRpcClient({ runtimePath: claudeRuntimePath }) })) : []));
    if (Array.isArray(options.claudeBackends)) this.validateClaudeModes(options.claudeBackends);
    /** @type {Value|null} */ this.codex = null;
    /** @type {Value|null} */ this.antigravity = null;
    /** @type {Value[]} */ this.claude = [];
    this.claudeInitialized = false;
    this.createWindowAdapter = options.createWindowAdapter ?? createLocalAgentAdapter;
    this.allowDeferredSources = options.allowDeferredSources === true;
    this.windowAdapters = /** @type {Map<string,Value>} */ (new Map());
    this.pendingProviderDisposals = /** @type {Set<Value>} */ (new Set());
  }
  /** @param {string} app */
  sourceEnabled(app) { return !this.closed && DESKTOP_SOURCE_APPS.includes(app) && (this.sourceSubscriptions?.isEnabled(app) ?? true); }
  revision() { return this.sourceSubscriptions?.revision ?? 0; }
  /** @param {Value[]} adapters */
  validateClaudeModes(adapters) {
    if (adapters.some(adapter => !['code', 'chat'].includes(adapter.appMode)) || new Set(adapters.map(adapter => adapter.appMode)).size !== adapters.length) throw Object.assign(Error('Explicit unique Claude Desktop modes are required.'), { code: 'invalid-native-mode' });
  }
  /** Factories create only Codelync clients, never original apps/runners. @param {string} app */
  ensureProvider(app) {
    if (!this.sourceEnabled(app)) throw new BridgeError('source-disabled', 'This desktop source is disabled in Codelync.', 503);
    if (app === 'codex') {
      this.codex ??= this.codexFactory();
      if (this.codex?.disposed === true) throw new BridgeError('source-unavailable', 'The Codelync source adapter must be recreated.', 503);
      return this.codex;
    }
    if (app === 'antigravity') {
      this.antigravity ??= this.antigravityFactory();
      if (this.antigravity?.disposed === true) throw new BridgeError('source-unavailable', 'The Codelync source adapter must be recreated.', 503);
      return this.antigravity;
    }
    if (!this.claudeInitialized) {
      const adapters = this.claudeFactory(); this.validateClaudeModes(adapters); this.claude = adapters; this.claudeInitialized = true;
    }
    if (this.claude.some(adapter => adapter.disposed === true)) throw new BridgeError('source-unavailable', 'The Codelync source adapter must be recreated.', 503);
    return this.claude;
  }
  /** Consumers are fenced/closed by the daemon before disposing these clients. */
  async reconcileSubscriptions() {
    if (!this.sourceEnabled('codex') && this.codex) { this.pendingProviderDisposals.add(this.codex); this.codex = null; }
    if (!this.sourceEnabled('antigravity') && this.antigravity) { this.pendingProviderDisposals.add(this.antigravity); this.antigravity = null; }
    if (!this.sourceEnabled('claude-desktop') && this.claudeInitialized) {
      const backends = this.claude; this.claude = []; this.claudeInitialized = false;
      for (const backend of backends) this.pendingProviderDisposals.add(backend);
    }
    const results = await Promise.allSettled([...this.pendingProviderDisposals].map(async backend => {
      await backend.dispose?.(); this.pendingProviderDisposals.delete(backend);
    }));
    if (results.some(result => result.status === 'rejected')) throw new BridgeError('source-subscriptions-apply-pending', 'The source choices are saved but switching is not complete.', 503);
  }
  /** @returns {Promise<DiscoveryResult>} */
  async discover() {
    if (this.closed) throw new BridgeError('source-unavailable', 'Codelync discovery is closed.', 503);
    const revision = this.revision(), enabledApps = DESKTOP_SOURCE_APPS.filter(app => this.sourceEnabled(app));
    /** @type {{app:string,read:Promise<any>}[]} */ const jobs = [];
    if (enabledApps.includes('codex')) jobs.push({ app: 'codex', read: Promise.resolve().then(() => { this.ensureProvider('codex'); return this.storage.list('codex'); }) });
    if (enabledApps.includes('antigravity')) jobs.push({ app: 'antigravity', read: Promise.resolve().then(() => this.discoverAntigravity()) });
    if (enabledApps.includes('claude-desktop')) jobs.push({ app: 'claude-desktop', read: Promise.resolve().then(async () => {
      const adapters = /** @type {Value[]} */ (this.ensureProvider('claude-desktop'));
      return { adapters, results: await Promise.allSettled(adapters.map(adapter => adapter.list())) };
    }) });
    if (this.allowDeferredSources) jobs.push({ app: 'windows', read: this.windows() });
    const results = await Promise.allSettled(jobs.map(job => job.read));
    if (this.closed || revision !== this.revision()) return { sources: [], errors: [], inventoryApps: [], activityInventoryApps: [], hiddenSources: [], enabledApps: DESKTOP_SOURCE_APPS.filter(app => this.sourceEnabled(app)), stale: true };
    /** @type {Value[]} */ const sources = [];
    /** @type {string[]} */ const errors = [];
    const inventoryApps = /** @type {Set<string>} */ (new Set()), activityInventoryApps = /** @type {Set<string>} */ (new Set());
    for (const [index, job] of jobs.entries()) {
      const result = results[index];
      if (result.status !== 'fulfilled') { errors.push(job.app === 'windows' ? 'local-window-discovery-unavailable' : `${job.app}-index-unavailable`); continue; }
      if (job.app === 'codex') {
        if (!Array.isArray(result.value)) { errors.push('codex-index-unavailable'); continue; }
        inventoryApps.add('codex'); activityInventoryApps.add('codex');
        for (const row of result.value) {
          if (sourceArchived(row, row.metadata)) continue;
          const project = row.project ?? (typeof row.workspace === 'string' && isAbsolute(row.workspace) ? { key: row.workspace, path: row.workspace, label: basename(row.workspace) || row.workspace } : undefined);
          sources.push({ ...row, ...(project ? { project } : {}), app: 'codex', hostId: 'local', kind: 'session', adapterKey: 'codex' });
        }
      } else if (job.app === 'antigravity') {
        if (!Array.isArray(result.value)) { errors.push('antigravity-index-unavailable'); continue; }
        sources.push(...result.value);
        if (this.antigravity) {
          if (this.antigravity.inventoryComplete === false) errors.push('antigravity-index-unavailable'); else inventoryApps.add('antigravity');
          if (this.antigravity.activityInventoryComplete === true) activityInventoryApps.add('antigravity');
        }
      } else if (job.app === 'claude-desktop') {
        const adapters = /** @type {Value[]} */ (result.value.adapters), inventories = /** @type {PromiseSettledResult<Value[]>[]} */ (result.value.results);
        let complete = adapters.length > 0;
        for (const [modeIndex, adapter] of adapters.entries()) {
          const inventory = inventories[modeIndex];
          if (inventory.status !== 'fulfilled' || !Array.isArray(inventory.value) || inventory.value.some(source => !isCodelyncClaudeSource(source, source.metadata)
              || source.appMode !== adapter.appMode || source.hostId !== adapter.hostId())) { complete = false; if (!errors.includes('claude-desktop-index-unavailable')) errors.push('claude-desktop-index-unavailable'); continue; }
          sources.push(...inventory.value);
        }
        if (complete) { inventoryApps.add('claude-desktop'); activityInventoryApps.add('claude-desktop'); }
      } else if (Array.isArray(result.value)) sources.push(...result.value);
      else errors.push('local-window-discovery-unavailable');
    }
    return { sources: sources.filter(source => this.sourceEnabled(source.app) || this.allowDeferredSources && !DESKTOP_SOURCE_APPS.includes(source.app)).filter(source => !sourceArchived(source, source.metadata)), errors,
      inventoryApps: [...inventoryApps], activityInventoryApps: [...activityInventoryApps], enabledApps,
      hiddenSources: this.sourceEnabled('antigravity') && Array.isArray(this.antigravity?.excludedSources) ? this.antigravity.excludedSources : [] };
  }
  async discoverAntigravity() {
    this.ensureProvider('antigravity');
    if (!this.antigravity) return [];
    try { return await this.antigravity.list({ fresh: true }); }
    catch (error) {
      if (this.antigravity.activityInventoryComplete === true && Array.isArray(this.antigravity.residentCatalog)) {
        this.antigravity.inventoryComplete = false; return structuredClone(this.antigravity.residentCatalog);
      }
      if (!this.antigravityConfigured && !this.antigravity.rpc?.latestRuntime && /** @type {Value} */ (error)?.code === 'antigravity-unavailable') return [];
      throw error;
    }
  }
  /** @param {Value} source */
  adapter(source) {
    if (DESKTOP_SOURCE_APPS.includes(source.app)) this.ensureProvider(source.app);
    if (isCodelyncCodexSource(source, source.metadata) && this.codex) return this.codex;
    if (isCodelyncAntigravitySource(source, source.metadata) && this.antigravity) return this.antigravity;
    if (isCodelyncClaudeSource(source, source.metadata)) {
      const adapter = this.claude.find(adapter => adapter.appMode === source.appMode && adapter.hostId() === source.hostId);
      if (adapter) return adapter;
      throw Object.assign(Error('This Claude collection has no configured matching original owner.'), { code: 'unsupported-source' });
    }
    if (!this.allowDeferredSources || this.closed) throw Object.assign(Error('Only verified native desktop session sources are supported.'), { code: 'unsupported-source' });
    let adapter = this.windowAdapters.get(source.app);
    if (!adapter) { adapter = this.createWindowAdapter(source.app); this.windowAdapters.set(source.app, adapter); }
    return adapter;
  }
  async close() {
    if (this.closed) return; this.closed = true;
    try { await this.reconcileSubscriptions(); }
    finally { await Promise.allSettled([...this.windowAdapters.values()].map(adapter => adapter.dispose?.())); this.windowAdapters.clear(); }
  }
}
