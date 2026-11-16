import { mkdir, writeFile, readFile, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { NativeHappyConnector } from './native-connector.mjs';
import { HappySessionTransport } from './session-transport.mjs';
import { CommandReceipts } from '../commands.mjs';
import { sourceKey } from './source-registry.mjs';
import { BridgeError } from '../errors.mjs';

/** @typedef {Record<string,any>} Value */
const lockfile = createRequire(import.meta.url)('proper-lockfile');

/** Wraps only screenshot files already produced by the bound native adapter. */
export class SourceImageAdapter {
  get supportsNativeHistoryPaging() { return this.adapter.supportsNativeHistoryPaging === true; }
  get supportsNativeModelSettings() { return this.adapter.supportsNativeModelSettings === true; }
  get supportsSourceCommands() { return this.adapter.supportsSourceCommands === true; }
  get supportsNativeSavedHistory() { return this.adapter.supportsNativeSavedHistory === true; }
  get supportsDataOnlyHistoryPaging() { return this.source?.app === 'claude-desktop' && typeof this.adapter.historyPage === 'function'; }
  get supportedActions() { return this.adapter.supportedActions; }
  get taskSnapshot() {
    return this.source?.app === 'claude-desktop' && typeof this.adapter.taskSnapshot === 'function'
      ? (/** @type {string} */ id, /** @type {Value} */ context = {}) => this.readTaskData('taskSnapshot', id, context) : undefined;
  }
  get taskLogPage() {
    return this.source?.app === 'claude-desktop' && typeof this.adapter.taskLogPage === 'function'
      ? (/** @type {string} */ id, /** @type {Value} */ context = {}) => this.readTaskData('taskLogPage', id, context) : undefined;
  }
  get getTaskOutput() {
    return this.source?.app === 'claude-desktop' && typeof this.adapter.getTaskOutput === 'function'
      ? (/** @type {string} */ id, /** @type {string} */ taskId, /** @type {Value} */ context) => this.taskOperation('getTaskOutput', id, taskId, context) : undefined;
  }
  get stopTask() {
    return this.source?.app === 'claude-desktop' && typeof this.adapter.stopTask === 'function'
      ? (/** @type {string} */ id, /** @type {string} */ taskId, /** @type {string} */ commandId, /** @type {Value} */ context) => this.taskOperation('stopTask', id, taskId, context, commandId) : undefined;
  }
  /** @param {Value} adapter @param {HappySessionTransport} transport @param {Value} [source] */
  constructor(adapter, transport, source) { this.adapter = adapter; this.transport = transport; this.source = source; this.latest = /** @type {Value|null} */ (null); this.image = /** @type {{digest:string,ref:string}|null} */ (null); }
  context() { return ['antigravity', 'claude-desktop'].includes(this.source?.app) ? { expectedHostId: this.source?.hostId } : undefined; }
  scopedHost() { return ['antigravity', 'claude-desktop'].includes(this.source?.app); }
  /** Selected task data never replaces the live transcript/control view.
   * @param {'taskSnapshot'|'taskLogPage'} method @param {string} id @param {Value} context */
  async readTaskData(method, id, context) {
    if (this.source?.app !== 'claude-desktop' || id !== this.source.id || typeof this.adapter[method] !== 'function') throw new BridgeError('unsupported-action', 'The selected original task reader is unavailable.');
    const main = this.generation(), owner = this.generation(id);
    const assertOwner = () => {
      if (!main || !owner || this.generation() !== main || this.generation(id) !== owner
        || context.expectedGeneration !== undefined && context.expectedGeneration !== owner
        || context.scope && context.scope.runtimeGeneration !== main) throw new BridgeError('source-epoch-changed', 'The bound original task owner changed.');
    };
    assertOwner();
    const result = await this.adapter[method](id, { ...context, ...this.context() });
    assertOwner(); return result;
  }
  /** Exact original session/collection for task output and single-task mutations.
   * @param {'getTaskOutput'|'stopTask'} method @param {string} id @param {string} taskId
   * @param {Value} context @param {string} [commandId] */
  async taskOperation(method, id, taskId, context, commandId) {
    const source = this.source;
    if (source?.app !== 'claude-desktop' || id !== source.id || typeof this.adapter[method] !== 'function') throw new BridgeError('unsupported-action', 'The selected original task operation is unavailable.');
    const main = this.generation(), owner = this.generation(id);
    const assertOwner = () => {
      if (!main || !owner || this.generation() !== main || this.generation(id) !== owner || this.adapter.hostId?.() !== source.hostId
        || !context?.scope || context.scope.runtimeGeneration !== main || context.scope.ownerGeneration !== owner
        || context.scope.parentConversationId !== id || context.scope.hostId !== source.hostId
        || context.scope.nativeCollection !== source.nativeCollection) throw new BridgeError('source-epoch-changed', 'The bound original task owner changed.');
    };
    assertOwner();
    const fixed = { ...context, ...this.context() };
    const result = method === 'stopTask' ? await this.adapter.stopTask(id, taskId, commandId, fixed) : await this.adapter.getTaskOutput(id, taskId, fixed);
    try { assertOwner(); } catch (error) {
      if (method === 'stopTask') throw new BridgeError('delivery-unknown', 'The original task owner changed after the stop; no replay is allowed.');
      throw error;
    }
    return result;
  }
  /** @param {Value} saved @param {string} id */
  terminalSaved(saved, id) {
    const proof = saved?.historicalRead, lifecycle = proof?.lastLifecycle;
    return saved?.status === 'history-only' && saved.ownerGeneration === null && saved.currentTurnId === null && proof?.app === 'codex'
      && proof.available === true && proof.originator === 'Codex Desktop' && proof.nativeId === id && proof.hostId === this.source?.hostId
      && proof.trailingIncomplete === false && lifecycle?.terminalObserved === true && ['task_complete', 'turn_aborted'].includes(lifecycle.type)
      && typeof lifecycle.turnId === 'string' && lifecycle.turnId.length > 0;
  }
  /** @param {Value} frame */
  async transform(frame) {
    if (this.scopedHost() && this.adapter.hostId?.() !== this.source?.hostId) throw new BridgeError('source-epoch-changed', 'This native view belongs to another instance.');
    const raw = frame.native ?? frame;
    const view = raw.kind === 'window' ? { ...raw, bounds: raw.bounds ?? raw.captureStamp?.bounds ?? raw.physicalBounds ?? raw.logicalBounds } : raw;
    this.latest = view;
    if (view.kind !== 'window' || !view.imagePath || !view.captureStamp) return frame.native ? { ...frame, native: view } : view;
    const folder = await realpath(this.adapter.screenshotDir), path = await realpath(view.imagePath), rel = relative(folder, path);
    if (!rel || isAbsolute(rel) || rel.startsWith('..') || !/^window-[a-f0-9-]{36}\.png$/u.test(rel)) throw new BridgeError('invalid-window-image', 'The screenshot is outside this source adapter.');
    const size = (await stat(path)).size; if (size > 16 * 1024 * 1024) throw new BridgeError('image-too-large', 'The source screenshot exceeds its size bound.');
    const bytes = await readFile(path);
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new BridgeError('invalid-window-image', 'The source screenshot is not a PNG.');
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (this.image?.digest !== digest) { const result = await this.transport.uploadAttachment(bytes, { filename: 'desktop-window.png' }); this.image = { digest, ref: result.ref }; }
    const mapped = { ...view, imagePath: undefined, imageRef: this.image.ref, bounds: view.bounds ?? view.captureStamp.bounds ?? view.physicalBounds ?? view.logicalBounds };
    return frame.native ? { ...frame, native: mapped } : mapped;
  }
  /** Fallback remains a verified saved-data read, never a child control owner.
   * @param {string} id @param {boolean} fresh */
  async readNativeView(id, fresh) {
    if (!fresh && this.source?.app === 'codex' && this.source.isSubagent === true && this.supportsNativeSavedHistory && this.adapter.generation?.(id) == null) {
      try {
        const saved = await this.adapter.readHistoricalPage(id);
        if (this.terminalSaved(saved, id)) return this.transform(saved);
      } catch { /* Unknown/nonterminal sources must still use the live owner path. */ }
    }
    if (fresh && this.latest?.historicalRead?.available === true && this.supportsNativeSavedHistory && this.adapter.generation?.(id) == null) {
      const saved = await this.adapter.readHistoricalPage(id);
      if (this.terminalSaved(saved, id)) return this.transform(saved);
    }
    try {
      const view = fresh ? await this.adapter.freshSnapshot(id, this.context()) : await this.adapter.snapshot(id, this.context());
      return this.transform(view);
    } catch (error) {
      if (this.source?.app !== 'codex' || !this.supportsNativeSavedHistory || !['codex-owner-unavailable', 'codex-discovery-timeout', 'codex-snapshot-timeout', 'codex-unavailable'].includes(/** @type {Value} */ (error).code)) throw error;
      try { return await this.transform(await this.adapter.readHistoricalPage(id)); }
      catch { throw error; }
    }
  }
  /** @param {string} id */ async snapshot(id) { return this.readNativeView(id, false); }
  /** @param {string} id */ async freshSnapshot(id) {
    if (typeof this.adapter.freshSnapshot !== 'function') throw new BridgeError('fresh-snapshot-unavailable', 'The original adapter cannot confirm a fresh snapshot.');
    return this.readNativeView(id, true);
  }
  /** @param {string} id @param {Value} [historyBoundary] */ async completeSnapshot(id, historyBoundary) {
    if (typeof this.adapter.completeSnapshot !== 'function') throw new BridgeError('history-unavailable', 'The original adapter cannot load earlier saved history.');
    return this.transform(await this.adapter.completeSnapshot(id, { ...this.context(), ...(historyBoundary ? { historyBoundary } : {}) }));
  }
  /** @param {string} id @param {Value} boundary */
  readMaterializedHistory(id, boundary) { return this.adapter.readMaterializedHistory?.(id, boundary, this.context()) ?? null; }
  /** @param {string} id @param {Value} [boundary] */
  readHistoricalPage(id, boundary) { return this.adapter.readHistoricalPage?.(id, boundary) ?? null; }
  /** Older pages are returned as data without updating the current control view.
   * @param {string} id @param {Value} boundary */
  async readDataHistoryPage(id, boundary) {
    if (!this.supportsDataOnlyHistoryPaging) throw new BridgeError('history-unavailable', 'This original owner has no data-only history reader.');
    const page = await this.adapter.historyPage(id, { ...this.context(), historyBoundary: boundary });
    if (this.scopedHost() && this.adapter.hostId?.() !== this.source?.hostId) throw new BridgeError('source-epoch-changed', 'The original history namespace changed.');
    return page;
  }
  /** @param {string} id @param {(frame:Value)=>void} callback */
  async subscribe(id, callback) {
    if (this.source?.app === 'codex' && this.latest?.historicalRead?.available === true && this.supportsNativeSavedHistory && this.adapter.generation?.(id) == null) {
      const saved = await this.adapter.readHistoricalPage(id);
      if (this.terminalSaved(saved, id)) {
        this.latest = saved; callback(structuredClone(saved));
        return () => { this.adapter.releaseHistoricalSource?.(id); };
      }
    }
    let closed = false, running = false;
    /** @type {Value|null} */ let pending = null;
    const pump = async () => {
      if (running) return; running = true;
      try {
        while (pending && !closed) { const current = pending; pending = null;
          try { const mapped = await this.transform(current); if (!closed) callback(mapped); }
          catch { if (!closed) callback(this.source?.kind === 'session' ? { status: 'owner-unavailable', rows: [], requests: [], currentTurnId: null, ownerGeneration: null } : { kind: 'window', status: 'disconnected', rows: [], controls: [], imageRef: null, captureStamp: null }); }
        }
      } finally { running = false; }
    };
    const release = await this.adapter.subscribe(id, (/** @type {Value} */ frame) => { pending = frame; pump().catch(() => {}); }, this.context());
    return () => { closed = true; pending = null; release(); };
  }
  /** @param {string} id @param {string} action @param {Value} payload @param {string} commandId @param {Value} [context] */
  command(id, action, payload, commandId, context) { return this.adapter.command(id, action, payload, commandId, { ...context, ...this.context() }); }
  /** @param {string} [id] */
  generation(id) {
    if (this.scopedHost() && this.adapter.hostId?.() !== this.source?.hostId) return null;
    if (typeof this.adapter.generation === 'function') return this.adapter.generation(id);
    if (this.adapter.ipc) { const owner = this.adapter.ipc.owners.get(id); return owner ? `${owner.hostId}:${owner.ownerClientId}` : null; }
    const view = this.latest;
    return view?.captureStamp ? JSON.stringify([view.captureStamp.runtimeGeneration, view.captureStamp.windowGeneration]) : null;
  }
}

/** Factory never starts a model. A source lease is held before any explicit desktop navigation.
 * @param {{account:Value,binding:Value,directory:string,leaseDirectory:string,adapter:Value,assertHostLease?:()=>boolean}} options */
export async function createBoundSource(options) {
  const hash = sourceKey(options.binding.source); await mkdir(options.directory, { recursive: true, mode: 0o700 }); await mkdir(options.leaseDirectory, { recursive: true, mode: 0o700 });
  const marker = join(options.leaseDirectory, `${hash}.source`);
  await writeFile(marker, '', { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  let ownsLease = true;
  const releaseLease = await lockfile.lock(marker, { realpath: false, stale: 10000, update: 2000, retries: 0, onCompromised: () => { ownsLease = false; } });
  let closed = false, retiring = false, activeOperations = 0;
  /** @type {Promise<void>|null} */ let closeFlight = null;
  /** @type {Promise<boolean>|null} */ let idleCloseFlight = null;
  const binding = options.binding, key = new Uint8Array(Buffer.from(binding.sessionKey, 'base64'));
  const transport = new HappySessionTransport({ serverOrigin: options.account.serverUrl, token: options.account.token, sessionId: binding.happySessionId,
    encryptionKey: key, statePath: join(options.directory, 'transport.json'), initialMetadata: binding.metadata });
  const adapter = new SourceImageAdapter(options.adapter, transport, { ...options.binding.source,
    isSubagent: options.binding.metadata?.nativeSession?.isSubagent === true,
    parentId: options.binding.metadata?.nativeSession?.parentId ?? null });
  let connector;
  try {
    connector = new NativeHappyConnector({ transport, adapter, nativeId: binding.source.id, sourceIdentity: binding.source, bindingId: `codelight:${binding.happySessionId}`,
      metadata: binding.metadata, encryptionKey: key, statePath: join(options.directory, 'projection.json'), receipts: await CommandReceipts.load(join(options.directory, 'receipts.json')),
      getGeneration: () => adapter.generation(binding.source.id), assertLease: () => ownsLease && !closed && (options.assertHostLease?.() ?? true), supportsNativeProjection: true,
      recentRowLimit: ['codex', 'antigravity'].includes(binding.source.app) ? 100 : undefined,
      publishInitialHistory: !['codex', 'antigravity'].includes(binding.source.app) });
  } catch (error) { await transport.close(); await releaseLease(); throw error; }
  const close = () => {
    if (!closeFlight) {
      closed = true; retiring = true; ownsLease = false;
      closeFlight = (async () => {
        try { await connector.close(); }
        finally {
          await transport.updateMetadata(current => {
            const value = /** @type {Value} */ (current ?? {});
            // 断开只关闭原生动作；回执是非侵入源的协议语义，不能让旧未确认消息变成“已接收”。
            return { ...value, bridge: { ...value.bridge, sourceStatus: 'disconnected' }, capabilities: { ...value.capabilities, abort: false, steering: false, messageReceipts: true, rpcMethods: [] } };
          }).catch(() => {});
          await transport.close(); await releaseLease().catch(() => {});
        }
      })();
    }
    return closeFlight;
  };
  return {
    transport, connector,
    supportsDesktopNavigation: !Array.isArray(options.adapter.supportedActions) || options.adapter.supportedActions.includes('open-desktop'),
    /** @param {string} commandId */
    async openDesktop(commandId) {
      if (!ownsLease || closed || retiring || options.assertHostLease?.() === false) throw new BridgeError('source-lease-unavailable', 'This source lease is unavailable.');
      activeOperations++;
      try {
        if (binding.source.app === 'codex' || binding.source.app === 'antigravity') return await options.adapter.command(binding.source.id, 'open-desktop', {}, commandId);
        const frame = await options.adapter.snapshot(binding.source.id);
        if (!ownsLease || closed || retiring || options.assertHostLease?.() === false) throw new BridgeError('source-lease-unavailable', 'This source lease is unavailable.');
        if (!frame.captureStamp) throw new BridgeError('source-unavailable', 'The original window is unavailable.');
        return await options.adapter.command(binding.source.id, 'activate', { captureStamp: frame.captureStamp, windowGeneration: frame.captureStamp.windowGeneration }, commandId);
      } finally { activeOperations--; }
    },
    start: () => closed || retiring ? Promise.reject(new BridgeError('source-unavailable', 'The CodeLight observer is closing.')) : connector.start(), status: () => connector.status(),
    /** @returns {Promise<boolean>} */
    tryCloseIfIdle() {
      if (closeFlight) return closeFlight.then(() => true);
      if (idleCloseFlight) return idleCloseFlight;
      retiring = true;
      if (activeOperations) { retiring = false; return Promise.resolve(false); }
      const flight = connector.tryCloseIfIdle().then(async retired => {
        if (!retired && !closed) { retiring = false; return false; }
        await close(); return true;
      }).finally(() => { if (idleCloseFlight === flight) idleCloseFlight = null; });
      idleCloseFlight = flight; return flight;
    },
    close,
  };
}
