import { projectClaudeNativeTranscript, projectClaudeNativeMessage } from './claude-history.mjs';
import { nativeSettingsScope, confirmedNativeSettingsEvidence } from '../happy/native-settings-scope.mjs';
/** @typedef {Record<string,any>} Value */
/** @param {unknown} value @returns {Value} */
function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Value} */ (value) : {}; }
/** @param {unknown} value @param {number} [max] @returns {string|null} */
function label(value, max = 256) { return typeof value === 'string' && value.length <= max && !/[\x00-\x1f]|https?:\/\/|Bearer\s|sk-[A-Za-z0-9]/i.test(value) ? value : null; }
/** @param {unknown} input @returns {string[]} */
const taskTypes = input => Array.isArray(input) && input.length === 1 && input[0] === 'local_bash' ? ['local_bash'] : [];
/** Opaque native task IDs may legitimately contain "task-"; it is not a key prefix.
 * @param {unknown} value @returns {string|null} */
const taskIdentity = value => typeof value === 'string' && !!value.trim() && value.length <= 256
  && !/[\x00-\x1f\x7f]|https?:\/\/|Bearer\s|^sk-[A-Za-z0-9]/i.test(value) ? value : null;
/** @param {unknown} input @returns {Value} */
function taskScope(input) {
  const value = object(input), collection = value.nativeCollection;
  if (value.app !== 'claude-desktop' || !['claude-code-sessions', 'local-agent-mode-sessions'].includes(collection)
    || !Object.hasOwn(value, 'queryToken') || !Object.hasOwn(value, 'cliSessionId')) throw Error('unverified-task-scope');
  const scope = { app: value.app, nativeCollection: collection, hostId: label(value.hostId), parentConversationId: label(value.parentConversationId, 512),
    ownerGeneration: label(value.ownerGeneration), runtimeGeneration: label(value.runtimeGeneration),
    queryToken: value.queryToken === null ? null : label(value.queryToken), cliSessionId: value.cliSessionId === null ? null : label(value.cliSessionId, 512) };
  if (!scope.hostId || !scope.parentConversationId || !scope.ownerGeneration || !scope.runtimeGeneration
    || value.queryToken !== null && !scope.queryToken || value.cliSessionId !== null && !scope.cliSessionId) throw Error('unverified-task-scope');
  return scope;
}
/** Strict data projection; no native runtime object may reach task clients. @param {Value} value */
function taskFeed(value) {
  const scope = taskScope(value.scope), coverage = object(value.coverage);
  if (value.version !== 1 || value.sessionId !== scope.parentConversationId || value.ownerGeneration !== scope.ownerGeneration
    || value.runtimeGeneration !== scope.runtimeGeneration || value.cliSessionId !== scope.cliSessionId
    || typeof value.queryPresent !== 'boolean' || value.queryPresent && value.executionToken !== scope.queryToken
    || !value.queryPresent && scope.queryToken !== null || !label(value.executionToken) || !Number.isSafeInteger(value.cursor) || value.cursor < 0) throw Error('unverified-task-scope');
  let malformed = false;
  const events = Array.isArray(value.events) ? value.events.slice(0, 128).flatMap(input => {
    const row = object(input), message = object(row.message);
    if (!Number.isSafeInteger(row.sequence) || row.sequence < 0 || row.sequence >= value.cursor || message.type !== 'system'
      || !['task_started', 'task_progress', 'task_updated', 'task_notification', 'background_tasks_changed'].includes(message.subtype)) { malformed = true; return []; }
    try { return [{ sequence: row.sequence, message: projectClaudeNativeMessage(message) }]; } catch { malformed = true; return []; }
  }) : [];
  const rawForeground = object(value.foregroundLevel);
  const foregroundTasks = Array.isArray(rawForeground.tasks) ? rawForeground.tasks.slice(0, 128).flatMap(input => {
    const row = object(input), id = taskIdentity(row.task_id), type = label(row.task_type, 64);
    if (!id || !type) { malformed = true; return []; } return [{ task_id: id, task_type: type }];
  }) : [];
  let level = null;
  if (value.level !== null && value.level !== undefined) {
    try { if (value.level.type === 'system' && value.level.subtype === 'background_tasks_changed') level = projectClaudeNativeMessage(value.level); else malformed = true; }
    catch { malformed = true; }
  }
  const dispatchChildren = Array.isArray(value.dispatchChildren) ? value.dispatchChildren.slice(0, 128).flatMap(input => {
    const row = object(input), source = object(row.source), native = object(row.nativeRecord);
    let parentScope; try { parentScope = taskScope(row.parentScope); } catch { malformed = true; return []; }
    if (row.nativeCollectionVerified !== true || source.app !== 'claude-desktop' || !['claude-code-sessions', 'local-agent-mode-sessions'].includes(source.nativeCollection)
      || !label(source.id, 512) || source.id !== native.sessionId || !label(source.hostId) || !label(source.ownerGeneration) || !label(source.runtimeGeneration)) { malformed = true; return []; }
    return [{ nativeCollectionVerified: true, parentScope, source: { app: source.app, id: label(source.id, 512), nativeCollection: source.nativeCollection,
      hostId: label(source.hostId), ownerGeneration: label(source.ownerGeneration), runtimeGeneration: label(source.runtimeGeneration) },
    nativeRecord: { sessionId: label(native.sessionId, 512), title: label(native.title), dispatchParentId: label(native.dispatchParentId, 512), dispatchParentOrigin: label(native.dispatchParentOrigin),
      parentSessionId: label(native.parentSessionId, 512), sessionType: label(native.sessionType), lifecycleState: label(native.lifecycleState),
      isRunning: typeof native.isRunning === 'boolean' ? native.isRunning : null, pendingPermissionCount: Number.isSafeInteger(native.pendingPermissionCount) ? native.pendingPermissionCount : null,
      isArchived: native.isArchived === true } }];
  }) : [];
  const bounded = !malformed && Array.isArray(value.events) && value.events.length <= 128;
  return { version: 1, sessionId: scope.parentConversationId, ownerGeneration: scope.ownerGeneration, runtimeGeneration: scope.runtimeGeneration,
    executionToken: label(value.executionToken), cliSessionId: scope.cliSessionId, queryPresent: value.queryPresent, scope, cursor: value.cursor, resetRequired: value.resetRequired === true,
    events, level, foregroundLevel: { available: rawForeground.available === true, complete: rawForeground.complete === true && !malformed && Array.isArray(rawForeground.tasks) && rawForeground.tasks.length <= 128, tasks: foregroundTasks },
    coverage: { available: coverage.available === true, lifecycleComplete: coverage.lifecycleComplete === true && bounded,
      levelComplete: coverage.levelComplete === true && level !== null && !malformed, foregroundComplete: coverage.foregroundComplete === true && rawForeground.complete === true && !malformed,
      dispatchAvailable: coverage.dispatchAvailable === true, dispatchComplete: coverage.dispatchComplete === true && !malformed && Array.isArray(value.dispatchChildren) && value.dispatchChildren.length <= 128 },
    dispatchChildren, capabilities: {
      taskOutputVerified: value.capabilities?.taskOutputVerified === true && taskTypes(value.capabilities?.outputTaskTypes).length > 0,
      taskStopVerified: value.capabilities?.taskStopVerified === true && taskTypes(value.capabilities?.stopTaskTypes).length > 0,
      outputTaskTypes: value.capabilities?.taskOutputVerified === true ? taskTypes(value.capabilities?.outputTaskTypes) : [],
      stopTaskTypes: value.capabilities?.taskStopVerified === true ? taskTypes(value.capabilities?.stopTaskTypes) : [] } };
}
/** @param {unknown} models @returns {string[]} */
function modelIds(models) { return Array.isArray(models) ? models.slice(0, 256).flatMap(model => { const id = label(typeof model === 'string' ? model : object(model).name ?? object(model).id); return id ? [id] : []; }) : []; }
/** @param {unknown} value */
function timestamp(value) { const result = typeof value === 'number' ? value : typeof value === 'string' && value.length <= 80 ? Date.parse(value) : NaN; return Number.isFinite(result) && result > 0 ? result : null; }
/** Only primitive capability facts can enter native debug/verification output.
 * @param {unknown} provider */
export function claudeProviderFacts(provider) {
  const value = object(provider), creds = object(value.creds);
  return { provider: label(creds.provider), credentialPresent: typeof creds.apiKey === 'string' && !!creds.apiKey,
    modelIds: modelIds(creds.models), supportsDirectOneShot: value.supportsDirectOneShot === true };
}

/** Explicit owner/control-debug allowlist. Never recursively serialize native objects.
 * @param {string} method @param {unknown} input @returns {Value} */
export function projectClaudeBridgeResult(method, input) {
  const value = object(input);
  if (['code.controls', 'cowork.controls', 'code.settings', 'cowork.settings'].includes(method)) {
    const raw = method.endsWith('.settings') ? object(value.controls) : value, scope = nativeSettingsScope(raw.scope);
    if (!scope) throw Error('native-settings-scope-unavailable');
    const source = object(raw.model), current = object(source.current), efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
    const model = label(current.model, 512), effort = current.reasoningEffort === null ? null : label(current.reasoningEffort, 128);
    const confirmed = source.currentConfirmed === true && !!model && (current.reasoningEffort === null || !!effort);
    let malformed = !Array.isArray(source.models) || source.models.length > 256;
    const models = Array.isArray(source.models) ? source.models.slice(0, 256).flatMap(input => {
      const row = object(input), id = label(row.id, 512), name = label(row.label, 512);
      if (!id || !name || !Array.isArray(row.reasoningEfforts) || row.reasoningEfforts.length > 5
        || row.reasoningEfforts.some((/** @type {unknown} */ value) => !efforts.includes(/** @type {string} */ (value)))
        || row.defaultReasoningEffort !== null && !efforts.includes(row.defaultReasoningEffort)) { malformed = true; return []; }
      return [{ id, label: name, reasoningEfforts: [...row.reasoningEfforts], defaultReasoningEffort: row.defaultReasoningEffort,
        supportsEffort: typeof row.supportsEffort === 'boolean' ? row.supportsEffort : null,
        supportedEffortLevels: Array.isArray(row.supportedEffortLevels) && row.supportedEffortLevels.length <= 5
          && row.supportedEffortLevels.every((/** @type {string} */ value) => efforts.includes(value)) ? [...row.supportedEffortLevels] : null,
        effortCatalogComplete: row.effortCatalogComplete === true,
        ...(label(row.nativeResolvedModel, 512) ? { nativeResolvedModel: label(row.nativeResolvedModel, 512) } : {}),
        ...(label(row.description, 4096) ? { description: label(row.description, 4096) } : {}) }];
    }) : [];
    const commands = object(raw.commands); let commandsMalformed = !Array.isArray(commands.items) || commands.items.length > 1024;
    const items = Array.isArray(commands.items) ? commands.items.slice(0, 1024).flatMap(input => {
      const row = object(input), name = label(row.name, 128);
      if (!name || !/^[A-Za-z0-9][A-Za-z0-9_:.-]*$/.test(name)) { commandsMalformed = true; return []; }
      return [{ name, description: label(row.description, 4096) ?? '', execution: 'unsupported' }];
    }) : [];
    const controls = { scope, model: { available: source.available === true && !malformed && confirmed,
      catalogAvailable: source.catalogAvailable === true && !malformed, catalogComplete: source.catalogComplete === true && !malformed,
      catalogSource: 'existing-native-query', current: confirmed ? { model, reasoningEffort: effort, modelProvider: 'claude-desktop' } : null,
      currentConfirmed: confirmed, idleHeld: source.idleHeld === true, models, selectionMode: 'original-owner', ...(confirmed ? { selectionState: 'native' } : {}), reason: label(source.reason) },
    commands: { available: commands.available === true && !commandsMalformed, complete: commands.complete === true && !commandsMalformed,
      source: 'existing-native-query', items, executionAvailable: false },
    confirmation: { modelAckConfirmed: raw.confirmation?.modelAckConfirmed === true, effortAckConfirmed: raw.confirmation?.effortAckConfirmed === true, source: 'existing-query-readback' },
    nativeRecordSequences: { modelRecordSeq: Number.isSafeInteger(raw.nativeRecordSequences?.modelRecordSeq) ? raw.nativeRecordSequences.modelRecordSeq : null,
      modelChangeSeq: Number.isSafeInteger(raw.nativeRecordSequences?.modelChangeSeq) ? raw.nativeRecordSequences.modelChangeSeq : null } };
    if (!method.endsWith('.settings')) return controls;
    const evidence = confirmedNativeSettingsEvidence(value.nativeSettingsEvidence, value.nativeSettingsEvidence?.expectedScope, controls);
    return { applied: value.applied === true, settingsReadbackConfirmed: value.settingsReadbackConfirmed === true && evidence !== null,
      controls, ...(evidence ? { nativeSettingsEvidence: evidence } : {}) };
  }
  if (['code.taskFeed', 'cowork.taskFeed'].includes(method)) return taskFeed(value);
  if (['code.taskOutput', 'code.stopTask'].includes(method)) {
    const scope = taskScope(value.scope), taskId = taskIdentity(value.taskId);
    if (value.sessionId !== scope.parentConversationId || !taskId || !scope.queryToken || !scope.cliSessionId) throw Error('unverified-task-scope');
    const common = { sessionId: scope.parentConversationId, taskId, scope };
    if (method === 'code.taskOutput') {
      if (typeof value.output !== 'string' || Buffer.byteLength(value.output) > 65536 || typeof value.truncated !== 'boolean') throw Error('native-task-output-unavailable');
      return { ...common, output: value.output, truncated: value.truncated };
    }
    const raw = object(value.terminalProof);
    const proof = raw.kind === 'native-task-notification' && Number.isSafeInteger(raw.sequence) && raw.sequence >= 0
      && ['completed', 'failed', 'stopped'].includes(raw.status)
      ? { kind: raw.kind, nativeEventId: label(raw.nativeEventId), sequence: raw.sequence, status: raw.status } : null;
    return { ...common, stopRequested: value.stopRequested === true, stopped: proof?.status === 'stopped', readbackConfirmed: proof !== null,
      terminalProof: proof, observedStatus: proof?.status ?? 'unknown' };
  }
  if (['code.snapshot', 'code.page', 'cowork.snapshot', 'cowork.page'].includes(method)) return projectClaudeNativeTranscript(value);
  if (['code.events', 'cowork.events'].includes(method)) return { sessionId: label(value.sessionId), sessionGeneration: label(value.ownerGeneration ?? value.sessionGeneration),
    ownerGeneration: label(value.ownerGeneration ?? value.sessionGeneration), executionToken: label(value.executionToken ?? value.sessionGeneration),
    cursor: Number.isSafeInteger(value.cursor) ? value.cursor : null, resetRequired: value.resetRequired === true,
    events: Array.isArray(value.events) ? value.events.slice(0, 64).map(event => { const row = object(event); return { sequence: Number.isSafeInteger(row.sequence) ? row.sequence : null,
      type: label(row.type), message: row.message ? projectClaudeNativeMessage(row.message) : null }; }) : [] };
  if (method === 'owner.status') return { appVersion: label(value.appVersion), nativeOwner: value.nativeOwner === true,
    bridge: label(value.bridge), readOnly: value.readOnly === true, mutationAllowed: value.mutationAllowed === true && value.readOnly !== true,
    runtimeGeneration: label(value.runtimeGeneration),
    nativeSettingsReadMethods: Array.isArray(value.nativeSettingsReadMethods) && value.nativeSettingsReadMethods.length <= 2
      && value.nativeSettingsReadMethods.every((/** @type {unknown} */ name) => ['code.controls', 'cowork.controls'].includes(/** @type {string} */ (name)))
      ? [...new Set(value.nativeSettingsReadMethods)] : [],
    modeRoutes: Object.fromEntries(['code', 'cowork', 'chat'].map(mode => [mode, object(object(value.modes)[mode]).routePresent === true])) };
  if (method === 'owner.provenance') return { actualAsar: value.actualAsar === true, nativeManagerReference: value.nativeManagerReference === true,
    mainCacheReference: value.mainCacheReference === true, nativeApiFactoryReference: value.nativeApiFactoryReference === true,
    nativeApiFactoryInvocations: Number.isSafeInteger(value.nativeApiFactoryInvocations) ? value.nativeApiFactoryInvocations : null,
    existingNativeRendererApi: value.existingNativeRendererApi === true,
    apiManagerReference: value.apiManagerReference === true, generationMainReference: value.generationMainReference === true,
    extractedModuleCount: Number.isSafeInteger(value.extractedModuleCount) ? value.extractedModuleCount : null,
    profileMatches: value.profileMatches === true, sessionPersisted: value.sessionPersisted === true, queryPresent: value.queryPresent === true,
    copiedAsarSha256: label(value.copiedAsarSha256), appVersion: label(value.appVersion) };
  if (method === 'owner.resolvedConfig') return { configSource: label(object(value.configSource).type), thirdParty: value.thirdParty === true,
    provider: label(value.provider), credentialKind: label(value.credentialKind), credentialPresent: value.credentialPresent === true,
    gatewayBasePresent: value.gatewayBasePresent === true, nativeUserDataOverride: value.envUserdataSet === true };
  if (['owner.gateway', 'owner.resolveGateway'].includes(method)) {
    const provider = typeof value.provider === 'string' ? label(value.provider) : claudeProviderFacts(value.provider).provider;
    return { provider, accountScopeAvailable: value.accountOverridePresent === true, organizationScopeAvailable: value.orgOverridePresent === true,
      credentialEpoch: Number.isSafeInteger(value.credentialEpoch) ? value.credentialEpoch : null,
      credentialResolved: value.credentialResolved === true, managesProviderRouting: value.managesProviderRouting === true };
  }
  if (method === 'owner.mode') return { nativeModeClass: label(value.nativeModeClass), accountScopeAvailable: value.accountOverridePresent === true,
    organizationScopeAvailable: value.orgOverridePresent === true, isLoggedOut: typeof value.isLoggedOut === 'boolean' ? value.isLoggedOut : null };
  if (method === 'owner.surfaces') return { codeEnabled: typeof value.codeEnabled === 'boolean' ? value.codeEnabled : null,
    localCodeDisabled: typeof value.localCodeDisabled === 'boolean' ? value.localCodeDisabled : null, desktopHome: label(value.desktopHome),
    rendererCodeEnabled: typeof value.rendererCodeEnabled === 'boolean' ? value.rendererCodeEnabled : null,
    rendererLocalCodeDisabled: typeof value.rendererLocalCodeDisabled === 'boolean' ? value.rendererLocalCodeDisabled : null,
    rendererFlagNames: Array.isArray(value.rendererFlagNames) ? value.rendererFlagNames.filter(key => typeof key === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,80}$/.test(key)) : [] };
  if (method === 'owner.features') return { localPolicy: label(value.localPolicy), features: Object.fromEntries(Object.entries(object(value.features)).filter(([key]) => /^(chillingSloth|cowork|ccd|desktopTopBar|localSessions)/.test(key)).map(([key, feature]) => [key, { status: label(object(feature).status), unsupportedCode: label(object(feature).unsupportedCode) }])) };
  if (method === 'owner.windows') return { windows: Array.isArray(value.windows) ? value.windows.slice(0, 16).map(input => { const row = object(input); return {
    id: Number.isSafeInteger(row.id) ? row.id : null, title: label(row.title), visible: row.visible === true, focused: row.focused === true, scheme: label(row.scheme), pathname: label(row.pathname) }; }) : [] };
  if (method === 'cowork.meta') return { sessionId: label(value.sessionId), keys: Array.isArray(value.keys) ? value.keys.filter(key => typeof key === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,80}$/.test(key)) : [],
    appMode: label(value.appMode), kind: label(value.kind), source: label(value.source), viewMode: label(value.viewMode), isRunning: typeof value.isRunning === 'boolean' ? value.isRunning : null,
    sessionType: label(value.sessionType), hostLoopMode: label(value.hostLoopMode), servesUiSurface: typeof value.servesUiSurface === 'boolean' ? value.servesUiSurface : null,
    hasError: value.hasError === true, vmPresent: value.vmPresent === true, nativeQueryPresent: value.nativeQueryPresent === true, messageCount: Number.isSafeInteger(value.messageCount) ? value.messageCount : null };
  if (method === 'cowork.transcriptShape') return { nativeKeys: Array.isArray(value.nativeKeys) ? value.nativeKeys.filter(key => typeof key === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,80}$/.test(key)) : [],
    messageCount: Number.isSafeInteger(value.messageCount) ? value.messageCount : null, markerPresent: value.markerPresent === true,
    rowTypes: Array.isArray(value.rowTypes) ? value.rowTypes.map(value => label(value)).filter(Boolean) : [] };
  if (method === 'owner.lastFailure') return { errorType: label(value.errorType), category: label(value.category),
    frames: Array.isArray(value.frames) ? value.frames.slice(0, 5).filter(frame => typeof frame === 'string' && /^index\.chunk-[A-Za-z0-9_-]+\.js:\d+:\d+$/.test(frame)) : [] };
  if (method === 'code.capabilities') return { gatewayOnly: value.gatewayOnly === true, provider: label(value.nativeConfigProvider),
    nativeModelIds: modelIds(value.nativeConfigModels), effectiveModelIds: modelIds(value.effectiveCodeModels),
    isInitializing: value.isInitializing === true, nativeScopeAvailable: value.scratchScopePresent === true, appVersion: label(value.nativeAppVersion) };
  if (['code.initialize', 'code.prepare'].includes(method)) return { provider: label(value.provider), nativeScopeAvailable: value.nativeScopeAvailable === true,
    nativeModelIds: modelIds(value.nativeModelIds), modelRequests: 0, workspaceTrusted: value.workspaceTrusted === true, accountResolved: value.accountResolved === true, organizationResolved: value.organizationResolved === true,
    errorType: label(value.errorType), errorFrames: Array.isArray(value.errorFrames) ? value.errorFrames.slice(0, 4).flatMap(frame => label(frame) ? [label(frame)] : []) : [] };
  if (/^(code|cowork)\.methods$/.test(method)) return { methods: Array.isArray(value.methods) ? value.methods.filter(name => typeof name === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,100}$/.test(name)).slice(0, 1024) : [] };
  if (/^(code|cowork|chat)\.list$/.test(method)) return { sessions: Array.isArray(value.sessions) ? value.sessions.map(header => {
    const row = object(header); return { sessionId: label(row.sessionId), title: label(row.title), cwd: label(row.cwd), model: label(row.model),
      isRunning: typeof row.isRunning === 'boolean' ? row.isRunning : null, archived: row.isArchived === true, parentSessionId: label(row.parentSessionId), dispatchParentId: label(row.dispatchParentId),
      turnRunning: typeof row.turnRunning === 'boolean' ? row.turnRunning : null,
      hasBackgroundActivity: typeof row.hasBackgroundActivity === 'boolean' ? row.hasBackgroundActivity : null,
      hasBackgroundWork: typeof row.hasBackgroundWork === 'boolean' ? row.hasBackgroundWork : null,
      headerReadStartedAt: Number.isSafeInteger(row.headerReadStartedAt) && row.headerReadStartedAt > 0 ? row.headerReadStartedAt : null,
      headerIdentityVerified: row.headerIdentityVerified === true, headerCollectionComplete: row.headerCollectionComplete === true,
      sessionType: ['chat', 'cowork'].includes(row.sessionType) ? row.sessionType : null, ownerGeneration: label(row.ownerGeneration),
      pendingPermissionCount: Number.isSafeInteger(row.pendingPermissionCount) ? row.pendingPermissionCount : null,
      createdAt: timestamp(row.createdAt), updatedAt: timestamp(row.lastActivityAt), isSubagent: row.isSubagent === true };
  }) : [], archivedPending: value.archivedPending === true, loadGeneration: Number.isSafeInteger(value.loadGeneration) ? value.loadGeneration : null };
  if (method === 'code.create') return { sessionId: label(value.sessionId), originalDesktopOwned: value.originalDesktopOwned === true,
    model: label(value.model), modelInputSent: value.modelInputSent === true };
  if (method === 'code.historyShape') return { sessionId: label(value.sessionId), sessionGeneration: label(value.sessionGeneration),
    nativeKeys: Array.isArray(value.nativeKeys) ? value.nativeKeys.filter(key => typeof key === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,80}$/.test(key)) : [],
    messageCount: Number.isSafeInteger(value.messageCount) ? value.messageCount : null, hasMore: typeof value.hasMore === 'boolean' ? value.hasMore : null,
    rowTypes: Array.isArray(value.rowTypes) ? value.rowTypes.map(value => label(value)).filter(Boolean) : [], source: label(value.source),
    cursorPresent: value.cursorPresent === true, windowStatus: label(value.windowStatus), queryPresent: value.queryPresent === true,
    pendingPermissionCount: Number.isSafeInteger(value.pendingPermissionCount) ? value.pendingPermissionCount : null };
  if (['code.send', 'cowork.send'].includes(method)) return { sessionId: label(value.sessionId), sessionGeneration: label(value.ownerGeneration ?? value.sessionGeneration),
    ownerGeneration: label(value.ownerGeneration ?? value.sessionGeneration), executionToken: label(value.executionToken ?? value.sessionGeneration),
    messageUuid: label(value.messageUuid), originalDesktopOwned: value.originalDesktopOwned === true, admitted: value.admitted === true,
    queued: typeof value.queued === 'boolean' ? value.queued : null };
  if (['code.interrupt', 'cowork.interrupt'].includes(method)) return { sessionId: label(value.sessionId), sessionGeneration: label(value.ownerGeneration ?? value.sessionGeneration),
    ownerGeneration: label(value.ownerGeneration ?? value.sessionGeneration), executionToken: label(value.executionToken ?? value.sessionGeneration),
    cancelRequested: value.cancelRequested === true, observedStatus: label(value.observedStatus) };
  if (method === 'code.requests') return { sessionGeneration: label(value.sessionGeneration), requests: Array.isArray(value.requests) ? value.requests.map(input => {
    const row = object(input); return { requestId: label(row.requestId), toolName: label(row.toolName), onlyOnCard: row.onlyOnCard === true,
      outOfTurn: row.outOfTurn === true, inputKeys: Array.isArray(row.inputKeys) ? row.inputKeys.filter(key => typeof key === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,80}$/.test(key)) : [],
      targetWithinProbe: row.targetWithinProbe === true };
  }) : [] };
  if (method === 'code.permission') return { requestId: label(value.requestId), resolved: value.resolved === true, sessionGeneration: label(value.sessionGeneration) };
  if (method === 'code.eventsShape') return { eventCount: Number.isSafeInteger(value.eventCount) ? value.eventCount : null,
    events: Array.isArray(value.events) ? value.events.slice(-32).map(event => { const row = object(event); return { type: label(row.type), sessionId: label(row.sessionId),
      keys: Array.isArray(row.keys) ? row.keys.filter(key => typeof key === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,80}$/.test(key)) : [] }; }) : [] };
  throw Error('Unverified native reply projection');
}
