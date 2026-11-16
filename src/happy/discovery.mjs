import { SessionStorage } from '../storage.mjs';
import { CodexBackend } from '../adapters/codex-backend.mjs';
import { CodexSavedHistoryReader } from '../adapters/codex-history.mjs';
import { AntigravityBackend } from '../adapters/antigravity-backend.mjs';
import { ClaudeDesktopBackend } from '../adapters/claude-backend.mjs';
import { ClaudeDesktopRpcClient } from '../adapters/claude-desktop-rpc.mjs';
import { discoverLocalAgents, createLocalAgentAdapter } from '../adapters/local-agent-discovery.mjs';
import { isCodeLightCodexSource, isCodeLightAntigravitySource, isCodeLightClaudeSource } from './source-scope.mjs';
import { sourceArchived } from './source-catalog-scope.mjs';
import { isAbsolute, basename } from 'node:path';

/** @typedef {Record<string,any>} Value */

/** Local discovery returns descriptions only; it never opens or starts any Agent. */
export class LocalSourceDiscovery {
  /** @param {{storage?:Pick<SessionStorage,'list'>,localWindows?:()=>Promise<Value[]>,createWindowAdapter?:(app:string)=>Value,codexBackend?:CodexBackend,antigravityBackend?:Value|false,antigravityRuntimePath?:string,claudeBackends?:Value[]|false,claudeRuntimePath?:string,allowDeferredSources?:boolean}} [options] */
  constructor(options = {}) {
    this.storage = options.storage ?? new SessionStorage(); this.windows = options.localWindows ?? (() => discoverLocalAgents());
    const nativeRoot = /** @type {Value} */ (this.storage).roots?.codex;
    this.codex = options.codexBackend ?? new CodexBackend({ savedHistoryReader: typeof nativeRoot === 'string' && isAbsolute(nativeRoot) ? new CodexSavedHistoryReader({ root: nativeRoot }) : undefined });
    this.createWindowAdapter = options.createWindowAdapter ?? createLocalAgentAdapter;
    this.antigravity = options.antigravityBackend === false ? null : options.antigravityBackend ?? new AntigravityBackend({ runtimePath: options.antigravityRuntimePath });
    this.antigravityConfigured = !!options.antigravityRuntimePath || !!process.env.CODELIGHT_ANTIGRAVITY_RUNTIME;
    const claudeRuntimePath = options.claudeRuntimePath ?? process.env.CODELIGHT_CLAUDE_DESKTOP_RUNTIME;
    this.claude = options.claudeBackends === false ? [] : options.claudeBackends ?? (claudeRuntimePath ? ['code', 'chat'].map(appMode => new ClaudeDesktopBackend({
      appMode: /** @type {'code'|'chat'} */ (appMode), rpc: new ClaudeDesktopRpcClient({ runtimePath: claudeRuntimePath }) })) : []);
    if (this.claude.some(adapter => !['code', 'chat'].includes(adapter.appMode)) || new Set(this.claude.map(adapter => adapter.appMode)).size !== this.claude.length) throw Object.assign(Error('Explicit unique Claude Desktop modes are required.'), { code: 'invalid-native-mode' });
    this.allowDeferredSources = options.allowDeferredSources === true;
    this.windowAdapters = /** @type {Map<string,Value>} */ (new Map());
  }
  async discover() {
    // 默认产品发现不触发窗口扫描；延期研究只能由内部构造参数显式启用。
    const result = await Promise.allSettled([this.storage.list('codex'), this.discoverAntigravity(), ...this.claude.map(adapter => adapter.list()), ...(this.allowDeferredSources ? [this.windows()] : [])]);
    /** @type {Value[]} */ const sources = [];
    /** @type {string[]} */ const errors = [];
    if (result[0].status === 'fulfilled' && Array.isArray(result[0].value)) for (const row of result[0].value) {
      if (sourceArchived(row, row.metadata)) continue;
      const project = row.project ?? (typeof row.workspace === 'string' && isAbsolute(row.workspace) ? { key: row.workspace, path: row.workspace, label: basename(row.workspace) || row.workspace } : undefined);
      sources.push({ ...row, ...(project ? { project } : {}), app: 'codex', hostId: 'local', kind: 'session', adapterKey: 'codex' });
    }
    else errors.push('codex-index-unavailable');
    if (result[1].status === 'fulfilled') {
      sources.push(...result[1].value);
      if (this.antigravity?.inventoryComplete === false) errors.push('antigravity-index-unavailable');
    } else errors.push('antigravity-index-unavailable');
    for (let index = 0; index < this.claude.length; index++) {
      const inventory = result[2 + index], adapter = this.claude[index];
      if (inventory.status !== 'fulfilled' || !Array.isArray(inventory.value) || inventory.value.some(source => !isCodeLightClaudeSource(source, source.metadata)
          || source.appMode !== adapter.appMode || source.hostId !== adapter.hostId())) {
        if (!errors.includes('claude-desktop-index-unavailable')) errors.push('claude-desktop-index-unavailable');
        continue;
      }
      sources.push(...inventory.value);
    }
    if (this.allowDeferredSources) {
      const windows = result[2 + this.claude.length];
      if (windows.status === 'fulfilled') sources.push(...windows.value); else errors.push('local-window-discovery-unavailable');
    }
    return { sources: sources.filter(source => !sourceArchived(source, source.metadata)), errors,
      activityInventoryApps: ['codex', ...(result[1].status === 'fulfilled' && this.antigravity?.activityInventoryComplete === true ? ['antigravity'] : [])]
        .filter(app => app !== 'codex' || result[0].status === 'fulfilled'),
      inventoryApps: this.claude.length && !errors.includes('claude-desktop-index-unavailable') ? ['claude-desktop'] : [],
      hiddenSources: Array.isArray(this.antigravity?.excludedSources) ? this.antigravity.excludedSources : [] };
  }
  async discoverAntigravity() {
    if (!this.antigravity) return [];
    try { return await this.antigravity.list({ fresh: true }); }
    catch (error) {
      // Durable historical enrichment is not current resident-index authority.
      // A successful native index can still register/read its current sessions
      // while full catalog removals remain explicitly unavailable.
      if (this.antigravity?.activityInventoryComplete === true && Array.isArray(this.antigravity.residentCatalog)) {
        this.antigravity.inventoryComplete = false;
        return structuredClone(this.antigravity.residentCatalog);
      }
      // An absent desktop is a successful empty discovery. A configured/stale
      // owner or unreadable index stays explicit and cannot erase saved sources.
      if (!this.antigravityConfigured && !this.antigravity.rpc?.latestRuntime && /** @type {Value} */ (error)?.code === 'antigravity-unavailable') return [];
      throw error;
    }
  }
  /** @param {Value} source */
  adapter(source) {
    if (isCodeLightCodexSource(source, source.metadata)) return this.codex;
    if (isCodeLightAntigravitySource(source, source.metadata) && this.antigravity) return this.antigravity;
    if (isCodeLightClaudeSource(source, source.metadata)) {
      const adapter = this.claude.find(adapter => adapter.appMode === source.appMode && adapter.hostId() === source.hostId);
      if (adapter) return adapter;
      throw Object.assign(Error('This Claude collection has no configured matching original owner.'), { code: 'unsupported-source' });
    }
    if (!this.allowDeferredSources) throw Object.assign(Error('Only verified native desktop session sources are supported.'), { code: 'unsupported-source' });
    let adapter = this.windowAdapters.get(source.app);
    if (!adapter) { adapter = this.createWindowAdapter(source.app); this.windowAdapters.set(source.app, adapter); }
    return adapter;
  }
  async close() { await this.codex.dispose(); await this.antigravity?.dispose?.(); await Promise.allSettled([...this.claude, ...this.windowAdapters.values()].map(adapter => adapter.dispose?.())); this.windowAdapters.clear(); }
}
