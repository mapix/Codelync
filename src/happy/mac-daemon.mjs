import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SourceRegistry, sourceKey } from './source-registry.mjs';
import { CodeLightMachineConnection } from './machine-presence.mjs';
import { createBoundSource } from './bound-source.mjs';
import { CommandReceipts } from '../commands.mjs';
import { writeDurablePrivateJson, readOptionalPrivateJson } from './discovery-persistence.mjs';
import { BridgeError } from '../errors.mjs';
import { isCodeLightNativeSource } from './source-scope.mjs';
import { sourceArchived, sourceCatalogVisible } from './source-catalog-scope.mjs';
import { NativeProjectActivityService } from './project-activity.mjs';
import { DESKTOP_SOURCE_APPS } from './source-subscriptions.mjs';

/** @typedef {Record<string,any>} Value */
/** @typedef {{directory:string,leaseDirectory?:string,account:Value,discovery:{discover:()=>Promise<{sources:Value[],errors?:string[],hiddenSources?:Value[],inventoryApps?:string[],activityInventoryApps?:string[],stale?:boolean}>,adapter:(source:Value)=>Value,close?:()=>Promise<void>|void,reconcileSubscriptions?:()=>Promise<void>},sourceSubscriptions?:{isEnabled:(app:string)=>boolean,readonly revision:number,appRevision?:(app:string)=>number,snapshot?:()=>{known:boolean}},registry?:Value,machineConnection?:(options:Value)=>Value,sourceFactory?:(options:Value)=>Promise<Value>,activityFactory?:(options:Value)=>Value,onRpc?:(method:string)=>void,viewedSessions?:()=>Set<string>,scanMs?:number,only?:(source:Value)=>boolean,maxActiveSources?:number,observeBackground?:boolean,activityBackgroundSources?:number,activityRefreshMs?:number,actorIdleMs?:number,now?:()=>number}} Options */
const lockfile = createRequire(import.meta.url)('proper-lockfile');

/** One process owns a profile; sources activate lazily and keep their original runtime owner. */
export class CodeLightMacDaemon extends EventEmitter {
  /** @type {Map<string,{source:Value,binding:Value}>} */ sources = new Map();
  /** @type {Map<string,Value>} */ actors = new Map();
  /** @type {Map<string,Promise<Value>>} */ activating = new Map();
  /** @type {Promise<Value>|null} */ scanFlight = null;
  /** @type {Value|null} */ machine = null;
  /** @type {Value|null} */ connection = null;
  /** @type {CommandReceipts|null} */ receipts = null;
  /** @type {(()=>Promise<void>)|null} */ releaseLease = null;
  /** @type {ReturnType<typeof setInterval>|null} */ timer = null;
  /** @type {Map<string,Promise<Value>>} */ preparing = new Map();
  /** @type {Map<string,Promise<void>>} */ starts = new Map();
  /** @type {Map<string,number>} */ latestSelection = new Map();
  activeSave = Promise.resolve();
  /** @type {Set<string>} */ restored = new Set();
  /** @type {Value|null} */ activity = null;
  inventoryAvailable = false;
  registrationAvailable = false;
  inventoryApps = new Set();
  activityInventoryApps = new Set();
  activityInventoryAvailable = false;
  cacheReconciledApps = new Set();
  /** @type {Map<string,number>} */ sourceUses = new Map();
  /** @type {Map<string,number>} */ lastUsed = new Map();
  /** @type {Set<string>} */ archivedKeys = new Set();
  capacityTail = Promise.resolve();
  /** @type {Map<string,Value>} */ pendingDisabledBindings = new Map();
  /** @type {Map<string,{actor:Value,flight:Promise<void>}>} */ sourceClosures = new Map();
  /** @type {WeakMap<Value,number>} */ actorRevisions = new WeakMap();
  subscriptionTail = Promise.resolve();
  lastEnabledApps = new Set(DESKTOP_SOURCE_APPS);
  /** @param {Options} options */
  constructor(options) {
    super(); this.options = options; this.directory = resolve(options.directory); this.leaseDirectory = resolve(options.leaseDirectory ?? join(this.directory, 'leases'));
    this.registry = options.registry ?? new SourceRegistry({ directory: join(this.directory, 'sources'), account: options.account });
    this.sourceFactory = options.sourceFactory ?? createBoundSource;
    this.now = options.now ?? Date.now; this.actorIdleMs = options.actorIdleMs ?? 300000;
    if (!Number.isSafeInteger(this.actorIdleMs) || this.actorIdleMs < 1000 || this.actorIdleMs > 3600000) throw new BridgeError('invalid-actor-idle-limit', 'The idle observer retention must fit its time bound.');
    this.closed = false; this.ownsLease = false;
    this.lastEnabledApps = new Set(DESKTOP_SOURCE_APPS.filter(app => this.sourceEnabled({ app })));
  }
  async start() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 }); const marker = join(this.directory, 'daemon.source');
    await writeFile(marker, '', { mode: 0o600, flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    this.releaseLease = await lockfile.lock(marker, { realpath: false, stale: 10000, update: 2000, retries: 0, onCompromised: () => { this.ownsLease = false; this.maintainActivity(); this.emit('diagnostic', { code: 'daemon-lease-lost' }); } }); this.ownsLease = true;
    try {
      this.receipts = await CommandReceipts.load(join(this.directory, 'machine-receipts.json'));
      this.machine = await this.registry.machine();
      this.activity = (this.options.activityFactory ?? (options => new NativeProjectActivityService(/** @type {any} */ (options))))({
        sources: () => [...this.sources.values()].filter(({ source }) => this.sourceEnabled(source)).map(({ source, binding }) => ({ ...source, relayId: binding.happySessionId, controlMode: binding.metadata?.bridge?.controlMode,
          available: sourceCatalogVisible(source, binding.metadata) })),
        inventoryAvailable: (/** @type {string|undefined} */ app) => (app ? this.sourceEnabled({ app }) && this.activityInventoryApps.has(app) : this.activityInventoryAvailable) && !this.closed && this.ownsLease,
        ownedAvailable: () => !this.closed && this.ownsLease,
        observedSources: () => [...this.actors.keys()].sort((a, b) => (this.lastUsed.get(b) ?? 0) - (this.lastUsed.get(a) ?? 0))
          .map(key => this.sources.get(key)?.source).filter(source => !!source && this.sourceEnabled(source)),
        backgroundSources: this.options.activityBackgroundSources ?? 16, intrinsicRefreshMs: this.options.activityRefreshMs,
        now: this.now,
        nativeAdapter: (/** @type {Value} */ source) => this.options.discovery.adapter(source),
      });
      const saved = await readOptionalPrivateJson(join(this.directory, 'active-sources.json'));
      this.restored = new Set(Array.isArray(saved?.keys) ? saved.keys.filter((/** @type {unknown} */ key) => typeof key === 'string' && /^[a-f0-9]{64}$/u.test(key)) : []);
      await this.pruneDisabledRestored();
      if (this.options.observeBackground === false) {
        const required = new Set();
        for (const key of this.restored) {
          const transport = await readOptionalPrivateJson(join(this.directory, 'active', key, 'transport.json'));
          // 原 inbox 只在 native execute 后 ACK；保留未处理输入/待发镜像，不能为省观察成本丢已接受工作。
          if (transport?.inbox?.length || transport?.outbox?.length) required.add(key);
        }
        this.restored = required;
      }
      const machine = /** @type {Value} */ (this.machine);
      this.connection = (this.options.machineConnection ?? (options => new CodeLightMachineConnection(/** @type {any} */ (options))))({ serverUrl: this.options.account.serverUrl, token: this.options.account.token,
        machineId: machine.id, accountSecret: new Uint8Array(Buffer.from(this.options.account.secret, 'base64url')), metadata: machine.metadata, metadataVersion: machine.record?.metadataVersion ?? 0, onRpc: this.options.onRpc });
      this.connection.registerRpc('codelight-open-source', (/** @type {unknown} */ params) => this.openSource(params));
      this.connection.registerRpc('codelight-select-source', (/** @type {unknown} */ params) => this.selectSource(params));
      this.connection.registerRpc('codelight-observe-source', (/** @type {unknown} */ params) => this.observeSource(params));
      this.connection.registerRpc('codelight-receipt', (/** @type {unknown} */ params) => this.receipt(params));
      this.connection.registerRpc('codelight-close-source', (/** @type {unknown} */ params) => this.closeSource(params));
      this.connection.registerRpc('codelight-project-activity', (/** @type {Value} */ params) => {
        if (this.closed || !this.ownsLease) throw new BridgeError('source-unavailable', 'Project activity is unavailable.');
        return this.activity?.poll(params);
      });
      await this.connection.waitForConnect(); await this.restoreRegisteredSources(); await this.scan();
      this.timer = setInterval(() => { this.scan().catch(() => this.emit('diagnostic', { code: 'discovery-scan-pending' })); }, this.options.scanMs ?? 20000); this.timer.unref();
      this.emit('ready', this.status()); return this.status();
    } catch (error) { await this.close(); throw error; }
  }
  status() { return { service: 'CodeLight', running: !this.closed && this.ownsLease, machineId: this.machine?.id ?? null, sources: this.sources.size, activeSources: this.actors.size, modelRunnersStarted: 0 }; }
  /** @param {Value|undefined} source */
  sourceEnabled(source) { return !!source && DESKTOP_SOURCE_APPS.includes(source.app) && (this.options.sourceSubscriptions?.isEnabled(source.app) ?? true); }
  sourceConfigurationKnown() { return this.options.sourceSubscriptions?.snapshot?.().known !== false; }
  subscriptionRevision() { return this.options.sourceSubscriptions?.revision ?? 0; }
  /** @param {Value} source */
  sourceRevision(source) { return this.options.sourceSubscriptions?.appRevision?.(source.app) ?? this.subscriptionRevision(); }
  /** @param {Value} source @param {number} revision */
  sourceCurrent(source, revision) { return !this.closed && this.ownsLease && this.sourceEnabled(source) && this.sourceRevision(source) === revision; }
  async pruneDisabledRestored() {
    let changed = false;
    for (const key of this.restored) {
      const binding = this.sources.get(key)?.binding ?? await readOptionalPrivateJson(join(this.directory, 'sources', `${key}.json`)).catch(() => null);
      if (binding?.source && isCodeLightNativeSource(binding.source, binding.metadata) && !this.sourceEnabled(binding.source)) { this.restored.delete(key); changed = true; }
    }
    if (changed) await this.saveRestored();
  }
  /** Immediate admission and catalog fence; never stops an original session. */
  fenceSourceSubscriptions() {
    const enabled = DESKTOP_SOURCE_APPS.filter(app => this.sourceEnabled({ app }));
    if (!this.sourceConfigurationKnown() || enabled.some(app => !this.lastEnabledApps.has(app))) this.registrationAvailable = false;
    else if (!enabled.length) this.registrationAvailable = true;
    this.lastEnabledApps = new Set(enabled);
    for (const app of DESKTOP_SOURCE_APPS) if (!this.sourceEnabled({ app })) { this.inventoryApps.delete(app); this.activityInventoryApps.delete(app); this.cacheReconciledApps.delete(app); }
    for (const [key, entry] of this.sources) if (!this.sourceEnabled(entry.source)) {
      const actor = this.actors.get(key);
      if (actor || entry.binding.metadata?.nativeSession?.sourceDisabled === true) this.pendingDisabledBindings.set(key, entry.binding);
      if (actor && !this.sourceClosures.has(key)) {
        let flight;
        try { flight = Promise.resolve(actor.close()); } catch (error) { flight = Promise.reject(error); }
        flight.catch(() => {}); this.sourceClosures.set(key, { actor, flight });
      }
      this.sources.delete(key); this.actors.delete(key); this.lastUsed.delete(key); this.restored.delete(key);
    }
    this.inventoryAvailable = this.sourceConfigurationKnown() && enabled.every(app => this.inventoryApps.has(app));
    this.activityInventoryAvailable = this.sourceConfigurationKnown() && enabled.every(app => this.activityInventoryApps.has(app));
    this.maintainActivity();
    this.emit('source-subscriptions');
  }
  /** Persisted choices are already effective before asynchronous cleanup begins. */
  reconcileSourceSubscriptions() {
    this.fenceSourceSubscriptions();
    const operation = this.subscriptionTail.catch(() => {}).then(async () => {
      const connection = this.connection;
      if (this.closed || !this.ownsLease || !connection) throw new BridgeError('source-unavailable', 'CodeLight source switching is unavailable.', 503);
      await this.pruneDisabledRestored(); await this.saveRestored();
      const failures = [];
      const bindings = new Map(this.pendingDisabledBindings);
      if (typeof this.registry.savedBindings === 'function') for (const binding of await this.registry.savedBindings()) if (binding.machineId === this.machine?.id) bindings.set(sourceKey(binding.source), binding);
      const metadataJobs = [...bindings].filter(([key, binding]) => binding.metadata?.nativeSession?.sourceDisabled === true || this.pendingDisabledBindings.has(key));
      const updateBinding = async (/** @type {[string,Value]} */ [key, binding]) => {
        const enabled = this.sourceEnabled(binding.source);
        try {
          if (connection.socket?.connected === false) throw new BridgeError('source-subscriptions-apply-pending', 'The local source metadata connection is unavailable.');
          if (enabled && binding.metadata?.nativeSession?.sourceDisabled === true && typeof this.registry.markEnabled === 'function') await this.registry.markEnabled(binding, connection.socket);
          else if (!enabled && (this.pendingDisabledBindings.has(key) || binding.metadata?.nativeSession?.sourceDisabled === true) && typeof this.registry.markDisabled === 'function') await this.registry.markDisabled(binding, connection.socket);
          this.pendingDisabledBindings.delete(key);
        } catch { failures.push('metadata'); this.pendingDisabledBindings.set(key, binding); }
      };
      for (let offset = 0; offset < metadataJobs.length; offset += 4) await Promise.all(metadataJobs.slice(offset, offset + 4).map(updateBinding));
      await this.restoreRegisteredSources(); this.emit('source-subscriptions');
      for (const [key, closing] of this.sourceClosures) {
        try { await closing.flight; this.sourceClosures.delete(key); }
        catch { failures.push('observer'); closing.flight = Promise.resolve().then(() => closing.actor.close()); closing.flight.catch(() => {}); }
      }
      await this.scanFlight?.catch(() => {});
      try { await this.options.discovery.reconcileSubscriptions?.(); } catch { failures.push('provider'); }
      await this.scan(); this.emit('source-subscriptions');
      if (failures.length) throw new BridgeError('source-subscriptions-apply-pending', 'The source choices are saved but switching is not complete.', 503);
      return this.status();
    });
    this.subscriptionTail = operation.then(() => {}, () => {}); return operation;
  }
  maintainActivity() {
    try { this.activity?.intrinsicRefresh?.(); }
    catch { this.emit('diagnostic', { code: 'activity-maintenance-pending' }); }
  }
  /** Read current same-source facts only; no history or refresh on retirement. @param {string} key */
  sourceIsBusy(key) {
    try {
      const value = this.activity?.cachedSourceStatus?.(this.sources.get(key)?.source);
      return value?.sameSource === true && value.known === true && (value.active === true || value.waiting === true);
    } catch { return false; }
  }
  /** Account-bound saved registrations are data, not native activity/removal proof. */
  async restoreRegisteredSources() {
    this.registrationAvailable = false;
    if (this.closed || !this.ownsLease || typeof this.machine?.id !== 'string' || !this.machine.id || !this.connection || typeof this.registry.savedBindings !== 'function') return;
    const revision = this.subscriptionRevision(), bindings = await this.registry.savedBindings();
    if (revision !== this.subscriptionRevision()) return;
    if (!Array.isArray(bindings) || this.closed || !this.ownsLease || typeof this.machine?.id !== 'string' || !this.machine.id || !this.connection) throw new BridgeError('source-unavailable', 'The registered native source map is unavailable.', 503);
    for (const binding of bindings) {
      const source = binding?.source, metadata = binding?.metadata ?? {};
      if (!source || !this.sourceEnabled(source) || binding.machineId !== this.machine.id || !isCodeLightNativeSource(source, metadata)
        || !sourceCatalogVisible(source, metadata) || this.options.only && !this.options.only(source)) continue;
      const native = metadata.nativeSession ?? {};
      const restored = { ...source, title: native.title || metadata.summary?.text || source.app, updatedAt: native.updatedAt ?? 0,
        workspace: metadata.path ?? '', parentId: native.parentId ?? null, agentName: native.agentName ?? '', isSubagent: native.isSubagent === true,
        ...(native.projectKey && native.projectPath ? { project: { key: native.projectKey, path: native.projectPath, label: native.projectLabel ?? '' } } : {}) };
      this.sources.set(sourceKey(source), { source: restored, binding });
    }
    this.registrationAvailable = true;
  }
  scan() {
    if (this.scanFlight) return this.scanFlight;
    this.scanFlight = this.scanOnce().finally(() => { this.scanFlight = null; }); return this.scanFlight;
  }
  async scanOnce() {
    if (this.closed || !this.ownsLease || !this.machine || !this.connection) throw new BridgeError('source-unavailable', 'The CodeLight daemon is unavailable.');
    const connection = this.connection, revision = this.subscriptionRevision();
    let found;
    try { found = await this.options.discovery.discover(); }
    catch (error) { if (revision !== this.subscriptionRevision() || this.closed) return this.status(); this.activityInventoryApps.clear(); this.activityInventoryAvailable = false; this.maintainActivity(); throw error; }
    if (revision !== this.subscriptionRevision() || found.stale || this.closed || !this.ownsLease) return this.status();
    this.inventoryApps = new Set((found.inventoryApps ?? ['codex', 'antigravity']).filter(app => this.sourceEnabled({ app }) && !(found.errors ?? []).includes(`${app}-index-unavailable`)));
    const required = this.options.sourceSubscriptions ? DESKTOP_SOURCE_APPS.filter(app => this.sourceEnabled({ app })) : ['codex', 'antigravity'];
    this.inventoryAvailable = this.sourceConfigurationKnown() && required.every(app => this.inventoryApps.has(app))
      && !(found.errors ?? []).some(error => error.endsWith('-index-unavailable'));
    this.activityInventoryApps = new Set([...this.inventoryApps, ...(found.activityInventoryApps ?? [])].filter(app => this.sourceEnabled({ app })));
    this.activityInventoryAvailable = this.sourceConfigurationKnown() && required.every(app => this.activityInventoryApps.has(app));
    const seen = new Set();
    for (const error of found.errors ?? []) this.emit('diagnostic', { code: error });
    const hidden = (found.hiddenSources ?? []).filter(source => this.sourceEnabled(source) && isCodeLightNativeSource(source) && sourceArchived(source, source.metadata));
    const hiddenKeys = new Set(hidden.map(source => sourceKey(source)));
    for (const key of this.archivedKeys) if (!hiddenKeys.has(key)) this.archivedKeys.delete(key);
    for (const source of hidden) {
      if (revision !== this.subscriptionRevision() || !this.sourceEnabled(source)) return this.status();
      const key = sourceKey(source);
      const binding = this.sources.get(key)?.binding ?? (typeof this.registry.existingBinding === 'function' ? await this.registry.existingBinding(source, this.machine.id) : null);
      if (revision !== this.subscriptionRevision() || !this.sourceEnabled(source)) return this.status();
      if (binding && typeof this.registry.markArchived === 'function') {
        try { await this.registry.markArchived(binding, connection.socket, source); }
        catch { this.emit('diagnostic', { code: 'source-archive-update-pending' }); continue; }
      }
      this.sources.delete(key); this.archivedKeys.add(key);
      const actor = this.actors.get(key);
      if (actor && typeof actor.tryCloseIfIdle === 'function' && await actor.tryCloseIfIdle()) {
        this.actors.delete(key); this.lastUsed.delete(key); this.restored.delete(key); await this.saveRestored();
      }
    }
    for (const source of found.sources) {
      if (revision !== this.subscriptionRevision() || this.closed) return this.status();
      if (!this.sourceEnabled(source) || !isCodeLightNativeSource(source) || sourceArchived(source, source.metadata) || hiddenKeys.has(sourceKey(source)) || this.options.only && !this.options.only(source)) continue;
      const key = sourceKey(source); const previous = this.sources.get(key);
      seen.add(key);
      if (previous) {
        previous.source = source;
        if (typeof this.registry.refreshMetadata === 'function' && this.connection?.socket) await this.registry.refreshMetadata(previous.binding, source, this.connection.socket).catch(() => this.emit('diagnostic', { code: 'source-metadata-pending' }));
        continue;
      }
      try {
        const binding = await this.registry.register(source, this.machine.id);
        if (revision !== this.subscriptionRevision() || !this.sourceEnabled(source) || this.closed) {
          if (!this.sourceEnabled(source) && typeof this.registry.markDisabled === 'function') {
            try { await this.registry.markDisabled(binding, connection.socket); } catch { this.pendingDisabledBindings.set(key, binding); }
          }
          return this.status();
        }
        if (typeof this.registry.refreshMetadata === 'function' && this.connection?.socket) await this.registry.refreshMetadata(binding, source, this.connection.socket);
        if (revision !== this.subscriptionRevision() || !this.sourceEnabled(source) || this.closed) {
          if (!this.sourceEnabled(source) && typeof this.registry.markDisabled === 'function') {
            try { await this.registry.markDisabled(binding, connection.socket); } catch { this.pendingDisabledBindings.set(key, binding); }
          }
          return this.status();
        }
        this.sources.set(key, { source, binding });
      }
      catch { this.emit('diagnostic', { code: 'source-registration-pending', sourceKey: key }); }
    }
    // 完整索引才有删除证据；读取失败不能把缓存目录全标成已移除。
    if (this.inventoryApps.size) {
      const unreconciled = new Set([...this.inventoryApps].filter(app => !this.cacheReconciledApps.has(app)));
      if (unreconciled.size && typeof this.registry.savedBindings === 'function' && typeof this.registry.markUnavailable === 'function') {
        const failedApps = new Set();
        for (const binding of await this.registry.savedBindings()) {
          if (revision !== this.subscriptionRevision() || this.closed) return this.status();
          const key = sourceKey(binding.source);
          // Restored descriptors are reconciled by the normal source loop below.
          if (!this.sourceEnabled(binding.source) || binding.machineId !== this.machine.id || !unreconciled.has(binding.source.app) || seen.has(key) || this.sources.has(key)) continue;
          try { await this.registry.markUnavailable(binding, connection.socket); }
          catch { failedApps.add(binding.source.app); this.emit('diagnostic', { code: 'source-catalogue-update-pending' }); }
        }
        for (const app of unreconciled) if (!failedApps.has(app)) this.cacheReconciledApps.add(app);
      }
      for (const [key, entry] of this.sources) if (this.inventoryApps.has(entry.source.app) && !seen.has(key)) {
        if (revision !== this.subscriptionRevision() || this.closed || !this.sourceEnabled(entry.source)) return this.status();
        if (typeof this.registry.markUnavailable === 'function') await this.registry.markUnavailable(entry.binding, connection.socket).catch(() => this.emit('diagnostic', { code: 'source-catalogue-update-pending' }));
        this.sources.delete(key);
      }
    }
    if (revision !== this.subscriptionRevision() || this.closed) return this.status();
    for (const key of this.restored) if (this.sourceEnabled(this.sources.get(key)?.source) && this.sources.has(key) && !this.actors.has(key)) {
      // 当前发行只恢复原生 Codex observer；旧 desktop-open、unknown 或模型命令不会重放。
      this.activate(key, null).catch(() => this.emit('diagnostic', { code: 'source-observation-pending', sourceKey: key }));
    }
    for (const key of this.restored) if (!this.sources.has(key)) {
      const binding = await readOptionalPrivateJson(join(this.directory, 'sources', `${key}.json`));
      if (!binding?.happySessionId || binding.serverUrl !== this.options.account.serverUrl || binding.machineId !== this.machine.id ||
        !this.sourceEnabled(binding.source) || !isCodeLightNativeSource(binding.source, binding.metadata) || !sourceCatalogVisible(binding.source, binding.metadata) || hiddenKeys.has(key) ||
        this.inventoryApps.has(binding.source?.app) && !seen.has(key) || sourceKey(binding.source) !== key) continue;
      const source = { ...binding.source, kind: binding.metadata?.bridge?.controlMode === 'window' ? 'window' : 'session' };
      this.sources.set(key, { source, binding }); this.activate(key, null).catch(() => this.emit('diagnostic', { code: 'source-observation-pending', sourceKey: key }));
    }
    if (this.options.observeBackground === false) await this.retireUnviewed();
    this.maintainActivity();
    return this.status();
  }
  async retireUnviewed() {
    const viewed = this.options.viewedSessions?.() ?? new Set();
    for (const [key, actor] of this.actors) {
      if (viewed.has(this.sources.get(key)?.binding.happySessionId) || this.sourceUses.has(key) || this.activating.has(key)
        || this.preparing.has(key) || this.starts.has(key) || this.now() - (this.lastUsed.get(key) ?? this.now()) < this.actorIdleMs
        || typeof actor.tryCloseIfIdle !== 'function') continue;
      if (this.sourceIsBusy(key)) continue;
      if (!await actor.tryCloseIfIdle()) continue;
      this.actors.delete(key); this.lastUsed.delete(key); this.restored.delete(key);
      await this.saveRestored();
    }
  }
  /** @param {unknown} params */
  async openSource(params) {
    const value = validateParams(params, true), entry = this.sources.get(value.sourceKey);
    if (!entry || !this.sourceEnabled(entry.source) || this.closed || !this.ownsLease) throw new BridgeError('source-unavailable', 'This source has not been discovered by the current CodeLight Mac.');
    const revision = this.sourceRevision(entry.source);
    if (entry.source.available === false && entry.source.kind === 'window') throw new BridgeError('source-unavailable', 'The original application/window is not available.');
    const receipt = await this.useSource(value.sourceKey, () => /** @type {CommandReceipts} */ (this.receipts).run(`codelight-machine:${this.machine?.id}`, value.commandId,
      { sourceKey: value.sourceKey, action: 'open-source' }, () => {
        if (!this.sourceCurrent(entry.source, revision)) throw new BridgeError('source-unavailable', 'The desktop source choice changed.');
        return this.activate(value.sourceKey, value.commandId);
      }));
    return { ok: true, receipt };
  }
  /** @param {unknown} params */
  receipt(params) { const value = validateParams(params, false); return { ok: true, receipt: this.receipts?.query(`codelight-machine:${this.machine?.id}`, value.commandId) ?? null }; }
  /** A fresh phone tap navigates immediately; initial snapshot hydration is asynchronous. @param {unknown} params */
  async selectSource(params) {
    const value = validateParams(params, true), input = /** @type {Value} */ (params);
    if (typeof input.selectionClient !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/u.test(input.selectionClient) || !Number.isSafeInteger(input.selectionSeq) || input.selectionSeq < 1) throw new BridgeError('invalid-selection', 'A stable phone selection order is required.');
    const latest = this.latestSelection.get(input.selectionClient) ?? 0;
    if (input.selectionSeq > latest) this.latestSelection.set(input.selectionClient, input.selectionSeq);
    const entry = this.sources.get(value.sourceKey), revision = entry ? this.sourceRevision(entry.source) : -1;
    const receipt = await this.useSource(value.sourceKey, () => /** @type {CommandReceipts} */ (this.receipts).run(`codelight-machine:${this.machine?.id}`, value.commandId,
      { sourceKey: value.sourceKey, action: 'select-source', selectionClient: input.selectionClient, selectionSeq: input.selectionSeq }, () => this.useSource(value.sourceKey, async () => {
        if (!entry || !this.sourceCurrent(entry.source, revision)) throw new BridgeError('source-unavailable', 'The desktop source choice changed.');
        if (this.latestSelection.get(input.selectionClient) !== input.selectionSeq) throw new BridgeError('selection-superseded', 'A newer phone selection superseded this request.');
        const actor = await this.prepareSource(value.sourceKey);
        if (!this.sourceCurrent(entry.source, revision)) throw new BridgeError('source-unavailable', 'The desktop source choice changed.');
        if (this.latestSelection.get(input.selectionClient) !== input.selectionSeq) throw new BridgeError('selection-superseded', 'A newer phone selection superseded this request.');
        this.restored.add(value.sourceKey); await this.saveRestored();
        if (!this.sourceCurrent(entry.source, revision)) throw new BridgeError('source-unavailable', 'The desktop source choice changed.');
        if (this.latestSelection.get(input.selectionClient) !== input.selectionSeq) throw new BridgeError('selection-superseded', 'A newer phone selection superseded this request.');
        void this.startSource(value.sourceKey, actor).catch(() => this.emit('diagnostic', { code: 'source-observation-pending' }));
        const desktopSwitchRequested = actor.supportsDesktopNavigation !== false;
        if (desktopSwitchRequested) await actor.openDesktop(value.commandId);
        return { sourceKey: value.sourceKey, desktopSwitchRequested, syncStarting: true };
      })));
    return { ok: true, receipt };
  }
  /** Foreground reconciliation resumes observation without desktop navigation. @param {unknown} params */
  async observeSource(params) {
    const value = validateParams(params, true);
    const entry = this.sources.get(value.sourceKey), revision = entry ? this.sourceRevision(entry.source) : -1;
    const receipt = await this.useSource(value.sourceKey, () => /** @type {CommandReceipts} */ (this.receipts).run(`codelight-machine:${this.machine?.id}`, value.commandId,
      { sourceKey: value.sourceKey, action: 'observe-source' }, () => this.useSource(value.sourceKey, async () => {
        if (!entry || !this.sourceCurrent(entry.source, revision)) throw new BridgeError('source-unavailable', 'The desktop source choice changed.');
        const actor = await this.prepareSource(value.sourceKey);
        void this.startSource(value.sourceKey, actor).catch(() => this.emit('diagnostic', { code: 'source-observation-pending' }));
        return { sourceKey: value.sourceKey, syncStarting: true };
      })));
    return { ok: true, receipt };
  }
  saveRestored() {
    const write = this.activeSave.catch(() => {}).then(() => writeDurablePrivateJson(join(this.directory, 'active-sources.json'), { version: 1, keys: [...this.restored] }));
    this.activeSave = write; return write;
  }
  /** Stops this CodeLight observer only, never the original Agent. @param {unknown} params */
  async closeSource(params) {
    const value = validateParams(params, true);
    if (!this.sources.has(value.sourceKey) || this.closed || !this.ownsLease) throw new BridgeError('source-unavailable', 'This CodeLight source is unavailable.');
    const receipt = await /** @type {CommandReceipts} */ (this.receipts).run(`codelight-machine:${this.machine?.id}`, value.commandId, { sourceKey: value.sourceKey, action: 'close-source' }, async () => {
      await Promise.allSettled([this.activating.get(value.sourceKey), this.preparing.get(value.sourceKey), this.starts.get(value.sourceKey)]);
      const actor = this.actors.get(value.sourceKey); if (actor) { await actor.close(); this.actors.delete(value.sourceKey); }
      this.starts.delete(value.sourceKey); this.restored.delete(value.sourceKey); await this.saveRestored();
      return { sourceKey: value.sourceKey, observerClosed: true, originalAgentStopped: false };
    });
    return { ok: true, receipt };
  }
  /** @param {string} key @param {string|null} commandId */
  activate(key, commandId) {
    if (this.activating.has(key)) return /** @type {Promise<Value>} */ (this.activating.get(key));
    const flight = this.useSource(key, () => this.activateOnce(key, commandId)).finally(() => this.activating.delete(key)); this.activating.set(key, flight); return flight;
  }
  /** Source-scoped navigation pin; machine receipt serialization is not a source-use signal.
   * @param {string} key @param {()=>Promise<Value>} operation */
  useSource(key, operation) {
    const entry = this.sources.get(key), revision = entry ? this.sourceRevision(entry.source) : -1;
    if (!entry || !this.sourceCurrent(entry.source, revision)) return Promise.reject(new BridgeError('source-unavailable', 'The desktop source is unavailable.'));
    this.sourceUses.set(key, (this.sourceUses.get(key) ?? 0) + 1);
    return Promise.resolve().then(async () => {
      if (!this.sourceCurrent(entry.source, revision)) throw new BridgeError('source-unavailable', 'The desktop source choice changed.');
      const result = await operation();
      if (!this.sourceCurrent(entry.source, revision)) throw new BridgeError('source-unavailable', 'The desktop source choice changed.');
      return result;
    }).finally(() => {
      const count = (this.sourceUses.get(key) ?? 1) - 1;
      if (count) this.sourceUses.set(key, count); else this.sourceUses.delete(key);
    });
  }
  /** @param {string} key @param {string|null} commandId */
  async activateOnce(key, commandId) {
    const entry = this.sources.get(key);
    if (!entry) throw new BridgeError('source-unavailable', 'The desktop source is unavailable.');
    const revision = this.sourceRevision(entry.source), existing = this.actors.has(key), actor = await this.prepareSource(key);
    try {
      if (!this.sourceCurrent(entry.source, revision)) throw new BridgeError('source-unavailable', 'The desktop source choice changed.');
      this.restored.add(key); await this.saveRestored();
      if (!this.sourceCurrent(entry.source, revision)) throw new BridgeError('source-unavailable', 'The desktop source choice changed.');
      if (commandId && actor.supportsDesktopNavigation !== false) await actor.openDesktop(commandId);
      await this.startSource(key, actor); return { sourceKey: key, happySessionId: entry.binding.happySessionId, sourceStatus: actor.status().sourceStatus };
    } catch (error) { if (!existing && this.actors.get(key) === actor) { this.actors.delete(key); await actor.close(); } throw error; }
  }
  /** @param {string} key @returns {Promise<Value>} */
  prepareSource(key) {
    const entry = this.sources.get(key);
    if (!entry || !this.sourceEnabled(entry.source) || !isCodeLightNativeSource(entry.source, entry.binding.metadata) || this.closed || !this.ownsLease) return Promise.reject(new BridgeError('source-unavailable', 'This source is unavailable.'));
    const revision = this.sourceRevision(entry.source), actor = this.actors.get(key);
    if (actor && (this.actorRevisions.get(actor) ?? revision) === revision) { this.lastUsed.set(key, this.now()); return Promise.resolve(actor); }
    const pending = this.preparing.get(key); if (pending) return pending;
    // 旧实现保留每次成功启动的 actor，第17次切换就永久撞容量；单飞预留并回收无用户/操作占用的旧 observer。
    const flight = this.capacityTail.then(async () => {
      if (!this.sourceCurrent(entry.source, revision)) throw new BridgeError('source-unavailable', 'This source is unavailable.');
      const stale = this.actors.get(key);
      if (stale && (this.actorRevisions.get(stale) ?? revision) !== revision) { await stale.close(); if (this.actors.get(key) === stale) this.actors.delete(key); }
      await this.makeRoom();
      if (!this.sourceCurrent(entry.source, revision)) throw new BridgeError('source-unavailable', 'This source is unavailable.');
      const created = await this.sourceFactory({ account: this.options.account, binding: entry.binding, directory: join(this.directory, 'active', key), leaseDirectory: this.leaseDirectory,
        adapter: this.options.discovery.adapter(entry.source), assertHostLease: () => this.sourceCurrent(entry.source, revision) });
      if (!this.sourceCurrent(entry.source, revision)) { await created.close(); throw new BridgeError('source-unavailable', 'This source is unavailable.'); }
      created.connector?.on('notification-observation', (/** @type {Value} */ summary) => this.emit('notification-observation', { sourceKey: key, sessionId: entry.binding.happySessionId, summary }));
      created.connector?.on('rpc-observation', (/** @type {Value} */ value) => { try { this.options.onRpc?.(value.method); } catch { /* Metrics never affect native admission. */ } });
      this.actorRevisions.set(created, revision); this.actors.set(key, created); this.lastUsed.set(key, this.now()); this.maintainActivity(); return created;
    }).finally(() => { if (this.preparing.get(key) === flight) this.preparing.delete(key); });
    this.capacityTail = flight.then(() => {}, () => {});
    this.preparing.set(key, flight); return flight;
  }
  async makeRoom() {
    if (this.actors.size < (this.options.maxActiveSources ?? 16)) return;
    const candidates = [...this.actors].filter(([key, actor]) => {
      const binding = this.sources.get(key)?.binding;
      return !!binding && !this.sourceUses.has(key) && !this.activating.has(key) && !this.preparing.has(key) && !this.starts.has(key)
        && !this.options.viewedSessions?.().has(binding.happySessionId) && typeof actor.tryCloseIfIdle === 'function';
    }).map(([key, actor]) => ({ key, actor, busy: this.sourceIsBusy(key) }))
      .sort((a, b) => Number(a.busy) - Number(b.busy) || (this.lastUsed.get(a.key) ?? 0) - (this.lastUsed.get(b.key) ?? 0));
    for (const { key, actor } of candidates) {
      const binding = this.sources.get(key)?.binding;
      if (!binding || this.sourceUses.has(key) || this.activating.has(key) || this.preparing.has(key) || this.starts.has(key) ||
        this.options.viewedSessions?.().has(binding.happySessionId) || typeof actor.tryCloseIfIdle !== 'function') continue;
      if (!await actor.tryCloseIfIdle()) continue;
      if (this.actors.get(key) === actor) this.actors.delete(key);
      this.lastUsed.delete(key); this.starts.delete(key); this.restored.delete(key); await this.saveRestored();
      if (this.actors.size < (this.options.maxActiveSources ?? 16)) return;
    }
    throw new BridgeError('source-capacity', 'The current CodeLight observers are still in use.');
  }
  /** @param {string} key @param {Value} actor @returns {Promise<void>} */
  startSource(key, actor) {
    const entry = this.sources.get(key), revision = this.actorRevisions.get(actor) ?? (entry ? this.sourceRevision(entry.source) : -1);
    if (!entry || this.actors.get(key) !== actor || !this.sourceCurrent(entry.source, revision)) return Promise.reject(new BridgeError('source-unavailable', 'The desktop source is unavailable.'));
    const pending = this.starts.get(key); if (pending) return pending;
    const start = (async () => {
      this.restored.add(key); await this.saveRestored();
      if (!this.sourceCurrent(entry.source, revision) || this.actors.get(key) !== actor) throw new BridgeError('source-unavailable', 'The desktop source choice changed.');
      await actor.start();
      if (!this.sourceCurrent(entry.source, revision)) throw new BridgeError('source-unavailable', 'The desktop source changed while activating.');
    })().catch(async error => {
      this.starts.delete(key); this.restored.delete(key); await this.saveRestored();
      if (this.actors.get(key) === actor) this.actors.delete(key); await actor.close(); throw error;
    }).finally(() => { if (this.starts.get(key) === start) this.starts.delete(key); });
    this.starts.set(key, start); return start;
  }
  async close() {
    if (this.closed) return; this.closed = true; this.ownsLease = false; if (this.timer) clearInterval(this.timer); this.connection?.close();
    await this.activity?.close();
    await Promise.allSettled([this.scanFlight, ...this.activating.values(), ...this.preparing.values(), ...this.starts.values(), this.activeSave, this.subscriptionTail, ...[...this.sourceClosures.values()].map(value => value.flight)]);
    await Promise.allSettled([...this.actors.values()].map(actor => actor.close())); this.actors.clear();
    await this.options.discovery.close?.(); await this.releaseLease?.().catch(() => {}); this.releaseLease = null;
  }
}

/** @param {unknown} params @param {boolean} needsSource @returns {{commandId:string,sourceKey:string}} */
function validateParams(params, needsSource) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new BridgeError('invalid-rpc-payload', 'A CodeLight machine request is required.');
  const value = /** @type {Value} */ (params);
  if (typeof value.commandId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/u.test(value.commandId)) throw new BridgeError('invalid-command-id', 'A stable commandId is required.');
  if (needsSource && (typeof value.sourceKey !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sourceKey))) throw new BridgeError('invalid-source', 'A discovered source key is required.');
  return { commandId: value.commandId, sourceKey: value.sourceKey ?? '' };
}
