import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AntigravityRpcClient, antigravityHostId } from './antigravity-rpc.mjs';
import { BridgeError } from '../errors.mjs';
import { nativeCauseCode } from '../commands.mjs';
import { AntigravityHistoryCatalog, pageAntigravityHistory, antigravityArchivedIds, antigravityCatalogueSemanticStamp } from './antigravity-history.mjs';
import { AntigravitySettings } from './antigravity-settings.mjs';
import { antigravitySubagentIdentity, antigravitySubagentIndex, projectAntigravitySubagentTree,
  antigravitySummaryHasWork } from './antigravity-subagents.mjs';
import { AntigravitySummaryStream } from './antigravity-summary-stream.mjs';
import { aggregateNativeActivity } from './native-aggregate-activity.mjs';
import { resolveLocalGitProjects } from '../happy/project-identity.mjs';

/** @typedef {Record<string,any>} Value */
const ACTIVE = new Set(['CASCADE_RUN_STATUS_RUNNING', 'CASCADE_RUN_STATUS_CANCELING', 'CASCADE_RUN_STATUS_BUSY', 2, 3, 4]);
const IDLE = new Set(['CASCADE_RUN_STATUS_IDLE', 1]);
const STEP_STATUS = new Map([[0, 'unknown'], [1, 'pending'], [2, 'running'], [3, 'completed'], [4, 'failed'], [5, 'cancelled'], [6, 'cancelled'], [7, 'failed'], [8, 'running'], [9, 'waiting'], [11, 'pending'], [12, 'interrupted']]);
const MAX_STEPS = 16384;
const HISTORY_BATCH_STEPS = 16;
const MAX_TEXT = 1024 * 1024;

/** @param {unknown} value @returns {value is Value} */
function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }

/** Only bounded summary/header fields enter the status replica; never steps or prompts.
 * @param {Value} value @returns {Value} */
function nativeResidentHeader(value) {
  const header = Object.create(null);
  for (const key of ['status', 'summary', 'trajectoryId', 'stepCount', 'lastModifiedTime', 'createdTime', 'workspaces', 'source',
    'forkParentConversationId', 'notFullyIdle', 'hasRunningSubagents', 'hasActiveChildren', 'backgroundTaskCount', 'killed', 'interrupted', 'latestExecutorTerminationReason']) {
    if (value[key] !== undefined) header[key] = value[key];
  }
  if (Array.isArray(value.waitingSteps)) header.waitingSteps = Array.from({ length: value.waitingSteps.length }, () => null);
  if (record(value.annotations)) header.annotations = { title: value.annotations.title, archived: value.annotations.archived,
    pinned: value.annotations.pinned, starred: value.annotations.starred };
  const metadata = value.trajectoryMetadata;
  if (record(metadata)) {
    header.trajectoryMetadata = {};
    for (const key of ['parentConversationId', 'rootConversationId', 'rootParentConversationId', 'createdAt', 'workspaceUris', 'workspaces']) {
      if (metadata[key] !== undefined) header.trajectoryMetadata[key] = metadata[key];
    }
    if (record(metadata.subagentSpec)) {
      header.nativeSubagentSpecPresent = Object.keys(metadata.subagentSpec).length > 0;
      header.trajectoryMetadata.subagentSpec = {};
      for (const key of ['role', 'typeName']) if (metadata.subagentSpec[key] !== undefined) header.trajectoryMetadata.subagentSpec[key] = metadata.subagentSpec[key];
    }
  }
  if (typeof value.nativeSubagentSpecPresent === 'boolean') header.nativeSubagentSpecPresent = value.nativeSubagentSpecPresent;
  return header;
}

/** Native folders are explicit workspace roots; preserve monorepo boundaries.
 * @param {Value[]} rows @param {string} [home] */
function resolveAntigravityProjects(rows, home = homedir()) {
  return resolveLocalGitProjects(rows, { saved: { 'electron-saved-workspace-roots': [...new Set(rows.map(row => row.workspace).filter(Boolean))] },
    managedRoot: join(home, '.gemini/antigravity/worktrees'), managedRepoComponent: 0 });
}
/** @param {unknown} value @param {string} [code] @returns {string} */
function nativeId(value, code = 'invalid-session') {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\x00-\x1f]/.test(value)) throw new BridgeError(code, 'A bounded original Antigravity identity is required.');
  return value;
}
/** Only project intended visible text; never native signatures or raw metadata.
 * @param {unknown} value @returns {string} */
function text(value) {
  if (typeof value !== 'string') return '';
  if (value.length > MAX_TEXT) throw new BridgeError('antigravity-text-too-large', 'The native visible text exceeds the projection bound.', 503);
  return value;
}
/** @param {unknown} value @returns {number|null} */
function timestamp(value) {
  const number = typeof value === 'string' ? Date.parse(value) : record(value) && /^\d+$/.test(String(value.seconds)) ? Number(value.seconds) * 1000 + Math.floor(Number(value.nanos ?? 0) / 1e6) : NaN;
  return Number.isFinite(number) ? number : null;
}
/** @param {unknown} value */
function stepStatus(value) {
  if (typeof value === 'number') return STEP_STATUS.get(value) ?? 'unknown';
  const name = typeof value === 'string' ? value.replace('CORTEX_STEP_STATUS_', '').toLowerCase() : '';
  return ({ done: 'completed', generating: 'running', running: 'running', waiting: 'waiting', queued: 'pending', pending: 'pending', canceled: 'cancelled', cleared: 'cancelled', error: 'failed', invalid: 'failed', interrupted: 'interrupted' })[name] ?? 'unknown';
}
/** @param {Value} trajectory @param {number} index */
function rowId(trajectory, index) { return `agy:${trajectory.trajectoryId}:${index}`; }
/** @param {Value} trajectory @param {number} index */
function turnId(trajectory, index) { return `agy-turn:${trajectory.trajectoryId}:${index}`; }
/** @param {Value} step */
function visibleError(step) { const error = step.errorMessage?.error ?? step.error; return text(error?.userErrorMessage || error?.shortError); }
/** @param {Value} step */
function stepName(step) { return text(step.metadata?.toolCall?.name) || String(step.type ?? 'Antigravity tool').replace('CORTEX_STEP_TYPE_', '').toLowerCase(); }
/** @param {Value|undefined} render */
function nativeMarkdown(render) {
  if (!record(render) || render.hidden === true) return '';
  const blocks = render.contentBlocks;
  if (Array.isArray(blocks) && blocks.length > 128) throw new BridgeError('antigravity-text-too-large', 'The native Markdown blocks exceed the projection bound.', 503);
  const parts = Array.isArray(blocks) ? blocks.map(block => text(block?.markdown)).filter(Boolean) : [];
  return text(parts.length ? parts.join('\n\n') : render.markdown);
}
/** @param {Value} step */
function toolOutput(step) {
  if (step.runCommand) return text(step.runCommand.combinedOutput?.full || step.runCommand.combinedOutput?.truncated || step.runCommand.combinedOutputSnapshot?.full || step.runCommand.stdout || step.runCommand.stdoutOutput?.full) + text(step.runCommand.stderr || step.runCommand.stderrOutput?.full);
  if (step.commandStatus) return text(step.commandStatus.combined || step.commandStatus.stdout) + text(step.commandStatus.stderr);
  if (step.viewFile) return text(step.viewFile.content);
  if (step.mcpTool) return text(step.mcpTool.resultString || step.mcpTool.progressMessage);
  if (step.codeAction) {
    const edit = step.codeAction.actionResult?.edit, lines = edit?.diff?.unifiedDiff?.lines;
    if (Array.isArray(lines) && lines.length <= 20000) return lines.map((/** @type {Value} */ line) => (line.type === 'UNIFIED_DIFF_LINE_TYPE_INSERT' ? '+' : line.type === 'UNIFIED_DIFF_LINE_TYPE_DELETE' ? '-' : ' ') + text(line.text)).join('\n');
    return text(step.codeAction.description || step.codeAction.codeInstruction);
  }
  if (step.fileChange) return text(step.fileChange.instruction);
  if (step.taskBoundary) return text(step.taskBoundary.taskSummaryWithCitations || step.taskBoundary.taskSummary || step.taskBoundary.taskStatus);
  if (step.generic) return nativeMarkdown(step.generic.result?.stepRenderInfo) || text(step.generic.result?.result);
  return visibleError(step);
}
/** @param {Value} step @returns {Value} */
function toolInput(step) {
  const call = step.metadata?.toolCall;
  if (typeof call?.argumentsJson === 'string' && call.argumentsJson.length <= MAX_TEXT) {
    try { const value = JSON.parse(call.argumentsJson); if (record(value)) return value; } catch { /* Partial generation remains visible as text. */ }
  }
  if (step.runCommand) return { command: text(step.runCommand.commandLine || step.runCommand.command), cwd: text(step.runCommand.cwd) };
  if (step.viewFile) return { path: text(step.viewFile.absolutePathUri), startLine: step.viewFile.startLine, endLine: step.viewFile.endLine };
  if (step.fileChange) return { path: text(step.fileChange.absolutePathUri) };
  if (record(step.generic?.args)) {
    const entries = Object.entries(step.generic.args);
    if (entries.length > 128 || entries.some(([key, value]) => key.length > 256 || typeof value !== 'string')) throw new BridgeError('antigravity-invalid-response', 'The native generic input does not match its bounded string map.', 503);
    const args = Object.fromEntries(entries.map(([key, value]) => [key, text(value)]));
    text(JSON.stringify(args)); return args;
  }
  return {};
}
/** @param {Value} step @param {Value} trajectory @param {number} index @returns {Value|null} */
function pendingRequest(step, trajectory, index) {
  const requested = step.requestedInteraction;
  if (!record(requested) || stepStatus(step.status) !== 'waiting' || Array.isArray(step.completedInteractions) && step.completedInteractions.length) return null;
  const base = { requestId: `agy-request:${trajectory.trajectoryId}:${index}`, trajectoryId: trajectory.trajectoryId, stepIndex: index, operable: true, itemId: rowId(trajectory, index) };
  if (record(requested.runCommand)) return { ...base, kind: 'command', command: text(step.runCommand?.commandLine || step.runCommand?.command), allowedActions: ['accept', 'decline'], nativeInteraction: 'runCommand' };
  if (record(requested.approvalInteraction)) return { ...base, kind: 'file', command: text(step.metadata?.toolSummary) || stepName(step), allowedActions: ['accept', 'decline'], nativeInteraction: 'approvalInteraction' };
  if (record(requested.permission)) {
    const scopes = requested.permission.approvalScopeFilter;
    const once = !Array.isArray(scopes) || !scopes.length || scopes.includes('PERMISSION_SCOPE_ONCE') || scopes.includes(1);
    return { ...base, kind: 'command', command: text(requested.permission.actionDescription || requested.permission.reason || step.metadata?.toolSummary), allowedActions: once ? ['accept', 'decline'] : ['decline'], acceptSupported: once, nativeInteraction: 'permission' };
  }
  if (record(requested.askQuestion) && Array.isArray(requested.askQuestion.questions) && requested.askQuestion.questions.length <= 32) {
    const questions = requested.askQuestion.questions.map((/** @type {Value} */ question, /** @type {number} */ at) => ({ id: `q${at}`, header: '', question: text(question.question),
      options: Array.isArray(question.options) ? question.options.map((/** @type {Value} */ option) => ({ label: text(option.text) })) : [], secret: false }));
    return { ...base, kind: 'user-input', questions, nativeInteraction: 'askQuestion', nativeQuestions: requested.askQuestion.questions.map((/** @type {Value} */ question) => ({ question: text(question.question), isMultiSelect: question.isMultiSelect === true,
      options: Array.isArray(question.options) ? question.options.map((/** @type {Value} */ option) => ({ id: text(option.id), text: text(option.text) })) : [] })) };
  }
  return { ...base, kind: 'unsupported', operable: false, command: stepName(step) };
}

/** Derived from the shipped 2.31.2 gemini_coder.Trajectory / Step descriptors.
 * @param {string} id @param {Value} reply @param {string} generation */
export function projectAntigravityTrajectory(id, reply, generation) {
  const trajectory = reply.trajectory;
  if (!record(trajectory) || typeof trajectory.trajectoryId !== 'string' || !trajectory.trajectoryId || trajectory.cascadeId && trajectory.cascadeId !== id ||
      trajectory.steps !== undefined && !Array.isArray(trajectory.steps)) throw new BridgeError('antigravity-invalid-response', 'The native trajectory identity or shape is invalid.', 503);
  const steps = trajectory.steps ?? [];
  const offset = reply.nativeStepOffset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 0xffffffff) throw new BridgeError('antigravity-invalid-response', 'The native step offset is invalid.', 503);
  if (steps.length > MAX_STEPS || steps.some((/** @type {unknown} */ step) => !record(step))) throw new BridgeError('antigravity-response-too-large', 'The native trajectory exceeds its projection bounds.', 503);
  /** @type {Value[]} */ const rows = [], requests = [];
  let current = /** @type {string|null} */ (null), latest = /** @type {string|null} */ (null), nativeModel = /** @type {Value|null} */ (null);
  // This is a display grouping only, never an inferred current control turn.
  const prefixTurn = `agy-turn:${trajectory.trajectoryId}:prefix`;
  for (let localIndex = 0; localIndex < steps.length; localIndex++) {
    const index = offset + localIndex, step = steps[localIndex], rid = rowId(trajectory, index), status = stepStatus(step.status), at = timestamp(step.metadata?.createdAt);
    if (step.generic?.result?.stepRenderInfo?.hidden === true || step.systemMessage?.renderInfo?.hidden === true || step.systemMessage?.agentMessage?.hideFromUser === true) continue;
    if (record(step.userInput)) {
      const queued = step.userInput.isQueuedMessage === true || status === 'pending';
      const planner = step.userInput.userConfig?.plannerConfig;
      const model = record(planner?.requestedModel) ? planner.requestedModel : typeof planner?.planModel === 'string' ? { model: planner.planModel } : null;
      if (!queued && model) nativeModel = model;
      latest = turnId(trajectory, index); if (!queued) current = latest;
      const visibleItems = Array.isArray(step.userInput.items) ? step.userInput.items.map((/** @type {Value} */ item) => {
        const command = item.item?.slashCommand?.info?.name;
        return typeof command === 'string' && /^[A-Za-z0-9][A-Za-z0-9_:.-]*$/.test(command) ? '/' + command : text(item.text);
      }).filter(Boolean).join(' ') : '';
      const content = visibleItems || text(step.userInput.userResponse || step.userInput.query);
      rows.push({ id: rid, role: 'user', text: content, tools: [], turnId: latest, status: queued ? 'pending' : status,
        inputStatus: queued ? 'pending' : status === 'failed' ? 'failed' : 'accepted', at, order: index, ...(model ? { nativeModel: model } : {}),
        ...(typeof step.userInput.clientMessageId === 'string' && step.userInput.clientMessageId ? { commandId: step.userInput.clientMessageId } : {}) });
    } else if (record(step.plannerResponse)) {
      const content = text(step.plannerResponse.modifiedResponse || step.plannerResponse.response);
      if (content) rows.push({ id: rid, role: 'assistant', text: content, tools: [], turnId: current ?? prefixTurn, status, at, order: index });
    } else if (record(step.notifyUser)) {
      const content = text(step.notifyUser.notificationContent);
      if (content) rows.push({ id: rid, role: 'assistant', text: content, tools: [], turnId: current ?? prefixTurn, status, at, order: index });
    } else if (record(step.systemMessage)) {
      const message = step.systemMessage.agentMessage, body = text(message?.content);
      const title = body ? text(message?.renderDetails?.messageTitle) : '';
      const content = body ? text(title && title !== body ? title + '\n\n' + body : body) : text(step.systemMessage.message);
      if (content) rows.push({ id: rid, role: body ? 'assistant' : 'system', text: content, tools: [], turnId: current ?? prefixTurn, status, at, order: index });
    } else if (record(step.errorMessage)) {
      const content = visibleError(step);
      if (content) rows.push({ id: rid, role: 'system', text: content, tools: [], turnId: current ?? prefixTurn, status: 'failed', at, order: index });
    } else if (step.metadata?.toolCall || step.runCommand || step.viewFile || step.mcpTool || step.fileChange || step.commandStatus || step.taskBoundary || step.generic) {
      const tid = text(step.metadata?.toolCall?.id) || rid;
      rows.push({ id: rid, role: 'tool', text: '', tools: [{ id: tid, name: stepName(step), arguments: toolInput(step), output: toolOutput(step), status }], turnId: current ?? prefixTurn, status, at, order: index });
    }
    const request = pendingRequest(step, trajectory, index); if (request) requests.push(request);
  }
  const active = ACTIVE.has(reply.status), waiting = requests.length > 0;
  const status = active ? waiting ? 'waiting' : 'running' : IDLE.has(reply.status) ? 'idle' : 'unknown';
  const activeTurn = active ? current ?? (offset ? null : `agy-turn:${trajectory.trajectoryId}:initial`) : null;
  const total = reply.numTotalSteps ?? 0;
  return { rows, requests, status, currentTurnId: activeTurn, latestTurnId: latest, ownerGeneration: generation,
    revision: null, contentStamp: createHash('sha256').update(JSON.stringify({ rows, requests, status, currentTurnId: activeTurn, total })).digest('hex'),
    historyComplete: offset === 0 && Number.isSafeInteger(total) && total === steps.length, nativeStepOffset: offset, nativeStepEnd: offset + steps.length, nativeStepTotal: total,
    trajectoryId: trajectory.trajectoryId, nativeModel,
    workspaceUris: trajectory.metadata?.workspaceUris ?? trajectory.metadata?.workspaces?.map((/** @type {Value} */ workspace) => workspace.workspaceFolderAbsoluteUri).filter(Boolean) ?? [] };
}

/** @param {string} id @param {Value} summary @param {string} generation @param {string} hostId */
export function antigravitySource(id, summary, generation, hostId) {
  let workspace = '';
  const uri = summary.workspaces?.[0]?.workspaceFolderAbsoluteUri ?? summary.trajectoryMetadata?.workspaceUris?.[0];
  if (typeof uri === 'string') { try { if (uri.startsWith('file:')) workspace = fileURLToPath(uri); } catch { /* Malformed URI is not a workspace. */ } }
  const annotations = summary.annotations ?? {};
  const child = antigravitySubagentIdentity(summary);
  return { app: 'antigravity', id: nativeId(id), hostId, kind: 'session', adapterKey: 'antigravity', protocol: 'antigravity-connect', runtimeGeneration: generation,
    title: text(annotations.title || summary.summary) || child.name || (child.isSubagent ? `Subagent ${id.slice(0, 8)}` : 'Antigravity'),
    agentName: child.name, isSubagent: child.isSubagent, preview: '', workspace, available: true,
    createdAt: timestamp(summary.createdTime ?? summary.trajectoryMetadata?.createdAt) ?? 0,
    updatedAt: timestamp(summary.lastModifiedTime) ?? 0,
    parentId: child.isSubagent ? child.parentId : summary.forkParentConversationId || summary.trajectoryMetadata?.parentConversationId || null,
    isPinned: annotations.pinned === true || annotations.starred === true, archived: annotations.archived === true,
    ...(workspace ? { project: { key: workspace, path: workspace, label: workspace.split('/').filter(Boolean).at(-1) || workspace } } : {}) };
}

export class AntigravityBackend {
  supportsNativeModelSettings = true;
  supportsNativeHistoryPaging = true;
  supportedActions = Object.freeze(['send', 'steer', 'interrupt', 'approval', 'read-controls', 'stage-settings']);
  /** @param {{rpc?:Value,runtimePath?:string,pollMs?:number,now?:()=>number,historyIndex?:Value|false,settings?:Value,summaryStream?:Value,summaryStreamFactory?:(scope:Value)=>Value}} [options] */
  constructor(options = {}) {
    this.rpc = options.rpc ?? new AntigravityRpcClient({ runtimePath: options.runtimePath }); this.now = options.now ?? Date.now;
    this.settings = options.settings ?? new AntigravitySettings({ rpc: this.rpc });
    this.historyIndex = options.historyIndex === false ? null : options.historyIndex ?? new AntigravityHistoryCatalog({ rpc: this.rpc, now: this.now });
    this.inventoryComplete = true; this.catalogueStamp = '';
    this.residentIndexComplete = false;
    this.pollMs = options.pollMs ?? 1000;
    if (!Number.isSafeInteger(this.pollMs) || this.pollMs < 1000) throw new BridgeError('invalid-refresh-rate', 'Antigravity selected-session refresh cannot exceed one request per second.');
    /** @type {Map<string,Value>} */ this.sessions = new Map();
    /** @type {Map<string,Value>} */ this.activities = new Map();
    /** @type {Map<string,string>} */ this.indexHints = new Map();
    /** @type {Value[]} */ this.catalog = [];
    /** @type {Value[]} */ this.excludedSources = [];
    /** @type {Value[]} */ this.residentCatalog = [];
    /** @type {Value} */ this.residentSummaries = {};
    /** @type {Value} */ this.baseResidentSummaries = {};
    this.subagentIndex = antigravitySubagentIndex({});
    this.summaryStreamFactory = options.summaryStreamFactory ?? (scope => options.summaryStream ?? new AntigravitySummaryStream({ rpc: this.rpc,
      expectedHostId: scope.hostId, generation: scope.generation, now: this.now }));
    this.summaryStream = /** @type {Value|null} */ (null);
    this.summaryScope = /** @type {Value|null} */ (null);
    this.summaryRead = /** @type {Value|null} */ (null);
    this.summaryUnsubscribe = /** @type {(()=>void)|null} */ (null);
    this.indexCapturedAt = 0;
    /** @type {Map<string,Value>} */ this.subagentGroups = new Map();
    this.indexHost = /** @type {string|null} */ (null); this.indexGeneration = /** @type {string|null} */ (null);
    this.catalogueHost = /** @type {string|null} */ (null); this.catalogueGeneration = /** @type {string|null} */ (null);
    /** @type {Map<string,{owner:string,trajectoryId:string,offset:number}>} */ this.historyOffsets = new Map();
    /** Materialized public rows, separate from native-read intent and live controls.
     * @type {Map<string,Value[]>} */ this.materializedHistory = new Map();
    /** @type {Map<string,number>} */ this.historyReadGenerations = new Map();
    /** @type {Promise<Value[]>|null} */ this.indexFlight = null;
    /** @type {Promise<Value[]>|null} */ this.residentFlight = null;
    this.indexAt = 0; this.catalogueAt = 0; this.indexSemanticStamp = null; this.catalogueIndexStamp = null; this.disposed = false;
  }
  generation() { return this.rpc.generation(); }
  hostId() { return this.rpc.latestRuntime ? antigravityHostId(this.rpc.latestRuntime) : null; }
  /** @param {string} hostId @param {string} generation */
  async scopedSummaryStream(hostId, generation) {
    if (this.summaryStream && (this.summaryScope?.hostId !== hostId || this.summaryScope?.generation !== generation)) {
      this.summaryUnsubscribe?.(); this.summaryUnsubscribe = null;
      const previous = this.summaryStream; this.summaryStream = null; this.summaryRead = null;
      await previous.dispose?.();
    }
    if (!this.summaryStream) {
      this.summaryScope = { hostId, generation };
      try {
        this.summaryStream = this.summaryStreamFactory(this.summaryScope);
        this.summaryUnsubscribe = this.summaryStream.subscribe?.((/** @type {Value} */ change) => this.summaryChanged(change)) ?? null;
      } catch { this.summaryStream = null; }
    }
    return this.summaryStream;
  }
  /** @param {Value|null} read @param {string} hostId @param {string} generation */
  summaryProofMatches(read, hostId, generation) {
    return read?.available === true && read.scope?.hostId === hostId && read.scope?.generation === generation
      && read.liveProof?.currentAlive === true && read.liveProof?.hostId === hostId && read.liveProof?.generation === generation
      && read.liveProof?.fullReplacement === true && read.liveProof?.proto3Defaults === true
      && typeof read.streamEpoch === 'string' && !!read.streamEpoch && read.liveProof.streamEpoch === read.streamEpoch;
  }
  /** Continuous stream coverage avoids bulk polling solely to renew status age. */
  liveSummaryIndex() {
    if (!this.summaryStream || !this.indexHost || !this.indexGeneration || this.generation() !== this.indexGeneration || this.hostId() !== this.indexHost) return false;
    return this.summaryProofMatches(this.summaryStream.getReplica([], { expectedHostId: this.indexHost, generation: this.indexGeneration }), this.indexHost, this.indexGeneration);
  }
  /** Reduced replica only; a new stream epoch cannot borrow old row authority.
   * @param {string} id @returns {boolean} */
  currentActivityAuthority(id) {
    const value = this.activities.get(id), proof = value?.liveSummaryProof;
    if (!proof || !this.summaryStream || !this.indexHost || !this.indexGeneration || this.generation() !== this.indexGeneration || this.hostId() !== this.indexHost) return false;
    let read;
    try { read = this.summaryStream.getReplica(value?.proofIds ?? [id], { expectedHostId: this.indexHost, generation: this.indexGeneration }); }
    catch { return false; }
    return this.summaryProofMatches(read, this.indexHost, this.indexGeneration) && read.streamEpoch === proof.streamEpoch
      && (value?.proofIds ?? [id]).every((/** @type {string} */ key) => read.states?.[key] === 'ready');
  }
  /** @param {Value} change */
  summaryChanged(change) {
    if (this.disposed || !this.indexHost || !this.indexGeneration || !this.summaryStream) return;
    const matching = change.scope?.hostId === this.indexHost && change.scope?.generation === this.indexGeneration
      && this.generation() === this.indexGeneration && this.hostId() === this.indexHost;
    const ids = [...new Set([...Object.keys(this.baseResidentSummaries), ...(Array.isArray(change.changedIds) ? change.changedIds : [])])];
    this.summaryRead = matching ? this.summaryStream.getReplica(ids, { expectedHostId: this.indexHost, generation: this.indexGeneration }) : null;
    if (this.summaryProofMatches(this.summaryRead, this.indexHost, this.indexGeneration)) {
      for (const id of ids) if (!Object.hasOwn(this.baseResidentSummaries, id) && this.summaryRead?.states?.[id] === 'ready' && record(this.summaryRead.headers?.[id])) this.baseResidentSummaries[id] = structuredClone(this.summaryRead.headers[id]);
    }
    this.rebuildActivity(true);
    this.publishCachedStatus();
  }
  /** Recompute status/topology from headers only, without project scans/history.
   * @param {boolean} [invalidated] */
  rebuildActivity(invalidated = false) {
    if (!this.indexHost || !this.indexGeneration) return;
    const hostId = this.indexHost, generation = this.indexGeneration, read = this.summaryRead;
    const rich = this.summaryProofMatches(read, hostId, generation);
    /** @type {Value} */ const summaries = Object.create(null);
    for (const [id, base] of Object.entries(this.baseResidentSummaries)) {
      if (rich && read?.states?.[id] === 'deleted') continue;
      const ready = rich && read?.states?.[id] === 'ready' && record(read.headers?.[id]);
      summaries[id] = { ...base, ...(ready ? read.headers[id] : {}), nativeSummaryAvailable: ready,
        nativeActivityInvalidated: !ready && (invalidated || rich), nativeObservedAt: ready ? read.captures?.[id] ?? read.observedAt : this.indexCapturedAt };
      if (ready) {
        summaries[id].killed = read.headers[id].killed ?? false;
        summaries[id].interrupted = read.headers[id].interrupted ?? false;
        summaries[id].latestExecutorTerminationReason = read.headers[id].latestExecutorTerminationReason ?? 0;
        summaries[id].waitingSteps = read.headers[id].waitingSteps ?? [];
      }
      // The stream exposes reduced status headers, not a replacement private metadata body.
      if (ready && record(read.headers[id].trajectoryMetadata)) summaries[id].trajectoryMetadata = {
        ...(record(base.trajectoryMetadata) ? base.trajectoryMetadata : {}), ...read.headers[id].trajectoryMetadata,
        ...(record(read.headers[id].trajectoryMetadata.subagentSpec) ? { subagentSpec: {
          ...(record(base.trajectoryMetadata?.subagentSpec) ? base.trajectoryMetadata.subagentSpec : {}), ...read.headers[id].trajectoryMetadata.subagentSpec } } : {}) };
    }
    this.residentSummaries = summaries; this.subagentIndex = antigravitySubagentIndex(summaries);
    const activities = new Map();
    for (const [id, summary] of Object.entries(summaries)) {
      const ownActive = summary.nativeActivityInvalidated !== true && ACTIVE.has(summary.status);
      const ownKnown = ownActive || IDLE.has(summary.status) && summary.nativeSummaryAvailable === true && summary.nativeActivityInvalidated !== true;
      const ownWaiting = ownActive && Array.isArray(summary.waitingSteps) && summary.waitingSteps.length > 0;
      const tree = projectAntigravitySubagentTree(this.subagentIndex, id, hostId, generation);
      const members = tree.allRows.slice(0, 256);
      const allCurrent = summary.nativeSummaryAvailable === true && tree.allRows.every(row => summaries[row.nativeConversationId]?.nativeSummaryAvailable === true);
      const rosterComplete = this.residentIndexComplete && tree.activityComplete && allCurrent && (summary.hasActiveChildren !== true || tree.total > 0)
        && (summary.hasRunningSubagents !== true || members.some(row => ['running', 'waiting'].includes(row.status)));
      const aggregate = aggregateNativeActivity({ app: 'antigravity', parentConversationId: id, hostId, ownerGeneration: generation,
        ownStatus: ownKnown ? ownActive ? 'running' : 'idle' : 'unknown', ownWaiting, subagents: members,
        rosterAvailable: this.residentIndexComplete, rosterComplete, nativeChildActive: antigravitySummaryHasWork(summary) });
      const proofIds = aggregate.known && rich ? summary.nativeSummaryAvailable === true && antigravitySummaryHasWork(summary) ? [id]
        : allCurrent && rosterComplete ? [id, ...tree.allRows.map(row => row.nativeConversationId)]
        : members.filter(row => ['running', 'waiting'].includes(row.status) && summaries[row.nativeConversationId]?.nativeSummaryAvailable === true).map(row => row.nativeConversationId) : [];
      activities.set(id, { known: aggregate.known, active: aggregate.active, waiting: aggregate.waiting, ownKnown, ownActive, ownWaiting,
        ownNativeStatus: summary.status, status: aggregate.known ? 'ready' : 'unavailable', observedAt: summary.nativeObservedAt,
        generation, revision: rich ? read?.revision : null, aggregateActivity: aggregate,
        ...(proofIds.length ? { liveSummaryProof: { ...read?.liveProof }, proofIds } : {}) });
    }
    this.activities = activities;
    this.indexHints = new Map(Object.entries(summaries).map(([id, value]) => [id, JSON.stringify([value.trajectoryId ?? null, value.lastModifiedTime ?? null, value.stepCount ?? null])]));
    this.indexSemanticStamp = createHash('sha256').update(JSON.stringify([antigravityCatalogueSemanticStamp(summaries, [hostId, generation]),
      rich ? read?.streamEpoch : null, rich ? read?.revision : null, [...activities].map(([id, value]) => [id, value.aggregateActivity.digest])])).digest('hex');
  }
  /** Summary deltas update retained body views without loading message history. */
  publishCachedStatus() {
    for (const current of this.sessions.values()) {
      if (current.closed || !current.view || current.view.ownerGeneration !== this.indexGeneration) continue;
      const view = this.withSubagents(current.nativeId, current.view), stamp = `${view.ownerGeneration}:${view.contentStamp}`;
      if (stamp !== current.stamp) { current.stamp = stamp; current.view = view; for (const callback of current.callbacks) callback(structuredClone(view)); }
    }
  }
  get activityInventoryComplete() { return !this.disposed && this.residentIndexComplete && this.indexGeneration !== null && this.indexHost !== null
    && this.indexGeneration === this.generation() && this.indexHost === this.hostId(); }
  async status() { try { await this.rpc.call('GetCapabilities'); return { connected: true, mode: 'native', protocol: 'antigravity-connect' }; } catch { return { connected: false, mode: 'native', reason: 'antigravity-unavailable' }; } }
  /** Discovery uses native indices/metadata, not full conversations. Status-only
   * callers skip the durable catalogue index.
   * @param {{fresh?:boolean,history?:boolean,expectedHostId?:string,forceHistory?:boolean}} [options] @returns {Promise<Value[]>} */
  list(options = {}) {
    if (this.disposed) return Promise.reject(new BridgeError('adapter-disposed', 'The Antigravity backend is disposed.', 503));
    if (options.expectedHostId && this.hostId() && options.expectedHostId !== this.hostId()) return Promise.reject(new BridgeError('source-epoch-changed', 'The Antigravity storage namespace does not match this source.', 409));
    if (options.history === false) return this.refreshedResident(options);
    if (this.indexFlight) return this.indexFlight.then(() => this.list({ ...options, fresh: false }));
    const validCatalogue = this.catalogueGeneration === this.generation() && this.catalogueHost === this.hostId() && this.catalogueIndexStamp === this.indexSemanticStamp;
    if (!options.fresh && this.catalogueAt && this.now() - this.catalogueAt < 1000 && validCatalogue) return Promise.resolve(structuredClone(this.catalog));
    const flight = (async () => {
      await this.refreshedResident(options);
      const generation = this.indexGeneration, hostId = this.indexHost;
      if (typeof generation !== 'string' || !generation || typeof hostId !== 'string' || !hostId) throw new BridgeError('source-generation-unavailable', 'A current native catalogue owner is required.');
      let indexStamp = this.indexSemanticStamp, summaries = this.residentSummaries;
      let indexed = this.historyIndex ? await this.historyIndex.merge(summaries, { generation, hostId, force: options.forceHistory }) : { summaries, complete: true, stamp: '', archivedIds: [] };
      if (this.generation() !== generation || this.hostId() !== hostId) throw new BridgeError('source-epoch-changed', 'The native catalogue owner changed during the header merge.', 409);
      if (this.indexSemanticStamp !== indexStamp) {
        indexStamp = this.indexSemanticStamp; summaries = this.residentSummaries;
        indexed = this.historyIndex ? await this.historyIndex.merge(summaries, { generation, hostId, force: false }) : { summaries, complete: true, stamp: '', archivedIds: [] };
      }
      const hidden = antigravityArchivedIds(indexed.summaries, indexed.archivedIds);
      const allSources = await resolveAntigravityProjects(Object.entries(indexed.summaries).map(([id, summary]) => antigravitySource(id, /** @type {Value} */ (summary), generation, hostId)), this.rpc.latestRuntime.home);
      if (this.generation() !== generation || this.hostId() !== hostId) throw new BridgeError('source-epoch-changed', 'The native catalogue owner changed before publication.', 409);
      if (this.indexSemanticStamp !== indexStamp) throw new BridgeError('stale-native-catalogue', 'The native catalogue changed during publication.', 409);
      this.inventoryComplete = indexed.complete; this.catalogueStamp = indexed.stamp;
      this.catalogueHost = hostId; this.catalogueGeneration = generation;
      this.excludedSources = allSources.filter(source => hidden.has(source.id)).map(source => ({ ...source, archived: true, available: false }));
      this.catalog = allSources.filter(source => !hidden.has(source.id)).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
      this.catalogueAt = this.now(); this.catalogueIndexStamp = indexStamp;
      return structuredClone(this.catalog);
    })().catch(error => { this.inventoryComplete = false; throw error; }).finally(() => { if (this.indexFlight === flight) this.indexFlight = null; });
    this.indexFlight = flight; return flight;
  }
  /** Current resident headers only, independent from durable catalogue/steps.
   * @param {{fresh?:boolean,expectedHostId?:string}} [options] @returns {Promise<Value[]>} */
  refreshedResident(options = {}) {
    if (this.disposed) return Promise.reject(new BridgeError('adapter-disposed', 'The Antigravity backend is disposed.', 503));
    if (options.expectedHostId && this.hostId() && options.expectedHostId !== this.hostId()) return Promise.reject(new BridgeError('source-epoch-changed', 'The Antigravity storage namespace does not match this source.', 409));
    if (this.residentFlight) return this.residentFlight.then(() => this.refreshedResident({ ...options, fresh: false }));
    const validIndex = this.activityInventoryComplete;
    if (!options.fresh && this.indexAt && validIndex && (this.now() - this.indexAt < 1000 || this.liveSummaryIndex())) return Promise.resolve(structuredClone(this.residentCatalog));
    let residentReadSucceeded = false;
    const flight = (async () => {
      const observedAt = this.now();
      const reply = await this.rpc.call('GetAllCascadeTrajectories', {}, { expectedHostId: options.expectedHostId }), summaries = reply.trajectorySummaries ?? {};
      if (!record(summaries) || Object.keys(summaries).length > 20000) throw new BridgeError('antigravity-invalid-response', 'The native Antigravity index is invalid.', 503);
      const generation = this.rpc.generation(); if (typeof generation !== 'string' || !generation) throw new BridgeError('source-generation-unavailable', 'The Antigravity owner generation is unavailable.');
      const hostId = antigravityHostId(this.rpc.latestRuntime);
      const stream = await this.scopedSummaryStream(hostId, generation);
      this.baseResidentSummaries = Object.fromEntries(Object.entries(summaries).map(([id, summary]) => [id, nativeResidentHeader(summary)])); this.indexCapturedAt = observedAt;
      this.indexHost = hostId; this.indexGeneration = generation; this.residentIndexComplete = true;
      try { this.summaryRead = stream ? await stream.read(Object.keys(summaries), { expectedHostId: hostId, generation, waitMs: 1000 }) : null; }
      catch { this.summaryRead = null; }
      this.rebuildActivity();
      const resolvedCatalog = await resolveAntigravityProjects(Object.entries(this.residentSummaries).map(([id, summary]) => antigravitySource(id, summary, generation, hostId)), this.rpc.latestRuntime.home);
      if (this.generation() !== generation || this.hostId() !== hostId) throw new BridgeError('source-epoch-changed', 'The native resident owner changed before publication.', 409);
      this.residentCatalog = resolvedCatalog; this.indexAt = this.now(); residentReadSucceeded = true;
      this.publishCachedStatus();
      const residentHidden = antigravityArchivedIds(summaries);
      this.excludedSources = resolvedCatalog.filter(source => residentHidden.has(source.id)).map(source => ({ ...source, archived: true, available: false }));
      return structuredClone(resolvedCatalog);
    })().catch(error => { if (!residentReadSucceeded) this.residentIndexComplete = false; throw error; }).finally(() => { if (this.residentFlight === flight) this.residentFlight = null; });
    this.residentFlight = flight; return flight;
  }
  /** Reduced state only; project status never opens full history.
   * @param {string} id @param {{expectedHostId?:string}} [context] */
  async activity(id, context = {}) { await this.list({ history: false, expectedHostId: context.expectedHostId }); return this.activities.get(id) ?? { known: false, active: false, waiting: false, status: 'unavailable', observedAt: this.now(), generation: this.generation(), revision: null }; }
  /** Reduced current replica only; no network, project scan or conversation read.
   * @param {string} id @param {{expectedHostId?:string}} [context] @returns {Value|null} */
  cachedActivity(id, context = {}) {
    if (!this.activityInventoryComplete || context.expectedHostId && context.expectedHostId !== this.indexHost) return null;
    const value = this.activities.get(id);
    if (!value || value.generation !== this.indexGeneration || value.aggregateActivity?.hostId !== this.indexHost || value.aggregateActivity?.parentConversationId !== id) return null;
    if (value.liveSummaryProof && !this.currentActivityAuthority(id)) return { ...value, known: false, active: false, waiting: false, status: 'unavailable' };
    return { ...value };
  }
  /** Catalogue paging does not load conversation steps.
   * @param {{offset?:number,limit?:number,stamp?:string}} [options] */
  async historyPage(options = {}) { const sources = await this.list(); return { ...pageAntigravityHistory(sources, options, this.catalogueStamp), inventoryComplete: this.inventoryComplete }; }
  /** @param {string} id @param {{expectedHostId?:string,older?:boolean,historyBaseOffset?:number}} [context] */
  async snapshot(id, context = {}) {
    nativeId(id); if (this.disposed) throw new BridgeError('adapter-disposed', 'The Antigravity backend is disposed.', 503);
    const readGeneration = this.historyReadGenerations.get(id) ?? 0;
    const before = this.generation(); let indexAvailable = true;
    try { await this.list({ history: false, expectedHostId: context.expectedHostId }); }
    catch { indexAvailable = false; }
    if (before && this.generation() && this.generation() !== before) throw new BridgeError('source-epoch-changed', 'The original owner changed during the selected native index read.', 409);
    const summary = this.residentSummaries[id], owner = this.generation();
    if (indexAvailable && record(summary) && typeof owner === 'string' && typeof summary.trajectoryId === 'string' && Number.isSafeInteger(summary.stepCount) && summary.stepCount > HISTORY_BATCH_STEPS) {
      const saved = this.historyOffsets.get(id), count = summary.stepCount;
      const matching = saved?.owner === owner && saved.trajectoryId === summary.trajectoryId;
      let offset = Math.max(0, count - HISTORY_BATCH_STEPS);
      if (context.older) offset = Math.max(0, (context.historyBaseOffset ?? (matching && saved.offset < count ? saved.offset : offset)) - HISTORY_BATCH_STEPS);
      let reply;
      while (true) {
        try { reply = await this.rpc.call('GetCascadeTrajectorySteps', { cascadeId: id, stepOffset: offset, trajectoryVerbosity: 'CLIENT_TRAJECTORY_VERBOSITY_FULL' }, { expectedHostId: context.expectedHostId, expectedGeneration: owner }); break; }
        catch (error) {
          if (context.older || !(error instanceof BridgeError) || error.code !== 'antigravity-response-too-large' || count - offset <= 1) throw error;
          offset = count - Math.max(1, Math.floor((count - offset) / 2));
        }
      }
      if (!Array.isArray(reply.steps) || !reply.steps.length || reply.steps.length > MAX_STEPS) throw new BridgeError('antigravity-invalid-response', 'The native suffix does not match its observed offset/count.', 503);
      await this.list({ history: false, fresh: true, expectedHostId: context.expectedHostId });
      if (this.generation() !== owner) throw new BridgeError('source-epoch-changed', 'The original owner changed during the native suffix read.', 409);
      const current = this.residentSummaries[id];
      if (!record(current) || current.trajectoryId !== summary.trajectoryId || !Number.isSafeInteger(current.stepCount) || current.stepCount < offset + reply.steps.length) throw new BridgeError('antigravity-invalid-response', 'The native index did not confirm the suffix boundary.', 503);
      const view = projectAntigravityTrajectory(id, { trajectory: { trajectoryId: summary.trajectoryId, cascadeId: id, steps: reply.steps, metadata: summary.trajectoryMetadata },
        status: current.status, numTotalSteps: current.stepCount, nativeStepOffset: offset }, owner);
      if ((context.older || !matching) && readGeneration === (this.historyReadGenerations.get(id) ?? 0)) this.historyOffsets.set(id, { owner, trajectoryId: summary.trajectoryId, offset });
      const result = this.withSubagents(id, view, context); this.retainMaterializedHistory(id, result); return result;
    }
    const reply = await this.rpc.call('GetCascadeTrajectory', { cascadeId: id, trajectoryVerbosity: 'CLIENT_TRAJECTORY_VERBOSITY_FULL' }, { expectedHostId: context.expectedHostId });
    const generation = this.rpc.generation(); if (typeof generation !== 'string' || !generation) throw new BridgeError('source-generation-unavailable', 'The original owner generation is unavailable.');
    const view = projectAntigravityTrajectory(id, reply, generation);
    try { await this.list({ history: false, expectedHostId: context.expectedHostId }); }
    catch {
      if (this.generation() !== generation) throw new BridgeError('source-epoch-changed', 'The native owner changed after the selected trajectory read.', 409);
      return this.withSubagents(id, view, context, false);
    }
    if (this.generation() !== generation) throw new BridgeError('source-epoch-changed', 'The native owner changed after the selected trajectory read.', 409);
    return this.withSubagents(id, view, context);
  }
  /** Reduced child projection can update a cached idle parent without reading
   * parent or child message history. @param {string} id @param {ReturnType<typeof projectAntigravityTrajectory> & {baseContentStamp?:string,ownNativeStatus?:string,subagents?:Value[],subagentsAvailable?:boolean}} view @param {{expectedHostId?:string}} [context] @param {boolean} [available] */
  withSubagents(id, view, context = {}, available = true) {
    const baseContentStamp = view.baseContentStamp ?? view.contentStamp;
    const result = { ...view, baseContentStamp, ownNativeStatus: view.ownNativeStatus ?? view.status,
      subagentsAvailable: false, subagentsComplete: false, subagentsTruncated: false, subagentsTotal: /** @type {number|null} */ (null) };
    delete result.subagents;
    const hostId = context.expectedHostId ?? this.hostId();
    const currentIndex = available && !!hostId && this.indexHost === hostId && this.indexGeneration === view.ownerGeneration && this.generation() === view.ownerGeneration;
    let aggregateActivity;
    try {
      if (!currentIndex || !hostId || !record(this.residentSummaries[id])) throw new BridgeError('source-epoch-changed', 'The child status owner changed.');
      const tree = projectAntigravitySubagentTree(this.subagentIndex, id, hostId, view.ownerGeneration);
      result.subagents = tree.rows; result.subagentsAvailable = true;
      result.subagentsTruncated = tree.truncated; result.subagentsTotal = tree.total;
      const activity = this.activities.get(id);
      aggregateActivity = activity?.aggregateActivity;
      result.subagentsComplete = tree.complete && activity?.aggregateActivity.rosterComplete === true;
    } catch { /* Unknown child status keeps retained body data, without an empty successful list. */ }
    if (!aggregateActivity) aggregateActivity = aggregateNativeActivity({ app: 'antigravity', parentConversationId: id, hostId: hostId ?? '',
      ownerGeneration: view.ownerGeneration, ownStatus: 'unknown', ownWaiting: false, subagents: undefined,
      rosterAvailable: false, rosterComplete: false, nativeChildActive: false });
    result.contentStamp = createHash('sha256').update(JSON.stringify([baseContentStamp, result.subagentsAvailable, result.subagents,
      result.subagentsTruncated, result.subagentsTotal, result.subagentsComplete, aggregateActivity.digest])).digest('hex');
    return { ...result, aggregateActivity };
  }

  /** @param {string} id @param {{expectedHostId?:string}} [context] */ freshSnapshot(id, context = {}) { return this.snapshot(id, context); }
  /** @param {string} id @param {Value} view */
  retainMaterializedHistory(id, view) {
    let merged = view;
    const kept = (this.materializedHistory.get(id) ?? []).filter(prior => prior.ownerGeneration === view.ownerGeneration && prior.trajectoryId === view.trajectoryId);
    for (let index = 0; index < kept.length;) {
      const prior = kept[index];
      if (prior.nativeStepEnd < merged.nativeStepOffset || merged.nativeStepEnd < prior.nativeStepOffset) { index++; continue; }
      kept.splice(index, 1);
      const previousRows = prior.rows.filter((/** @type {Value} */ row) => row.order < merged.nativeStepOffset || row.order >= merged.nativeStepEnd);
      const rows = new Map([...previousRows, ...merged.rows].map((/** @type {Value} */ row) => [row.id, row]));
      const start = Math.min(prior.nativeStepOffset, merged.nativeStepOffset), end = Math.max(prior.nativeStepEnd, merged.nativeStepEnd);
      merged = { ...merged, rows: [...rows.values()].sort((a, b) => a.order - b.order), nativeStepOffset: start, nativeStepEnd: end,
        historyComplete: (prior.historyComplete === true || merged.historyComplete === true) && start === 0 && end === view.nativeStepTotal };
      index = 0;
    }
    this.materializedHistory.set(id, [...kept, merged]);
  }
  /** @param {string} id @param {Value} boundary @param {{expectedHostId?:string}} [context] */
  materializedBoundary(id, boundary, context = {}) {
    if (context.expectedHostId && context.expectedHostId !== this.hostId()) return null;
    return (this.materializedHistory.get(id) ?? []).find(view => view.ownerGeneration === this.generation()
      && (view.rows.some((/** @type {Value} */ row) => row.id === boundary.id) || boundary.empty === true && Number.isSafeInteger(boundary.nativeStepOffset)
        && view.nativeStepOffset <= boundary.nativeStepOffset && boundary.nativeStepOffset <= view.nativeStepEnd)) ?? null;
  }
  /** Cached history is data only; it never promotes old controls/requests.
   * @param {string} id @param {Value} boundary @param {{expectedHostId?:string}} [context] */
  async readMaterializedHistory(id, boundary, context = {}) {
    // Verify the existing process lifetime without fetching conversation bodies.
    if (typeof this.rpc.runtime === 'function') await this.rpc.runtime();
    const view = this.materializedBoundary(id, boundary, context); if (!view) return null;
    const row = view.rows.find((/** @type {Value} */ row) => row.id === boundary.id), order = row?.order ?? boundary.nativeStepOffset ?? view.nativeStepOffset;
    if (view.historyComplete !== true && !view.rows.some((/** @type {Value} */ row) => row.order < order && row.turnId && ['user', 'assistant', 'reasoning', 'tool'].includes(row.role))) return null;
    const result = structuredClone(view);
    if (boundary.empty === true) result.rows = result.rows.filter((/** @type {Value} */ row) => row.order < order);
    result.historyComplete = view.historyComplete === true && view.nativeStepOffset === 0
      && view.nativeStepEnd === this.residentSummaries[id]?.stepCount;
    return result;
  }
  /** @param {string} id @param {{expectedHostId?:string,historyBoundary?:Value}} [context] */
  completeSnapshot(id, context = {}) {
    const boundary = context.historyBoundary, view = boundary ? this.materializedBoundary(id, boundary, context) : null;
    if (boundary && !view) return Promise.reject(new BridgeError('stale-history-cursor', 'The original native history boundary is not available under this owner.', 409));
    return this.snapshot(id, { ...context, older: true, ...(view ? { historyBaseOffset: view.nativeStepOffset } : {}) });
  }
  /** Once a mutation has been sent, readback failures are uncertain outcomes,
   * never the safe rejection codes used before native dispatch.
   * @param {string} id @param {string} generation @param {{expectedHostId?:string}} [context] */
  async readAfterDispatch(id, generation, context = {}) {
    try {
      const view = await this.freshSnapshot(id, context);
      if (view.ownerGeneration !== generation) throw new BridgeError('source-epoch-changed', 'The Antigravity owner changed during readback.');
      return view;
    } catch (error) {
      const unknown = new BridgeError('delivery-unknown', 'The native operation may have occurred and its owner readback is unconfirmed.');
      const cause = nativeCauseCode(error instanceof BridgeError ? error.code : undefined); if (cause) Object.assign(unknown, { nativeCause: cause });
      throw unknown;
    }
  }
  /** @param {string} id @param {(view:Value)=>void} callback @param {{expectedHostId?:string}} [context] */
  async subscribe(id, callback, context = {}) {
    nativeId(id); const key = JSON.stringify([context.expectedHostId ?? null, id]); let session = this.sessions.get(key);
    if (!session) { session = { nativeId: id, callbacks: new Set(), timer: null, running: false, closed: false, stamp: null, view: null }; this.sessions.set(key, session); }
    let delivered = false;
    const listener = (/** @type {Value} */ view) => { delivered = true; callback(view); };
    session.callbacks.add(listener);
    const current = session;
    const poll = async () => {
      if (current.closed || current.running || this.disposed) return; current.running = true;
      try {
        if (current.view?.status === 'idle') {
          await this.list({ history: false, expectedHostId: context.expectedHostId });
          const hint = this.indexHints.get(id);
          if (hint && hint === current.hint && current.view.ownerGeneration === this.generation()) {
            const view = this.withSubagents(id, current.view, context), stamp = `${view.ownerGeneration}:${view.contentStamp}`;
            if (!current.closed && stamp !== current.stamp) { current.stamp = stamp; current.view = view; for (const listener of current.callbacks) listener(structuredClone(view)); }
            return;
          }
        }
        const view = await this.snapshot(id, context), stamp = `${view.ownerGeneration}:${view.contentStamp}`;
        current.hint = this.indexHints.get(id) ?? null;
        if (!current.closed && stamp !== current.stamp) { current.stamp = stamp; current.view = view; for (const listener of current.callbacks) listener(structuredClone(view)); }
      } catch {
        if (!current.closed && current.stamp !== 'unavailable') { current.stamp = 'unavailable'; current.view = { rows: [], requests: [], status: 'owner-unavailable', currentTurnId: null, ownerGeneration: this.generation() }; for (const listener of current.callbacks) listener(structuredClone(current.view)); }
      } finally { current.running = false; }
    };
    await poll();
    if (!delivered && current.view && !current.closed) listener(structuredClone(current.view));
    if (!current.timer) { current.timer = setInterval(() => { void poll(); }, this.pollMs); current.timer.unref(); }
    return () => {
      if (current.closed) return;
      current.callbacks.delete(listener);
      if (!current.callbacks.size) {
        current.closed = true; if (current.timer) clearInterval(current.timer); this.sessions.delete(key);
        if (![...this.sessions.values()].some(session => session.nativeId === id && session.callbacks.size)) {
          this.historyOffsets.delete(id); this.historyReadGenerations.set(id, (this.historyReadGenerations.get(id) ?? 0) + 1);
        }
      }
    };
  }
  /** @param {string} id @param {string} action @param {Value} payload @param {string} commandId @param {{expectedGeneration?:string|null,expectedHostId?:string}} [context] */
  async command(id, action, payload, commandId, context = {}) {
    nativeId(id); if (!this.supportedActions.includes(action)) throw new BridgeError('unsupported-action', 'This Antigravity action has no verified native contract.');
    if (typeof commandId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(commandId) || !record(payload)) throw new BridgeError('invalid-payload', 'A typed payload and stable command ID are required.');
    const view = await this.freshSnapshot(id, context), generation = view.ownerGeneration;
    if (context.expectedGeneration !== undefined && context.expectedGeneration !== generation) throw new BridgeError('source-epoch-changed', 'The Antigravity owner changed before dispatch.', 409);
    const nativeOptions = { expectedGeneration: generation, expectedHostId: context.expectedHostId, mutation: true };
    if (action === 'read-controls') {
      if (Object.keys(payload).length) throw new BridgeError('invalid-settings', 'A controls read cannot modify settings.');
      return this.settings.read(id, view, context);
    }
    if (action === 'stage-settings') {
      if (Object.keys(payload).some(key => !['model', 'reasoningEffort', 'expectedModel', 'expectedReasoningEffort'].includes(key)) || typeof payload.model !== 'string') throw new BridgeError('invalid-settings', 'A model from this source catalogue is required.');
      return this.settings.validate(id, view, payload, context);
    }
    if (action === 'send' || action === 'steer') {
      if (Object.keys(payload).some(key => !['text', 'model', 'modelIdentity'].includes(key)) || typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > MAX_TEXT || payload.model !== undefined && typeof payload.model !== 'string' || payload.modelIdentity !== undefined && (!record(payload.modelIdentity) || Object.keys(payload.modelIdentity).length !== 1 || !['model', 'alias'].some(key => typeof payload.modelIdentity[key] === 'string'))) throw new BridgeError('invalid-input', 'A bounded text message and source model are required.');
      if (action === 'send' && view.currentTurnId !== null || action === 'steer' && view.currentTurnId === null) throw new BridgeError('stale-turn', 'The original Antigravity invocation changed.', 409);
      const message = await this.settings.message(id, view, payload, context);
      await this.rpc.call('SendUserCascadeMessage', { cascadeId: id, items: message.items, ...(message.cascadeConfig ? { cascadeConfig: message.cascadeConfig } : {}), clientMessageId: commandId,
        remoteControlDetails: { userAgent: 'CodeLight' }, ...(action === 'steer' ? { deliveryStrategy: 'MESSAGE_DELIVERY_STRATEGY_NEXT_INVOCATION' } : {}) }, nativeOptions);
      const admitted = await this.readAfterDispatch(id, generation, context);
      const original = admitted.rows.find((/** @type {Value} */ row) => row.role === 'user' && row.commandId === commandId && !['failed', 'rejected'].includes(row.inputStatus));
      if (original) {
        const modelConfirmed = !message.selectedNativeModel || JSON.stringify(original.nativeModel) === JSON.stringify(message.selectedNativeModel);
        if (!modelConfirmed) throw new BridgeError('delivery-unknown', 'The native input model configuration has not been confirmed.');
        return { admitted: true, queued: original.inputStatus === 'pending', turnId: original.turnId, messageId: original.id, ...(payload.model ? { selectedModel: payload.model, modelReadbackConfirmed: true } : {}) };
      }
      return { nativeDispatchConfirmed: true };
    }
    if (action === 'interrupt') {
      if (Object.keys(payload).some(key => key !== 'turnId') || payload.turnId !== view.currentTurnId || !view.currentTurnId) throw new BridgeError('stale-turn', 'The original Antigravity invocation is no longer foreground.', 409);
      await this.rpc.call('CancelCascadeInvocation', { cascadeId: id }, nativeOptions);
      const observed = await this.readAfterDispatch(id, generation, context);
      return { cancelRequested: true, turnId: payload.turnId, foregroundActive: observed.currentTurnId !== null, observedStatus: observed.status };
    }
    const request = view.requests.find((/** @type {Value} */ request) => request.requestId === payload.requestId);
    if (!request?.operable) throw new BridgeError('stale-approval', 'The original Antigravity interaction is unavailable.', 409);
    const interaction = this.interaction(request, payload);
    await this.rpc.call('HandleCascadeUserInteraction', { cascadeId: id, interaction: { trajectoryId: view.trajectoryId, stepIndex: request.stepIndex, ...interaction } }, nativeOptions);
    const answered = await this.readAfterDispatch(id, generation, context);
    if (answered.requests.some((/** @type {Value} */ current) => current.requestId === request.requestId)) throw new BridgeError('delivery-unknown', 'The original native interaction response has not been confirmed.');
    return { answered: true, requestId: request.requestId };
  }
  /** @param {Value} request @param {Value} payload */
  interaction(request, payload) {
    if (request.nativeInteraction === 'runCommand' || request.nativeInteraction === 'approvalInteraction' || request.nativeInteraction === 'permission') {
      if (payload.kind !== request.kind || !['accept', 'decline'].includes(payload.decision) || !request.allowedActions.includes(payload.decision) || Object.keys(payload).some(key => !['kind', 'requestId', 'decision'].includes(key))) throw new BridgeError('unsupported-approval', 'Only the current native once permission can be answered.');
      const confirm = payload.decision === 'accept';
      return request.nativeInteraction === 'permission' ? { permission: { allow: confirm, scope: 'PERMISSION_SCOPE_ONCE' } } : { [request.nativeInteraction]: { confirm } };
    }
    if (request.nativeInteraction === 'askQuestion') {
      const answers = payload.response?.answers;
      if (payload.kind !== 'user-input' || !record(answers) || Object.keys(payload).some(key => !['kind', 'requestId', 'response'].includes(key)) ||
          Object.keys(answers).length !== request.nativeQuestions.length || Object.keys(answers).some(key => !/^q\d+$/.test(key))) throw new BridgeError('invalid-answer-identity', 'Answer the exact original Antigravity question identities.');
      const responses = request.nativeQuestions.map((/** @type {Value} */ question, /** @type {number} */ index) => {
        const selected = answers[`q${index}`]?.answers;
        if (!Array.isArray(selected) || !selected.length || selected.some(value => typeof value !== 'string' || value.length > MAX_TEXT)) throw new BridgeError('invalid-answer', 'A bounded answer for each original question is required.');
        const optionIds = [], custom = [];
        for (const value of selected) {
          const matching = question.options.filter((/** @type {Value} */ option) => option.text === value);
          if (matching.length > 1) throw new BridgeError('invalid-answer-identity', 'Ambiguous native option labels cannot be reconstructed.');
          if (matching.length === 1) optionIds.push(matching[0].id); else custom.push(value);
        }
        if (!question.isMultiSelect && optionIds.length > 1) throw new BridgeError('invalid-answer', 'The original native question permits one option.');
        return { ...question, selectedOptionIds: optionIds, ...(custom.length ? { writeInResponse: custom.join('\n') } : {}) };
      });
      return { askQuestion: { responses } };
    }
    throw new BridgeError('unsupported-approval', 'This native interaction response is not supported.');
  }
  async dispose() { this.disposed = true; this.summaryUnsubscribe?.(); this.summaryUnsubscribe = null; await this.summaryStream?.dispose?.(); for (const session of this.sessions.values()) { session.closed = true; if (session.timer) clearInterval(session.timer); } this.sessions.clear(); this.historyOffsets.clear(); this.materializedHistory.clear(); this.historyReadGenerations.clear(); this.settings.dispose?.(); this.historyIndex?.dispose?.(); await this.rpc.dispose?.(); }
}

/** Reduced foreground observer sharing the native index read budget. */
export class AntigravityActivityObserver {
  /** @param {{id:string,backend:AntigravityBackend,now?:()=>number,expectedHostId?:string}} options */
  constructor(options) { this.id = options.id; this.backend = options.backend; this.expectedHostId = options.expectedHostId; this.now = options.now ?? Date.now; this.closed = false; this.value = /** @type {Value} */ ({ known: false, active: false, waiting: false, status: 'refreshing', observedAt: 0, generation: null, revision: null }); }
  /** @returns {Value} */
  status() {
    if (this.closed) return { ...this.value, known: false, active: false, waiting: false, status: 'unavailable' };
    const current = this.backend.cachedActivity?.(this.id, { expectedHostId: this.expectedHostId });
    if (current) this.value = { ...current };
    const sameOwner = this.backend.activityInventoryComplete !== false && (this.value.generation === null || this.value.generation === this.backend.generation() &&
      (!this.expectedHostId || this.expectedHostId === this.backend.hostId()) &&
      (!this.value.aggregateActivity || this.value.aggregateActivity.hostId === this.backend.hostId()));
    const continuouslyCurrent = sameOwner && this.backend.currentActivityAuthority?.(this.id) === true;
    return !sameOwner || this.value.known && !continuouslyCurrent && this.now() - this.value.observedAt > 5000
      ? { ...this.value, known: false, active: false, waiting: false, status: 'refreshing' } : { ...this.value };
  }
  /** @returns {number|null} */
  refreshDueAt() { const value = this.status(); return this.backend.currentActivityAuthority?.(this.id) === true ? null : !this.closed && value.known && typeof value.observedAt === 'number' && Number.isFinite(value.observedAt) ? value.observedAt + 3000 : null; }
  async refresh() { if (this.closed) return; try { const value = await this.backend.activity(this.id, { expectedHostId: this.expectedHostId }); if (!this.closed) this.value = { ...value }; } catch { if (!this.closed) this.value = { known: false, active: false, waiting: false, status: 'unavailable', observedAt: this.now(), generation: null, revision: null }; } }
  close() { this.closed = true; }
}
