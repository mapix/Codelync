import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { realpathSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ClaudeCommandReceipts } from './claude-command-receipts.mjs';
import { projectClaudeBridgeResult } from './claude-diagnostics.mjs';
import { existingClaudeRendererApi } from './claude-existing-renderer-api.mjs';
import { projectClaudeNativeMessage, boundClaudeNativeTail } from './claude-history.mjs';
import { BridgeError } from '../errors.mjs';
import { ClaudeNativeSettings } from './claude-settings.mjs';

/** @typedef {Record<string,any>} Value */
const hash = (/** @type {unknown} */ value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const deny = (/** @type {string} */ code) => Object.assign(Error(code), { effectMayHaveOccurred: false });
const SLOT = Symbol.for('codelync.claude.native.owner.v1');
const slots = /** @type {any} */ (globalThis);
const TASK_EVENTS = new Set(['task_started', 'task_progress', 'task_updated', 'task_notification', 'background_tasks_changed']);
const TASK_TERMINAL = new Set(['completed', 'failed', 'stopped']);
/** @param {unknown} input @returns {string[]} */
const verifiedTaskTypes = input => Array.isArray(input) && input.length === 1 && input[0] === 'local_bash' ? ['local_bash'] : [];
/** @param {Value|undefined} message */
const taskMessage = message => message?.type === 'system' && TASK_EVENTS.has(message.subtype);

/** Install into the existing main process via the vendor's native debugger.
 * No app files, Gateway settings, keychains, permissions or runners are changed.
 * @param {{electron:Value,hostRequire:(path:string)=>any,runtimePath:string,expectedAsarSha256:string,profileNamespace?:string,readOnly?:boolean,verifiedCodeTaskOutputTypes?:string[],verifiedCodeTaskStopTypes?:string[],verifiedCodeIdleSettings?:boolean,probeCodeIdleEffort?:boolean}} options
 * @returns {Promise<Value>} */
export async function installClaudeOwnerBridge(options) {
  const { electron, hostRequire } = options, app = electron.app, appPath = app.getAppPath(), readOnly = options.readOnly === true;
  const outputTaskTypes = verifiedTaskTypes(options.verifiedCodeTaskOutputTypes), stopTaskTypes = readOnly ? [] : verifiedTaskTypes(options.verifiedCodeTaskStopTypes);
  if (app.getVersion() !== '4.16336.0' || !appPath.endsWith('/app.asar') || !isAbsolute(options.runtimePath)) throw deny('unverified-native-owner');
  const actualHash = createHash('sha256').update(hostRequire('original-fs').readFileSync(appPath)).digest('hex');
  if (actualHash !== options.expectedAsarSha256) throw deny('source-artifact-changed');
  const probeCodeIdleEffort = options.probeCodeIdleEffort === true && !readOnly && options.profileNamespace === 'isolated-native-probe'
    && actualHash === 'a0afea1496637fe0c0327ec4310f623b4297462e124db54198ba9cd6ab3d90c8';
  const existing = slots[SLOT];
  if (existing) { if (existing.runtimePath !== options.runtimePath || existing.readOnly !== readOnly) throw deny('native-bridge-already-installed'); return existing; }
  const main = hostRequire(join(appPath, '.vite/build/index.chunk-Du-Wqi0E.js'));
  function nativeGatewayMarker() {
    const mode = main.Hft(), config = main.Lut(), source = main.Fut();
    if (mode.type !== '3p' || !main.bdt(config) || source?.type !== 'local' || config.inference?.provider !== 'gateway'
      || mode.getProvider()?.creds?.provider !== 'gateway' || mode.managesProviderRouting?.() !== true) throw deny('gateway-native-mode-unverified');
    const metadataPath = main.Wdt(), metadata = JSON.parse(hostRequire('node:fs').readFileSync(metadataPath, 'utf8'));
    if (!metadata.appliedId || !config.inference?.baseUrl || !config.inference?.credential?.kind) throw deny('gateway-native-profile-unverified');
    return hash([mode.type, source.type, metadataPath, metadata.appliedId, config.inference.provider, config.inference.baseUrl,
      config.inference.credential.kind, mode.accountIdOverride?.(), mode.orgUuidOverride?.(), mode.credentialEpoch?.()]);
  }
  const gatewayMarker = nativeGatewayMarker();
  /** @type {Value} */ const managers = { code: hostRequire(join(appPath, '.vite/build/index.chunk-CqaSnEfn.js')).claudeCodeSessionManager,
    cowork: hostRequire(join(appPath, '.vite/build/index.chunk-vuRwhTdh.js')).n };
  /** @type {Map<string,Value>} */ const apis = new Map();
  /** @type {Map<string,Value>} */ const logs = new Map();
  /** @type {Map<string,Value>} */ const dispatchCache = new Map();
  /** @type {Map<string,ClaudeNativeSettings>} */ const settingsControllers = new Map();
  const taskGuards = new Set();
  const identities = new WeakMap(), receipts = new ClaudeCommandReceipts();
  const epoch = randomBytes(16).toString('hex'), token = randomBytes(32).toString('hex'); let closed = false;
  /** @type {Value} */ let runtime;
  /** @param {Value|null|undefined} object */
  function identity(object) { if (!object) return 'none'; if (!identities.has(object)) identities.set(object, randomUUID()); return identities.get(object); }
  /** @param {Value} session @param {string} kind */
  function owner(session, kind) { const mode = main.Hft(); return hash([runtime.generation, runtime.storagePath, gatewayMarker, kind, session.sessionId, session.createdAt, session.sessionType ?? kind, mode.accountIdOverride?.(), mode.orgUuidOverride?.()]); }
  /** @param {Value} session */
  function query(session) { const mode = main.Hft(); return hash([runtime.generation, identity(session.query), session.clearGeneration ?? 0, session._deliberateStopGen ?? 0,
    session.cliSessionId, mode.credentialEpoch?.()]); }
  /** @param {string} kind */
  const collection = kind => kind === 'code' ? 'claude-code-sessions' : 'local-agent-mode-sessions';
  /** @param {string} kind */
  const collectionHost = kind => 'local:claude-desktop:' + hash([runtime.storagePath, runtime.profileNamespace, collection(kind)]);
  /** @param {string} kind @param {Value} value */
  function taskScope(kind, value) { return { app: 'claude-desktop', nativeCollection: collection(kind), hostId: collectionHost(kind),
    parentConversationId: value.sessionId, ownerGeneration: owner(value, kind), runtimeGeneration: runtime.generation,
    queryToken: value.query ? query(value) : null, cliSessionId: value.cliSessionId ?? null }; }
  /** Shared, expiring native header reads. Capture starts before the read, not on reuse.
   * @param {string} kind @returns {Promise<Value>} */
  async function dispatchHeaders(kind) {
    let cached = dispatchCache.get(kind);
    if (!cached || Date.now() - cached.at > 750) {
      const at = Date.now(), before = new Map([...managers[kind].sessions.entries()].map(([id, value]) => [id,
        { record: value, ownerGeneration: owner(value, kind), queryRef: value.query, cliSessionId: value.cliSessionId ?? null,
          dispatchParentId: value.dispatchParentId, parentSessionId: value.parentSessionId, sessionType: value.sessionType }]));
      cached = { at, promise: (async () => {
        const native = await managers[kind].getSessionList(), rows = Array.isArray(native) ? native : native.sessions;
        if (!Array.isArray(rows)) throw deny('invalid-native-headers');
        return { at, complete: native.restPending !== true && native.archivedPending !== true,
          rows: rows.map((/** @type {Value} */ header) => ({ before: before.get(header.sessionId),
            header: { sessionId: header.sessionId, title: header.title, isRunning: header.isRunning, isArchived: header.isArchived,
              pendingPermissionCount: header.pendingToolPermissions?.length ?? null } })) };
      })() }; dispatchCache.set(kind, cached);
    }
    try { return await cached.promise; } catch (error) { if (dispatchCache.get(kind) === cached) dispatchCache.delete(kind); throw error; }
  }
  /** @param {string} kind */
  function api(kind) {
    const wc = electron.webContents.getAllWebContents().find((/** @type {Value} */ contents) => {
      if (contents.isDestroyed()) return false;
      try { const location = new URL(contents.getURL()); return location.protocol === 'app:' && location.hostname === 'localhost'; } catch { return false; }
    });
    if (!wc || wc.isDestroyed()) throw deny('native-window-unavailable');
    const saved = apis.get(kind); if (saved && saved.webContents === wc) return saved.api;
    const value = existingClaudeRendererApi(wc, /** @type {'code'|'cowork'} */ (kind));
    apis.set(kind, { webContents: wc, api: value, manager: managers[kind] }); return value;
  }
  /** @param {string} kind @param {string} id */
  function session(kind, id) { const value = managers[kind]?.sessions.get(id); if (!value || kind === 'cowork' && value.sessionType !== 'chat') throw deny('unsupported-native-session'); return value; }
  /** @param {string} kind */
  function settings(kind) {
    let controller = settingsControllers.get(kind); if (controller) return controller;
    controller = new ClaudeNativeSettings({ kind: /** @type {'code'|'cowork'} */ (kind), manager: managers[kind], api: () => api(kind), mode: () => main.Hft(), readOnly,
      writeVerified: kind === 'code' && options.verifiedCodeIdleSettings === true,
      probeIdleEffort: kind === 'code' && probeCodeIdleEffort,
      scope: value => ({ app: 'claude-desktop', appMode: kind === 'code' ? 'code' : 'chat', nativeCollection: collection(kind),
        nativeConversationId: value.sessionId, hostId: collectionHost(kind), ownerGeneration: owner(value, kind), runtimeGeneration: runtime.generation,
        queryToken: value.query ? query(value) : null, cliSessionId: value.cliSessionId ?? null }),
      assertCurrent: (value, queryRef, scope) => {
        if (closed) throw deny('native-bridge-deactivated');
        if (nativeGatewayMarker() !== gatewayMarker) throw deny('source-profile-changed');
        if (managers[kind].sessions.get(value.sessionId) !== value || value.query !== queryRef || !queryRef || owner(value, kind) !== scope.ownerGeneration
          || runtime.generation !== scope.runtimeGeneration || query(value) !== scope.queryToken || value.cliSessionId !== scope.cliSessionId) throw deny('stale-query');
      },
      assertWritable: value => {
        if (kind !== 'code' || readOnly || options.verifiedCodeIdleSettings !== true && !probeCodeIdleEffort) throw deny('native-settings-gate-unverified');
        const formatter = managers.code.sessionViewRecord?.formatSessionForEvent;
        if (typeof formatter !== 'function') throw deny('native-settings-fence-unavailable');
        const header = formatter.call(managers.code.sessionViewRecord, value);
        if (header.sessionId !== value.sessionId || header.isRunning !== false || header.turnRunning !== false || header.hasBackgroundActivity !== false
          || header.hasBackgroundWork !== false || header.starting === true || value.startResumeInFlight || value.modelInFlight || value.isStopping)
          throw deny('native-settings-state-unverified');
        if (typeof managers.code.hasAgentRunInProgress !== 'function' || managers.code.hasAgentRunInProgress(value.sessionId) !== false)
          throw deny('native-settings-state-unverified');
      } });
    settingsControllers.set(kind, controller); return controller;
  }
  /** @param {string} kind @param {Value} value @param {Value} params */
  function fence(kind, value, params) {
    if (params.expectedOwnerGeneration && params.expectedOwnerGeneration !== owner(value, kind)) throw deny('source-epoch-changed');
    if (params.expectedExecutionToken !== query(value)) throw deny('stale-query');
  }
  /** @param {string} kind */
  function observe(kind) {
    let log = logs.get(kind); if (log) return log;
    log = { next: 0, rows: [], taskProof: new Map() }; const current = log;
    log.listener = (/** @type {Value} */ event) => { const value = managers[kind].sessions.get(event.sessionId); if (!value) return;
      const captured = { ownerGeneration: owner(value, kind), executionToken: query(value), cliSessionId: value.cliSessionId ?? null, queryRef: value.query };
      current.rows.push({ sequence: current.next++, event, ...captured });
      const message = event.message;
      if (taskMessage(message) && value.query && typeof message.session_id === 'string' && message.session_id === value.cliSessionId) {
        const proof = current.taskProof.get(event.sessionId) ?? {};
        const sameQuery = (/** @type {Value|undefined} */ prior) => !!prior && prior.queryRef === captured.queryRef && prior.executionToken === captured.executionToken
          && prior.cliSessionId === captured.cliSessionId && prior.ownerGeneration === captured.ownerGeneration;
        if (proof.foreground && (!sameQuery(proof.foreground) || proof.foreground.mapRef !== value.foregroundTasks)) delete proof.foreground;
        if (proof.background && !sameQuery(proof.background)) delete proof.background;
        proof.started ??= new Map(); proof.terminals ??= new Map();
        for (const [id, birth] of proof.started) if (!sameQuery(birth)) proof.started.delete(id);
        for (const [id, terminal] of proof.terminals) if (!sameQuery(terminal)) proof.terminals.delete(id);
        if (message.subtype === 'task_started' && message.ambient !== true && message.task_type !== 'dream'
          && typeof message.task_id === 'string' && typeof message.task_type === 'string') {
          proof.started.delete(message.task_id); proof.started.set(message.task_id, { ...captured, taskType: message.task_type, sequence: current.next - 1 });
          proof.terminals.delete(message.task_id);
          if (proof.started.size > 128) proof.started.delete(proof.started.keys().next().value);
        }
        if (message.subtype === 'task_notification' && typeof message.task_id === 'string') {
          const birth = proof.started.get(message.task_id);
          if (sameQuery(birth)) {
            proof.terminals.delete(message.task_id); proof.terminals.set(message.task_id, { ...captured, birth, sequence: current.next - 1,
              nativeEventId: typeof message.uuid === 'string' ? message.uuid : null, status: typeof message.status === 'string' ? message.status : 'unknown' });
            if (proof.terminals.size > 128) proof.terminals.delete(proof.terminals.keys().next().value);
          }
          proof.started.delete(message.task_id);
        }
        if (message.subtype === 'task_started' && message.is_backgrounded !== true && message.ambient !== true && message.task_type !== 'dream'
          && typeof message.task_id === 'string' && typeof message.task_type === 'string' && value.foregroundTasks instanceof Map
          && value.foregroundTasks.get(message.task_id) === message.task_type) {
          proof.foreground ??= { ...captured, mapRef: value.foregroundTasks, ids: new Map() };
          proof.foreground.ids.set(message.task_id, message.task_type);
        }
        if (message.subtype === 'task_notification' && sameQuery(proof.foreground)) proof.foreground.ids.delete(message.task_id);
        if (message.subtype === 'background_tasks_changed' && value.lastBackgroundTasksLevel === message) {
          try { proof.background = { ...captured, levelRef: message, digest: hash(projectClaudeNativeMessage(message)) }; }
          catch { delete proof.background; }
        }
        current.taskProof.delete(event.sessionId); current.taskProof.set(event.sessionId, proof);
        if (current.taskProof.size > 128) current.taskProof.delete(current.taskProof.keys().next().value);
      }
      if (current.rows.length > 512) current.rows.shift(); };
    managers[kind].on('event', log.listener); logs.set(kind, log); return log;
  }
  /** A native task birth is distinct from a map row or a reused task ID.
   * @param {Value} value @param {Value} params @param {'taskOutput'|'stopTask'} action @returns {Value} */
  function codeTask(value, params, action) {
    if (closed) throw deny('native-bridge-deactivated');
    if (nativeGatewayMarker() !== gatewayMarker) throw deny('source-profile-changed');
    if (typeof params.taskId !== 'string' || !params.taskId.trim() || params.taskId.length > 256 || /[\x00-\x1f\x7f]/.test(params.taskId)
      || typeof params.expectedOwnerGeneration !== 'string' || typeof params.expectedExecutionToken !== 'string') throw deny('invalid-task-request');
    if (managers.code.sessions.get(value.sessionId) !== value || !value.query || !value.cliSessionId) throw deny('stale-query');
    fence('code', value, params);
    const lookup = managers.code.cliTaskControls?.deps?.[action === 'stopTask' ? 'held' : 'getSession'];
    if (typeof lookup !== 'function' || lookup.call(managers.code.cliTaskControls.deps, value.sessionId) !== value) throw deny('native-task-owner-unproven');
    const log = observe('code'), proof = log.taskProof.get(value.sessionId), scope = taskScope('code', value);
    const matches = (/** @type {Value|undefined} */ item) => !!item && item.queryRef === value.query && item.ownerGeneration === scope.ownerGeneration
      && item.executionToken === scope.queryToken && item.cliSessionId === scope.cliSessionId;
    const activeBirth = proof?.started?.get(params.taskId), terminal = proof?.terminals?.get(params.taskId);
    const terminalMember = action === 'taskOutput' && !activeBirth && matches(terminal) && matches(terminal.birth)
      && TASK_TERMINAL.has(terminal.status);
    const birth = activeBirth ?? (terminalMember ? terminal.birth : null);
    if (!birth || !matches(birth)) throw deny('native-task-birth-unproven');
    if (birth.taskType !== 'local_bash') throw deny('unsupported-task-type');
    const foreground = matches(proof.foreground) && proof.foreground.mapRef === value.foregroundTasks && value.foregroundTasks instanceof Map
      && proof.foreground.ids.get(params.taskId) === 'local_bash' && value.foregroundTasks.get(params.taskId) === 'local_bash';
    let background = false;
    if (matches(proof.background) && proof.background.levelRef === value.lastBackgroundTasksLevel) {
      try {
        const level = projectClaudeNativeMessage(value.lastBackgroundTasksLevel);
        background = hash(level) === proof.background.digest && level.tasks.some((/** @type {Value} */ item) => item.task_id === params.taskId
          && item.task_type === 'local_bash' && (!Object.hasOwn(item, 'status') || ['running', 'pending', 'paused'].includes(item.status)));
      } catch { /* Unproved level remains unavailable. */ }
    }
    if (!foreground && !background && !terminalMember) throw deny('native-task-membership-unproven');
    return { value, params, action, scope, birth, log, queryRef: value.query, taskId: params.taskId };
  }
  /** Guard the original native manager entry reached by the trusted renderer IPC.
   * @param {Value} context @param {()=>Promise<any>} invoke @returns {Promise<any>} */
  async function invokeCodeTask(context, invoke) {
    const manager = managers.code, method = context.action === 'stopTask' ? 'stopBackgroundTask' : 'getTaskOutputTail';
    if (taskGuards.has(method)) throw deny('native-task-operation-busy');
    const original = manager[method], descriptor = Object.getOwnPropertyDescriptor(manager, method);
    if (typeof original !== 'function') throw deny('native-task-route-unavailable');
    taskGuards.add(method); let reached = false; /** @type {Error|null} */ let gateFailure = null;
    const guarded = function (/** @type {any[]} */ ...args) {
      if (args[0] === context.value.sessionId && args[1] === context.taskId) {
        try {
          const current = codeTask(context.value, context.params, context.action);
          if (current.birth !== context.birth || current.queryRef !== context.queryRef) throw deny('stale-task-scope');
        } catch (error) { gateFailure = error instanceof Error ? error : deny('stale-task-scope'); throw gateFailure; }
        reached = true;
      }
      return original.apply(manager, args);
    };
    try {
      try { Object.defineProperty(manager, method, { value: guarded, configurable: true, writable: true, enumerable: descriptor?.enumerable ?? false }); }
      catch { throw deny('native-task-fence-unavailable'); }
      const current = codeTask(context.value, context.params, context.action);
      if (current.birth !== context.birth || current.queryRef !== context.queryRef) throw deny('stale-task-scope');
      let result; try { result = await invoke(); } catch (error) { if (gateFailure) throw gateFailure; throw error; }
      if (!reached) throw Object.assign(Error('native-task-dispatch-unconfirmed'), { effectMayHaveOccurred: context.action === 'stopTask' });
      return result;
    } finally {
      if (manager[method] === guarded) { if (descriptor) Object.defineProperty(manager, method, descriptor); else delete manager[method]; }
      taskGuards.delete(method);
    }
  }
  /** Original notification proof, never a roster-disappearance or void-ack inference.
   * @param {Value} context */
  function taskTerminalWait(context) {
    /** @type {(value:Value|null)=>void} */ let resolve = () => {};
    /** @type {Promise<Value|null>} */ const promise = new Promise(done => { resolve = done; });
    let settled = false;
    const finish = (/** @type {Value|null} */ value) => { if (settled) return; settled = true; clearTimeout(timer); managers.code.off('event', listener); resolve(value); };
    const listener = () => {
      const terminal = context.log.taskProof.get(context.value.sessionId)?.terminals?.get(context.taskId);
      if (terminal?.birth !== context.birth || terminal.queryRef !== context.queryRef || terminal.ownerGeneration !== context.scope.ownerGeneration
        || terminal.executionToken !== context.scope.queryToken || terminal.cliSessionId !== context.scope.cliSessionId
        || terminal.sequence <= context.birth.sequence || !TASK_TERMINAL.has(terminal.status)) return;
      finish({ kind: 'native-task-notification', nativeEventId: terminal.nativeEventId, sequence: terminal.sequence, status: terminal.status });
    };
    const timer = setTimeout(() => finish(null), 3000); managers.code.on('event', listener);
    return { promise, close: () => finish(null) };
  }
  /** @param {string} method @param {Value} params */
  async function invoke(method, params) {
    if (closed) throw deny('native-bridge-deactivated');
    if (nativeGatewayMarker() !== gatewayMarker) throw deny('source-profile-changed');
    if (method === 'owner.status') return { appVersion: app.getVersion(), nativeOwner: true, bridge: 'vendor-main-debugger', readOnly, mutationAllowed: !readOnly, runtimeGeneration: runtime.generation,
      nativeSettingsReadMethods: ['code.controls', 'cowork.controls'],
      modes: { code: { routePresent: true }, chat: { routePresent: true }, cowork: { routePresent: false } } };
    if (method === 'owner.provenance') return { actualAsar: true, nativeManagerReference: managers.code === hostRequire(join(appPath, '.vite/build/index.chunk-CqaSnEfn.js')).claudeCodeSessionManager,
      mainCacheReference: main === hostRequire(join(appPath, '.vite/build/index.chunk-Du-Wqi0E.js')), generationMainReference: true,
      nativeApiFactoryInvocations: 0, existingNativeRendererApi: apis.has('code'),
      apiManagerReference: apis.get('code')?.manager === managers.code,
      extractedModuleCount: Object.keys(hostRequire('node:module')._cache).filter(path => path.startsWith(appPath.replace(/\.asar$/, '') + '/')).length,
      profileMatches: realpathSync(app.getPath('userData')) === runtime.storagePath, copiedAsarSha256: actualHash, appVersion: app.getVersion() };
    if (method === 'owner.deactivate') { await bridge.deactivate(); return { deactivated: true }; }
    const [kind, action] = method.split('.'); if (!['code', 'cowork'].includes(kind)) throw deny('unsupported-native-action');
    if (readOnly && ['send', 'interrupt', 'permission', 'stopTask', 'settings'].includes(action)) throw deny('native-read-only');
    if (kind === 'code' && (main.Lut().codeSurface?.enabled !== true || main.r3() !== 'allowed')) throw deny('native-code-policy-unavailable');
    if (kind === 'cowork' && main.Lut().chatSurface?.enabled === false) throw deny('native-chat-policy-unavailable');
    const manager = managers[kind];
    if (action === 'list') {
      const headerReadStartedAt = Date.now(), before = new Map([...manager.sessions.entries()].map(([id, value]) => [id,
        { value, owner: owner(value, kind), query: value.query, cli: value.cliSessionId, parent: value.parentSessionId, dispatchParent: value.dispatchParentId }]));
      const raw = await manager.getSessionList(), list = Array.isArray(raw) ? { sessions: raw } : raw;
      if (!Array.isArray(list.sessions) || list.sessions.length > 10000) throw deny('invalid-native-headers');
      if (nativeGatewayMarker() !== gatewayMarker) throw deny('source-profile-changed');
      const complete = kind === 'code' ? typeof list.archivedPending === 'boolean' && list.archivedPending === false
        && Number.isSafeInteger(list.loadGeneration) && list.loadGeneration >= 0 : typeof list.restPending === 'boolean' && list.restPending === false;
      return { ...list, sessions: list.sessions.filter((/** @type {Value} */ row) => kind === 'code' || row.sessionType === 'chat').map((/** @type {Value} */ row) => {
        const value = manager.sessions.get(row.sessionId), previous = before.get(row.sessionId);
        const verified = !!value && !!previous && previous.value === value && previous.owner === owner(value, kind)
          && previous.query === value.query && previous.cli === value.cliSessionId && previous.parent === value.parentSessionId && previous.dispatchParent === value.dispatchParentId;
        return { ...row, headerReadStartedAt, headerIdentityVerified: verified, headerCollectionComplete: complete,
        ...(!verified ? { isRunning: null, turnRunning: null, hasBackgroundActivity: null, hasBackgroundWork: null, parentSessionId: null, dispatchParentId: null } : {}),
        ownerGeneration: verified ? previous.owner : null,
        pendingPermissionCount: kind === 'code' ? [...manager.permissionBroker.pendingPermissions.values()].filter(request => request.sessionId === row.sessionId && !request.outOfTurn).length
          : Array.isArray(row.pendingToolPermissions) ? row.pendingToolPermissions.length : null }; }) };
    }
    const value = session(kind, params.sessionId), generation = owner(value, kind), execution = query(value);
    if (params.expectedOwnerGeneration && params.expectedOwnerGeneration !== generation) throw deny('source-epoch-changed');
    if (action === 'controls' || action === 'settings') {
      if (Object.hasOwn(params, 'expectedExecutionToken') && params.expectedExecutionToken !== (value.query ? execution : null)) throw deny('stale-query');
      return action === 'controls' ? settings(kind).read(value) : settings(kind).update(value, params.payload ?? {});
    }
    if (action === 'taskOutput' || action === 'stopTask') {
      if (kind !== 'code') throw deny('unsupported-native-action');
      const context = codeTask(value, params, action);
      if (action === 'taskOutput') {
        const output = await invokeCodeTask(context, () => api('code').getTaskOutput(params.sessionId, params.taskId));
        const current = codeTask(value, params, action);
        if (current.birth !== context.birth || current.queryRef !== context.queryRef) throw deny('stale-task-scope');
        if (!output || typeof output.output !== 'string' || typeof output.truncated !== 'boolean') throw deny('native-task-output-unavailable');
        if (Buffer.byteLength(output.output) > 65536) throw deny('native-task-output-too-large');
        return { sessionId: params.sessionId, taskId: params.taskId, scope: context.scope, output: output.output, truncated: output.truncated };
      }
      const terminal = taskTerminalWait(context);
      try {
        await invokeCodeTask(context, () => api('code').stopTask(params.sessionId, params.taskId));
        const proof = await terminal.promise;
        return { sessionId: params.sessionId, taskId: params.taskId, scope: context.scope, stopRequested: true,
          stopped: proof?.status === 'stopped', readbackConfirmed: proof !== null, terminalProof: proof, observedStatus: proof?.status ?? 'unknown' };
      } finally { terminal.close(); }
    }
    if (action === 'taskFeed') {
      if (Object.hasOwn(params, 'expectedExecutionToken') && params.expectedExecutionToken !== (value.query ? execution : null)) throw deny('stale-query');
      const log = observe(kind), cursor = params.cursor ?? 0, limit = Number.isSafeInteger(params.limit) ? Math.max(1, Math.min(128, params.limit)) : 128;
      if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > log.next) throw deny('invalid-task-cursor');
      const oldest = log.rows[0]?.sequence ?? log.next, cliSessionId = value.cliSessionId ?? null, queryRef = value.query;
      /** @param {Value|undefined} captured */
      const matches = captured => !!captured && !!queryRef && captured.queryRef === queryRef && captured.ownerGeneration === generation
        && captured.executionToken === execution && captured.cliSessionId === cliSessionId;
      const scope = taskScope(kind, value); /** @type {Value[]} */ const children = [];
      let dispatchAvailable = false, dispatchComplete = true;
      for (const childKind of ['code', 'cowork']) {
        let captured;
        try { captured = await dispatchHeaders(childKind); dispatchAvailable = true;
        } catch { dispatchComplete = false; continue; }
        dispatchComplete &&= captured.complete === true && Date.now() - captured.at <= 750;
        for (const { header, before } of captured.rows) {
          const child = managers[childKind].sessions.get(header.sessionId);
          if (!child || child.sessionId !== header.sessionId) { dispatchComplete = false; continue; }
          if (child.sessionId === value.sessionId) continue;
          const parentId = childKind === 'code' ? child.dispatchParentId : child.parentSessionId;
          if (parentId !== value.sessionId || childKind === 'cowork' && child.sessionType !== 'dispatch_child' || child.dispatchParentOrigin === 'remote') continue;
          if (child.isArchived === true || header.isArchived === true || child.lifecycleState === 'archived') continue;
          if (!before || before.record !== child || before.ownerGeneration !== owner(child, childKind)
            || before.queryRef !== child.query || before.cliSessionId !== (child.cliSessionId ?? null) || before.sessionType !== child.sessionType
            || before.dispatchParentId !== child.dispatchParentId || before.parentSessionId !== child.parentSessionId) { dispatchComplete = false; continue; }
          if (children.length >= 128) { dispatchComplete = false; continue; }
          children.push({ nativeCollectionVerified: true, parentScope: scope,
            source: { app: 'claude-desktop', id: child.sessionId, nativeCollection: collection(childKind), hostId: collectionHost(childKind), ownerGeneration: owner(child, childKind), runtimeGeneration: runtime.generation },
            childProof: { kind: childKind, record: child, ownerGeneration: owner(child, childKind), queryRef: child.query, cliSessionId: child.cliSessionId ?? null,
              parentId, sessionType: child.sessionType, observedAt: captured.at },
            nativeRecord: { sessionId: child.sessionId, title: header.title, dispatchParentId: child.dispatchParentId, dispatchParentOrigin: child.dispatchParentOrigin,
              parentSessionId: child.parentSessionId, sessionType: child.sessionType, lifecycleState: child.lifecycleState, isRunning: header.isRunning,
              pendingPermissionCount: childKind === 'code' ? [...managers.code.permissionBroker.pendingPermissions.values()].filter(request => request.sessionId === child.sessionId && !request.outOfTurn).length : header.pendingPermissionCount } });
        }
        const listed = new Set(captured.rows.map((/** @type {Value} */ row) => row.header.sessionId));
        for (const resident of managers[childKind].sessions.values()) {
          const relevant = childKind === 'code' ? resident.dispatchParentId === value.sessionId
            : resident.sessionType === 'dispatch_child' && resident.parentSessionId === value.sessionId;
          if (relevant && !listed.has(resident.sessionId)) dispatchComplete = false;
        }
      }
      if (nativeGatewayMarker() !== gatewayMarker || owner(value, kind) !== generation) throw deny('source-epoch-changed');
      if (value.query !== queryRef || query(value) !== execution || (value.cliSessionId ?? null) !== cliSessionId) throw deny('stale-query');
      const verifiedChildren = children.flatMap(child => {
        const p = child.childProof, current = managers[p.kind].sessions.get(child.source.id);
        const valid = current === p.record && owner(current, p.kind) === p.ownerGeneration && current.query === p.queryRef
          && (current.cliSessionId ?? null) === p.cliSessionId && current.sessionType === p.sessionType
          && (p.kind === 'code' ? current.dispatchParentId : current.parentSessionId) === p.parentId;
        if (!valid) dispatchComplete = false;
        if (valid && typeof current.isRunning === 'boolean') child.nativeRecord.isRunning = current.isRunning;
        if (valid && typeof current.lifecycleState === 'string') child.nativeRecord.lifecycleState = current.lifecycleState;
        if (valid && Date.now() - p.observedAt > 750) { child.nativeRecord.isRunning = null; child.nativeRecord.lifecycleState = null; dispatchComplete = false; }
        return valid ? [{ nativeCollectionVerified: child.nativeCollectionVerified, parentScope: child.parentScope,
          source: child.source, nativeRecord: child.nativeRecord }] : [];
      });
      const rows = log.rows.filter((/** @type {Value} */ row) => row.sequence >= Math.max(cursor, oldest) && row.event.sessionId === params.sessionId
        && row.ownerGeneration === generation && row.executionToken === execution && row.cliSessionId === cliSessionId && row.queryRef === queryRef && taskMessage(row.event.message)).slice(0, limit);
      const proof = log.taskProof.get(params.sessionId) ?? {}, foregroundAvailable = matches(proof.foreground)
        && proof.foreground.mapRef === value.foregroundTasks && value.foregroundTasks instanceof Map;
      const nativeForeground = foregroundAvailable ? [...value.foregroundTasks.entries()].filter(([, type]) => type !== 'dream') : [];
      const foreground = nativeForeground.filter(([id, type]) => proof.foreground.ids.get(id) === type);
      const foregroundLevel = { available: foregroundAvailable, complete: foregroundAvailable && nativeForeground.length === foreground.length && foreground.length <= 128,
        tasks: foreground.slice(0, 128).map(([task_id, task_type]) => ({ task_id, task_type })) };
      const levelAvailable = matches(proof.background) && proof.background.levelRef === value.lastBackgroundTasksLevel;
      let level = null, levelComplete = false;
      if (levelAvailable) {
        try { level = projectClaudeNativeMessage(value.lastBackgroundTasksLevel); levelComplete = hash(level) === proof.background.digest;
          if (!levelComplete) level.tasks = level.tasks.map((/** @type {Value} */ task) => ({ ...task, status: 'unknown' })); }
        catch { level = null; }
      }
      const events = rows.flatMap((/** @type {Value} */ row) => {
        try { return [{ sequence: row.sequence, message: projectClaudeNativeMessage(row.event.message) }]; } catch { return []; }
      });
      return { version: 1, sessionId: value.sessionId, ownerGeneration: generation, executionToken: execution, runtimeGeneration: runtime.generation,
        cliSessionId, queryPresent: !!queryRef, scope, cursor: rows.length ? rows.at(-1).sequence + 1 : log.next, resetRequired: cursor < oldest,
        events,
        level, foregroundLevel,
        coverage: { available: true, lifecycleComplete: false, levelComplete,
          foregroundComplete: foregroundLevel.complete, dispatchAvailable, dispatchComplete: dispatchAvailable && dispatchComplete },
        dispatchChildren: verifiedChildren, capabilities: { taskOutputVerified: kind === 'code' && !!value.query && outputTaskTypes.length > 0,
          taskStopVerified: kind === 'code' && !!value.query && stopTaskTypes.length > 0,
          outputTaskTypes: kind === 'code' && value.query ? outputTaskTypes : [], stopTaskTypes: kind === 'code' && value.query ? stopTaskTypes : [] } };
    }
    if (action === 'events') {
      const log = observe(kind), cursor = Number.isSafeInteger(params.cursor) ? params.cursor : 0, oldest = log.rows[0]?.sequence ?? log.next;
      const rows = log.rows.filter((/** @type {Value} */ row) => row.sequence >= Math.max(cursor, oldest)).slice(0, 64);
      return { sessionId: params.sessionId, ownerGeneration: generation, executionToken: execution, cursor: rows.length ? rows.at(-1).sequence + 1 : log.next,
        resetRequired: cursor < oldest, events: rows.filter((/** @type {Value} */ row) => row.event.sessionId === params.sessionId && row.executionToken === execution).map((/** @type {Value} */ row) => ({ sequence: row.sequence, type: row.event.type, message: row.event.message })) };
    }
    if (action === 'snapshot' || action === 'page') {
      observe(kind); let data;
      if (kind === 'code') {
        if (action === 'snapshot') data = boundClaudeNativeTail(await api(kind).getTranscriptTail(params.sessionId, 32));
        else { if (!params.cursor) throw deny('explicit-history-cursor-required'); data = await api(kind).getTranscriptPage(params.sessionId, params.cursor, 32, { window: 'accept' }); }
      } else if (action === 'snapshot') {
        const rows = await api(kind).getTranscript(params.sessionId, { limit: 33, maxScan: 1024 * 1024 }); data = { messages: rows.slice(-32), hasMore: rows.length > 32 ? true : null, source: 'tail' };
      } else {
        if (!params.cursor) throw deny('explicit-history-cursor-required'); const read = await manager.getTranscriptRead(params.sessionId), index = read.messages.findIndex((/** @type {Value} */ row) => row.uuid === params.cursor);
        if (index < 0) throw deny('stale-history-cursor'); data = { messages: read.messages.slice(Math.max(0, index - 32), index), hasMore: index > 32 ? true : read.diag?.truncated ? null : false, found: true, source: 'full' };
      }
      const header = await api(kind).getSession(params.sessionId, kind === 'cowork' ? { metadataOnly: true } : undefined);
      if (owner(value, kind) !== generation) throw deny('source-epoch-changed');
      return { ...data, sessionId: params.sessionId, ownerGeneration: generation, executionToken: query(value),
        requests: action === 'snapshot' && kind === 'code' ? [...manager.permissionBroker.pendingPermissions.entries()].filter(([, request]) => request.sessionId === params.sessionId).map(([id, request]) => ({ requestId: id, toolName: request.toolName, input: request.input, onlyOnCard: request.onlyOnCard, outOfTurn: request.outOfTurn })) : [],
        header: { sessionId: header.sessionId, sessionType: kind === 'code' ? 'code' : value.sessionType, isRunning: header.isRunning,
          turnRunning: header.turnRunning, hasBackgroundActivity: header.hasBackgroundActivity, hasBackgroundWork: header.hasBackgroundWork,
          starting: header.starting, queryPresent: !!value.query, model: header.model, effort: header.effort ?? header.effortLevel,
          pendingPermissionCount: kind === 'code' ? [...manager.permissionBroker.pendingPermissions.values()].filter(request => request.sessionId === params.sessionId && !request.outOfTurn).length : header.pendingToolPermissions?.length ?? null } };
    }
    fence(kind, value, params);
    if (action === 'send') {
      if (main.Hft().getProvider()?.creds?.provider !== 'gateway' || main.Lut().inference?.provider !== 'gateway') throw deny('gateway-route-not-proven');
      if (typeof params.message !== 'string' || !params.message.trim() || params.message.length > 1024 * 1024 || !/^[a-f0-9-]{36}$/.test(params.messageUuid ?? '')) throw deny('invalid-native-input');
      let queued;
      if (kind === 'code') {
        const descriptor = Object.getOwnPropertyDescriptor(manager, 'sendMessage'), original = manager.sendMessage;
        const observer = async (/** @type {any[]} */ ...args) => { const result = await original.apply(manager, args); if (args[0] === params.sessionId && args[3]?.messageUuid === params.messageUuid) queued = result?.queued === true; return result; };
        manager.sendMessage = observer;
        try { await api(kind).sendMessage(params.sessionId, params.message, undefined, undefined, undefined, undefined, undefined, params.messageUuid, undefined, undefined, undefined, undefined, undefined, undefined, { personSent: true, rejectUndelivered: true }); }
        finally { if (descriptor) Object.defineProperty(manager, 'sendMessage', descriptor); else delete manager.sendMessage; }
      } else { const result = await api(kind).sendMessage(params.sessionId, params.message, undefined, undefined, params.messageUuid); if (result?.dispatched === false) throw Error('native-admission-unconfirmed'); }
      return { sessionId: params.sessionId, ownerGeneration: owner(value, kind), executionToken: query(value), messageUuid: params.messageUuid, originalDesktopOwned: true, admitted: true, queued };
    }
    if (action === 'interrupt') {
      const header = await api(kind).getSession(params.sessionId, kind === 'cowork' ? { metadataOnly: true } : undefined);
      if (header.isRunning !== true) throw deny('stale-turn'); if (kind === 'code') await api(kind).interrupt(params.sessionId); else await api(kind).stop(params.sessionId);
      const after = await api(kind).getSession(params.sessionId, kind === 'cowork' ? { metadataOnly: true } : undefined);
      return { sessionId: params.sessionId, ownerGeneration: owner(value, kind), executionToken: query(value), cancelRequested: true, observedStatus: after.isRunning ? 'running' : 'idle' };
    }
    if (action === 'permission' && kind === 'code') {
      const request = manager.permissionBroker.pendingPermissions.get(params.requestId);
      if (!request || request.sessionId !== params.sessionId || request.toolName !== 'Write' || request.onlyOnCard || request.outOfTurn) throw deny('stale-approval');
      if (!['once', 'deny'].includes(params.decision)) throw deny('invalid-approval'); await api(kind).respondToToolPermission(params.requestId, params.decision);
      return { requestId: params.requestId, resolved: !manager.permissionBroker.pendingPermissions.has(params.requestId), sessionGeneration: generation };
    }
    throw deny('unsupported-native-action');
  }
  const server = http.createServer(async (request, response) => {
    if (request.headers.authorization !== 'Bearer ' + token) { response.writeHead(401).end(); return; }
    if (request.url !== '/rpc' || request.method !== 'POST') { response.writeHead(404).end(); return; }
    /** @type {Value} */ let packet = {}; let invoked = false;
    try {
      let body = ''; for await (const part of request) { body += part; if (body.length > 131072) throw deny('bounded-request'); }
      packet = JSON.parse(body); if (packet.version !== 1 || !/^(owner|code|cowork)\.[A-Za-z][A-Za-z0-9]{0,63}$/.test(packet.method ?? '')) throw deny('invalid-request');
      const mutation = /^(code|cowork)\.(send|interrupt|permission|stopTask|settings)$/.test(packet.method);
      if (readOnly && mutation) throw deny('native-read-only');
      const operation = mutation ? receipts.admit(packet.commandId, packet.method, packet.params ?? {}, () => invoke(packet.method, packet.params ?? {})) : invoke(packet.method, packet.params ?? {});
      invoked = true; const value = await receipts.wait(operation, 10000), result = packet.method === 'owner.deactivate' ? value : projectClaudeBridgeResult(packet.method, value);
      const bodyOut = JSON.stringify({ version: 1, ok: true, ownerGeneration: runtime.generation, hostId: runtime.hostId, ...(packet.commandId ? { commandId: packet.commandId } : {}), result });
      if (Buffer.byteLength(bodyOut) > 8 * 1024 * 1024) throw Error('native-response-too-large'); response.writeHead(200, { 'Content-Type': 'application/json' }).end(bodyOut);
    } catch (error) {
      const nativeError = error instanceof Error ? /** @type {Error & {effectMayHaveOccurred?:boolean}} */ (error) : Error('native-operation-unavailable');
      const candidate = nativeError instanceof BridgeError ? nativeError.code : nativeError.message;
      const code = /^[a-z][a-z-]{0,64}$/.test(candidate ?? '') ? candidate : 'native-operation-unavailable';
      response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ version: 1, ok: false, ownerGeneration: runtime.generation, hostId: runtime.hostId,
        ...(packet?.commandId ? { commandId: packet.commandId } : {}), error: { code }, effectMayHaveOccurred: /^(code|cowork)\.(send|interrupt|permission|stopTask|settings)$/.test(packet?.method ?? '') && invoked && /** @type {Error & {effectMayHaveOccurred?:boolean}} */ (nativeError).effectMayHaveOccurred !== false }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const startTime = execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
  runtime = { version: 1, protocol: 'claude-desktop-native', pid: process.pid, parentPid: process.ppid, startTime, executable: process.execPath,
    storagePath: realpathSync(app.getPath('userData')), profileNamespace: options.profileNamespace ?? 'stock-desktop', bootEpoch: epoch, accessToken: token,
    origin: 'http://127.0.0.1:' + /** @type {any} */ (server.address()).port, appVersion: app.getVersion(), asarSha256: actualHash, gatewayMarker, readOnly, mutationAllowed: !readOnly };
  runtime.generation = 'claude-desktop:' + hash([runtime.executable, runtime.pid, runtime.parentPid, runtime.startTime, runtime.bootEpoch]);
  runtime.hostId = 'local:claude-desktop:' + hash([runtime.storagePath, runtime.profileNamespace]);
  mkdirSync(dirname(options.runtimePath), { recursive: true, mode: 0o700 }); writeFileSync(options.runtimePath, JSON.stringify(runtime), { mode: 0o600 });
  const onBeforeQuit = () => { void bridge.deactivate(); };
  const bridge = { runtimePath: options.runtimePath, pid: process.pid, version: 1, readOnly,
    async deactivate() { if (closed) return; closed = true; for (const [kind, log] of logs) managers[kind].off('event', log.listener); logs.clear();
      for (const controller of settingsControllers.values()) controller.close();
      app.off('before-quit', onBeforeQuit); apis.clear(); dispatchCache.clear(); settingsControllers.clear(); server.close(); try { unlinkSync(options.runtimePath); } catch {} delete slots[SLOT]; } };
  slots[SLOT] = bridge; app.once('before-quit', onBeforeQuit); return bridge;
}
