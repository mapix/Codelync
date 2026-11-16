import { ClaudeDesktopRpcClient, claudeDesktopHostId } from './claude-desktop-rpc.mjs';
import { claudeTranscriptView, projectClaudeNativeTranscript, projectClaudeNativeMessage } from './claude-history.mjs';
import { projectClaudeTasks, readClaudeTaskLogPage } from './claude-tasks.mjs';
import { sourceNativeTasks } from './source-native-tasks.mjs';
import { BridgeError } from '../errors.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { nativeSettingsScope, sameNativeSettingsScope, confirmedNativeSettingsEvidence } from '../happy/native-settings-scope.mjs';

/** @typedef {Record<string,any>} Value */
const TASK_EVENT_TYPES = new Set(['task_started', 'task_progress', 'task_updated', 'task_notification', 'background_tasks_changed']);
/** @param {unknown} value */
const taskMessage = value => record(value) && value.type === 'system' && TASK_EVENT_TYPES.has(value.subtype);
/** @param {unknown} value @returns {value is Value} */
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
/** @param {unknown} value @param {number} [max] */
const identity = (value, max = 512) => typeof value === 'string' && !!value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
/** @param {unknown} input @returns {string[]} */
const taskTypes = input => Array.isArray(input) && input.length === 1 && input[0] === 'local_bash' ? ['local_bash'] : [];
/** Session-own/background activity only; selected input/turn semantics stay separate.
 * @param {Value} header @param {string} mode */
const directoryStatus = (header, mode) => {
  const positive = header.isRunning === true && header.headerIdentityVerified !== false || mode === 'code' && header.headerIdentityVerified === true
    && (header.turnRunning === true || header.hasBackgroundActivity === true || header.hasBackgroundWork === true);
  if (positive) return header.pendingPermissionCount > 0 ? 'waiting' : 'running';
  if (mode === 'code') return header.headerIdentityVerified === true && header.headerCollectionComplete === true && header.isRunning === false
    && header.turnRunning === false && header.hasBackgroundActivity === false && header.hasBackgroundWork === false ? 'idle' : 'unknown';
  return header.isRunning === false && header.headerIdentityVerified !== false && header.headerCollectionComplete !== false ? 'idle' : 'unknown';
};
/** @param {Value} a @param {Value} b */
const sameTaskScope = (a, b) => ['app', 'nativeCollection', 'hostId', 'parentConversationId', 'ownerGeneration', 'runtimeGeneration', 'queryToken', 'cliSessionId'].every(key => a[key] === b[key]);
/** Native desktop owner only. Unsupported modes/actions remain unavailable. */
export class ClaudeDesktopBackend {
  get supportsNativeModelSettings() { return this.controlsPolicy?.generation === this.rpc.generation() && this.controlsPolicy?.hostId === this.hostId()
    && this.controlsPolicy?.methods?.includes(this.namespace + '.controls') === true; }
  supportsNativeHistoryPaging = true;
  get readOnly() { return this.rpc?.isReadOnly?.() === true || this.rpc?.latestRuntime?.readOnly === true || this.rpc?.latestRuntime?.mutationAllowed === false
    || this.ownerPolicy?.generation === this.rpc?.generation() && this.ownerPolicy?.hostId === this.hostId() && this.ownerPolicy?.readOnly === true; }
  get supportsSourceCommands() { return false; }
  get supportedActions() { return this.readOnly ? [] : [...(this.appMode === 'chat' ? ['send', 'interrupt'] : ['send', 'interrupt', 'approval']),
    ...(this.supportsNativeModelSettings ? ['read-controls', ...(this.appMode === 'code' ? ['update-settings'] : [])] : [])]; }
  /** @param {{rpc?:ClaudeDesktopRpcClient,pollMs?:number,appMode?:'code'|'chat',now?:()=>number,taskFreshMs?:number,taskFeedNegativeTtlMs?:number}} [options] */
  constructor(options = {}) {
    this.rpc = options.rpc ?? new ClaudeDesktopRpcClient(); this.pollMs = options.pollMs ?? 500;
    this.now = options.now ?? Date.now; this.taskFreshMs = options.taskFreshMs ?? 5000; this.taskFeedNegativeTtlMs = options.taskFeedNegativeTtlMs ?? 2000;
    /** @type {Value|null} */ this.taskFeedNegative = null;
    /** @type {Value|null} */ this.ownerPolicy = null;
    /** @type {Value|null} */ this.controlsPolicy = null;
    this.appMode = options.appMode ?? 'code'; this.namespace = this.appMode === 'chat' ? 'cowork' : 'code'; this.collection = this.appMode === 'chat' ? 'local-agent-mode-sessions' : 'claude-code-sessions';
    if (!['code', 'chat'].includes(this.appMode)) throw new BridgeError('unsupported-native-mode', 'This Claude Desktop mode has not been verified.');
    /** @type {Map<string,Value>} */ this.sessions = new Map();
    /** @type {Map<string,Value>} */ this.taskStates = new Map();
    /** @type {Map<string,Promise<Value>>} */ this.taskFlights = new Map();
    /** @type {Map<string,Promise<Value>>} */ this.taskReads = new Map();
    /** @type {Map<string,number>} */ this.taskPending = new Map();
    this.taskCaptureEpoch = randomBytes(16).toString('hex'); this.taskCaptureSequence = 0;
    /** @type {Map<string,{generation:string,boundaries:Set<string>}>} */ this.history = new Map(); /** @type {Map<string,{generation:string,main:string|null,host:string|null}>} */ this.owners = new Map(); this.disposed = false;
  }
  /** @param {string} [id] */
  generation(id) { if (id === undefined) return this.rpc.generation(); const owner = this.owners.get(id); return owner && owner.main === this.rpc.generation() && owner.host === this.hostId() ? owner.generation : null; }
  hostId() { return this.rpc.latestRuntime ? claudeDesktopHostId(this.rpc.latestRuntime, this.collection) : null; }
  /** @param {string} id @param {unknown} generation */
  rememberOwner(id, generation) { if (typeof generation === 'string') this.owners.set(id,{generation,main:this.rpc.generation(),host:this.hostId()}); }
  /** @param {Value} view */
  inputCapabilities(view) {
    const modeVerified = view.nativeSessionType === this.appMode;
    view.nativeInput.activeSendMode = this.appMode === 'code' ? 'queue' : 'unverified';
    view.nativeInput.canSend = modeVerified && (view.status === 'idle' || this.appMode === 'code' && ['running', 'waiting'].includes(view.status));
    view.nativeCancel.available = modeVerified && view.nativeCancel.available === true;
    if (this.readOnly) {
      view.nativeInput.sendSupported = false; view.nativeInput.canSend = false; view.nativeInput.canSteer = false;
      view.nativeCancel.available = false;
      view.requests = (view.requests ?? []).map((/** @type {Value} */ request) => ({ ...request, operable: false, allowedActions: [] }));
    }
    view.nativeReadOnly = this.readOnly;
    view.nativeQuery = { version: 1, app: 'claude-desktop', nativeConversationId: view.nativeInput.sessionId, hostId: this.hostId(),
      ownerGeneration: view.ownerGeneration, queryToken: view.nativeCancel.queryPresent === true ? view.nativeInput.queryToken : null,
      status: view.status, canSend: view.nativeInput.canSend, activeSendMode: view.nativeInput.activeSendMode,
      canCancel: view.nativeCancel.available === true };
    view.nativeDesktopRuntimeGeneration = this.rpc.generation();
    return view;
  }
  /** Public metadata only: bounded logs and projection state never enter resident agentState.
   * @param {Value} projection @returns {Value} */
  publicTasks(projection) {
    const result = { ...projection }; delete result.state; delete result.logs; delete result.logsTruncated; delete result.observationRejected;
    return { version: 1, scope: projection.state.scope, ...result };
  }
  /** @param {string} id @param {Value|null} [fallbackScope] @returns {Value} */
  unavailableTasks(id, fallbackScope = null) {
    const saved = this.taskStates.get(id), scope = fallbackScope ?? saved?.state.scope ?? null;
    const projected = this.publicTasks(projectClaudeTasks({ scope, observedScope: scope, connected: false, fresh: false, coverage: {} }, saved?.state ?? null));
    return { ...projected, capture: saved?.capture && scope && sameTaskScope(saved.state.scope, scope) ? { ...saved.capture } : null };
  }
  /** @param {string} id @param {Value} view @param {Value} context */
  async attachTasks(id, view, context) {
    if (view.nativeSessionType !== this.appMode) { view.nativeTasks = this.unavailableTasks(id); view.nativeTaskCapture = null;
      view.nativeTaskControls = { version: 1, scope: null, outputTaskTypes: [], stopTaskTypes: [] }; return view; }
    const cached = this.taskFeedNegative;
    if (cached && cached.main === this.rpc.generation() && cached.host === this.hostId() && cached.until > this.now()) view.nativeTasks = this.unavailableTasks(id);
    else try { view.nativeTasks = await this.taskSnapshot(id, { ...context, expectedGeneration: view.ownerGeneration, expectedQueryToken: view.nativeQuery.queryToken }); }
    catch (error) {
      view.nativeTasks = this.unavailableTasks(id);
      if (error instanceof BridgeError && ['unsupported-action', 'unsupported-native-action', 'native-operation-unavailable', 'claude-invalid-task-feed'].includes(error.code)) {
        this.taskFeedNegative = { main: this.rpc.generation(), host: this.hostId(), until: this.now() + this.taskFeedNegativeTtlMs };
      }
    }
    view.nativeDesktopRuntimeGeneration = this.rpc.generation();
    const { capture } = view.nativeTasks;
    view.nativeTaskCapture = capture ? { ...capture } : null;
    const saved = this.taskStates.get(id), scope = view.nativeTasks.scope;
    const controlScope = this.appMode === 'code' && view.nativeTasks.tasksAvailable === true && saved && record(scope)
      && sameTaskScope(saved.state.scope, scope) && scope.ownerGeneration === view.ownerGeneration && scope.runtimeGeneration === this.rpc.generation()
      && scope.hostId === this.hostId() && scope.queryToken === view.nativeQuery?.queryToken && identity(scope.queryToken) ? scope : null;
    view.nativeTaskControls = { version: 1, scope: controlScope,
      outputTaskTypes: controlScope ? [...(saved?.capabilities.outputTaskTypes ?? [])] : [],
      stopTaskTypes: controlScope && !this.readOnly ? [...(saved?.capabilities.stopTaskTypes ?? [])] : [] };
    const semantic = sourceNativeTasks(view.nativeTasks, { app: 'claude-desktop', id, hostId: this.hostId(), nativeCollection: this.collection }, view.ownerGeneration,
      { runtimeGeneration: this.rpc.generation(), queryToken: view.nativeQuery?.queryToken ?? null, current: view.nativeSessionType === this.appMode });
    view.contentStamp = createHash('sha256').update(JSON.stringify([view.contentStamp, semantic?.digest ?? null, view.nativeTaskControls])).digest('hex');
    return view;
  }
  /** A selected native task feed is independent of transcript/message loading.
   * @param {string} id @param {{expectedHostId?:string,expectedGeneration?:string|null,expectedQueryToken?:string|null,scope?:Value}} [context] @returns {Promise<Value>} */
  async taskSnapshot(id, context = {}) {
    if (!identity(id)) throw new BridgeError('invalid-task-request', 'An original parent session identity is required.');
    const key = createHash('sha256').update(JSON.stringify([id, this.collection, this.rpc.generation(), this.hostId(), context.expectedHostId ?? null,
      Object.hasOwn(context, 'expectedGeneration') ? [context.expectedGeneration] : null,
      Object.hasOwn(context, 'expectedQueryToken') ? [context.expectedQueryToken] : null,
      context.scope ? ['app', 'nativeCollection', 'hostId', 'parentConversationId', 'ownerGeneration', 'runtimeGeneration', 'queryToken', 'cliSessionId'].map(name => context.scope?.[name]) : null])).digest('hex');
    const shared = this.taskReads.get(key); if (shared) return shared;
    if ((this.taskPending.get(id) ?? 0) >= 2) throw new BridgeError('native-task-read-busy', 'The selected native task reader is busy.', 503);
    const previous = this.taskFlights.get(id);
    const read = (previous ? previous.catch(() => null) : Promise.resolve()).then(() => this.readTaskSnapshot(id, context));
    this.taskFlights.set(id, read); this.taskReads.set(key, read); this.taskPending.set(id, (this.taskPending.get(id) ?? 0) + 1);
    try { return await read; } finally {
      if (this.taskFlights.get(id) === read) this.taskFlights.delete(id);
      if (this.taskReads.get(key) === read) this.taskReads.delete(key);
      const pending = (this.taskPending.get(id) ?? 1) - 1;
      if (pending > 0) this.taskPending.set(id, pending); else this.taskPending.delete(id);
    }
  }
  /** @param {string} id @param {{expectedHostId?:string,expectedGeneration?:string|null,expectedQueryToken?:string|null,scope?:Value}} context @returns {Promise<Value>} */
  async readTaskSnapshot(id, context) {
    if (this.disposed) throw new BridgeError('claude-desktop-unavailable', 'The native task adapter is unavailable.');
    if (!identity(id)) throw new BridgeError('invalid-task-request', 'An original parent session identity is required.');
    const startedAt = this.now(), before = this.rpc.generation(), prior = this.taskStates.get(id);
    const cursorCurrent = prior && prior.state.scope.runtimeGeneration === before && prior.state.scope.hostId === this.hostId()
      && (context.expectedGeneration === undefined || context.expectedGeneration === prior.state.scope.ownerGeneration)
      && (!Object.hasOwn(context, 'expectedQueryToken') || context.expectedQueryToken === prior.state.scope.queryToken);
    const params = { sessionId: id, cursor: cursorCurrent ? prior.cursor : 0, limit: 128,
      ...(context.expectedGeneration !== undefined ? { expectedOwnerGeneration: context.expectedGeneration } : {}),
      ...(Object.hasOwn(context, 'expectedQueryToken') ? { expectedExecutionToken: context.expectedQueryToken } : {}) };
    const reply = await this.rpc.call(this.namespace + '.taskFeed', params,
      { ...(before !== null ? { expectedGeneration: before } : {}), expectedHostId: context.expectedHostId, collection: this.collection });
    if (this.disposed) throw new BridgeError('claude-desktop-unavailable', 'The native task adapter is unavailable.');
    const scope = reply.scope, main = this.rpc.generation();
    if (!record(scope) || reply.version !== 1 || reply.sessionId !== id || scope.app !== 'claude-desktop' || scope.parentConversationId !== id ||
      scope.nativeCollection !== this.collection || scope.hostId !== this.hostId() || !identity(scope.ownerGeneration) || !identity(scope.runtimeGeneration) ||
      scope.runtimeGeneration !== main || reply.runtimeGeneration !== main || reply.ownerGeneration !== scope.ownerGeneration ||
      ![true, false].includes(reply.queryPresent) || scope.queryToken !== (reply.queryPresent ? reply.executionToken : null) ||
      scope.cliSessionId !== reply.cliSessionId || scope.cliSessionId !== null && !identity(scope.cliSessionId) ||
      scope.queryToken !== null && !identity(scope.queryToken) || !Number.isSafeInteger(reply.cursor) || reply.cursor < 0 ||
      !Array.isArray(reply.events) || reply.events.length > 128 || !record(reply.coverage)) {
      throw new BridgeError('claude-invalid-task-feed', 'A bounded original-owner task feed with exact source/query identity is required.');
    }
    if (this.now() - startedAt > this.taskFreshMs) throw new BridgeError('stale-task-feed', 'The original task read exceeded its freshness bound.', 409);
    if (context.expectedGeneration !== undefined && context.expectedGeneration !== scope.ownerGeneration) throw new BridgeError('source-epoch-changed', 'The original parent owner changed during the task read.', 409);
    if (Object.hasOwn(context, 'expectedQueryToken') && context.expectedQueryToken !== scope.queryToken) throw new BridgeError('stale-turn', 'The original parent query changed during the task read.', 409);
    if (context.scope && !sameTaskScope(context.scope, scope)) throw new BridgeError('stale-task-scope', 'The original task scope changed during the read.', 409);
    const latest = this.taskStates.get(id), same = latest && sameTaskScope(latest.state.scope, scope);
    if (same && reply.cursor < latest.cursor) throw new BridgeError('stale-task-cursor', 'The original task feed cursor moved backwards.', 409);
    const events = reply.events.map((/** @type {Value} */ row) => {
      if (!record(row) || !Number.isSafeInteger(row.sequence) || row.sequence < 0 || row.sequence >= reply.cursor ||
        !record(row.message) || row.message.type !== 'system' || !TASK_EVENT_TYPES.has(row.message.subtype)) throw new BridgeError('claude-invalid-task-feed', 'An original task lifecycle frame is required.');
      return projectClaudeNativeMessage(row.message);
    });
    const previous = latest?.state ?? null;
    const projected = projectClaudeTasks({ scope, observedScope: scope, connected: true, fresh: true, events,
      ...(record(reply.level) ? { level: projectClaudeNativeMessage(reply.level) } : {}), foregroundLevel: reply.foregroundLevel,
      dispatchChildren: reply.dispatchChildren, observationSequence: reply.cursor,
      coverage: { ...reply.coverage, lifecycleComplete: reply.resetRequired === true ? false : reply.coverage.lifecycleComplete === true } },
      reply.resetRequired === true && same ? { ...previous, tasks: previous.tasks.map((/** @type {Value} */ row) => ({ ...row, status: 'unknown' })), tasksTruncated: true } : previous);
    if (projected.state.scope === null || projected.observationRejected) throw new BridgeError('claude-invalid-task-feed', 'The original task observation is unavailable.');
    if (this.taskCaptureSequence >= Number.MAX_SAFE_INTEGER) throw new BridgeError('native-task-capture-exhausted', 'The original task capture sequence is unavailable.');
    const capture = { epoch: this.taskCaptureEpoch, seq: ++this.taskCaptureSequence };
    this.rememberOwner(id, scope.ownerGeneration);
    this.taskStates.delete(id); this.taskStates.set(id, { cursor: reply.cursor, state: projected.state, capture,
      capabilities: { taskOutputVerified: reply.capabilities?.taskOutputVerified === true && taskTypes(reply.capabilities?.outputTaskTypes).length > 0,
        taskStopVerified: !this.readOnly && reply.capabilities?.taskStopVerified === true && taskTypes(reply.capabilities?.stopTaskTypes).length > 0,
        outputTaskTypes: reply.capabilities?.taskOutputVerified === true ? taskTypes(reply.capabilities?.outputTaskTypes) : [],
        stopTaskTypes: !this.readOnly && reply.capabilities?.taskStopVerified === true ? taskTypes(reply.capabilities?.stopTaskTypes) : [] } });
    if (this.taskStates.size > 128) { const oldest = this.taskStates.keys().next().value; if (oldest !== undefined) this.taskStates.delete(oldest); }
    this.taskFeedNegative = null;
    return { ...this.publicTasks(projected), capture: { ...capture } };
  }
  /** On-demand content-free lifecycle logs; the full current source/query scope is mandatory.
   * @param {string} id @param {{scope:Value,taskId?:string|null,before?:string|null,limit?:number,expectedHostId?:string}} context @returns {Promise<Value>} */
  async taskLogPage(id, context) {
    if (!record(context?.scope)) throw new BridgeError('stale-task-scope', 'An exact current task scope is required.', 409);
    const view = await this.taskSnapshot(id, { expectedHostId: context.expectedHostId, expectedGeneration: context.scope.ownerGeneration,
      expectedQueryToken: context.scope.queryToken, scope: context.scope });
    const state = this.taskStates.get(id)?.state;
    if (!state || !sameTaskScope(view.scope, context.scope)) throw new BridgeError('stale-task-scope', 'The original task scope changed during the log read.', 409);
    return { ...readClaudeTaskLogPage(state, { scope: context.scope, taskId: context.taskId, before: context.before, limit: context.limit ?? 12 }), scope: view.scope };
  }
  /** Native output is separate from resident task metadata and is disabled until original readback verification.
   * @param {string} id @param {string} taskId @param {{scope:Value,expectedHostId?:string}} context */
  async getTaskOutput(id, taskId, context) {
    if (!record(context?.scope)) throw new BridgeError('stale-task-scope', 'An exact current task scope is required.', 409);
    const view = await this.taskSnapshot(id, { expectedHostId: context.expectedHostId, expectedGeneration: context.scope.ownerGeneration, expectedQueryToken: context.scope.queryToken, scope: context.scope });
    if (this.appMode !== 'code' || this.taskStates.get(id)?.capabilities.taskOutputVerified !== true || !view.tasksAvailable ||
      !identity(taskId, 256) || !view.tasks.some((/** @type {Value} */ row) => row.nativeTaskId === taskId && this.taskStates.get(id)?.capabilities.outputTaskTypes.includes(row.taskType))
      || !identity(view.scope.queryToken)) throw new BridgeError('unsupported-action', 'Original task output is not verified for this source.');
    const reply = await this.rpc.call('code.taskOutput', { sessionId: id, taskId, expectedOwnerGeneration: view.scope.ownerGeneration, expectedExecutionToken: view.scope.queryToken },
      { expectedGeneration: view.scope.runtimeGeneration, expectedHostId: context.expectedHostId, collection: this.collection });
    if (!record(reply.scope) || !sameTaskScope(reply.scope, view.scope) || reply.sessionId !== id || reply.taskId !== taskId ||
      typeof reply.output !== 'string' || Buffer.byteLength(reply.output) > 65536 || typeof reply.truncated !== 'boolean') throw new BridgeError('claude-invalid-task-output', 'A bounded original task output read is required.');
    return { scope: view.scope, taskId, output: reply.output, truncated: reply.truncated };
  }
  /** Not a generic supported action. Request forwarding is never reported as confirmed termination.
   * @param {string} id @param {string} taskId @param {string} commandId @param {{scope:Value,expectedHostId?:string}} context */
  async stopTask(id, taskId, commandId, context) {
    /** @type {Value} */ let view;
    try {
      if (typeof this.rpc.runtime === 'function') await this.rpc.runtime();
      if (this.readOnly) throw new BridgeError('native-read-only', 'The original Claude Desktop bridge is read-only.');
      if (!record(context?.scope)) throw new BridgeError('stale-task-scope', 'An exact current task scope is required.', 409);
      view = await this.taskSnapshot(id, { expectedHostId: context.expectedHostId, expectedGeneration: context.scope.ownerGeneration, expectedQueryToken: context.scope.queryToken, scope: context.scope });
      if (this.taskStates.get(id)?.capabilities.taskStopVerified !== true || !view.tasksAvailable || !identity(taskId, 256) || !identity(view.scope.queryToken) ||
        !view.tasks.some((/** @type {Value} */ row) => row.nativeTaskId === taskId && this.taskStates.get(id)?.capabilities.stopTaskTypes.includes(row.taskType)
          && ['running', 'pending', 'paused'].includes(row.status))) throw new BridgeError('unsupported-action', 'Original task stop and readback are not verified for this source.');
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(commandId)) throw new BridgeError('invalid-command-id', 'A stable original task operation ID is required.');
    } catch (error) { if (error instanceof Error) Object.assign(error, { effectMayHaveOccurred: false }); throw error; }
    const reply = await this.rpc.call(this.namespace + '.stopTask', { sessionId: id, taskId, expectedOwnerGeneration: view.scope.ownerGeneration, expectedExecutionToken: view.scope.queryToken },
      { expectedGeneration: view.scope.runtimeGeneration, expectedHostId: context.expectedHostId, collection: this.collection, mutation: true, commandId });
    const proof = reply.terminalProof;
    if (!record(reply.scope) || !sameTaskScope(reply.scope, view.scope) || reply.sessionId !== id || reply.taskId !== taskId || reply.stopRequested !== true
      || !record(proof) || proof.kind !== 'native-task-notification' || !Number.isSafeInteger(proof.sequence) || proof.sequence < 0
      || !['stopped', 'completed', 'failed'].includes(proof.status) || proof.nativeEventId !== null && !identity(proof.nativeEventId)) {
      throw Object.assign(new BridgeError('delivery-unknown', 'The original task stop may have occurred; its termination is unconfirmed.'), { effectMayHaveOccurred: true });
    }
    return { taskId, scope: view.scope, stopped: proof.status === 'stopped', terminalStatus: proof.status,
      readbackConfirmed: true, terminalProof: { ...proof }, nativeDispatchConfirmed: true };
  }
  async status() {
    try { const owner = await this.rpc.call('owner.status');
      if (typeof owner.readOnly === 'boolean' || typeof owner.mutationAllowed === 'boolean') this.ownerPolicy = { generation: this.rpc.generation(), hostId: this.hostId(), readOnly: owner.readOnly === true || owner.mutationAllowed === false };
      const declared = Array.isArray(owner.nativeSettingsReadMethods) && owner.nativeSettingsReadMethods.length <= 2
        && owner.nativeSettingsReadMethods.every((/** @type {unknown} */ name) => ['code.controls', 'cowork.controls'].includes(/** @type {string} */ (name))) ? [...new Set(owner.nativeSettingsReadMethods)] : [];
      this.controlsPolicy = owner.nativeOwner === true && typeof owner.runtimeGeneration === 'string' && owner.runtimeGeneration === this.rpc.generation()
        ? { generation: owner.runtimeGeneration, hostId: this.hostId(), methods: declared } : null;
      return { connected: owner.nativeOwner === true, mode: 'native', protocol: 'claude-desktop-native', appMode: this.appMode, readOnly: this.readOnly, mutationAllowed: !this.readOnly }; }
    catch (error) { this.controlsPolicy = null; return { connected: false, mode: 'native', reason: error instanceof BridgeError ? error.code : 'claude-desktop-unavailable' }; }
  }
  /** Native headers only; no conversation read for directory/status.
   * @param {{expectedHostId?:string}} [context] */
  async list(context = {}) {
    const reply = await this.rpc.call(this.namespace + '.list', {}, { expectedHostId: context.expectedHostId, collection: this.collection });
    return (reply.sessions ?? []).filter((/** @type {Value} */ header) => this.appMode === 'code' || header.sessionType === 'chat').map((/** @type {Value} */ header) => { this.rememberOwner(header.sessionId, header.ownerGeneration); return ({ id: header.sessionId, app: 'claude-desktop', kind: 'session',
      protocol: 'claude-desktop-native', adapterKey: 'claude-desktop:' + this.appMode, appMode: this.appMode, nativeCollection: this.collection, hostId: this.hostId(), title: header.title,
      appVersion: this.rpc.latestRuntime?.appVersion ?? null, asarSha256: this.rpc.latestRuntime?.asarSha256 ?? null,
      workspace: header.cwd, model: header.model, parentSessionId: header.parentSessionId, runtimeGeneration: header.ownerGeneration ?? null, ownerGeneration: header.ownerGeneration ?? null,
      parentId: header.parentSessionId ?? null, isSubagent: header.isSubagent === true, subagentsAvailable: false, createdAt: header.createdAt ?? null, updatedAt: header.updatedAt ?? null,
      nativeConversationId: header.sessionId, pendingPermissionCount: header.pendingPermissionCount ?? null,
      turnRunning: header.turnRunning ?? null, hasBackgroundActivity: header.hasBackgroundActivity ?? null, hasBackgroundWork: header.hasBackgroundWork ?? null,
      nativeActivityObservedAt: header.headerReadStartedAt ?? null, nativeActivityScope: 'session-own-and-background',
      nativeStatus: directoryStatus(header, this.appMode), archived: header.archived === true }); });
  }
  /** @param {string} id @param {{expectedHostId?:string}} [context] */
  async snapshot(id, context = {}) {
    const reply = projectClaudeNativeTranscript(await this.rpc.call(this.namespace + '.snapshot', { sessionId: id, limit: 32 }, { expectedHostId: context.expectedHostId, collection: this.collection }));
    const view = this.inputCapabilities(claudeTranscriptView(reply)); this.rememberOwner(id, view.ownerGeneration); const prior = this.sessions.get(id);
    await this.attachTasks(id, view, context);
    if (prior && prior.generation === view.ownerGeneration) { prior.transcript = reply; prior.view = view; }
    this.rememberHistory(id, reply);
    return view;
  }
  /** @param {string} id @param {Value} reply */
  rememberHistory(id, reply) {
    let entry = this.history.get(id);
    if (!entry || entry.generation !== reply.sessionGeneration) { entry = { generation: reply.sessionGeneration, boundaries: new Set() }; this.history.set(id, entry); }
    for (const message of reply.messages) if (message.uuid) entry.boundaries.add('claude:' + message.uuid);
  }
  /** @param {string} id @param {{expectedHostId?:string}} [context] */
  freshSnapshot(id, context = {}) { return this.snapshot(id, context); }
  /** Explicit cursor/gesture required; old history cannot grant controls.
   * @param {string} id @param {{expectedHostId?:string,historyBoundary?:Value}} [context] */
  async historyPage(id, context = {}) {
    const boundary = context.historyBoundary;
    if (!boundary || typeof boundary.id !== 'string' || !boundary.id.startsWith('claude:')) throw new BridgeError('stale-history-cursor', 'An explicit original Claude history boundary is required.', 409);
    const saved = this.history.get(id);
    if (!saved?.boundaries.has(boundary.id) || boundary.ownerGeneration && saved.generation !== boundary.ownerGeneration) throw new BridgeError('stale-history-cursor', 'The original Claude history boundary is no longer available.', 409);
    const generation = saved.generation;
    const reply = projectClaudeNativeTranscript(await this.rpc.call(this.namespace + '.page', { sessionId: id, cursor: boundary.id.slice(7), limit: 32,
      ...(generation ? { expectedOwnerGeneration: generation } : {}) }, { expectedHostId: context.expectedHostId, collection: this.collection }));
    const view = claudeTranscriptView(reply);
    this.rememberHistory(id, reply);
    return { rows: view.rows, ownerGeneration: view.ownerGeneration, historyComplete: view.historyComplete, nativeHistory: view.nativeHistory,
      coverage: { hasMore: reply.hasMore, found: reply.found, source: reply.source, windowFallback: reply.windowFallback, readFailure: reply.readFailure },
      olderCursor: reply.hasMore !== false && view.rows.length ? { id: view.rows[0].id, ownerGeneration: view.ownerGeneration } : null, historyDataOnly: true };
  }
  /** Compatibility only. Shared activation consumes historyPage without promoting controls.
   * @param {string} id @param {{expectedHostId?:string,historyBoundary?:Value}} [context] */
  async completeSnapshot(id, context = {}) { return { ...await this.historyPage(id, context), status: 'unknown', currentTurnId: null, requests: [] }; }
  /** @param {string} id @param {(view:Value)=>void} callback @param {{expectedHostId?:string}} [context] */
  async subscribe(id, callback, context = {}) {
    let session = this.sessions.get(id);
    if (!session) { session = { callbacks: new Set(), events: [], cursor: 0, generation: null, running: false, timer: null, closed: false, stamp: null }; this.sessions.set(id, session); }
    session.callbacks.add(callback); const current = session;
    const poll = async () => {
      if (current.closed || current.running || this.disposed) return; current.running = true;
      try {
        const events = await this.rpc.call(this.namespace + '.events', { sessionId: id, cursor: current.cursor }, { expectedHostId: context.expectedHostId, collection: this.collection });
        if (events.ownerGeneration !== current.generation || events.executionToken !== current.executionToken || events.resetRequired) { current.events = []; current.cursor = 0; current.transcript = null; current.generation = events.ownerGeneration; current.executionToken = events.executionToken; }
        current.cursor = events.cursor;
        const transcriptChanged = (events.events ?? []).some((/** @type {Value} */ event) => !taskMessage(event.message));
        for (const event of events.events ?? []) if (event.message && !taskMessage(event.message)) current.events.push(event.message);
        if (current.events.length > 512) current.events = current.events.slice(-512);
        if (!current.transcript || transcriptChanged) current.transcript = projectClaudeNativeTranscript(await this.rpc.call(this.namespace + '.snapshot', { sessionId: id, limit: 32 }, { expectedHostId: context.expectedHostId, collection: this.collection }));
        if (current.transcript.sessionGeneration !== current.generation) { current.transcript = null; return; }
        const view = this.inputCapabilities(claudeTranscriptView(current.transcript, current.events)); this.rememberOwner(id, view.ownerGeneration);
        await this.attachTasks(id, view, context);
        if (view.contentStamp !== current.stamp) { current.stamp = view.contentStamp; current.view = view; for (const listener of current.callbacks) listener(structuredClone(view)); }
      } catch {
        current.transcript = null; current.events = []; current.cursor = 0;
        if (current.stamp !== 'unavailable') { current.stamp = 'unavailable'; for (const listener of current.callbacks) listener({ rows: [], requests: [], status: 'owner-unavailable', currentTurnId: null, ownerGeneration: null, historyComplete: false }); }
      } finally { current.running = false; }
    };
    await poll();
    if (!current.timer) { current.timer = setInterval(() => { void poll(); }, this.pollMs); current.timer.unref(); }
    return () => { current.callbacks.delete(callback); if (!current.callbacks.size) { current.closed = true; clearInterval(current.timer); this.sessions.delete(id); } };
  }
  /** @param {string} id @param {string} action @param {Value} payload @param {string} commandId @param {{expectedGeneration?:string|null,expectedHostId?:string,expectedQueryToken?:string|null}} [context] */
  async command(id, action, payload, commandId, context = {}) {
    if (typeof this.rpc.runtime === 'function') await this.rpc.runtime();
    if (action === 'read-controls') {
      if (Object.keys(payload).length) throw Object.assign(new BridgeError('invalid-settings', 'A native catalogue read has no settings payload.'), { effectMayHaveOccurred: false });
      return this.nativeControls(id, context);
    }
    if (action === 'update-settings') return this.updateNativeSettings(id, payload, commandId, context);
    if (this.readOnly) throw new BridgeError('native-read-only', 'The original Claude Desktop bridge is read-only.');
    if (!this.supportedActions.includes(action)) throw new BridgeError('unsupported-action', 'This Claude Desktop native action has not been verified.');
    if (typeof commandId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(commandId)) throw new BridgeError('invalid-command-id', 'A stable original Claude command ID is required.');
    if (action === 'send' && (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 1024 * 1024 || Object.keys(payload).some(key => key !== 'text'))) throw new BridgeError('invalid-input', 'A bounded text input is required.');
    const view = await this.freshSnapshot(id, context);
    if (this.readOnly) throw new BridgeError('native-read-only', 'The original Claude Desktop bridge is read-only.');
    if (view.nativeSessionType !== this.appMode) throw new BridgeError('unsupported-native-mode', 'The original Claude Desktop record changed mode.', 409);
    if (context.expectedGeneration !== undefined && context.expectedGeneration !== view.ownerGeneration) throw new BridgeError('source-epoch-changed', 'The Claude Desktop query changed before dispatch.', 409);
    if (Object.hasOwn(context, 'expectedQueryToken') && context.expectedQueryToken !== view.nativeQuery?.queryToken) throw new BridgeError('stale-turn', 'The original Claude Desktop query changed before dispatch.', 409);
    if (action === 'approval') {
      if (Object.keys(payload).some(key => !['requestId', 'decision'].includes(key)) || !['accept', 'decline'].includes(payload.decision)) throw new BridgeError('invalid-approval', 'An explicit original Claude approval decision is required.');
      const request = view.requests.find((/** @type {Value} */ row) => row.requestId === payload.requestId);
      if (!request?.operable || !request.allowedActions.includes(payload.decision)) throw new BridgeError('stale-approval', 'The original Claude permission request is unavailable.', 409);
      const reply = await this.rpc.call('code.permission', { sessionId: id, requestId: payload.requestId, decision: payload.decision === 'accept' ? 'once' : 'deny', expectedOwnerGeneration: view.ownerGeneration, expectedExecutionToken: view.nativeInput.queryToken },
        { expectedGeneration: this.generation(), expectedHostId: context.expectedHostId, mutation: true, commandId, collection: this.collection });
      if (reply.resolved !== true || reply.requestId !== payload.requestId) throw new BridgeError('delivery-unknown', 'The original Claude permission response is unconfirmed.');
      return { approved: payload.decision === 'accept', nativeDispatchConfirmed: true, requestId: reply.requestId };
    }
    if (action === 'interrupt') {
      if (Object.keys(payload).some(key => !['turnId', 'queryToken'].includes(key)) || payload.turnId != null || payload.queryToken !== undefined && payload.queryToken !== view.nativeCancel.queryToken || !['running', 'waiting'].includes(view.status)) throw new BridgeError('stale-turn', 'The original Claude Desktop session is no longer running.', 409);
      const reply = await this.rpc.call(this.namespace + '.interrupt', { sessionId: id, expectedOwnerGeneration: view.ownerGeneration, expectedExecutionToken: view.nativeCancel.queryToken },
        { expectedGeneration: this.generation(), expectedHostId: context.expectedHostId, mutation: true, commandId, collection: this.collection });
      if (reply.cancelRequested !== true || reply.sessionId !== id) throw new BridgeError('delivery-unknown', 'The original Claude Desktop interruption is unconfirmed.');
      return { cancelRequested: true, foregroundActive: reply.observedStatus === 'running', observedStatus: reply.observedStatus, ownerGeneration: reply.ownerGeneration };
    }
    // Native message UUID is deterministic for the stable CodeLight operation ID.
    const hash = createHash('sha256').update(commandId).digest('hex');
    const uuid = `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
    const reply = await this.rpc.call(this.namespace + '.send', { sessionId: id, message: payload.text, messageUuid: uuid, expectedOwnerGeneration: view.ownerGeneration, expectedExecutionToken: view.nativeInput.queryToken },
      { expectedGeneration: this.generation(), expectedHostId: context.expectedHostId, mutation: true, commandId, collection: this.collection });
    if (reply.admitted !== true || reply.messageUuid !== uuid || reply.sessionId !== id) throw new BridgeError('delivery-unknown', 'The original Claude Desktop admission is unconfirmed.');
    return { admitted: true, nativeDispatchConfirmed: true, messageId: 'claude:' + uuid, messageUuid: uuid, ownerGeneration: reply.ownerGeneration,
      ...(typeof reply.queued === 'boolean' ? { queued: reply.queued } : {}) };
  }
  /** Catalogues do not load history and readonly owners remain readable.
   * @param {string} id @param {{expectedGeneration?:string|null,expectedHostId?:string,expectedQueryToken?:string|null}} [context] @returns {Promise<Value>} */
  async nativeControls(id, context = {}) {
    if (this.disposed) throw Object.assign(new BridgeError('claude-desktop-unavailable', 'The original settings reader is unavailable.'), { effectMayHaveOccurred: false });
    if (!this.controlsPolicy || this.controlsPolicy.generation !== this.rpc.generation() || this.controlsPolicy.hostId !== this.hostId()) await this.status();
    if (!this.supportsNativeModelSettings) throw Object.assign(new BridgeError('unsupported-action', 'This owner has not declared native model catalogue reads.'), { effectMayHaveOccurred: false });
    const before = this.rpc.generation();
    const controls = await this.rpc.call(this.namespace + '.controls', { sessionId: id,
      ...(context.expectedGeneration !== undefined ? { expectedOwnerGeneration: context.expectedGeneration } : {}),
      ...(Object.hasOwn(context, 'expectedQueryToken') ? { expectedExecutionToken: context.expectedQueryToken } : {}) },
    { ...(before ? { expectedGeneration: before } : {}), expectedHostId: context.expectedHostId, collection: this.collection });
    const scope = nativeSettingsScope(controls.scope);
    if (this.disposed || !scope || scope.nativeConversationId !== id || scope.appMode !== this.appMode || scope.nativeCollection !== this.collection
      || scope.runtimeGeneration !== this.rpc.generation() || scope.hostId !== this.hostId()
      || context.expectedGeneration !== undefined && scope.ownerGeneration !== context.expectedGeneration
      || Object.hasOwn(context, 'expectedQueryToken') && scope.queryToken !== context.expectedQueryToken) throw Object.assign(new BridgeError('source-epoch-changed', 'The original Query catalogue changed during read.'), { effectMayHaveOccurred: false });
    this.rememberOwner(id, scope.ownerGeneration);
    return { ...controls, scope, model: { ...controls.model, available: !this.readOnly && controls.model?.available === true } };
  }
  /** @param {string} id @param {Value} payload @param {string} commandId @param {{expectedGeneration?:string|null,expectedHostId?:string,expectedQueryToken?:string|null}} context @returns {Promise<Value>} */
  async updateNativeSettings(id, payload, commandId, context) {
    let controls, scope;
    try {
      if (this.disposed) throw new BridgeError('claude-desktop-unavailable', 'The original settings owner is unavailable.');
      if (this.readOnly) throw new BridgeError('native-read-only', 'The original Claude Desktop model settings owner is read-only.');
      if (this.appMode !== 'code') throw new BridgeError('unsupported-action', 'This native settings mode has not been verified.');
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(commandId)) throw new BridgeError('invalid-command-id', 'A stable original settings command ID is required.');
      controls = await this.nativeControls(id, context); scope = nativeSettingsScope(payload.expectedScope);
      if (this.readOnly) throw new BridgeError('native-read-only', 'The original Claude Desktop model settings owner is read-only.');
      if (!scope || !sameNativeSettingsScope(scope, controls.scope) || controls.model?.available !== true
        || controls.model.current?.model !== payload.expectedModel || controls.model.current?.reasoningEffort !== payload.expectedReasoningEffort) throw new BridgeError('settings-conflict', 'The displayed original Query settings changed.');
    } catch (error) { throw Object.assign(error instanceof Error ? error : new BridgeError('unsupported-action', 'The original settings owner is unavailable.'), { effectMayHaveOccurred: false }); }
    const reply = await this.rpc.call(this.namespace + '.settings', { sessionId: id, payload, expectedOwnerGeneration: scope.ownerGeneration, expectedExecutionToken: scope.queryToken },
      { expectedGeneration: this.rpc.generation(), expectedHostId: context.expectedHostId, collection: this.collection, mutation: true, commandId });
    const evidence = confirmedNativeSettingsEvidence(reply.nativeSettingsEvidence, scope, reply.controls);
    if (reply.applied !== true || reply.settingsReadbackConfirmed !== true || !evidence || evidence.confirmedScope.runtimeGeneration !== this.rpc.generation()
      || evidence.confirmedScope.hostId !== this.hostId()) throw Object.assign(new BridgeError('delivery-unknown', 'The original Query model and effort acknowledgement is incomplete.'), { effectMayHaveOccurred: true });
    return { ...reply, nativeSettingsEvidence: evidence, settingsReadbackConfirmed: true };
  }
  async dispose() { this.disposed = true; for (const session of this.sessions.values()) { session.closed = true; clearInterval(session.timer); } this.sessions.clear(); this.taskStates.clear(); this.taskFlights.clear(); this.taskReads.clear(); this.taskPending.clear(); this.taskFeedNegative = null; this.ownerPolicy = null; this.controlsPolicy = null; this.history.clear(); this.owners.clear(); await this.rpc.dispose(); }
}
