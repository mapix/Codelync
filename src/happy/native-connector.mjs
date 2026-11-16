/** Noninvasive single-source Happy connector. Native execution is owned by the
 * supplied original adapter and Root CommandReceipts/lease; no runners exist here.
 * Happy record/envelope conventions: slopus/happy ee5ccff79b046570dc7e62eeec90e7c8a9d7027e, MIT.
 */
import { EventEmitter } from 'node:events';
import { pendingNativeAsyncQuestions } from '../native-question-scope.mjs';
import { recentRowsPage, nativeHistoryBoundary, nativeSavedHistoryPage } from './recent-data.mjs';
import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { BridgeError } from '../errors.mjs';
import { nativeCauseCode } from '../commands.mjs';
import { encryptRecord, decryptRecord } from './session-transport.mjs';
import { archiveObserverCheckpointPayload, readArchivedObserverRows, validateObserverHistoryReferences } from './observer-history.mjs';
import { SOURCE_APPS } from './source-registry.mjs';
import { notificationSummary } from './notification-dispatcher.mjs';
import { rpcTarget, projectNativeToolInput } from '@slopus/happy-wire/codelight';
import { readNativeImage, compressNativeImage, NATIVE_PREVIEW_POLICY } from './native-image.mjs';
import { isCodeLightNativeSource } from './source-scope.mjs';
import { sourceSubagents } from '../adapters/native-subagents.mjs';
import { aggregateNativeActivity } from '../adapters/native-aggregate-activity.mjs';
import { sourceNativeTasks, sourceNativeTaskControls, nativeTaskActivity } from '../adapters/source-native-tasks.mjs';
import { NativeTaskTransfers } from './native-task-transfers.mjs';
import { nativeTaskSignal } from '@slopus/happy-wire/native-tasks';
import { nativeSettingsScope, sameNativeSettingsScope, confirmedNativeSettingsEvidence } from './native-settings-scope.mjs';

/** @typedef {Record<string, any>} Value */
/** @typedef {{snapshot:(id:string)=>Promise<Value>,freshSnapshot?:(id:string)=>Promise<Value>,completeSnapshot?:(id:string,boundary?:Value)=>Promise<Value>,readDataHistoryPage?:(id:string,boundary:Value)=>Promise<Value>,readMaterializedHistory?:(id:string,boundary:Value)=>Value|null|Promise<Value|null>,subscribe:(id:string,onView:(view:Value)=>void)=>Promise<()=>void>,command:(id:string,action:string,payload:Value,commandId:string,context?:{expectedGeneration:string|null,expectedQueryToken?:string|null})=>Promise<Value>,supportsNativeModelSettings?:boolean,supportsNativeHistoryPaging?:boolean,supportsDataOnlyHistoryPaging?:boolean}} NativeAdapter */
/** @typedef {{run:(scope:string,id:string,payload:unknown,execute:()=>Promise<unknown>)=>Promise<any>,query:(scope:string,id:string)=>any}} Receipts */
/** @typedef {{transport:any,adapter:NativeAdapter,nativeId:string,sourceIdentity:Value,bindingId:string,metadata?:Value,receipts:Receipts,statePath:string,encryptionKey:Uint8Array,getGeneration?:()=>unknown|Promise<unknown>,assertLease?:()=>unknown|Promise<unknown>,leaseRequired?:boolean,admissionTimeoutMs?:number,supportsNativeProjection?:boolean,recentRowLimit?:number,publishInitialHistory?:boolean}} ConnectorOptions */
const owners = new Set();
const BAD_SOURCE = new Set(['owner-unavailable', 'disconnected', 'locked', 'permission-required', 'unavailable', 'codex-unavailable', 'not-loaded']);
const SAFE_NATIVE_ERRORS = new Set(['stale-turn', 'stale-question', 'stale-approval', 'unsupported-action', 'unsupported-approval', 'invalid-input', 'invalid-turn', 'invalid-payload', 'invalid-response', 'invalid-answer-identity', 'approval-details-unavailable', 'permission-expansion', 'source-epoch-changed', 'source-generation-unavailable', 'source-lease-unavailable', 'source-unavailable', 'settings-conflict', 'unsupported-model-settings', 'native-settings-unavailable', 'native-model-catalog-unavailable', 'invalid-settings', 'native-read-only']);

/** @param {unknown} value @returns {value is Value} */
function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
/** @param {unknown} value @returns {string} */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
/** @param {unknown} value */
function hash(value) { return createHash('sha256').update(stable(value)).digest('hex'); }
/** @param {unknown} value @param {string} label */
function id(value, label) { if (typeof value !== 'string' || !value || value.length > 512) throw new BridgeError('invalid-connector-options', `${label} is required.`); return value; }
/** @param {unknown} value */
function commandId(value) { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/u.test(value)) throw new BridgeError('invalid-command-id', 'A stable commandId is required.'); return value; }
/** @param {Value} value */
function viewOf(value) { return object(value.native) ? value.native : value; }
/** @param {Value} view */
function available(view) { return Array.isArray(view.rows) && typeof view.status === 'string' && !BAD_SOURCE.has(view.status) && !['unknown', 'error', 'failed'].includes(view.status); }
/** @param {unknown} status */
function terminal(status) { return ['completed', 'complete', 'stop'].includes(/** @type {string} */ (status)) ? 'completed' : ['cancelled', 'canceled', 'interrupted'].includes(/** @type {string} */ (status)) ? 'cancelled' : ['failed', 'error'].includes(/** @type {string} */ (status)) ? 'failed' : null; }
/** @param {string} text */
function safePrefix(text) { const last = text.charCodeAt(text.length - 1); return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text; }

/** @param {Value} view @param {string} commandId @param {unknown} messageId */
function observedInputRow(view, commandId, messageId) {
  // 失败的本地 admission 也会留下带 caller ID 的占位输入；没有原 turn ID 就不能据此确认消息已接受。
  return (view.rows ?? []).find((/** @type {Value} */ row) => row.role === 'user' &&
    typeof row.turnId === 'string' && row.turnId.trim() &&
    !['pending', 'rejected', 'failed'].includes(row.inputStatus) &&
    (row.commandId === commandId || messageId && row.id === messageId) && !['draft', 'optimistic'].includes(row.status));
}
/** Legacy adapters omit the view field; an explicit owner must always agree.
 * @param {Value} view @param {string|null} epoch */
function viewOwnerMatches(view, epoch) { return view.ownerGeneration === undefined || view.ownerGeneration === epoch; }

export class NativeHappyConnector extends EventEmitter {
  /** @type {ConnectorOptions} */ #options;
  /** @type {Uint8Array} */ #key;
  /** @type {Value} */ #state = {};
  /** @type {Value} */ #view = { rows: [], requests: [], status: 'owner-unavailable', currentTurnId: null };
  /** @type {string|null} */ #diskText = null;
  #ioTail = Promise.resolve();
  /** @type {Promise<void>|null} */ #inputFlight = null;
  #inputDirty = false;
  /** @type {Promise<void>|null} */ #flushFlight = null;
  /** @type {Map<string,Promise<Value>>} */ #commandFlights = new Map();
  /** @type {(()=>void)|null} */ #release = null;
  /** @type {Array<()=>void>} */ #rpcReleases = [];
  #started = false;
  #closed = false;
  #ownsState = false;
  /** @type {Value|null} */ #pendingView = null;
  #pendingViewFromHistory = false;
  /** @type {Promise<void>|null} */ #projectFlight = null;
  /** @type {Promise<void>|null} */ #startFlight = null;
  #starting = false;
  /** A content checkpoint outlives its transport attachment. Metadata readiness
   * must be established again on every attachment, independently of content. */
  #attachmentMetadata = /** @type {{epoch:string|null,lease:boolean}|null} */ (null);
  #historyProjectionPrimed = false;
  #suppressedProjectionEvents = /** @type {Set<string>|null} */ (null);
  #retiring = false;
  /** @type {Promise<void>|null} */ #closeFlight = null;
  /** @type {Set<Promise<unknown>>} */ #operations = new Set();
  /** @type {Promise<void>|null} */ #attachFlight = null;
  /** @type {ReturnType<typeof setInterval>|null} */ #retryTimer = null;
  /** @type {Value} */ #metadata;
  /** @type {Value|null} */ #nativeControls = null;
  /** @type {Promise<Value>|null} */ #controlsFlight = null;
  #controlsReadAt = 0;
  /** @type {string|null} */ #controlsEpoch = null;
  #controlsRevision = 0;
  /** @type {Map<string,Promise<Value>>} */ #imageFlights = new Map();
  #taskTransfers = new NativeTaskTransfers();
  /** @type {{epoch:string,seq:number}|null} */ #taskCapture = null;
  /** Availability withdrawal can reuse the last successful native capture.
   * @type {{epoch:string,seq:number,tasks:boolean,dispatch:boolean}|null} */ #taskInvalidation = null;
  /** @type {{raw:Value,value:Value}|null} */ #latestTasks = null;

  /** @param {ConnectorOptions} options */
  constructor(options) {
    super({ captureRejections: true });
    this.#options = options;
    if (options.recentRowLimit !== undefined && (!Number.isSafeInteger(options.recentRowLimit) || options.recentRowLimit < 1 || options.recentRowLimit > 200)) throw new BridgeError('invalid-row-limit', 'The recent observation row limit is invalid.');
    this.nativeId = id(options.nativeId, 'Original native id'); this.bindingId = id(options.bindingId, 'Stable binding id');
    if (!object(options.sourceIdentity) || !SOURCE_APPS.includes(options.sourceIdentity.app) || options.sourceIdentity.id !== this.nativeId) throw new BridgeError('invalid-source-identity', 'Bind the verified original source identity, not a Happy session id.');
    if (!(options.encryptionKey instanceof Uint8Array) || options.encryptionKey.length !== 32 || !isAbsolute(options.statePath)) throw new BridgeError('invalid-connector-options', 'An owned absolute checkpoint path and 32-byte key are required.');
    this.#key = new Uint8Array(options.encryptionKey); this.statePath = resolve(options.statePath);
    this.receiptScope = `happy-native:${options.transport.sessionId}:${hash([this.bindingId, this.nativeId]).slice(0, 32)}`;
    this.#metadata = structuredClone(options.metadata ?? { path: '', host: options.sourceIdentity.hostId ?? 'local', client: { id: 'noninvasive-bridge', name: 'Existing desktop bridge', version: '1' } });
    this.on('error', () => this.emit('diagnostic', { code: 'connector-observer-error' }));
  }

  status() { return { started: this.#started, closed: this.#closed, retiring: this.#retiring, activeOperations: this.#operations.size, nativeId: this.nativeId, bindingId: this.bindingId,
    sourceStatus: this.#state.sourceStatus ?? 'owner-unavailable', currentTurnId: this.#view.currentTurnId ?? null,
    projectionStatus: this.#state.projectionStatus ?? 'unknown', commands: this.#state.commands?.length ?? 0,
    pendingEvents: this.#state.events?.filter((/** @type {Value} */ event) => !event.sent).length ?? 0 }; }

  /** Full row seeds for an authenticated selected-session read, never a new native command.
   * @param {{fresh?:boolean,cursor?:unknown,limit?:unknown}} [options] @returns {Promise<Value>} */
  async readRecent(options = {}) {
    return this.#operation(async () => {
    if (this.#closed || this.#retiring) throw new BridgeError('source-unavailable', 'The selected observer is unavailable.', 503);
    await this.start();
    if (this.#closed || this.#retiring) throw new BridgeError('source-unavailable', 'The selected observer is unavailable.', 503);
    let historyView = /** @type {Value|null} */ (null);
    let savedReadScope = /** @type {Value|null} */ (null);
    let dataPageOwner = /** @type {string|null} */ (null);
    if (options.cursor && this.#historical(this.#view)) {
      const scope = /** @type {Value} */ (structuredClone(this.#view.historicalRead)); savedReadScope = scope;
      const savedBoundary = nativeHistoryBoundary(options.cursor, this.#options.transport.sessionId).nativeSavedHistory;
      if (!object(savedBoundary) || typeof /** @type {Value} */ (this.#options.adapter).readHistoricalPage !== 'function') throw new BridgeError('invalid-history-cursor', 'This cursor does not match original saved history.');
      if (savedBoundary.sourceStamp !== scope.sourceStamp) throw new BridgeError('source-epoch-changed', 'The original saved-data view changed before this read.', 409);
      const historyLimit = options.limit == null ? 50 : Number(options.limit);
      if (!Number.isSafeInteger(historyLimit) || historyLimit < 1 || historyLimit > 100) throw new BridgeError('invalid-page-limit', 'A bounded saved-history page limit is required.');
      const saved = viewOf(await /** @type {Value} */ (this.#options.adapter).readHistoricalPage(this.nativeId, { ...savedBoundary, limit: historyLimit }));
      if (!this.#historical(saved)) throw new BridgeError('native-history-unverified', 'The saved-history read was not confirmed.', 503);
      if (!this.#historical(this.#view) || saved.historicalRead.sourceStamp !== scope.sourceStamp
        || saved.historicalRead.namespaceHash !== scope.namespaceHash || this.#view.historicalRead.sourceStamp !== scope.sourceStamp
        || this.#view.historicalRead.namespaceHash !== scope.namespaceHash) throw new BridgeError('source-epoch-changed', 'The original saved-data view changed during this read.', 409);
      historyView = saved;
    }
    const boundary = options.cursor && (this.#options.adapter.supportsNativeHistoryPaging === true || this.#options.sourceIdentity.app === 'codex')
      ? nativeHistoryBoundary(options.cursor, this.#options.transport.sessionId) : null;
    if (boundary && this.#options.sourceIdentity.app === 'codex' && !this.#historical(this.#view)
      && Object.hasOwn(boundary, 'ownerGeneration') && boundary.ownerGeneration !== await this.#epoch()) {
      throw new BridgeError('source-epoch-changed', 'The Codex history cursor belongs to another original owner.', 409);
    }
    if (boundary && !historyView && this.#options.sourceIdentity.app === 'claude-desktop' && this.#options.adapter.supportsDataOnlyHistoryPaging === true) {
      dataPageOwner = await this.#epoch();
      if (!dataPageOwner || this.#view.ownerGeneration !== dataPageOwner || boundary.ownerGeneration !== dataPageOwner) throw new BridgeError('source-epoch-changed', 'The original history cursor has no current matching owner.', 409);
      if (typeof this.#options.adapter.readDataHistoryPage !== 'function') throw new BridgeError('complete-history-unavailable', 'The original data-only history reader is unavailable.', 503);
      const earlier = await this.#options.adapter.readDataHistoryPage(this.nativeId, boundary);
      if (earlier.historyDataOnly !== true || !Array.isArray(earlier.rows) || earlier.rows.length > 500 || typeof earlier.historyComplete !== 'boolean'
        || earlier.ownerGeneration !== dataPageOwner || earlier.coverage?.found !== true) throw new BridgeError('complete-history-unconfirmed', 'The original owner did not confirm this history page.', 503);
      if (this.#closed || this.#retiring || await this.#epoch() !== dataPageOwner || this.#view.ownerGeneration !== dataPageOwner) throw new BridgeError('source-epoch-changed', 'The original owner changed during the history read.', 409);
      historyView = { rows: earlier.rows, ownerGeneration: dataPageOwner, historyComplete: earlier.historyComplete, nativeHistory: earlier.nativeHistory };
    }
    if (boundary && !historyView && this.#options.adapter.readMaterializedHistory) {
      const cached = await this.#options.adapter.readMaterializedHistory(this.nativeId, boundary);
      if (cached && typeof cached.ownerGeneration === 'string' && cached.ownerGeneration === await this.#epoch()) historyView = viewOf(cached);
    }
    // A native incomplete flag describes the unloaded prefix, not every page.
    // Codex already supplies a substantial owner window; scroll inside it must
    // not ask the original app to load its complete conversation again.
    let loadedCodexPage = false;
    if (this.#options.sourceIdentity.app === 'codex' && options.fresh === false && options.cursor && !historyView
      && !this.#historical(this.#view) && available(this.#view) && this.#view.historyComplete === false) {
      const loadedBoundary = nativeHistoryBoundary(options.cursor, this.#options.transport.sessionId);
      if (loadedBoundary.empty !== true) {
        if (!this.#view.rows.some((/** @type {Value} */ row) => row.id === loadedBoundary.id)) {
          throw new BridgeError('stale-history-cursor', 'The Codex history boundary is no longer in the confirmed native window.', 409);
        }
        loadedCodexPage = recentRowsPage(this.#options.transport.sessionId, this.#view.rows, {
          ...options, historyComplete: false, nativeStepOffset: this.#view.nativeStepOffset,
        }).rows.length > 0;
      }
    }
    if (options.fresh !== false) {
      if (typeof this.#options.adapter.freshSnapshot !== 'function') throw new BridgeError('fresh-native-unavailable', 'This observer cannot confirm a fresh original-owner view.', 503);
      const fresh = viewOf(await this.#options.adapter.freshSnapshot(this.nativeId));
      if (!available(fresh)) throw new BridgeError('source-unavailable', 'The original owner did not provide a fresh usable view.', 503);
      if (this.#closed || this.#retiring || typeof fresh.ownerGeneration === 'string' && fresh.ownerGeneration !== await this.#epoch()) throw new BridgeError('source-epoch-changed', 'The original owner changed during the recent read.', 409);
      await this.project(fresh);
    } else if (options.cursor && !historyView && !loadedCodexPage && this.#view.historyComplete === false) {
      if (typeof this.#options.adapter.completeSnapshot !== 'function') throw new BridgeError('complete-history-unavailable', 'The original observer cannot load earlier native history.', 503);
      const complete = viewOf(await this.#options.adapter.completeSnapshot(this.nativeId, boundary ?? undefined));
      const advanced = this.#options.adapter.supportsNativeHistoryPaging === true && Number.isSafeInteger(complete.nativeStepOffset)
        && Number.isSafeInteger(this.#view.nativeStepOffset) && complete.nativeStepOffset < this.#view.nativeStepOffset
        && Number.isSafeInteger(complete.nativeStepEnd) && complete.nativeStepEnd >= this.#view.nativeStepEnd;
      if (!available(complete) || complete.historyComplete !== true && !advanced) throw new BridgeError('complete-history-unconfirmed', 'The original owner has not confirmed an earlier native history boundary.', 503);
      if (this.#closed || this.#retiring || typeof complete.ownerGeneration === 'string' && complete.ownerGeneration !== await this.#epoch()) throw new BridgeError('source-epoch-changed', 'The original owner changed during the history read.', 409);
      await this.project(complete, true);
    }
    const view = this.#view;
    if (this.#closed || this.#retiring || !available(view)) throw new BridgeError('source-unavailable', 'The original native view is unavailable.', 503);
    if (typeof view.ownerGeneration === 'string' && view.ownerGeneration !== await this.#epoch()) throw new BridgeError('source-epoch-changed', 'The original owner changed during the native read.', 409);
    if (savedReadScope && (!this.#historical(this.#view) || this.#view.historicalRead.sourceStamp !== savedReadScope.sourceStamp
      || this.#view.historicalRead.namespaceHash !== savedReadScope.namespaceHash)) throw new BridgeError('source-epoch-changed', 'The saved-data projection changed before page publication.', 409);
    if (dataPageOwner && (await this.#epoch() !== dataPageOwner || view.ownerGeneration !== dataPageOwner)) throw new BridgeError('source-epoch-changed', 'The original history owner changed before page publication.', 409);
    const pageView = historyView ?? view;
    const page = this.#historical(pageView) ? nativeSavedHistoryPage(this.#options.transport.sessionId, pageView, options)
      : recentRowsPage(this.#options.transport.sessionId, pageView.rows ?? [], { ...options, ...(dataPageOwner ? { cursor: undefined } : {}), historyComplete: pageView.historyComplete, nativeStepOffset: pageView.nativeStepOffset,
        ...(['claude-desktop', 'codex'].includes(this.#options.sourceIdentity.app) ? { ownerGeneration: this.#state.epoch } : {}) });
    const rows = this.#imageRows(page.rows);
    return { ...page, rows: rows.map((/** @type {Value} */ row) => {
      const saved = this.#state.rows.find((/** @type {Value} */ item) => item.id === row.id);
      const ownInput = row.role === 'user' ? this.#state.commands.find((/** @type {Value} */ command) => command.origin === 'message'
        && command.admission?.confirmed && (row.commandId === command.id || command.result?.messageId === row.id)) : null;
      // 首屏不能再复制手机已确认的输入；原 broker/local id 把 native 行接回同一个 optimistic/echo 行。
      const inputAliases = ownInput ? [ownInput.serverId, ownInput.key?.startsWith('message:') ? ownInput.key.slice(8) : null].filter(Boolean) : [];
      const streamRevision = row.role === 'tool' ? Math.max(0, ...(row.tools ?? []).map((/** @type {Value} */ tool) => this.#state.rows.find((/** @type {Value} */ item) => item.id === `tool:${tool.id}`)?.revision ?? 0)) : saved?.revision ?? 0;
      // 首屏完整原生行替换明确的镜像片段，不能把最近50条协议增量误当作50条完整消息。
      return { ...row, tools: (row.tools ?? []).map((/** @type {Value} */ tool) => {
        if (tool.name === 'file') return tool;
        const { arguments: args, input, inputUnavailable, ...visible } = tool;
        const value = input ?? args;
        return { ...visible, ...(value !== undefined ? projectNativeToolInput(value) : inputUnavailable ? { inputUnavailable: true } : {}) };
      }), replaceIds: [...new Set([...(saved?.eventIds ?? []), ...(saved?.replacedWireIds ?? []), ...inputAliases])], projectionRevision: Math.max(1, streamRevision), streamRevision,
        snapshotRevision: this.#state.recentVersion ?? 1, ownerGeneration: this.#state.epoch };
    }), revision: view.revision ?? null, ownerGeneration: this.#state.epoch, status: view.status,
      currentTurnId: view.currentTurnId ?? null, seq: this.#options.transport.peerSnapshot?.().seq ?? 0,
      historyComplete: pageView.historyComplete ?? null, historyCoverage: this.#historical(pageView) ? 'original-saved-data' : pageView.historyComplete === true ? 'complete-native-view' : 'loaded-native-view',
      ...(this.#historical(pageView) ? { historicalRead: { ...pageView.historicalRead, readOnly: true } } : {}) };
    });
  }

  start() {
    if (!this.#startFlight) { this.#starting = true; this.#startFlight = this.#start().catch(async error => {
      this.#closed = true; this.#release?.(); this.#release = null;
      for (const release of this.#rpcReleases.splice(0)) release();
      await this.#ioTail; this.#releaseState(); throw error;
    }).finally(() => { this.#starting = false; }); }
    return this.#startFlight;
  }
  async #start() {
    if (owners.has(this.statePath)) throw new BridgeError('connector-in-use', 'This connector checkpoint already has an owner.');
    owners.add(this.statePath);
    this.#ownsState = true;
    try { await this.#load(); if (this.#closed) throw new BridgeError('connector-closed', 'The connector closed while starting.'); this.#started = true; await this.#options.transport.start(); }
    catch (error) { this.#releaseState(); throw error; }
    if (this.#closed) throw new BridgeError('connector-closed', 'The connector closed while connecting.');
    const onRecord = () => { this.processInbox().catch(() => this.emit('diagnostic', { code: 'connector-input-pending' })); };
    this.#options.transport.on('record', onRecord);
    this.#rpcReleases.push(() => this.#options.transport.removeListener('record', onRecord));
    this.#registerRpc('abort', params => this.#rpc('abort', params));
    this.#registerRpc('permission', params => this.#rpc('permission', params));
    this.#registerRpc('communication', params => this.#rpc('communication', params));
    this.#registerRpc('bridge-receipt', params => this.#receiptQuery(params));
    this.#registerRpc('open-desktop', params => this.#rpc('open-desktop', params));
    if (this.#options.adapter.supportsNativeModelSettings === true) {
      this.#registerRpc('codex-controls-read', params => this.#readControlsRpc(params));
      this.#registerRpc('codex-controls-update', params => this.#rpc('codex-controls-update', params));
    }
    if (/** @type {Value} */ (this.#options.adapter).supportsSourceCommands === true) this.#registerRpc('source-command', params => this.#rpc('source-command', params));
    this.#registerRpc('window-control', params => this.#rpc('window-control', params));
    this.#registerRpc('native-image-read', params => this.#readImage(params));
    if (typeof /** @type {Value} */ (this.#options.adapter).taskSnapshot === 'function') this.#registerRpc('native-task-read', params => this.#readTasks(params));
    if (typeof /** @type {Value} */ (this.#options.adapter).taskLogPage === 'function') this.#registerRpc('native-task-log-read', params => this.#readTaskLogs(params));
    if (typeof /** @type {Value} */ (this.#options.adapter).getTaskOutput === 'function') this.#registerRpc('native-task-output-read', params => this.#readTaskOutput(params));
    if (typeof /** @type {Value} */ (this.#options.adapter).stopTask === 'function') this.#registerRpc('native-task-stop', params => this.#rpc('native-task-stop', params));
    await this.#collectBootstrap();
    try { this.#view = viewOf(await this.#options.adapter.snapshot(this.nativeId)); }
    catch { this.#view = { rows: [], requests: [], currentTurnId: null, status: 'owner-unavailable' }; }
    await this.#seedBootstrap(this.#view);
    await this.#attachSource();
    if (this.#closed) throw new BridgeError('connector-closed', 'The connector closed while subscribing.');
    await this.project(this.#view); await this.processInbox();
    this.#retryTimer = setInterval(() => { if (!this.#closed) {
      if (this.#state.sourceStatus === 'connected') this.#options.transport.keepAlive?.(this.#foregroundActive(this.#view));
      if (!this.#release) this.#attachSource().catch(() => this.emit('diagnostic', { code: 'source-observation-unavailable' }));
      this.processInbox().catch(() => this.emit('diagnostic', { code: 'connector-publication-pending' }));
    } }, 5000);
    this.#retryTimer.unref();
  }

  /** @param {string} method @param {(params:unknown)=>Promise<Value>} handler */
  #registerRpc(method, handler) {
    this.#rpcReleases.push(this.#options.transport.registerRpc(method, (/** @type {unknown} */ params) => {
      this.emit('rpc-observation', { method });
      return this.#operation(() => handler(params));
    }));
  }
  /** @template T @param {()=>Promise<T>} execute @returns {Promise<T>} */
  #operation(execute) {
    if (this.#closed || this.#retiring) return Promise.reject(new BridgeError('source-unavailable', 'The CodeLight observer is closing.'));
    // 在 epoch 读取、计划落盘之前占用入口，避免 LRU 检查漏掉已进入但尚未 dispatch 的 RPC。
    const flight = Promise.resolve().then(() => {
      if (this.#closed || this.#retiring) throw new BridgeError('source-unavailable', 'The CodeLight observer is closing.');
      return execute();
    }).finally(() => { this.#operations.delete(flight); });
    this.#operations.add(flight); return flight;
  }

  #attachSource() {
    if (this.#attachFlight || this.#release || this.#closed) return this.#attachFlight ?? Promise.resolve();
    this.#attachmentMetadata = null;
    this.#historyProjectionPrimed = false;
    this.#attachFlight = (async () => {
      try {
        const release = await this.#options.adapter.subscribe(this.nativeId, frame => {
          if (!this.#closed) this.project(viewOf(frame)).catch(() => this.emit('diagnostic', { code: 'connector-projection-pending' }));
        });
        if (this.#closed) release(); else this.#release = release;
      } catch {
        // 原应用没有打开这个 idle 会话时，只等待它自己的 owner；不能退回第二个 runtime。
        this.#view = { rows: [], requests: [], currentTurnId: null, status: 'owner-unavailable' };
        await this.project(this.#view);
      }
    })().finally(() => { this.#attachFlight = null; });
    return this.#attachFlight;
  }

  async #load() {
    const identity = { happySessionId: this.#options.transport.sessionId, nativeId: this.nativeId, bindingId: this.bindingId,
      source: { app: this.#options.sourceIdentity.app, id: this.nativeId, hostId: this.#options.sourceIdentity.hostId }, keyFingerprint: hash(Buffer.from(this.#key).toString('base64')) };
    let stored = null;
    try { stored = await readFile(this.statePath, 'utf8'); } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error; }
    if (stored) {
      let saved;
      try { saved = JSON.parse(stored); } catch { throw new BridgeError('invalid-connector-checkpoint', 'The connector checkpoint could not be decoded.'); }
      if (saved.format !== 'happy-native-connector-v1' || stable(saved.identity) !== stable(identity)) throw new BridgeError('connector-identity-mismatch', 'The checkpoint does not match this source/Happy/key binding.');
      const bundle = Buffer.from(saved.ciphertext, 'base64');
      if (bundle.length < 29 || bundle[0] !== 0) throw new BridgeError('connector-decryption-failed', 'The connector checkpoint has an unsupported encrypted format.');
      try { const cipher = createDecipheriv('aes-256-gcm', this.#key, bundle.subarray(1, 13)); cipher.setAuthTag(bundle.subarray(-16)); this.#state = JSON.parse(Buffer.concat([cipher.update(bundle.subarray(13, -16)), cipher.final()]).toString('utf8')); }
      catch { throw new BridgeError('connector-decryption-failed', 'The connector checkpoint could not be decrypted.'); }
      if (!Array.isArray(this.#state.rows) || !Array.isArray(this.#state.events) || !Array.isArray(this.#state.commands) || !Array.isArray(this.#state.turns)) throw new BridgeError('invalid-connector-checkpoint', 'The connector checkpoint is missing required journals.');
      this.#diskText = stored;
      const restored = JSON.stringify(this.#state);
      await validateObserverHistoryReferences(this.#state, this.statePath);
      for (const command of this.#state.commands) {
        if (command.state === 'dispatching') { command.state = 'unknown'; command.error = 'connector-restarted'; }
        // Claude admits a native message before a native turn exists. Other
        // sources retain the legacy no-turn placeholder repair.
        const invalidAdmission = this.#options.sourceIdentity.app === 'claude-desktop'
          ? typeof command.admission?.messageId !== 'string' || !command.admission.messageId.startsWith('claude:') || command.admission.messageId.length <= 7 || command.admission.messageId.length > 512
          : !command.admission?.queued && (typeof command.admission?.turnId !== 'string' || !command.admission.turnId.trim());
        if (command.admission?.confirmed && invalidAdmission) {
          command.admission = null; command.resolvedByObservation = false;
        }
      }
      // A new observation attachment can refresh metadata without replacing
      // identical encrypted content. Real command recovery still becomes durable.
      if (JSON.stringify(this.#state) !== restored) await this.#save(this.#state, identity);
      return;
    }
    this.#state = { identity, revision: 0, clock: 0, rows: [], turns: [], commands: [], events: [], bootstrap: [], requestMap: [], sourceStatus: 'owner-unavailable', projectionStatus: 'ready' };
    await this.#save(this.#state, identity);
  }

  /** @param {Value} state @param {Value} [identity] */
  async #save(state, identity = state.identity) {
    let current = null; try { current = await readFile(this.statePath, 'utf8'); } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error; }
    if (current !== this.#diskText) throw new BridgeError('connector-checkpoint-conflict', 'The owned connector checkpoint changed elsewhere.');
    let plain = Buffer.from(JSON.stringify(state));
    if (this.#options.sourceIdentity.app === 'codex' && plain.length >= 8 * 1024 * 1024) {
      // 已确认镜像及离开窗口的完整前缀有独立加密历史；命令、未发事件与行别名仍由当前检查点拥有。
      if (await archiveObserverCheckpointPayload(state, this.statePath, this.#key, plain.length > 32 * 1024 * 1024 ? 0 : 4 * 1024 * 1024)) plain = Buffer.from(JSON.stringify(state));
    }
    if (plain.length > 32 * 1024 * 1024) throw new BridgeError('connector-capacity', 'The connector checkpoint reached its explicit size bound.');
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.#key, nonce), encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    const text = JSON.stringify({ format: 'happy-native-connector-v1', identity, ciphertext: Buffer.concat([Buffer.from([0]), nonce, encrypted, cipher.getAuthTag()]).toString('base64') });
    const folder = dirname(this.statePath); await mkdir(folder, { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${randomUUID()}.tmp`, handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(text); await handle.sync(); await handle.close(); await rename(temporary, this.statePath); const dir = await open(folder, 'r'); try { await dir.sync(); } finally { await dir.close(); } this.#diskText = text; }
    catch (error) { await handle.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw error; }
  }

  /** @template T @param {(state:Value)=>T} change @returns {Promise<T>} */
  #mutate(change) {
    const result = this.#ioTail.catch(() => {}).then(async () => { const state = structuredClone(this.#state), value = change(state); state.revision++; await this.#save(state); this.#state = state; return value; });
    this.#ioTail = result.then(() => {}, () => {}); return result;
  }
  /** @param {unknown} value */ #mac(value) { return createHmac('sha256', this.#key).update(stable(value)).digest('hex'); }
  async #epoch() { const value = this.#options.getGeneration ? await this.#options.getGeneration() : this.#options.sourceIdentity.runtimeGeneration; return value === null || value === undefined || value === '' ? null : typeof value === 'string' ? value : stable(value); }
  /** A staged per-message choice is not an applied desktop preference.
   * @param {Value} controls @param {string|null} epoch */
  #selectedControls(controls, epoch) {
    const staged = this.#state.nextMessageSettings;
    if (controls.model?.selectionMode !== 'next-message' || !staged || staged.epoch !== epoch || !controls.model.models?.some((/** @type {Value} */ model) => model.id === staged.model)) return controls;
    return { ...controls, model: { ...controls.model, observedCurrent: controls.model.current, current: { model: staged.model, reasoningEffort: null, modelProvider: 'antigravity' }, selectionState: 'staged' } };
  }
  async #lease() { if (this.#options.leaseRequired === false) return true; if (!this.#options.assertLease) return false; try { return (await this.#options.assertLease()) !== false; } catch { return false; } }
  /** Original Claude query controls are separate from native foreground turns.
   * @param {Value} view @param {string|null} epoch */
  #query(view, epoch) {
    const query = view.nativeQuery;
    return this.#options.sourceIdentity.app === 'claude-desktop' && this.#metadata.nativeSession?.isSubagent !== true && epoch !== null && object(query) && query.version === 1
      && query.app === 'claude-desktop' && query.nativeConversationId === this.nativeId && query.hostId === this.#options.sourceIdentity.hostId
      && query.ownerGeneration === epoch && view.ownerGeneration === epoch && query.status === view.status && ['idle', 'running', 'waiting'].includes(query.status)
      && typeof query.canSend === 'boolean' && typeof query.canCancel === 'boolean' && ['queue', 'unverified'].includes(query.activeSendMode)
      && (query.queryToken === null || typeof query.queryToken === 'string' && query.queryToken.length > 0 && query.queryToken.length <= 512)
      ? query : null;
  }
  /** @param {Value} view */
  #foregroundActive(view) {
    return typeof view.currentTurnId === 'string' || ['running', 'waiting'].includes(this.#query(view, this.#state.epoch)?.status);
  }
  /** @param {Value} plan */
  async #guard(plan) {
    if (this.#closed) throw new BridgeError('source-unavailable', 'The connector is closing.');
    if (!await this.#lease()) throw new BridgeError('source-lease-unavailable', 'The original source lease is unavailable.');
    if (plan.action === 'open-desktop') {
      if (this.#options.sourceIdentity.app !== 'codex' || this.#options.sourceIdentity.hostId !== 'local') throw new BridgeError('source-unavailable', 'Only the bound local desktop chat can be opened.');
      return this.#view;
    }
    const epoch = await this.#epoch(); if (epoch === null) throw new BridgeError('source-generation-unavailable', 'The original source generation is unavailable.');
    if (epoch !== plan.epoch) throw new BridgeError('source-epoch-changed', 'The original source generation changed.');
    if (plan.action === 'stop-task') {
      await this.#assertTaskOwner(plan.payload.scope, epoch);
      this.#taskControl(plan.payload.scope, plan.payload.taskId, 'stop');
      return this.#view;
    }
    const view = viewOf(await this.#options.adapter.snapshot(this.nativeId)); this.#view = view;
    if (view.status === 'history-only' || view.historicalRead != null) throw new BridgeError('source-generation-unavailable', 'Saved history has no current native controller.');
    // snapshot/getGeneration均为异步，窗口/owner可能在读取期间更换；派发前再核对，不能只用读取前epoch。
    if (!await this.#lease()) throw new BridgeError('source-lease-unavailable', 'The source lease changed before dispatch.');
    if (await this.#epoch() !== plan.epoch) throw new BridgeError('source-epoch-changed', 'The original source changed while reading its current view.');
    if (plan.windowControl) {
      if (!available(view) || view.kind !== 'window') throw new BridgeError('source-unavailable', 'The bound original window is unavailable.');
      if (plan.action === 'type' && view.textInputAvailable === false) throw new BridgeError('unsupported-action', 'This window has no verified editable Agent draft.');
      if (['click', 'scroll'].includes(plan.action) && view.coordinateControlAvailable === false) throw new BridgeError('unsupported-action', 'This window has no verified coordinate control.');
      if ((plan.action === 'press' || plan.action === 'key' && plan.payload.nodeId) && view.semanticControlAvailable === false) throw new BridgeError('unsupported-action', 'This window has no verified accessibility control.');
      return view;
    }
    if (!available(view) || view.kind === 'window' || !isCodeLightNativeSource({ ...this.#options.sourceIdentity, runtimeGeneration: epoch }, { controlMode: 'session' })) throw new BridgeError('source-unavailable', 'This source has no verified native session control.');
    const nativeQuery = this.#query(view, epoch);
    if (plan.nativeQuery && (!nativeQuery || nativeQuery.queryToken !== plan.nativeQuery.queryToken)) throw new BridgeError('stale-turn', 'The original native query changed before dispatch.');
    if (plan.action === 'update-settings' && this.#options.sourceIdentity.app === 'claude-desktop') {
      if (view.nativeReadOnly !== false) throw new BridgeError('native-read-only', 'The original model settings owner is read-only.');
      const current = this.#validateSettingsControls(await this.#options.adapter.command(this.nativeId, 'read-controls', {}, 'settings-check-' + randomUUID(),
        { expectedGeneration: epoch, expectedQueryToken: nativeQuery?.queryToken }), epoch);
      if (this.#view.nativeReadOnly !== false || current.model?.available !== true || !sameNativeSettingsScope(current.scope, plan.payload.expectedScope) || current.model?.current?.model !== plan.payload.expectedModel
        || current.model?.current?.reasoningEffort !== plan.payload.expectedReasoningEffort) throw new BridgeError('settings-conflict', 'The original settings changed before dispatch.');
    }
    if (plan.action === 'interrupt' && this.#options.sourceIdentity.app === 'claude-desktop') {
      if (!nativeQuery || nativeQuery.canCancel !== true || !['running', 'waiting'].includes(nativeQuery.status) || nativeQuery.queryToken !== plan.payload.queryToken) throw new BridgeError('stale-turn', 'The original native query is no longer cancellable.');
    } else if (plan.action === 'interrupt' && view.currentTurnId !== plan.payload.turnId) throw new BridgeError('stale-turn', 'The foreground native turn changed; no other turn was stopped.');
    if (plan.action === 'send' && this.#options.sourceIdentity.app === 'claude-desktop' && (!nativeQuery || nativeQuery.canSend !== true
      || nativeQuery.status !== 'idle' && !(this.#options.sourceIdentity.appMode === 'code' && nativeQuery.activeSendMode === 'queue'))) throw new BridgeError('source-unavailable', 'The original native query cannot accept this input.');
    if (plan.action === 'steer' && view.currentTurnId !== plan.expectedTurnId) throw new BridgeError('stale-turn', 'The original foreground turn changed before steering.');
    if (plan.action === 'send' && view.currentTurnId != null) throw new BridgeError('stale-turn', 'A foreground turn started before this idle input was submitted.');
    if (plan.action === 'source-command' && plan.payload.name === 'compact' && view.currentTurnId != null) throw new BridgeError('stale-turn', 'The native compact command requires an idle original conversation.');
    if (plan.request) {
      const present = plan.request.type === 'async-question'
        ? pendingNativeAsyncQuestions(view).some((/** @type {Value} */ question) => question.questionItemId === plan.request.questionItemId)
        : (view.requests ?? []).some((/** @type {Value} */ request) => request.kind === plan.request.kind && stable(request.requestId) === stable(plan.request.requestId) && request.operable === true && (!plan.request.digest || this.#mac(request) === plan.request.digest));
      if (!present) throw new BridgeError(plan.request.type === 'async-question' ? 'stale-question' : 'stale-approval', 'The original pending request is no longer available.');
    }
    return view;
  }

  async #collectBootstrap() {
    const candidates = this.#options.transport.listInbox().filter((/** @type {Value} */ incoming) => incoming.record?.role === 'session' && typeof (incoming.record.content?.data ?? incoming.record.content)?.ev?.text === 'string');
    if (!candidates.some((/** @type {Value} */ candidate) => !this.#state.bootstrap?.some((/** @type {Value} */ item) => item.serverId === candidate.id))) return;
    await this.#mutate(state => {
      state.bootstrap ??= [];
      for (const candidate of candidates) if (!state.bootstrap.some((/** @type {Value} */ item) => item.serverId === candidate.id)) state.bootstrap.push({ serverId: candidate.id, ciphertext: encryptRecord(candidate.record, this.#key) });
    });
  }

  /** @param {Value} view */
  async #seedBootstrap(view) {
    if (!this.#state.bootstrap?.length) return;
    const known = new Set(this.#state.rows.map((/** @type {Value} */ row) => row.id));
    if (!this.#mirrorRows(view).some(row => !known.has(row.id))) return;
    const inbox = (this.#state.bootstrap ?? []).map((/** @type {Value} */ saved) => ({ record: decryptRecord(saved.ciphertext, this.#key) }));
    await this.#mutate(state => {
      for (const row of this.#mirrorRows(view)) {
        if (state.rows.some((/** @type {Value} */ entry) => entry.id === row.id)) continue;
        if (!row.id || !row.turnId || typeof row.text !== 'string' || !['user', 'assistant', 'reasoning'].includes(row.role)) continue;
        const expected = 'ni' + createHash('sha256').update(`${this.nativeId}:${row.id}:bootstrap`).digest('hex').slice(0, 28);
        const observed = inbox.find((/** @type {Value} */ incoming) => {
          const record = incoming.record, envelope = record?.content?.data ?? record?.content;
          return record?.role === 'session' && envelope?.id === expected && envelope.turn === row.turnId && envelope.role === (row.role === 'user' ? 'user' : 'agent') && typeof envelope.ev?.text === 'string' && row.text.startsWith(envelope.ev.text);
        });
        if (!observed) continue;
        const envelope = observed.record.content.data ?? observed.record.content, text = envelope.ev.text;
        state.rows.push({ id: row.id, role: row.role, turnId: row.turnId, text, digest: this.#mac(text), eventIds: [expected], revision: 0 });
        state.clock = Math.max(state.clock, envelope.time ?? 0);
        if (!state.turns.some((/** @type {Value} */ turn) => turn.id === row.turnId)) state.turns.push({ id: row.turnId, started: true, ended: null });
      }
    });
  }

  /** Only an explicitly verified native saved-data reader can supply this view.
   * @param {Value} view */
  #historical(view) {
    const proof = view.historicalRead;
    return /** @type {Value} */ (this.#options.adapter).supportsNativeSavedHistory === true && this.#options.sourceIdentity.app === 'codex'
      && view.status === 'history-only' && view.ownerGeneration === null && view.currentTurnId === null
      && Array.isArray(view.requests) && view.requests.length === 0 && object(proof) && proof.version === 1 && proof.available === true
      && proof.app === 'codex' && proof.originator === 'Codex Desktop' && proof.nativeId === this.nativeId && proof.hostId === this.#options.sourceIdentity.hostId
      && typeof proof.namespaceHash === 'string' && /^[a-f0-9]{64}$/u.test(proof.namespaceHash)
      && typeof proof.sourceStamp === 'string' && /^[a-f0-9]{64}$/u.test(proof.sourceStamp)
      && object(proof.byteBoundary) && [proof.byteBoundary.start, proof.byteBoundary.end, proof.byteBoundary.total].every(Number.isSafeInteger)
      && proof.byteBoundary.start >= 0 && proof.byteBoundary.end >= proof.byteBoundary.start && proof.byteBoundary.total >= proof.byteBoundary.end;
  }

  /** @param {Value} view @param {boolean} [historyRead] @returns {Promise<void>} */
  project(view, historyRead = false) {
    if (this.#closed || this.#retiring) return Promise.resolve();
    return this.#operation(() => this.#acceptProject(view, historyRead));
  }
  /** @param {Value} view @param {boolean} historyRead @returns {Promise<void>} */
  async #acceptProject(view, historyRead) {
    const actual = viewOf(view);
    if ((actual.status === 'history-only' || actual.historicalRead != null) && !this.#historical(actual)) throw new BridgeError('native-history-unverified', 'The original saved-history provenance is unavailable.', 503);
    const epoch = this.#historical(actual) ? null : await this.#epoch();
    if (this.#closed || this.#retiring) return;
    const capture = this.#capture(actual.nativeTasks);
    if (available(actual) && capture && this.#taskCapture?.epoch === capture.epoch && capture.seq < this.#taskCapture.seq) {
      this.emit('diagnostic', { code: 'stale-native-task-projection' }); return;
    }
    if (epoch === this.#state.epoch && Number.isSafeInteger(actual.revision) && Number.isSafeInteger(this.#state.lastViewRevision) && actual.revision < this.#state.lastViewRevision) { this.emit('diagnostic', { code: 'stale-native-projection' }); return; }
    this.#view = actual;
    if (!this.#projectFlight && !this.#pendingView && actual.contentStamp && this.#state.nativeImageProjectionVersion === 1
      && this.#state.recentStamp === `${epoch ?? 'unknown'}:${actual.contentStamp}` && this.#state.epoch === epoch) {
      // A restored same-owner baseline is already primed even when only its
      // attachment metadata needed repair. The next real delta is live.
      this.#historyProjectionPrimed = true;
      const lease = await this.#lease(), attachment = this.#attachmentMetadata;
      if (!attachment || attachment.epoch !== epoch || attachment.lease !== lease) await this.#ensureAttachmentMetadata(actual, epoch, lease);
      return;
    }
    this.#pendingView = structuredClone(actual);
    this.#pendingViewFromHistory = historyRead;
    if (!this.#projectFlight) this.#projectFlight = (async () => { while (this.#pendingView && !this.#closed) { const next = this.#pendingView, fromHistory = this.#pendingViewFromHistory; this.#pendingView = null; await this.#project(next, fromHistory); } })().finally(() => { this.#projectFlight = null; });
    return this.#projectFlight;
  }

  /** @param {Value} view @param {boolean} historyRead */
  async #project(view, historyRead) {
    const epoch = this.#historical(view) ? null : await this.#epoch(), lease = await this.#lease();
    const mirrorRows = this.#imageRows(this.#mirrorRows(view));
    await this.#seedBootstrap(view);
    const activeRowIds = new Set(this.#mirrorRows(view).flatMap(row => [row.id, ...(row.tools ?? []).map((/** @type {Value} */ tool) => `tool:${tool.id}`)]));
    const restoredRows = await readArchivedObserverRows(this.#state, this.statePath, this.#key, activeRowIds);
    const suppressed = new Set(), primedRows = new Set();
    const firstAttachment = this.#options.publishInitialHistory === false && (!this.#historyProjectionPrimed || this.#state.epoch !== epoch);
    try { await this.#mutate(state => {
      const previousRows = new Set(state.rows.map((/** @type {Value} */ row) => row.id));
      const newestKnown = mirrorRows.reduce((last, row, index) => previousRows.has(row.id) ? index : last, -1);
      // 仅 owner 内容 stamp 无法区分图片投影语义；升级后主动递增 seed 版本，替换旧参数。
      if (state.nativeImageProjectionVersion !== 1) {
        if (state.recentStamp) state.recentVersion = (state.recentVersion ?? 0) + 1;
        state.nativeImageProjectionVersion = 1;
      }
      for (const [rowId, row] of restoredRows) {
        const index = state.rows.findIndex((/** @type {Value} */ item) => item.id === rowId);
        if (index >= 0 && state.rows[index].historyRef) state.rows[index] = row;
      }
      state.activeRowIds = [...activeRowIds];
      state.sourceStatus = this.#historical(view) ? 'history-only' : available(view) ? (view.status === 'locked' ? 'locked' : 'connected') : view.status === 'locked' ? 'locked' : 'owner-unavailable';
      state.epoch = epoch; state.currentTurnId = view.currentTurnId ?? null;
      state.lastViewRevision = Number.isSafeInteger(view.revision) ? view.revision : null;
      if (view.kind === 'window' || !isCodeLightNativeSource({ ...this.#options.sourceIdentity, runtimeGeneration: epoch }, { controlMode: 'session' })) return;
      this.#reconcileCommands(state, view);
      const groups = new Map();
      const primeTurns = new Map();
      for (const [index, row] of mirrorRows.entries()) {
        if (!row.id || !row.turnId) continue;
        const prime = this.#options.publishInitialHistory === false && (firstAttachment || !previousRows.has(row.id)
          && (newestKnown >= 0 && index < newestKnown || historyRead && newestKnown < 0));
        this.#suppressedProjectionEvents = prime ? suppressed : null;
        primeTurns.set(row.turnId, (primeTurns.get(row.turnId) ?? true) && prime);
        if (prime) { primedRows.add(row.id); for (const tool of row.tools ?? []) primedRows.add(`tool:${tool.id}`); }
        groups.set(row.turnId, [...(groups.get(row.turnId) ?? []), row]);
        let entry = state.rows.find((/** @type {Value} */ item) => item.id === row.id);
        const own = row.role === 'user' && state.commands.some((/** @type {Value} */ command) => command.origin === 'message' && command.admission?.confirmed && (row.commandId === command.id || command.result?.messageId === row.id));
        if (own) {
          if (!entry) state.rows.push({ id: row.id, turnId: row.turnId, role: 'user', text: row.text ?? '', digest: this.#mac(row.text ?? ''), eventIds: [], suppressedOwnEcho: true });
          continue;
        }
        if (!entry) { entry = { id: row.id, turnId: row.turnId, role: row.role, text: '', digest: this.#mac(''), eventIds: [], revision: 0 }; state.rows.push(entry); }
        if (['user', 'assistant', 'reasoning'].includes(row.role) && typeof row.text === 'string') {
          const text = safePrefix(row.text); if (entry.digest !== this.#mac(entry.text)) throw new BridgeError('prefix-integrity-error', 'The stored native text prefix did not match its HMAC.');
          const replacedSources = Array.isArray(row.replaceSourceRowIds) ? row.replaceSourceRowIds : [];
          const aliasesChanged = stable(entry.replaceSourceRowIds ?? []) !== stable(replacedSources);
          if (text === entry.text && (!text || entry.rowIdentityVersion === 1) && !aliasesChanged) continue;
          this.#turnStart(state, row.turnId);
          const provisional = row.role === 'user' && row.commandId && row.id !== `pending-user:${row.commandId}`
            ? state.rows.find((/** @type {Value} */ item) => item.id === `pending-user:${row.commandId}`) : null;
          const legacyPrefix = !!entry.text && entry.rowIdentityVersion !== 1;
          if (text.startsWith(entry.text) && row.role === entry.role && row.turnId === entry.turnId && !provisional?.eventIds?.length && !legacyPrefix && !aliasesChanged && !entry.publicationBaseline) {
            const eventId = 'ni' + hash([this.bindingId, row.id, entry.text.length, text.length, this.#mac(text)]).slice(0, 28);
            this.#event(state, eventId, row.role === 'user' ? 'user' : 'agent', row.turnId, { t: 'text', text: text.slice(entry.text.length), ...(row.role === 'reasoning' ? { thinking: true } : {}) },
              { nativeRow: { id: row.id, offset: entry.text.length, revision: entry.revision ?? 0 } });
            entry.eventIds.push(eventId);
          } else {
            state.projectionStatus = this.#options.supportsNativeProjection ? 'ready' : 'resync-required'; entry.revision = (entry.revision ?? 0) + 1;
            const eventId = 'ni' + hash([this.bindingId, row.id, 'replace', entry.revision, this.#mac(text)]).slice(0, 28);
            const sourceWireIds = replacedSources.flatMap((/** @type {string} */ sourceId) => state.rows.find((/** @type {Value} */ item) => item.id === sourceId)?.eventIds ?? []);
            entry.replacedWireIds = [...new Set([...(entry.replacedWireIds ?? []), ...entry.eventIds, ...(provisional?.eventIds ?? []), ...sourceWireIds])];
            this.#event(state, eventId, row.role === 'user' ? 'user' : 'agent', row.turnId, { t: 'native-row-upsert', sourceRowId: row.id, role: row.role, text, revision: entry.revision,
              replaceIds: entry.replacedWireIds, ...(replacedSources.length ? { replaceSourceRowIds: replacedSources } : {}) });
            entry.eventIds = [eventId];
          }
          entry.text = text; entry.digest = this.#mac(text); entry.role = row.role; entry.turnId = row.turnId;
          entry.rowIdentityVersion = 1;
          entry.replaceSourceRowIds = replacedSources;
          entry.publicationBaseline = false;
        }
        for (const tool of row.tools ?? []) this.#tool(state, row, tool);
      }
      this.#suppressedProjectionEvents = null;
      for (const [turnId, rows] of groups) {
        this.#suppressedProjectionEvents = primeTurns.get(turnId) ? suppressed : null;
        const status = rows.map((/** @type {Value} */ row) => terminal(row.status)).filter(Boolean).at(-1);
        const turn = state.turns.find((/** @type {Value} */ item) => item.id === turnId);
        if (status && turn?.started && !turn.ended && view.currentTurnId !== turnId) { this.#event(state, 'ni' + hash([this.bindingId, turnId, 'turn-end', status]).slice(0, 28), 'agent', turnId, { t: 'turn-end', status }); turn.ended = status; }
      }
      this.#suppressedProjectionEvents = null;
      // Baselines retain real legacy aliases, but never reference data events
      // intentionally not emitted by this attachment/history projection.
      if (suppressed.size || primedRows.size) for (const entry of state.rows) {
        if (primedRows.has(entry.id)) entry.publicationBaseline = true;
        if (Array.isArray(entry.eventIds)) entry.eventIds = entry.eventIds.filter((/** @type {string} */ id) => !suppressed.has(id));
        if (Array.isArray(entry.replacedWireIds)) entry.replacedWireIds = entry.replacedWireIds.filter((/** @type {string} */ id) => !suppressed.has(id));
      }
      state.requestMap = this.#requestMap(view, epoch);
      const recentStamp = `${epoch ?? 'unknown'}:${view.contentStamp ?? hash(view.rows ?? [])}`;
      // 原 owner 的静默 stdout 快照可能沿用同一 revision；另存投影版本，不能让新鲜完整行被旧 seed 去重。
      if (state.recentStamp !== recentStamp) { state.recentStamp = recentStamp; state.recentVersion = (state.recentVersion ?? 0) + 1; }
    }); } finally { this.#suppressedProjectionEvents = null; }
    this.#historyProjectionPrimed = true;
    await this.#ensureAttachmentMetadata(view, epoch, lease);
    await this.#flushEvents();
    if (lease && epoch && available(view) && view.kind !== 'window' && isCodeLightNativeSource({ ...this.#options.sourceIdentity, runtimeGeneration: epoch }, { controlMode: 'session' })) this.emit('notification-observation', { ...notificationSummary(view, this.#state.requestMap), epoch });
  }

  /** Only the observer publication window is bounded; native commands/questions/history retain full evidence.
   * @param {Value} view @returns {Value[]} */
  #mirrorRows(view) {
    const rows = view.rows ?? [];
    return this.#options.recentRowLimit === undefined ? rows : rows.slice(-this.#options.recentRowLimit);
  }

  /** 图片同步只传占位标记；这里绝不读文件或传图片字节。
   * @param {Value[]} rows @returns {Value[]} */
  #imageRows(rows) {
    return rows.map(row => ({ ...row, tools: (row.tools ?? []).map((/** @type {Value} */ tool) => {
      if (!Object.hasOwn(tool, 'imagePath')) return tool;
      const { imagePath, ...publicTool } = tool;
      return { ...publicTool, name: 'file', arguments: { nativeImageId: tool.id, name: typeof imagePath === 'string' ? basename(imagePath) : 'Image' } };
    }) }));
  }

  /** 只有用户点击后的只读请求能触发图片读取；路径由原生 item 提供，不接受手机路径。
   * @param {unknown} params @returns {Promise<Value>} */
  async #readImage(params) {
    if (!object(params) || Object.keys(params).length !== 1 || typeof params.imageId !== 'string' || !params.imageId || params.imageId.length > 512) throw new BridgeError('invalid-image-request', 'An original image identity is required.');
    const epoch = await this.#epoch();
    const assertOwner = async () => {
      if (this.#closed || !epoch || this.#options.sourceIdentity.app !== 'codex' || this.#options.sourceIdentity.hostId !== 'local'
        || !available(this.#view) || !await this.#lease() || await this.#epoch() !== epoch
        || typeof this.#view.ownerGeneration === 'string' && this.#view.ownerGeneration !== epoch) throw new BridgeError('source-epoch-changed', 'The original image owner is unavailable.');
    };
    await assertOwner();
    const tool = (this.#view.rows ?? []).flatMap((/** @type {Value} */ row) => row.tools ?? []).find((/** @type {Value} */ tool) => tool.id === params.imageId && Object.hasOwn(tool, 'imagePath'));
    if (!tool) throw new BridgeError('native-image-unavailable', 'The image is not present in this original session.');
    const key = this.#mac([tool.id, tool.imagePath, NATIVE_PREVIEW_POLICY]);
    const cached = this.#state.nativeImages?.[key];
    if (cached) { await assertOwner(); return cached; }
    let flight = this.#imageFlights.get(key);
    if (!flight) {
      flight = (async () => {
        try {
          const image = await compressNativeImage(await readNativeImage(tool.imagePath));
          await assertOwner();
          const uploaded = await this.#options.transport.uploadAttachment(image.bytes, { filename: image.name });
          await assertOwner();
          const value = { ref: uploaded.ref, name: image.name, size: image.bytes.length, ...(image.image ? { image: image.image } : {}) };
          await this.#mutate(state => { state.nativeImages ??= {}; state.nativeImages[key] = value; });
          return value;
        } catch (error) {
          // 原系统错误可能含本机路径；网络上只返回固定图片错误，正文占位始终保留。
          if (error instanceof BridgeError) throw error;
          throw new BridgeError('native-image-unavailable', 'The original image could not be loaded.');
        }
      })().finally(() => { this.#imageFlights.delete(key); });
      this.#imageFlights.set(key, flight);
    }
    const result = await flight; await assertOwner(); return result;
  }

  /** @param {Value} state @param {string} eventId @param {string} role @param {string|null} turn @param {Value} ev @param {Value} [meta] */
  #event(state, eventId, role, turn, ev, meta = {}) {
    if (state.events.some((/** @type {Value} */ item) => item.id === eventId)) return;
    if (this.#suppressedProjectionEvents && ['text', 'native-row-upsert', 'tool-call-start', 'tool-call-end', 'turn-start', 'turn-end'].includes(ev.t)) {
      this.#suppressedProjectionEvents.add(eventId); return;
    }
    const time = Math.max(Date.now(), state.clock + 1); state.clock = time;
    const record = { role: 'session', content: { id: eventId, time, role, ...(turn ? { turn } : {}), ev }, meta: { sentFrom: 'noninvasive-observer', ...meta } };
    state.events.push({ id: eventId, localId: `${eventId}-observed`, ciphertext: encryptRecord(record, this.#key), sent: false });
  }
  /** @param {Value} state @param {string} turnId */
  #turnStart(state, turnId) {
    let turn = state.turns.find((/** @type {Value} */ item) => item.id === turnId);
    if (!turn) { turn = { id: turnId, started: false, ended: null }; state.turns.push(turn); }
    if (!turn.started) { this.#event(state, 'ni' + hash([this.bindingId, turnId, 'turn-start']).slice(0, 28), 'agent', turnId, { t: 'turn-start' }); turn.started = true; }
  }
  /** @param {Value} state @param {Value} row @param {Value} tool */
  #tool(state, row, tool) {
    if (!tool.id) return;
    let entry = state.rows.find((/** @type {Value} */ item) => item.id === `tool:${tool.id}`);
    if (!entry) {
      entry = { id: `tool:${tool.id}`, revision: 0, output: null, terminal: null, eventIds: [] }; state.rows.push(entry); this.#turnStart(state, row.turnId);
      const startId = 'ni' + hash([this.bindingId, tool.id, 'tool-start']).slice(0, 28); this.#event(state, startId, 'agent', row.turnId, { t: 'tool-call-start', call: tool.id, name: tool.name ?? 'Tool', title: tool.name ?? 'Tool', description: '', args: object(tool.arguments) ? tool.arguments : {} }); entry.eventIds.push(startId);
    }
    const status = terminal(tool.status), output = typeof tool.output === 'string' ? tool.output : '';
    const inputDigest = this.#mac([tool.name, tool.arguments ?? {}]);
    const inputChanged = entry.inputDigest !== undefined && entry.inputDigest !== inputDigest;
    if (output === entry.output && status === entry.terminal && !inputChanged) return;
    if (entry.publicationBaseline) {
      entry.revision++; state.projectionStatus = this.#options.supportsNativeProjection ? 'ready' : 'resync-required';
      const eventId = 'ni' + hash([this.bindingId, tool.id, 'tool-baseline-update', entry.revision, this.#mac(output)]).slice(0, 28);
      this.#event(state, eventId, 'agent', row.turnId, { t: 'native-row-upsert', sourceRowId: row.id, role: 'tool', text: '', tools: [{ id: tool.id, name: tool.name, output, status: tool.status,
        ...(tool.name === 'file' ? { arguments: tool.arguments } : projectNativeToolInput(tool.arguments ?? {})) }], revision: entry.revision, replaceIds: [] }); entry.eventIds.push(eventId);
      entry.publicationBaseline = false;
    } else if (status && !entry.terminal) {
      const eventId = 'ni' + hash([this.bindingId, tool.id, 'tool-end', this.#mac(output), status]).slice(0, 28);
      this.#event(state, eventId, 'agent', row.turnId, { t: 'tool-call-end', call: tool.id, result: output, isError: status === 'failed' }); entry.eventIds.push(eventId);
    } else if (output || inputChanged) {
      entry.revision++; state.projectionStatus = this.#options.supportsNativeProjection ? 'ready' : 'resync-required';
      const eventId = 'ni' + hash([this.bindingId, tool.id, 'tool-output', entry.revision, this.#mac(output)]).slice(0, 28);
      this.#event(state, eventId, 'agent', row.turnId, { t: 'native-row-upsert', sourceRowId: row.id, role: 'tool', text: '', tools: [{ id: tool.id, name: tool.name, output, status: tool.status,
        ...(tool.name === 'file' ? { arguments: tool.arguments } : projectNativeToolInput(tool.arguments ?? {})) }], revision: entry.revision, replaceIds: [] }); entry.eventIds.push(eventId);
    }
    entry.output = output; entry.terminal = status; entry.inputDigest = inputDigest;
  }

  async #flushEvents() {
    if (this.#flushFlight) return this.#flushFlight;
    this.#flushFlight = (async () => {
      while (!this.#closed) {
        const pending = this.#state.events.filter((/** @type {Value} */ event) => !event.sent).slice(0, 50);
        if (!pending.length) return;
        if (this.#closed) return;
        const records = pending.map((/** @type {Value} */ event) => {
          const record = decryptRecord(event.ciphertext, this.#key);
          if (!record) throw new BridgeError('event-plan-decryption-failed', 'The fixed Happy event plan could not be decoded.');
          return { localId: event.localId, record };
        });
        if (typeof this.#options.transport.publishBatch === 'function') await this.#options.transport.publishBatch(records);
        else for (const record of records) await this.#options.transport.publish(record.localId, record.record);
        const ids = new Set(pending.map((/** @type {Value} */ event) => event.id));
        await this.#mutate(state => { for (const event of state.events) if (ids.has(event.id)) event.sent = true; });
      }
    })().finally(() => { this.#flushFlight = null; }); return this.#flushFlight;
  }

  /** @param {Value} view @param {string|null} epoch */
  #requestMap(view, epoch) {
    /** @type {Value[]} */ const mappings = [];
    if (this.#historical(view)) return mappings;
    for (const request of view.requests ?? []) {
      if (!request.operable || request.requestId == null) continue;
      const key = 'rq' + hash([this.bindingId, request.kind, request.requestId]).slice(0, 28);
      mappings.push({ key, type: 'request', kind: request.kind, requestId: request.requestId, epoch, request: structuredClone(request) });
    }
    // 旧实现把所有历史未答问题放到底栏；最近一轮答完后仍会催促早先的解锁/授权问题。
    for (const question of pendingNativeAsyncQuestions(view)) {
      mappings.push({ key: 'cq' + hash([this.bindingId, question.questionItemId]).slice(0, 28), type: 'async-question', questionItemId: question.questionItemId, epoch, question: structuredClone(question) });
    }
    return mappings;
  }
  /** @param {Value} view @param {string|null} epoch @param {boolean} lease */
  async #ensureAttachmentMetadata(view, epoch, lease) {
    this.#attachmentMetadata = null;
    await this.#publishMetadata(view, epoch, lease);
    this.#attachmentMetadata = { epoch, lease };
  }

  /** @param {Value} view @param {string|null} epoch @param {boolean} lease */
  async #publishMetadata(view, epoch, lease) {
    const savedHistory = this.#historical(view);
    const sessionControl = !savedHistory && available(view) && view.kind !== 'window' && isCodeLightNativeSource({ ...this.#options.sourceIdentity, runtimeGeneration: epoch }, { controlMode: 'session' }) && epoch !== null && lease;
    const supported = /** @type {Value} */ (this.#options.adapter).supportedActions;
    const supports = (/** @type {string} */ action) => !Array.isArray(supported) || supported.includes(action);
    const inputMatches = view.nativeInput?.app === this.#options.sourceIdentity.app && view.nativeInput?.nativeConversationId === this.nativeId
      && view.nativeInput?.hostId === this.#options.sourceIdentity.hostId && view.nativeInput?.ownerGeneration === epoch;
    const nativeInput = inputMatches ? { ...view.nativeInput, available: sessionControl && view.nativeInput.available === true } : null;
    const originalQuery = this.#query(view, epoch), nativeQuery = originalQuery ? { ...originalQuery,
      canSend: sessionControl && supports('send') && originalQuery.canSend === true && (originalQuery.status === 'idle' || this.#options.sourceIdentity.appMode === 'code' && originalQuery.activeSendMode === 'queue'),
      canCancel: sessionControl && supports('interrupt') && originalQuery.canCancel === true && ['running', 'waiting'].includes(originalQuery.status) && typeof originalQuery.queryToken === 'string' } : null;
    const nativeTasks = this.#taskEnvelope(view, epoch, sessionControl);
    const nativeTaskControls = sourceNativeTaskControls(view.nativeTaskControls, nativeTasks);
    if (nativeTaskControls && view.nativeReadOnly === true) nativeTaskControls.stopTaskTypes = [];
    const observedLabel = (/** @type {unknown} */ value, /** @type {number} */ max) => typeof value === 'string' && value.trim() && value.length <= max ? value : null;
    const nativeObservedModel = this.#options.sourceIdentity.app === 'claude-desktop' && available(view) && view.ownerGeneration === epoch && epoch !== null && object(view.nativeModel)
      ? { version: 1, app: 'claude-desktop', nativeConversationId: this.nativeId, hostId: this.#options.sourceIdentity.hostId,
        ownerGeneration: epoch, readOnly: true, model: observedLabel(view.nativeModel.model, 512), effort: observedLabel(view.nativeModel.effort, 128) } : null;
    const rpcMethods = [];
    if (sessionControl && supports('interrupt')) rpcMethods.push('abort');
    if (sessionControl && supports('approval')) rpcMethods.push('permission');
    if (sessionControl && (supports('answer-question') || supports('approval'))) rpcMethods.push('communication');
    rpcMethods.push('bridge-receipt');
    const windowControl = available(view) && view.kind === 'window' && epoch !== null && lease;
    if (windowControl) rpcMethods.push('window-control');
    if (!savedHistory && lease && this.#options.sourceIdentity.hostId === 'local' && supports('open-desktop') && isCodeLightNativeSource({ ...this.#options.sourceIdentity, runtimeGeneration: epoch }, { controlMode: 'session' })) rpcMethods.push('open-desktop');
    if (sessionControl && this.#options.sourceIdentity.app === 'codex' && this.#options.sourceIdentity.hostId === 'local') rpcMethods.push('native-image-read');
    const modelController = sessionControl && this.#options.adapter.supportsNativeModelSettings === true && !this.#settingsChildBlocked(view);
    if (modelController) rpcMethods.push('codex-controls-read');
    if (sessionControl && /** @type {Value} */ (this.#options.adapter).supportsSourceCommands === true) rpcMethods.push('source-command');
    if (sessionControl && nativeTasks && typeof /** @type {Value} */ (this.#options.adapter).taskSnapshot === 'function') rpcMethods.push('native-task-read');
    if (sessionControl && nativeTasks?.tasksAvailable && typeof /** @type {Value} */ (this.#options.adapter).taskLogPage === 'function') rpcMethods.push('native-task-log-read');
    if (sessionControl && nativeTaskControls?.outputTaskTypes.length && typeof /** @type {Value} */ (this.#options.adapter).getTaskOutput === 'function') rpcMethods.push('native-task-output-read');
    if (sessionControl && nativeTaskControls?.stopTaskTypes.length && typeof /** @type {Value} */ (this.#options.adapter).stopTask === 'function') rpcMethods.push('native-task-stop');
    if (this.#controlsEpoch !== epoch) { this.#nativeControls = null; this.#controlsEpoch = epoch; this.#controlsReadAt = 0; }
    const catalogMatches = !view.nativeControlsCurrent || !!(view.nativeControlsCurrent.modelProvider === this.#nativeControls?.model?.current?.modelProvider &&
      this.#nativeControls?.model?.models?.some((/** @type {Value} */ m) => m.id === view.nativeControlsCurrent.model));
    let cachedControls = this.#nativeControls;
    if (cachedControls && this.#options.sourceIdentity.app === 'claude-desktop') {
      try { cachedControls = this.#validateSettingsControls(cachedControls, epoch, view); } catch { cachedControls = null; this.#nativeControls = null; this.#controlsReadAt = 0; }
    }
    const nativeControls = cachedControls ? { ...cachedControls, model: { ...cachedControls.model, available: modelController && catalogMatches && cachedControls.model?.available === true,
      ...(view.nativeControlsCurrent ? { current: view.nativeControlsCurrent } : {}) } } : undefined;
    if (modelController) void this.#refreshControls(epoch).catch(() => {});
    const modelSelection = sessionControl && nativeControls?.model?.available === true;
    if (modelController
      && (this.#options.sourceIdentity.app !== 'claude-desktop' || view.nativeReadOnly === false && modelSelection)) rpcMethods.push('codex-controls-update');
    const caps = { abort: this.#options.sourceIdentity.app === 'claude-desktop' ? nativeQuery?.canCancel === true : sessionControl && supports('interrupt') && typeof view.currentTurnId === 'string',
      ...(this.#options.sourceIdentity.app === 'claude-desktop' ? { send: nativeQuery?.canSend === true,
        ...(available(view) && epoch !== null && view.ownerGeneration === epoch && typeof view.nativeReadOnly === 'boolean' ? { readOnly: view.nativeReadOnly } : {}),
        ...(nativeTaskControls && (nativeTaskControls.outputTaskTypes.length || nativeTaskControls.stopTaskTypes.length) ? { nativeTaskControls } : {}) } : {}), attachments: { enabled: false, maxBytes: 0, mediaTypes: [] }, files: { browse: false, read: false, search: false, write: false }, messageReceipts: true, modelSelection, reasoningSelection: modelSelection && nativeControls?.model?.selectionMode !== 'next-message', permissionModeSelection: false, resume: false, rpcMethods, shell: false, steering: sessionControl && nativeInput?.available !== false && supports('steer'), windowControl };
    const bridge = { ...this.#metadata.bridge, version: 1, source: { ...this.#options.sourceIdentity, runtimeGeneration: epoch, windowGeneration: this.#options.sourceIdentity.windowGeneration ?? null }, currentTurnId: view.currentTurnId ?? null, controlMode: view.kind === 'window' ? 'window' : 'session', sourceStatus: this.#state.sourceStatus, projectionStatus: this.#state.projectionStatus };
    await this.#options.transport.updateMetadata((/** @type {Value} */ current) => ({ ...this.#metadata, ...current, bridge, capabilities: caps,
      ...(this.#options.sourceIdentity.app === 'claude-desktop' && available(view) && view.ownerGeneration === epoch ? { nativeDesktopRuntimeGeneration: /** @type {Value} */ (this.#options.adapter).generation?.() ?? null } : {}),
      ...(this.#options.sourceIdentity.app === 'claude-desktop' ? { nativeObservedModel } : {}),
      nativeSavedHistory: savedHistory ? { ...view.historicalRead, readOnly: true } : null,
      ...(nativeControls ? { nativeControls } : current?.nativeControls ? { nativeControls: { ...current.nativeControls, model: { ...current.nativeControls.model, available: false } } } : {}) }));
    // Happy 的在线状态由 session-alive 驱动；只更新 metadata 会让实际可控的原 owner 被手机判为离线。
    if (this.#state.sourceStatus === 'connected') this.#options.transport.keepAlive?.(this.#foregroundActive(view));
    const requests = /** @type {Value} */ ({}), communications = /** @type {Value} */ ({});
    for (const mapping of this.#state.requestMap) {
      // These message-style questions use send/steer rather than a native
      // pending-request reply. Parent-owned v2 children cannot accept that path.
      if (mapping.type === 'async-question' && nativeInput?.available === false) continue;
      if (mapping.type === 'async-question') communications[mapping.key] = { kind: 'form', title: mapping.question.title, form: { questions: [{ id: 'answer', header: '', question: mapping.question.title, options: (mapping.question.options ?? []).map((/** @type {string} */ label) => ({ label })), allowCustom: true, required: true }] } };
      else if (mapping.kind === 'user-input' && !(mapping.request.questions ?? []).some((/** @type {Value} */ question) => question.secret)) communications[mapping.key] = { kind: 'form', title: 'Native question', form: { questions: (mapping.request.questions ?? []).map((/** @type {Value} */ question) => ({ id: question.id, header: question.header ?? '', question: question.question ?? '', options: question.options ?? [], allowCustom: true, required: true })) } };
      else requests[mapping.key] = { tool: mapping.request.command ?? mapping.kind, arguments: { ...mapping.request, nativeRequestKey: mapping.key, acceptSupported: mapping.request.acceptSupported !== false }, toolUseId: mapping.request.itemId ?? undefined };
    }
    const window = view.kind === 'window' ? { controls: view.controls ?? [], captureStamp: view.captureStamp ?? null, imageRef: view.imageRef ?? null, bounds: view.bounds ?? view.captureStamp?.bounds ?? null,
      runtimeGeneration: view.runtimeGeneration ?? epoch, windowGeneration: view.windowGeneration ?? null, textInputAvailable: view.textInputAvailable ?? false,
      semanticControlAvailable: view.semanticControlAvailable ?? false, coordinateControlAvailable: view.coordinateControlAvailable ?? false,
      contentFreshness: view.contentFreshness ?? 'ax-observation-only' } : undefined;
    const subagents = sourceSubagents(view.subagents, /** @type {any} */ (this.#options.sourceIdentity), epoch);
    const nativeAggregate = view.aggregateActivity;
    const aggregateMatches = sessionControl && nativeAggregate?.app === this.#options.sourceIdentity.app
      && nativeAggregate?.hostId === this.#options.sourceIdentity.hostId && nativeAggregate?.parentConversationId === this.nativeId
      && nativeAggregate?.ownerGeneration === epoch;
    const aggregateActivity = aggregateMatches && !nativeTasks ? nativeAggregate : aggregateNativeActivity({
      app: this.#options.sourceIdentity.app, hostId: this.#options.sourceIdentity.hostId, parentConversationId: this.nativeId,
      ownerGeneration: epoch, ownStatus: sessionControl ? view.status : 'unknown',
      ownWaiting: sessionControl && Array.isArray(view.requests) && view.requests.length > 0,
      subagents, rosterAvailable: sessionControl && view.subagentsAvailable === true,
      rosterComplete: sessionControl && view.subagentsComplete === true,
      taskActivity: nativeTaskActivity(nativeTasks),
    });
    await this.#options.transport.updateAgentState(async (/** @type {Value} */ current) => {
      const taskCurrent = sessionControl && await this.#lease() && await this.#epoch() === epoch;
      const taskValue = this.#taskEnvelope(view, epoch, taskCurrent);
      const latestAggregate = taskValue ? aggregateNativeActivity({
        app: this.#options.sourceIdentity.app, hostId: this.#options.sourceIdentity.hostId, parentConversationId: this.nativeId,
        ownerGeneration: epoch, ownStatus: taskCurrent ? view.status : 'unknown', ownWaiting: taskCurrent && Array.isArray(view.requests) && view.requests.length > 0,
        subagents, rosterAvailable: taskCurrent && view.subagentsAvailable === true, rosterComplete: taskCurrent && view.subagentsComplete === true,
        taskActivity: nativeTaskActivity(taskValue),
      }) : aggregateActivity;
      const updated = /** @type {Value} */ ({ ...current, requests, communications, nativeInput, nativeQuery,
      subagents: sessionControl && view.subagentsAvailable === true ? subagents : (current?.subagents ?? [])
        .filter((/** @type {Value} */ row) => row.app === this.#options.sourceIdentity.app && row.hostId === this.#options.sourceIdentity.hostId && row.parentConversationId === this.nativeId)
        .slice(0, 128).map((/** @type {Value} */ row) => ({ ...row, ownerGeneration: epoch, status: 'unknown', statusSource: 'cached-native-membership' })),
      subagentsAvailable: sessionControl && view.subagentsAvailable === true, subagentsTruncated: view.subagentsTruncated === true,
      subagentsComplete: sessionControl && view.subagentsComplete === true, aggregateActivity: latestAggregate,
      ...(this.#options.sourceIdentity.app === 'antigravity' ? { subagentsTotal: sessionControl && view.subagentsAvailable === true
        && Number.isSafeInteger(view.subagentsTotal) && view.subagentsTotal >= subagents.length && view.subagentsTotal <= 20000 ? view.subagentsTotal : null } : {}),
      ...(this.#options.sourceIdentity.app === 'claude-desktop' ? { nativeTaskSignal: taskValue ? nativeTaskSignal(taskValue) : null } : {}),
      ...(window ? { windowObservation: window } : {}) });
      if (this.#options.sourceIdentity.app === 'claude-desktop') delete updated.nativeTasks;
      return updated;
    });
  }

  /** @param {Value|undefined} raw @returns {{epoch:string,seq:number}|null} */
  #capture(raw) {
    const value = raw?.capture;
    return object(value) && /^[a-f0-9]{32}$/.test(value.epoch) && Number.isSafeInteger(value.seq) && value.seq > 0 ? { epoch: value.epoch, seq: value.seq } : null;
  }

  /** @param {{epoch:string,seq:number}} capture @param {boolean} tasks @param {boolean} dispatch */
  #invalidateTasks(capture, tasks, dispatch) {
    const old = this.#taskInvalidation;
    if (!old || old.epoch !== capture.epoch || capture.seq > old.seq) this.#taskInvalidation = { ...capture, tasks, dispatch };
    else if (capture.seq === old.seq) this.#taskInvalidation = { ...old, tasks: old.tasks || tasks, dispatch: old.dispatch || dispatch };
  }

  /** @param {{epoch:string,seq:number}|null} capture @param {Value} value */
  #taskResurrection(capture, value) {
    const old = this.#taskInvalidation;
    return !!capture && !!old && capture.epoch === old.epoch && capture.seq <= old.seq
      && (old.tasks && value.tasksAvailable === true || old.dispatch && value.dispatchChildrenAvailable === true);
  }

  /** @param {Value} view @param {string|null} epoch @param {boolean} current */
  #taskEnvelope(view, epoch, current) {
    const adapter = /** @type {Value} */ (this.#options.adapter);
    const context = {
      runtimeGeneration: typeof adapter.generation === 'function' ? adapter.generation() : null,
      queryToken: this.#query(view, epoch)?.queryToken ?? null, current,
    };
    const capture = this.#capture(view.nativeTasks);
    let raw = view.nativeTasks;
    if (!current && this.#taskCapture) this.#invalidateTasks(this.#taskCapture, true, true);
    if (capture && (!current || raw?.tasksAvailable !== true || raw?.dispatchChildrenAvailable !== true)) {
      const loss = this.#taskCapture?.epoch === capture.epoch && this.#taskCapture.seq > capture.seq ? this.#taskCapture : capture;
      this.#invalidateTasks(loss, !current || raw?.tasksAvailable !== true, !current || raw?.dispatchChildrenAvailable !== true);
    }
    const invalidated = this.#taskInvalidation;
    if (capture && invalidated?.epoch === capture.epoch && capture.seq <= invalidated.seq) raw = { ...raw,
      tasksAvailable: !invalidated.tasks && raw?.tasksAvailable === true,
      dispatchChildrenAvailable: !invalidated.dispatch && raw?.dispatchChildrenAvailable === true };
    const candidate = sourceNativeTasks(raw, this.#options.sourceIdentity, epoch, context);
    if (!candidate) return null;
    if (current && capture && this.#taskCapture?.epoch === capture.epoch && capture.seq < this.#taskCapture.seq
      && this.#latestTasks && stable(this.#latestTasks.value.scope) === stable(candidate.scope)) return this.#latestTasks.value;
    if (current && capture) { this.#taskCapture = capture; this.#latestTasks = { raw: view.nativeTasks, value: candidate }; }
    this.#taskTransfers.remember(candidate); return candidate;
  }

  /** @param {Value} scope @param {string|null} epoch */
  async #assertTaskOwner(scope, epoch) {
    if (this.#closed || !epoch || !available(this.#view) || this.#historical(this.#view) || !await this.#lease() || await this.#epoch() !== epoch) throw new BridgeError('source-epoch-changed', 'The original task owner is unavailable.');
    const current = this.#taskEnvelope(this.#view, epoch, true);
    if (!current || stable(current.scope) !== stable(scope)) throw new BridgeError('source-epoch-changed', 'The original task query changed.');
  }

  /** @param {Value} scope @param {string} taskId @param {'output'|'stop'} action */
  #taskControl(scope, taskId, action) {
    if (action === 'stop' && this.#view.nativeReadOnly === true) throw new BridgeError('native-read-only', 'The original task owner is read-only.');
    const tasks = this.#taskEnvelope(this.#view, scope.ownerGeneration, true);
    const controls = sourceNativeTaskControls(this.#view.nativeTaskControls, tasks);
    const task = tasks?.tasks.find((/** @type {Value} */ row) => row.nativeTaskId === taskId);
    if (!tasks || stable(tasks.scope) !== stable(scope) || !controls || !task
      || !controls[action === 'output' ? 'outputTaskTypes' : 'stopTaskTypes'].includes(task.taskType)
      || action === 'stop' && !['running', 'pending', 'paused'].includes(task.status)) throw new BridgeError('unsupported-action', 'The original task operation is not verified for this target.');
  }

  /** Output remains an explicit data read outside histories, logs and receipts.
   * @param {unknown} params */
  async #readTaskOutput(params) {
    if (!object(params) || Object.keys(params).some(key => !['scope', 'taskId'].includes(key)) || !object(params.scope)
      || typeof params.taskId !== 'string' || !params.taskId.trim() || params.taskId.length > 256 || /[\x00-\x1f\x7f]/.test(params.taskId)) throw new BridgeError('invalid-rpc-payload', 'An exact original task output identity is required.');
    const epoch = await this.#epoch(); await this.#assertTaskOwner(params.scope, epoch);
    this.#taskControl(params.scope, params.taskId, 'output');
    const result = await /** @type {Value} */ (this.#options.adapter).getTaskOutput(this.nativeId, params.taskId, { scope: params.scope, expectedHostId: this.#options.sourceIdentity.hostId });
    await this.#assertTaskOwner(params.scope, epoch); this.#taskControl(params.scope, params.taskId, 'output');
    if (!object(result) || stable(result.scope) !== stable(params.scope) || result.taskId !== params.taskId
      || typeof result.output !== 'string' || Buffer.byteLength(result.output) > 65536 || typeof result.truncated !== 'boolean') throw new BridgeError('invalid-native-task-output', 'An intact bounded original task output is required.');
    return { scope: params.scope, taskId: params.taskId, output: result.output, truncated: result.truncated };
  }

  /** @param {unknown} params */
  async #readTasks(params) {
    if (!object(params) || Object.keys(params).some(key => !['scope', 'since'].includes(key)) || !object(params.scope)
      || params.since !== undefined && (typeof params.since !== 'string' || !/^[a-f0-9]{64}$/.test(params.since))) throw new BridgeError('invalid-rpc-payload', 'The selected original task scope is required.');
    const epoch = await this.#epoch(); await this.#assertTaskOwner(params.scope, epoch);
    const adapter = /** @type {Value} */ (this.#options.adapter);
    const result = await adapter.taskSnapshot(this.nativeId, { expectedHostId: this.#options.sourceIdentity.hostId,
      expectedGeneration: epoch, expectedQueryToken: params.scope.queryToken, scope: params.scope });
    await this.#assertTaskOwner(params.scope, epoch);
    const value = sourceNativeTasks(result.nativeTasks ?? result, this.#options.sourceIdentity, epoch, {
      runtimeGeneration: adapter.generation(), queryToken: params.scope.queryToken, current: true,
    });
    if (!value || stable(value.scope) !== stable(params.scope)) throw new BridgeError('source-epoch-changed', 'The original task result changed scope.');
    const capture = this.#capture(result.nativeTasks ?? result);
    if (this.#taskResurrection(capture, value)) throw new BridgeError('stale-task-feed', 'The task capture lost availability after this read started.', 409);
    if (capture && this.#taskCapture?.epoch === capture.epoch && capture.seq < this.#taskCapture.seq) throw new BridgeError('stale-task-feed', 'The task result was superseded by a newer observation.', 409);
    const response = this.#taskTransfers.response(value, params.since);
    if (capture) this.#taskCapture = capture;
    this.#latestTasks = { raw: result.nativeTasks ?? result, value };
    this.#view.nativeTasks = result.nativeTasks ?? result;
    await this.#publishMetadata(this.#view, epoch, await this.#lease());
    await this.#assertTaskOwner(params.scope, epoch);
    return response;
  }

  /** Content-free lifecycle pages; no operation receipt or model execution.
   * @param {unknown} params */
  async #readTaskLogs(params) {
    if (!object(params) || Object.keys(params).some(key => !['scope', 'taskId', 'before', 'limit'].includes(key)) || !object(params.scope)
      || params.taskId != null && (typeof params.taskId !== 'string' || !params.taskId || params.taskId.length > 256)
      || params.before != null && (typeof params.before !== 'string' || !params.before || params.before.length > 256)
      || params.limit !== undefined && (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 100)) throw new BridgeError('invalid-rpc-payload', 'A bounded original task log page is required.');
    const epoch = await this.#epoch(); await this.#assertTaskOwner(params.scope, epoch);
    const limit = params.limit ?? 12;
    const result = await /** @type {Value} */ (this.#options.adapter).taskLogPage(this.nativeId, { scope: params.scope, taskId: params.taskId ?? null,
      before: params.before ?? null, limit, expectedHostId: this.#options.sourceIdentity.hostId,
      expectedGeneration: epoch, expectedQueryToken: params.scope.queryToken });
    await this.#assertTaskOwner(params.scope, epoch);
    if (!object(result) || stable(result.scope) !== stable(params.scope) || !Array.isArray(result.logs) || result.logs.length > limit) throw new BridgeError('invalid-native-task-page', 'The original task log page is invalid.');
    const bounded = (/** @type {unknown} */ value, /** @type {number} */ max = 512) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
    const logs = result.logs.map((/** @type {Value} */ row) => {
      if (!object(row) || !bounded(row.id) || !bounded(row.nativeTaskId, 256) || params.taskId != null && row.nativeTaskId !== params.taskId
        || !Number.isSafeInteger(row.sequence) || row.sequence < 0 || !['task_started', 'task_progress', 'task_updated', 'task_notification'].includes(row.subtype)
        || !bounded(row.taskType, 64) || !['agent', 'shell', 'workflow', 'remote-agent', 'other'].includes(row.kind)
        || !['pending', 'running', 'paused', 'completed', 'failed', 'stopped', 'unknown'].includes(row.status)) throw new BridgeError('invalid-native-task-page', 'The original task log identity is invalid.');
      return { id: row.id, identity: 'local-log', sequence: row.sequence, nativeTaskId: row.nativeTaskId, subtype: row.subtype,
        taskType: bounded(row.taskType, 64), kind: bounded(row.kind, 64), status: bounded(row.status, 64),
        nativeStatus: bounded(row.nativeStatus, 64),
        isBackgrounded: typeof row.isBackgrounded === 'boolean' ? row.isBackgrounded : null,
        ...(bounded(row.nativeEventId) ? { nativeEventId: row.nativeEventId } : {}), ...(bounded(row.timestamp, 80) ? { timestamp: row.timestamp } : {}) };
    });
    if (result.nextCursor != null && !bounded(result.nextCursor, 256) || result.hasMore != null && typeof result.hasMore !== 'boolean') throw new BridgeError('invalid-native-task-page', 'The original task cursor is invalid.');
    return { scope: params.scope, status: bounded(result.status, 80) ?? 'unavailable', available: result.available === true,
      logs, hasMore: result.hasMore ?? null, nextCursor: result.nextCursor ?? null, truncated: result.truncated === true };
  }

  processInbox() {
    if (this.#closed || this.#retiring) return Promise.resolve();
    if (this.#inputFlight) { this.#inputDirty = true; return this.#inputFlight; }
    this.#inputFlight = (async () => {
      do {
      this.#inputDirty = false;
      for (const incoming of this.#options.transport.listInbox()) {
        if (this.#closed) return;
        if (incoming.publishedByThisTransport || incoming.record?.role !== 'user') { await this.#options.transport.ackInbox(incoming.id); continue; }
        await this.#message(incoming); await this.#options.transport.ackInbox(incoming.id);
      }
      await this.#flushEvents();
      } while (this.#inputDirty && !this.#closed);
    })().finally(() => { this.#inputFlight = null; }); return this.#inputFlight;
  }

  /** @param {Value} incoming */
  async #message(incoming) {
    const record = incoming.record;
    if (record.content?.type !== 'text' || typeof record.content.text !== 'string' || !record.content.text.trim()) { await this.#mutate(state => this.#rejectEvent(state, incoming.id, 'invalid-input')); return; }
    const key = `message:${incoming.localId ?? incoming.id}`, existing = this.#state.commands.find((/** @type {Value} */ command) => command.key === key);
    const inputDigest = this.#mac(record.content.text);
    if (existing) { if (existing.inputDigest !== inputDigest) throw new BridgeError('command-conflict', 'The stable Happy input identity was reused for other text.'); await this.#execute(existing); return; }
    const view = this.#view, action = typeof view.currentTurnId === 'string' ? 'steer' : 'send', epoch = await this.#epoch();
    const selection = this.#options.sourceIdentity.app === 'antigravity' && this.#state.nextMessageSettings?.epoch === epoch ? this.#state.nextMessageSettings : null;
    const plan = { key, id: 'hc' + hash([this.bindingId, incoming.localId ?? incoming.id, action]).slice(0, 62), origin: 'message', serverId: incoming.id, localId: incoming.localId, inputDigest, action,
      payload: { text: record.content.text, ...(selection ? { model: selection.model, modelIdentity: selection.nativeIdentity } : {}) }, ...(selection ? { settingsSelectionId: selection.commandId } : {}),
      ...(this.#options.sourceIdentity.app === 'claude-desktop' ? { nativeQuery: { queryToken: this.#query(view, epoch)?.queryToken } } : {}), epoch, expectedTurnId: view.currentTurnId ?? null, state: 'prepared', admission: null };
    await this.#mutate(state => state.commands.push(plan)); await this.#execute(plan);
  }

  /** @param {Value} plan @returns {Promise<Value>} */
  #execute(plan) {
    if (this.#commandFlights.has(plan.id)) return /** @type {Promise<Value>} */ (this.#commandFlights.get(plan.id));
    const flight = this.#executePlan(plan).finally(() => { this.#commandFlights.delete(plan.id); }); this.#commandFlights.set(plan.id, flight); return flight;
  }
  /** @param {Value} plan */
  async #executePlan(plan) {
    const saved = this.#state.commands.find((/** @type {Value} */ item) => item.id === plan.id), prior = this.#options.receipts.query(this.receiptScope, plan.id);
    if (saved.state !== 'prepared' || prior) {
      if (prior) {
        // query只提供状态，不能校验payload摘要；重复run仅用于既有receipt校验，永不重新调用native。
        await this.#options.receipts.run(this.receiptScope, plan.id, { action: plan.action, payload: plan.payload, epoch: plan.epoch, expectedTurnId: plan.expectedTurnId }, async () => { throw new BridgeError('delivery-unknown', 'The previous native receipt disappeared; no native redispatch was attempted.'); });
      }
      await this.#mutate(state => { const command = state.commands.find((/** @type {Value} */ item) => item.id === plan.id); if (prior && ['running', 'complete', 'failed', 'unknown'].includes(prior.status)) { command.state = prior.status; command.result = prior.result; command.error = prior.error; command.nativeCause = nativeCauseCode(prior.nativeCause); if (prior.result?.nativeAdmission?.confirmed) command.admission = prior.result.nativeAdmission; } else if (command.state === 'dispatching') { command.state = 'unknown'; command.error = 'unconfirmed-prior-dispatch'; } this.#reconcileCommands(state, this.#view); this.#receiptEvent(state, command); });
      return this.#mustReceipt(plan.id);
    }
    await this.#mutate(state => { const command = state.commands.find((/** @type {Value} */ item) => item.id === plan.id); command.state = 'dispatching'; });
    const receipt = await this.#options.receipts.run(this.receiptScope, plan.id, { action: plan.action, payload: plan.payload, epoch: plan.epoch, expectedTurnId: plan.expectedTurnId }, async () => {
      await this.#guard(plan);
      let result;
      try {
        result = plan.action === 'stop-task'
          ? await /** @type {Value} */ (this.#options.adapter).stopTask(this.nativeId, plan.payload.taskId, plan.id, { scope: structuredClone(plan.payload.scope), expectedHostId: this.#options.sourceIdentity.hostId })
          : await this.#options.adapter.command(this.nativeId, plan.action, structuredClone(plan.payload), plan.id, { expectedGeneration: plan.epoch,
            ...(plan.nativeQuery ? { expectedQueryToken: plan.nativeQuery.queryToken } : {}) });
        if (plan.action === 'stop-task' && (!object(result) || result.taskId !== plan.payload.taskId || stable(result.scope) !== stable(plan.payload.scope)
          || result.stopped !== true || result.readbackConfirmed !== true || result.nativeDispatchConfirmed !== true)) throw new BridgeError('delivery-unknown', 'The original task stop has no matching native terminal readback; no replay is allowed.');
        if (plan.action === 'stop-task' && (this.#closed || !await this.#lease() || await this.#epoch() !== plan.epoch)) throw new BridgeError('delivery-unknown', 'The original task owner changed after dispatch; no replay is allowed.');
      }
      catch (error) {
        if (plan.action !== 'stop-task' && error instanceof BridgeError && /** @type {BridgeError & {effectMayHaveOccurred?:boolean}} */ (error).effectMayHaveOccurred !== true && SAFE_NATIVE_ERRORS.has(error.code)) throw error;
        if (error instanceof BridgeError && /** @type {BridgeError & {effectMayHaveOccurred?:boolean}} */ (error).effectMayHaveOccurred === false) throw error;
        const unknown = new BridgeError('delivery-unknown', 'The native command may have occurred; it will not be replayed.');
        const cause = error instanceof BridgeError ? nativeCauseCode(/** @type {BridgeError & {nativeCause?:unknown}} */ (error).nativeCause ?? (plan.action === 'stop-task' ? error.code : undefined)) : undefined;
        if (cause) Object.assign(unknown, { nativeCause: cause });
        throw unknown;
      }
      if (plan.action === 'update-settings' && this.#options.sourceIdentity.app === 'claude-desktop'
        && (result.applied !== true || !confirmedNativeSettingsEvidence(result.nativeSettingsEvidence, plan.payload.expectedScope, result.controls))) {
        throw new BridgeError('delivery-unknown', 'The original Query did not confirm the requested settings operation; no replay is allowed.');
      }
      if (plan.action === 'update-settings' && result.applied === true) {
        const claude = this.#options.sourceIdentity.app === 'claude-desktop';
        const nativeEvidence = claude ? confirmedNativeSettingsEvidence(result.nativeSettingsEvidence, plan.payload.expectedScope, result.controls) : null;
        if (claude && !nativeEvidence) throw new BridgeError('delivery-unknown', 'The captured original Query did not confirm effective model and effort; no replay is allowed.');
        try {
          await this.#mutate(state => {
            const command = state.commands.find((/** @type {Value} */ item) => item.id === plan.id);
            command.nativeSettingsUpdate = { applied: true, model: claude ? nativeEvidence?.effectiveModel : plan.payload.model,
              reasoningEffort: claude ? nativeEvidence?.effectiveReasoningEffort : plan.payload.reasoningEffort, ownerEpoch: plan.epoch,
              ...(claude ? { nativeEvidence } : {}) };
          });
        } catch { throw new BridgeError('delivery-unknown', 'The applied original settings acknowledgment could not be checkpointed; no update replay is allowed.'); }
        if (result.settingsReadbackConfirmed !== true) throw new BridgeError('delivery-unknown', 'The original settings were applied, but readback is unconfirmed; this update will not be replayed.');
      }
      if (plan.action === 'stage-settings' && result.staged === true && object(result.nativeIdentity)) {
        await this.#mutate(state => {
          const previous = state.nextMessageSettings?.epoch === plan.epoch ? state.nextMessageSettings : null;
          const displayedModel = previous?.model ?? result.controls?.model?.observedCurrent?.model;
          if (displayedModel !== plan.payload.expectedModel || plan.payload.expectedReasoningEffort !== null) throw new BridgeError('settings-conflict', 'The displayed source model selection changed before staging.');
          state.nextMessageSettings = { model: plan.payload.model, nativeIdentity: result.nativeIdentity, epoch: plan.epoch, commandId: plan.id };
        });
      }
      if (['send', 'steer'].includes(plan.action)) {
        const evidence = await this.#waitAdmission(plan, result);
        if (!evidence) throw new BridgeError('delivery-unknown', 'Native acknowledgment has no verified input admission; it will not be resent.');
        return { ...result, nativeAdmission: evidence };
      }
      return result;
    });
    await this.#mutate(state => { const command = state.commands.find((/** @type {Value} */ item) => item.id === plan.id); command.state = receipt.status; command.result = receipt.result; command.error = receipt.error; command.nativeCause = nativeCauseCode(receipt.nativeCause); command.admission = receipt.result?.nativeAdmission ?? command.admission; this.#reconcileCommands(state, this.#view); this.#receiptEvent(state, command); });
    return this.#mustReceipt(plan.id);
  }

  /** @param {Value} plan @param {Value} result */
  async #waitAdmission(plan, result) {
    if (await this.#epoch() !== plan.epoch || !viewOwnerMatches(this.#view, plan.epoch)
      || result.ownerGeneration !== undefined && result.ownerGeneration !== plan.epoch) return null;
    const explicit = result.admitted === true || result.admissionConfirmed === true;
    if (this.#options.sourceIdentity.app === 'claude-desktop' && explicit && (typeof result.messageId !== 'string' || !result.messageId.startsWith('claude:') || result.messageId.length <= 7 || result.messageId.length > 512)) return null;
    if (explicit && (!plan.payload.modelIdentity || result.modelReadbackConfirmed === true)) return { confirmed: true, turnId: this.#options.sourceIdentity.app === 'claude-desktop' ? null : result.turnId ?? null, messageId: result.messageId ?? null, queued: result.queued === true };
    const deadline = Date.now() + (this.#options.admissionTimeoutMs ?? 5000);
    do {
      if (await this.#epoch() !== plan.epoch || !viewOwnerMatches(this.#view, plan.epoch)) return null;
      const row = observedInputRow(this.#view, plan.id, result.messageId);
      if (row && (!plan.payload.modelIdentity || stable(row.nativeModel) === stable(plan.payload.modelIdentity))) {
        if (await this.#epoch() !== plan.epoch || !viewOwnerMatches(this.#view, plan.epoch)) return null;
        return { confirmed: true, turnId: this.#options.sourceIdentity.app === 'claude-desktop' ? null : row.turnId ?? null, messageId: row.id, queued: false };
      }
      if (await this.#epoch() !== plan.epoch) return null;
      try {
        const next = viewOf(await this.#options.adapter.snapshot(this.nativeId));
        if (await this.#epoch() !== plan.epoch || !viewOwnerMatches(next, plan.epoch)) return null;
        this.#view = next;
      } catch { return null; }
      if (Date.now() >= deadline) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 25));
    } while (!this.#closed);
    return null;
  }
  /** @param {Value} state @param {Value} view */
  #reconcileCommands(state, view) {
    if (this.#historical(view) || !viewOwnerMatches(view, state.epoch)) return;
    for (const command of state.commands) {
      const questionReply = command.origin === 'rpc' && command.action === 'answer-question';
      if (!(command.origin === 'message' && ['send', 'steer'].includes(command.action) || questionReply)
        || !['dispatching', 'running', 'unknown', 'complete'].includes(command.state)) continue;
      const row = observedInputRow(view, command.id, command.result?.messageId);
      if (!row || state.epoch !== command.epoch || questionReply && row.inputStatus !== 'accepted' || command.payload?.modelIdentity && stable(row.nativeModel) !== stable(command.payload.modelIdentity)) continue;
      command.admission = { confirmed: true, turnId: this.#options.sourceIdentity.app === 'claude-desktop' ? null : row.turnId ?? null, messageId: row.id, queued: false }; command.resolvedByObservation = true; this.#receiptEvent(state, command);
      if (command.settingsSelectionId && state.nextMessageSettings?.commandId === command.settingsSelectionId) { delete state.nextMessageSettings; this.#controlsReadAt = 0; }
    }
  }
  /** @param {Value} state @param {Value} command */
  #receiptEvent(state, command) {
    if (command.origin !== 'message' || !command.serverId) return;
    if (this.#options.sourceIdentity.app === 'claude-desktop' && command.admission?.confirmed && typeof command.admission.messageId === 'string') {
      const eventId = 'hr' + hash([this.bindingId, command.id, 'accepted']).slice(0, 28);
      command.acceptedReceipt ??= { nativeMessageId: command.admission.messageId, disposition: command.admission.queued === true ? 'queued' : 'admitted' };
      if (!state.events.some((/** @type {Value} */ event) => event.id === eventId)) this.#event(state, eventId, 'agent', null, {
        t: 'user-message-accepted', id: eventId, ref: command.serverId, runId: null, ...command.acceptedReceipt });
    } else if (command.admission?.confirmed && command.admission.turnId) {
      const eventId = 'hr' + hash([this.bindingId, command.id, 'accepted']).slice(0, 28);
      this.#event(state, eventId, 'agent', command.admission.turnId, { t: 'user-message-accepted', id: eventId, ref: command.serverId, runId: command.admission.turnId });
    } else if (command.state === 'failed') this.#rejectEvent(state, command.serverId, command.error ?? 'native-rejected');
    else if (command.state === 'unknown' && !command.admission?.confirmed) {
      const eventId = 'hr' + hash([this.bindingId, command.id, 'delivery-unknown']).slice(0, 28);
      // 未知结果不能伪装“已接受/失败”；发布关联原消息的非终态提示，晚到原生身份可继续确认。
      this.#event(state, eventId, 'agent', null, { t: 'user-message-delivery-unknown', ref: command.serverId, commandId: command.id });
    }
  }
  /** @param {Value} state @param {string} serverId @param {string} reason */
  #rejectEvent(state, serverId, reason) { const eventId = 'hr' + hash([this.bindingId, serverId, 'rejected']).slice(0, 28); this.#event(state, eventId, 'agent', null, { t: 'user-message-rejected', ref: serverId, reason }); }
  /** @param {string} command */
  #publicReceipt(command) { const value = this.#state.commands.find((/** @type {Value} */ item) => item.id === command); return value ? { id: value.id, commandId: value.id, target: this.#receiptTarget(value), status: value.admission?.confirmed ? 'complete' : value.state,
    nativeReceiptStatus: value.resolvedBySettingsObservation ? this.#options.receipts.query(this.receiptScope, value.id)?.status ?? value.state : value.state,
    admission: value.admission ?? null, result: value.result ?? null, error: value.error ?? null, ...(nativeCauseCode(value.nativeCause) ? { nativeCause: nativeCauseCode(value.nativeCause) } : {}) } : null; }
  /** Nonsecret logical target lets another question proceed without replaying this operation. @param {Value} command */
  #receiptTarget(command) {
    if (typeof command.rpcTarget === 'string') return command.rpcTarget;
    if (command.action === 'answer-question' && typeof command.payload?.questionItemId === 'string') {
      const key = 'cq' + hash([this.bindingId, command.payload.questionItemId]).slice(0, 28);
      return rpcTarget('communication', { id: key });
    }
    if (command.action === 'interrupt') return rpcTarget('abort', { turnId: command.payload?.turnId, queryToken: command.payload?.queryToken });
    return undefined;
  }
  /** @param {string} command @returns {Value} */
  #mustReceipt(command) { const receipt = this.#publicReceipt(command); if (!receipt) throw new BridgeError('missing-command-plan', 'The saved native command plan is missing.'); return receipt; }
  /** @param {unknown} params */
  async #receiptQuery(params) {
    if (!object(params)) throw new BridgeError('invalid-command-id', 'A receipt commandId is required.');
    const key = commandId(params.commandId), command = this.#state.commands.find((/** @type {Value} */ item) => item.id === key);
    if (command?.nativeSettingsUpdate?.applied === true && command.state === 'unknown') {
      try { const controls = await this.#options.adapter.command(this.nativeId, 'read-controls', {}, key, { expectedGeneration: command.epoch }); await this.#confirmSettingsObservation(command, controls); } catch { /* A failed read cannot trigger a second write. */ }
    }
    return { ok: true, receipt: this.#publicReceipt(key) ?? this.#options.receipts.query(this.receiptScope, key) ?? null };
  }
  /** @param {Value} command @param {Value} controls */
  async #confirmSettingsObservation(command, controls) {
    if (this.#options.sourceIdentity.app === 'claude-desktop') {
      try { controls = this.#validateSettingsControls(controls, command.epoch); } catch { return; }
    }
    const evidence = command.nativeSettingsUpdate, current = controls.model?.current;
    const claude = this.#options.sourceIdentity.app === 'claude-desktop';
    if (claude && !confirmedNativeSettingsEvidence(evidence?.nativeEvidence, command.payload?.expectedScope, controls)) return;
    if (this.#closed || command.state !== 'unknown' || evidence?.applied !== true || evidence.ownerEpoch !== command.epoch ||
        !await this.#lease() || await this.#epoch() !== command.epoch || current?.model !== evidence.model || current?.reasoningEffort !== evidence.reasoningEffort) return;
    await this.#mutate(state => {
      const saved = state.commands.find((/** @type {Value} */ item) => item.id === command.id);
      if (!saved || saved.state !== 'unknown' || saved.nativeSettingsUpdate?.applied !== true
        || saved.epoch !== command.epoch || saved.nativeSettingsUpdate.ownerEpoch !== command.epoch) return;
      const nativeSettingsEvidence = claude
        ? confirmedNativeSettingsEvidence(saved.nativeSettingsUpdate.nativeEvidence, saved.payload?.expectedScope, controls) : null;
      if (claude && !nativeSettingsEvidence) return;
      saved.state = 'complete'; saved.resolvedBySettingsObservation = true; saved.error = null;
      saved.result = { acknowledged: true, applied: true, settingsReadbackConfirmed: true, controls,
        ...(nativeSettingsEvidence ? { nativeSettingsEvidence } : {}) };
    });
    this.#nativeControls = controls; this.#controlsReadAt = Date.now();
    await this.#options.transport.updateMetadata((/** @type {Value} */ current) => ({ ...current, nativeControls: { ...controls, model: { ...controls.model, available: this.#state.sourceStatus === 'connected' && controls.model?.available === true } },
      capabilities: { ...current.capabilities, modelSelection: this.#state.sourceStatus === 'connected' && controls.model?.available === true, reasoningSelection: this.#state.sourceStatus === 'connected' && controls.model?.available === true,
        ...(this.#options.sourceIdentity.app === 'claude-desktop' ? { rpcMethods: [...(current.capabilities?.rpcMethods ?? []).filter((/** @type {string} */ method) => method !== 'codex-controls-update'),
          ...(this.#state.sourceStatus === 'connected' && controls.model?.available === true && this.#view.nativeReadOnly === false ? ['codex-controls-update'] : [])] } : {}) } }));
  }

  /** Read model controls independently of transcript projection; this never starts a turn.
   * @param {string|null} epoch @param {boolean} [force] @returns {Promise<Value>} */
  #refreshControls(epoch, force = false) {
    if (this.#historical(this.#view)) return Promise.reject(new BridgeError('source-unavailable', 'Saved history has no current model settings controller.'));
    if (this.#settingsChildBlocked()) return Promise.reject(new BridgeError('unsupported-action', 'Native subagents have no independent model settings controller.'));
    if (this.#options.adapter.supportsNativeModelSettings !== true) return Promise.reject(new BridgeError('unsupported-action', 'This source has no original model settings contract.'));
    if (this.#controlsFlight) return this.#controlsFlight;
    if (!force && this.#nativeControls && this.#controlsEpoch === epoch && Date.now() - this.#controlsReadAt < 10000) {
      try { return Promise.resolve(this.#validateSettingsControls(this.#nativeControls, epoch)); } catch { this.#nativeControls = null; this.#controlsReadAt = 0; }
    }
    const read = (async () => {
      const revision = this.#controlsRevision;
      if (this.#closed || epoch === null || !await this.#lease() || !isCodeLightNativeSource({ ...this.#options.sourceIdentity, runtimeGeneration: epoch }, { controlMode: 'session' })) throw new BridgeError('source-unavailable', 'The original settings owner is unavailable.');
      const queryToken = this.#query(this.#view, epoch)?.queryToken;
      const controls = this.#validateSettingsControls(this.#selectedControls(await this.#options.adapter.command(this.nativeId, 'read-controls', {}, 'controls-read-' + randomUUID(),
        { expectedGeneration: epoch, ...(this.#options.sourceIdentity.app === 'claude-desktop' ? { expectedQueryToken: queryToken } : {}) }), epoch), epoch);
      if (this.#closed || this.#settingsChildBlocked() || !await this.#lease() || await this.#epoch() !== epoch) throw new BridgeError('source-epoch-changed', 'The original settings owner changed during read.');
      // 设置更新已开始时，旧只读结果不能在 RPC 确认后覆盖用户的新选择。
      if (revision !== this.#controlsRevision) { this.#controlsReadAt = 0; return this.#nativeControls ?? controls; }
      this.#nativeControls = controls; this.#controlsEpoch = epoch; this.#controlsReadAt = Date.now();
      for (const command of this.#state.commands) if (command.state === 'unknown' && command.nativeSettingsUpdate?.applied === true) await this.#confirmSettingsObservation(command, controls);
      await this.#options.transport.updateMetadata((/** @type {Value} */ current) => ({ ...current, nativeControls: { ...controls, model: { ...controls.model, available: this.#state.sourceStatus === 'connected' && controls.model?.available === true } },
        capabilities: { ...current.capabilities, modelSelection: this.#state.sourceStatus === 'connected' && controls.model?.available === true, reasoningSelection: this.#state.sourceStatus === 'connected' && controls.model?.available === true,
          ...(this.#options.sourceIdentity.app === 'claude-desktop' ? { rpcMethods: [...(current.capabilities?.rpcMethods ?? []).filter((/** @type {string} */ method) => method !== 'codex-controls-update'),
            ...(this.#state.sourceStatus === 'connected' && controls.model?.available === true && this.#view.nativeReadOnly === false ? ['codex-controls-update'] : [])] } : {}) } }));
      return controls;
    })().finally(() => { if (this.#controlsFlight === read) this.#controlsFlight = null; });
    this.#controlsFlight = read; return read;
  }
  /** @param {Value} [view] */
  #settingsChildBlocked(view = this.#view) {
    return this.#metadata?.nativeSession?.isSubagent === true || view?.nativeInput?.available === false && view.nativeInput.reason === 'parent-owned-subagent';
  }
  /** @param {Value} controls @param {string|null} epoch @param {Value} [view] @returns {Value} */
  #validateSettingsControls(controls, epoch, view = this.#view) {
    if (this.#options.sourceIdentity.app !== 'claude-desktop') return controls;
    const scope = nativeSettingsScope(controls.scope), source = this.#options.sourceIdentity, query = this.#query(view, epoch);
    if (!scope || scope.nativeConversationId !== this.nativeId || scope.hostId !== source.hostId || scope.nativeCollection !== source.nativeCollection
      || scope.appMode !== source.appMode || scope.ownerGeneration !== epoch || scope.runtimeGeneration !== /** @type {Value} */ (this.#options.adapter).generation?.()
      || scope.queryToken !== query?.queryToken) throw new BridgeError('source-epoch-changed', 'The original model catalogue belongs to another Query.');
    return { ...controls, scope, model: { ...controls.model, available: this.#options.adapter.supportsNativeModelSettings === true && view.nativeReadOnly === false && controls.model?.available === true } };
  }
  /** @param {unknown} params */
  async #readControlsRpc(params) {
    if (!object(params) || Object.keys(params).some(key => key !== 'commandId')) throw new BridgeError('invalid-rpc-payload', 'A controls read accepts only its stable command identity.');
    const key = commandId(params.commandId), epoch = await this.#epoch();
    const receipt = await this.#options.receipts.run(this.receiptScope, key, { action: 'read-controls', epoch }, () => this.#refreshControls(epoch, true));
    return this.#rpcReply(receipt);
  }

  /** @param {string} method @param {unknown} params */
  async #rpc(method, params) {
    if (!object(params)) throw new BridgeError('invalid-rpc-payload', 'A typed native RPC payload is required.');
    const key = commandId(params.commandId), existing = this.#state.commands.find((/** @type {Value} */ item) => item.id === key);
    const requestDigest = this.#mac({ method, params });
    if (existing) {
      // 原摘要遗漏 method 会把 open-desktop 回执误当 abort 成功；旧计划只能按已冻结动作识别原接口后迁移。
      const originalMethod = existing.rpcMethod ?? (existing.action === 'interrupt' ? 'abort' : existing.action === 'open-desktop' ? 'open-desktop'
        : existing.action === 'answer-question' || existing.action === 'approval' && existing.payload?.kind === 'user-input' ? 'communication'
          : existing.action === 'approval' ? 'permission' : null);
      if (originalMethod !== method || existing.requestDigest !== (existing.rpcMethod ? requestDigest : this.#mac(params))) throw new BridgeError('command-conflict', 'The stable RPC id was reused for another request or method.');
      if (!existing.rpcMethod) await this.#mutate(state => { const saved = state.commands.find((/** @type {Value} */ item) => item.id === key); saved.rpcMethod = method; saved.requestDigest = requestDigest; });
      if (existing.resolvedBySettingsObservation && existing.state === 'complete') return this.#rpcReply(this.#mustReceipt(key));
      return this.#rpcReply(await this.#execute(existing));
    }
    let plan;
    const epoch = await this.#epoch();
    if (method === 'window-control') {
      if (!['activate', 'click', 'press', 'type', 'key', 'scroll'].includes(params.action) || !object(params.payload)) throw new BridgeError('unsupported-action', 'An explicit supported window action and typed payload are required.');
      const keys = ['captureStamp', 'runtimeGeneration', 'windowGeneration', 'nodeId', 'text', 'key', 'x', 'y', 'deltaY'];
      if (Object.keys(params.payload).some(key => !keys.includes(key))) throw new BridgeError('invalid-payload', 'Window control cannot add arbitrary native fields.');
      plan = { action: params.action, payload: structuredClone(params.payload), expectedTurnId: null, windowControl: true };
    } else if (method === 'open-desktop') {
      plan = { action: 'open-desktop', payload: {}, expectedTurnId: null };
    } else if (method === 'abort') {
      if (this.#options.sourceIdentity.app === 'claude-desktop') {
        if (Object.keys(params).some(key => !['commandId', 'queryToken'].includes(key))) throw new BridgeError('invalid-rpc-payload', 'A native query cancellation accepts its exact query token.');
        const queryToken = id(params.queryToken, 'Original native query');
        const query = this.#query(this.#view, epoch);
        if (!query || query.canCancel !== true || query.queryToken !== queryToken) throw new BridgeError('stale-turn', 'The displayed native query is no longer cancellable.');
        plan = { action: 'interrupt', payload: { queryToken }, expectedTurnId: null, nativeQuery: { queryToken } };
      } else {
        const turnId = id(params.turnId, 'Original foreground turn');
        plan = { action: 'interrupt', payload: { turnId }, expectedTurnId: turnId };
      }
    } else if (method === 'native-task-stop') {
      if (Object.keys(params).some(name => !['commandId', 'scope', 'taskId'].includes(name)) || !object(params.scope)
        || typeof params.taskId !== 'string' || !params.taskId.trim() || params.taskId.length > 256 || /[\x00-\x1f\x7f]/.test(params.taskId)
        || typeof /** @type {Value} */ (this.#options.adapter).stopTask !== 'function') throw new BridgeError('invalid-rpc-payload', 'An exact original task and stable command ID are required.');
      await this.#assertTaskOwner(params.scope, epoch); this.#taskControl(params.scope, params.taskId, 'stop');
      plan = { action: 'stop-task', payload: { scope: structuredClone(params.scope), taskId: params.taskId }, expectedTurnId: null };
    } else if (method === 'source-command') {
      if (/** @type {Value} */ (this.#options.adapter).supportsSourceCommands !== true || Object.keys(params).some(key => !['commandId', 'name', 'arguments'].includes(key)) || typeof params.name !== 'string' || typeof params.arguments !== 'string') throw new BridgeError('unsupported-action', 'A verified native source command is required.');
      plan = { action: 'source-command', payload: { name: params.name, arguments: params.arguments }, expectedTurnId: null };
    } else if (method === 'codex-controls-update') {
      if (this.#settingsChildBlocked()) throw new BridgeError('unsupported-action', 'Native subagents have no independent model settings controller.');
      if (this.#options.adapter.supportsNativeModelSettings !== true) throw new BridgeError('unsupported-action', 'This source has no original model settings contract.');
      const keys = ['commandId', 'model', 'reasoningEffort', 'expectedModel', 'expectedReasoningEffort'];
      const claude = this.#options.sourceIdentity.app === 'claude-desktop';
      if (Object.keys(params).some(key => !keys.includes(key) && !(claude && key === 'expectedScope')) || keys.some(key => !Object.hasOwn(params, key)) ||
          typeof params.model !== 'string' || !params.model.trim() || typeof params.expectedModel !== 'string' || !params.expectedModel.trim() ||
          params.reasoningEffort !== null && typeof params.reasoningEffort !== 'string' || params.expectedReasoningEffort !== null && typeof params.expectedReasoningEffort !== 'string') throw new BridgeError('invalid-settings', 'A model choice and the original settings snapshot are required.');
      const controls = this.#options.sourceIdentity.app === 'antigravity' ? await this.#refreshControls(epoch, true) : null;
      let expectedScope;
      if (claude) {
        if (this.#view.nativeReadOnly !== false) throw new BridgeError('native-read-only', 'The original model settings owner is read-only.');
        const current = await this.#refreshControls(epoch, true);
        expectedScope = nativeSettingsScope(params.expectedScope);
        if (!expectedScope || !sameNativeSettingsScope(expectedScope, current.scope) || current.model?.available !== true
          || current.model?.current?.model !== params.expectedModel || current.model?.current?.reasoningEffort !== params.expectedReasoningEffort) throw new BridgeError('settings-conflict', 'The displayed original Query settings changed.');
      }
      if (controls?.model?.selectionMode === 'next-message' && (controls.model.current?.model !== params.expectedModel || controls.model.current?.reasoningEffort !== params.expectedReasoningEffort)) throw new BridgeError('settings-conflict', 'The displayed source model selection changed.');
      plan = { action: controls?.model?.selectionMode === 'next-message' ? 'stage-settings' : 'update-settings', payload: { model: params.model, reasoningEffort: params.reasoningEffort, expectedModel: params.expectedModel, expectedReasoningEffort: params.expectedReasoningEffort,
        ...(expectedScope ? { expectedScope } : {}) }, expectedTurnId: null,
        ...(expectedScope ? { nativeQuery: { queryToken: expectedScope.queryToken } } : {}) };
      this.#controlsRevision++;
    } else {
      const mapping = this.#state.requestMap.find((/** @type {Value} */ item) => item.key === params.id);
      if (!mapping || mapping.epoch !== epoch) throw new BridgeError('stale-approval', 'The original pending request mapping is unavailable.');
      if (method === 'permission') plan = this.#permissionPlan(mapping, params);
      else plan = this.#communicationPlan(mapping, params);
    }
    const full = { ...plan, id: key, key: `rpc:${key}`, origin: 'rpc', rpcMethod: method, rpcTarget: rpcTarget(method, params), state: 'prepared', epoch, requestDigest, admission: null };
    const admitted = await this.#mutate(state => {
      // Preparation awaits owner/scope reads. Another same-ID request can be
      // admitted during that gap, so compare again inside the serialized write.
      const prior = state.commands.find((/** @type {Value} */ item) => item.id === key);
      if (prior) {
        if (prior.rpcMethod !== method || prior.requestDigest !== requestDigest) throw new BridgeError('command-conflict', 'The stable RPC ID was admitted for another request.');
        return prior;
      }
      state.commands.push(full); return full;
    });
    const result = await this.#execute(admitted);
    if (method === 'codex-controls-update' && result.status === 'complete') {
      if (result.result?.controls) { this.#nativeControls = result.result.controls; this.#controlsReadAt = 0; }
      void this.#refreshControls(epoch, true).catch(() => {});
    }
    return this.#rpcReply(result);
  }
  /** @param {Value} result */
  #rpcReply(result) {
    if (result.status !== 'complete') { const error = new BridgeError(result.error ?? (result.status === 'failed' ? 'native-rejected' : 'delivery-unknown'), 'The native operation could not be confirmed.'); Object.assign(error, { effectMayHaveOccurred: result.status !== 'failed', receipt: result, ...(nativeCauseCode(result.nativeCause) ? { nativeCause: nativeCauseCode(result.nativeCause) } : {}) }); throw error; }
    return { ok: true, receipt: result };
  }

  /** @param {Value} mapping @param {Value} params */
  #permissionPlan(mapping, params) {
    if (mapping.type !== 'request' || params.mode != null || (params.allowTools?.length ?? 0) || params.updatedInput != null || params.decision === 'approved_for_session') throw new BridgeError('unsupported-permission-mode', 'This native permission mode or input rewrite is unsupported.');
    const request = mapping.request, requestLink = { type: 'request', kind: mapping.kind, requestId: mapping.requestId, digest: this.#mac(mapping.request) };
    if (['command', 'file'].includes(mapping.kind)) {
      const decision = params.decision === 'abort' ? 'cancel' : params.approved === true ? 'accept' : params.approved === false ? 'decline' : null;
      if (!decision || decision === 'accept' && request.acceptSupported === false || request.allowedActions && !request.allowedActions.includes(decision)) throw new BridgeError('unsupported-approval', 'The requested native permission action is unavailable.');
      return { action: 'approval', payload: { ...(this.#options.sourceIdentity.app === 'claude-desktop' ? {} : { kind: mapping.kind }), requestId: mapping.requestId, decision }, request: requestLink };
    }
    if (mapping.kind === 'permissions' && typeof params.approved === 'boolean') {
      const scope = params.scope ?? 'turn';
      if (!['turn', 'session'].includes(scope) || !request.grantScopes?.includes(scope)) throw new BridgeError('unsupported-permission-mode', 'The requested native permission scope is unavailable.');
      const response = params.approved ? { permissions: request.requestedPermissions, scope } : { permissions: {}, scope };
      return { action: 'approval', payload: { kind: 'permissions', requestId: mapping.requestId, response }, request: requestLink };
    }
    if (mapping.kind === 'elicitation' && object(params.response)) return { action: 'approval', payload: { kind: 'elicitation', requestId: mapping.requestId, response: params.response }, request: requestLink };
    throw new BridgeError('unsupported-approval', 'Use the verified native question/form channel for this request.');
  }
  /** @param {Value} mapping @param {Value} params */
  #communicationPlan(mapping, params) {
    if (params.kind != null && params.kind !== 'form') throw new BridgeError('unsupported-communication', 'This native communication requires the matching form kind.');
    if (params.status !== 'answered' || !object(params.answers)) throw new BridgeError('unsupported-communication', 'This native question requires an explicit answer.');
    const answerText = (/** @type {Value} */ answer) => [...(Array.isArray(answer.options) ? answer.options.filter((/** @type {unknown} */ text) => typeof text === 'string') : []), ...(typeof answer.custom === 'string' && answer.custom.trim() ? [answer.custom] : [])];
    if (mapping.type === 'async-question') {
      if (Object.keys(params.answers).length !== 1 || !object(params.answers.answer)) throw new BridgeError('invalid-answer-identity', 'Answer the original asynchronous question identity.');
      const answer = answerText(params.answers.answer).join('\n'); if (!answer.trim()) throw new BridgeError('invalid-answer', 'A nonempty original question answer is required.');
      return { action: 'answer-question', payload: { questionItemId: mapping.questionItemId, answer }, request: { type: 'async-question', questionItemId: mapping.questionItemId } };
    }
    if (mapping.kind !== 'user-input' || (mapping.request.questions ?? []).some((/** @type {Value} */ question) => question.secret)) throw new BridgeError('unsupported-communication', 'This native communication is not supported by the Happy form.');
    const questions = mapping.request.questions ?? [], expected = questions.map((/** @type {Value} */ question) => question.id);
    if (Object.keys(params.answers).length !== expected.length || Object.keys(params.answers).some(key => !expected.includes(key))) throw new BridgeError('invalid-answer-identity', 'Answer ids must match the pending native questions.');
    /** @type {Value} */ const answers = {};
    for (const question of questions) { if (!object(params.answers[question.id])) throw new BridgeError('invalid-answer', 'An answer object is required.'); answers[question.id] = { answers: answerText(params.answers[question.id]) }; }
    return { action: 'approval', payload: { kind: 'user-input', requestId: mapping.requestId, response: { answers } }, request: { type: 'request', kind: 'user-input', requestId: mapping.requestId, digest: this.#mac(mapping.request) } };
  }

  /** Atomically retire an idle CodeLight observer; unknown history remains durable.
   * @returns {Promise<boolean>} */
  tryCloseIfIdle() {
    if (this.#closeFlight) return this.#closeFlight.then(() => true);
    // 同一同步片段先封住入口再复查；忙时恢复入口，不能用检查后的异步 close 留出 admission 窗口。
    this.#retiring = true;
    if (this.#unsafeToRetire()) { this.#retiring = false; return Promise.resolve(false); }
    return this.close().then(() => true);
  }
  #unsafeToRetire() {
    if (this.#starting || this.#operations.size || this.#commandFlights.size || this.#inputFlight || this.#attachFlight ||
      this.#projectFlight || this.#pendingView || this.#flushFlight || this.#controlsFlight ||
      this.#state.commands?.some((/** @type {Value} */ command) => ['prepared', 'dispatching', 'running'].includes(command.state)) ||
      this.#state.events?.some((/** @type {Value} */ event) => !event.sent)) return true;
    // 未知 transport 状态不是空队列；当前实现提供同步状态，退休后 late capture 仍由原 close 保存。
    try {
      const value = this.#options.transport.status();
      return !Number.isSafeInteger(value.pendingInbox) || value.pendingInbox !== 0 || !Number.isSafeInteger(value.pendingOutbox) || value.pendingOutbox !== 0;
    } catch { return true; }
  }
  close() {
    if (!this.#closeFlight) {
      this.#closed = true; this.#retiring = true;
      this.#closeFlight = Promise.resolve().then(() => this.#close());
    }
    return this.#closeFlight;
  }
  async #close() {
    this.#release?.(); this.#release = null;
    if (this.#retryTimer) clearInterval(this.#retryTimer);
    for (const release of this.#rpcReleases.splice(0)) release();
    await Promise.allSettled([this.#startFlight, this.#attachFlight, this.#projectFlight, this.#inputFlight, this.#flushFlight, this.#controlsFlight, ...this.#operations, ...this.#commandFlights.values()]); await this.#ioTail;
    this.#taskTransfers.clear(); this.#latestTasks = null; this.#taskCapture = null; this.#taskInvalidation = null;
    this.#releaseState();
  }
  #releaseState() { if (this.#ownsState) { owners.delete(this.statePath); this.#ownsState = false; } }
}
