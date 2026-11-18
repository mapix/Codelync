import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { nativeSettingsScope, sameNativeSettingsScope } from '../codelync/native-settings-scope.mjs';

/** @typedef {Record<string,any>} Value */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const object = (/** @type {unknown} */ input) => input && typeof input === 'object' && !Array.isArray(input) ? /** @type {Value} */ (input) : {};
const label = (/** @type {unknown} */ input, max = 512) => typeof input === 'string' && !!input.trim() && input.length <= max && !/[\x00-\x1f\x7f]/.test(input) ? input : null;
const hash = (/** @type {unknown} */ input) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const fail = (/** @type {string} */ code, effect = false) => Object.assign(Error(code), { effectMayHaveOccurred: effect });
/** @param {unknown} error @param {boolean} effect @returns {Error & {effectMayHaveOccurred?:boolean}} */
function preserveEffect(error, effect) {
  const inherited = Boolean(error && typeof error === 'object' && /** @type {Value} */ (error).effectMayHaveOccurred === true);
  const mayHaveOccurred = effect || inherited;
  if (error instanceof Error) {
    const desc = Object.getOwnPropertyDescriptor(error, 'effectMayHaveOccurred');
    if (desc?.value === mayHaveOccurred) return error;
    if (Object.isExtensible(error) && (!desc || desc.writable && desc.configurable)) {
      /** @type {Value} */ (error).effectMayHaveOccurred = mayHaveOccurred;
      return error;
    }
    const wrapped = Error(error.message || 'native-settings-operation-failed', { cause: error });
    wrapped.name = error.name;
    if (typeof /** @type {Value} */ (error).code === 'string') /** @type {Value} */ (wrapped).code = /** @type {Value} */ (error).code;
    if (error.stack) wrapped.stack = error.stack;
    return Object.assign(wrapped, { effectMayHaveOccurred: mayHaveOccurred });
  }
  const msg = typeof error === 'string' && error ? error
    : error && typeof error === 'object' && typeof /** @type {Value} */ (error).message === 'string' && /** @type {Value} */ (error).message
      ? /** @type {Value} */ (error).message : 'native-settings-operation-failed';
  const code = error && typeof error === 'object' && typeof /** @type {Value} */ (error).code === 'string' ? /** @type {Value} */ (error).code : null;
  return Object.assign(Error(msg), { ...(code ? { code } : {}), effectMayHaveOccurred: mayHaveOccurred });
}
const SCOPE_IDENTITY_KEYS = ['app', 'appMode', 'nativeCollection', 'nativeConversationId', 'hostId', 'ownerGeneration', 'runtimeGeneration', 'queryToken', 'cliSessionId'];
/** @param {unknown} a @param {unknown} b */
function sameScopeIdentity(a, b) {
  if (!a || typeof a !== 'object' || !b || typeof b !== 'object') return false;
  const left = /** @type {Value} */ (a), right = /** @type {Value} */ (b);
  return SCOPE_IDENTITY_KEYS.every(key => left[key] === right[key]);
}
/** The native Query read can await initialization; its failure never creates another Query.
 * @param {()=>Promise<any>} read @returns {Promise<any>} */
async function boundedRead(read) {
  /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer;
  try { return await Promise.race([Promise.resolve().then(read), new Promise((_, reject) => { timer = setTimeout(() => reject(fail('native-settings-read-timeout')), 2000); })]); }
  finally { clearTimeout(timer); }
}

/** Strict catalogue projection, independent of settings write permission.
 * @param {unknown} raw @param {Value} mode @param {'code'|'cowork'} kind */
export function claudeNativeModels(raw, mode, kind) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 256 || typeof mode.clampSessionEffort !== 'function') return { complete: false, items: [] };
  const seen = new Set(); /** @type {Value[]} */ const items = [];
  for (const input of raw) {
    const row = object(input), id = label(typeof input === 'string' ? input : row.value ?? row.id);
    if (!id || seen.has(id)) return { complete: false, items: [] };
    seen.add(id);
    const resolvedModel = label(row.resolvedModel), policyModel = resolvedModel ?? id;
    const supportsEffort = typeof row.supportsEffort === 'boolean' ? row.supportsEffort : null;
    const supportedEffortLevels = Array.isArray(row.supportedEffortLevels) && row.supportedEffortLevels.length <= 5
      && row.supportedEffortLevels.every((/** @type {string} */ effort) => EFFORTS.includes(effort)) ? [...row.supportedEffortLevels] : null;
    const reasoningEfforts = supportsEffort === true && supportedEffortLevels ? EFFORTS.filter(effort => supportedEffortLevels.includes(effort)
      && mode.clampSessionEffort(kind, policyModel, effort) === effort) : [];
    const defaultEffort = supportsEffort === true ? mode.clampSessionEffort(kind, policyModel, undefined) : null;
    if (defaultEffort !== undefined && defaultEffort !== null && !EFFORTS.includes(defaultEffort)) return { complete: false, items: [] };
    const defaultOffered = typeof defaultEffort === 'string' && reasoningEfforts.includes(defaultEffort);
    const effortCatalogComplete = supportsEffort === true && supportedEffortLevels !== null && reasoningEfforts.length > 0
      && (defaultEffort === undefined || defaultEffort === null || defaultOffered);
    items.push({ id, label: label(row.displayName ?? row.labelOverride ?? row.name) ?? id,
      reasoningEfforts, defaultReasoningEffort: defaultOffered ? defaultEffort : null,
      supportsEffort, supportedEffortLevels, effortCatalogComplete,
      ...(resolvedModel ? { nativeResolvedModel: resolvedModel } : {}),
      ...(label(row.description, 4096) ? { description: row.description } : {}) });
  }
  return { complete: true, items };
}

/** @param {unknown} raw */
export function claudeNativeCommands(raw) {
  if (!Array.isArray(raw) || raw.length > 1024) return { complete: false, items: [] };
  const seen = new Set(); /** @type {Value[]} */ const items = [];
  for (const input of raw) {
    const row = object(input), name = label(row.name, 128);
    if (!name || !/^[A-Za-z0-9][A-Za-z0-9_:.-]*$/.test(name) || seen.has(name)) return { complete: false, items: [] };
    seen.add(name); items.push({ name, description: label(row.description, 4096) ?? '', execution: 'unsupported' });
  }
  return { complete: true, items };
}

/** Selected native Query settings. Dependencies are original owner references;
 * no constructor, API factory, renderer listener or runner is invoked here. */
export class ClaudeNativeSettings {
  /** @param {{manager:Value,api:()=>Value,mode:()=>Value,scope:(value:Value)=>Value,assertCurrent:(value:Value,query:Value,scope:Value)=>void,assertWritable?:(value:Value)=>void,readOnly:boolean,writeVerified?:boolean,probeIdleEffort?:boolean,ackTimeoutMs?:number,kind?:'code'|'cowork'}} options */
  constructor(options) { this.options = options; this.kind = options.kind ?? 'code'; this.busy = false; this.closed = false;
    this.context = new AsyncLocalStorage(); /** @type {Set<Value>} */ this.pending = new Set(); }
  /** @param {Value} value */
  record(value) { return { model: label(value.model), effort: label(value.effort, 128),
    modelRecordSeq: Number.isSafeInteger(value.modelRecordSeq) ? value.modelRecordSeq : null,
    modelChangeSeq: Number.isSafeInteger(value.modelChangeSeq) ? value.modelChangeSeq : null,
    modelConfirmed: label(value.modelConfirmed?.model), unconfirmed: value.modelUnconfirmedOn === value.query,
    modelInFlight: !!value.modelInFlight, startInFlight: !!value.startResumeInFlight }; }
  /** @param {Value} value @param {Value} query @param {Value} scope @param {Value} header */
  idle(value, query, scope, header) {
    this.options.assertCurrent(value, query, scope);
    const idle = this.kind === 'code' && value.backend?.kind === 'local' && header.sessionId === value.sessionId
      && header.isRunning === false && header.turnRunning === false && header.hasBackgroundActivity === false
      && header.hasBackgroundWork === false && header.starting !== true && !value.startResumeInFlight
      && !value.modelInFlight && !value.isStopping;
    if (idle && (this.options.writeVerified === true || this.options.probeIdleEffort === true) && !this.options.readOnly) {
      try { this.options.assertWritable?.(value); } catch { return false; }
    }
    return idle;
  }
  /** @param {Value} value @returns {Promise<Value>} */
  async read(value) {
    if (this.closed) throw fail('native-bridge-deactivated');
    const query = value?.query, base = this.options.scope(value), expectedMode = this.kind === 'cowork' ? 'chat' : 'code';
    if (!query || !base || typeof base !== 'object' || base.appMode !== expectedMode || !label(base.queryToken) || !label(base.cliSessionId)) throw fail('native-settings-query-unavailable');
    this.options.assertCurrent(value, query, base);
    const before = this.record(value), mode = this.options.mode();
    const reads = await Promise.allSettled([
      boundedRead(() => { if (typeof query.supportedModels !== 'function') throw fail('native-model-catalog-unavailable'); return query.supportedModels(); }),
      boundedRead(() => query.supportedCommands()),
      boundedRead(() => query.getContextUsage({ detail: 'summary' })),
      boundedRead(() => query.getSettings()),
      boundedRead(() => this.options.api().getSession(value.sessionId, this.kind === 'cowork' ? { metadataOnly: true } : undefined)),
    ]);
    this.options.assertCurrent(value, query, base);
    if (!sameScopeIdentity(base, this.options.scope(value))) throw fail('stale-query');
    if (hash(before) !== hash(this.record(value))) throw fail('settings-conflict');
    const result = (/** @type {number} */ index) => reads[index].status === 'fulfilled' ? reads[index].value : null;
    const models = claudeNativeModels(result(0), mode, this.kind), commands = claudeNativeCommands(result(1));
    const usage = object(result(2)), applied = object(object(result(3)).applied);
    const model = label(usage.model), effort = applied.effort === null ? null : label(applied.effort, 128);
    const modelAckConfirmed = !!model, effortAckConfirmed = Object.hasOwn(applied, 'effort') && (applied.effort === null || !!effort);
    const current = modelAckConfirmed && effortAckConfirmed ? { model, reasoningEffort: effort, modelProvider: 'claude-desktop' } : null;
    const header = object(result(4)), idleHeld = this.idle(value, query, base, header);
    const confirmation = { modelAckConfirmed, effortAckConfirmed, source: 'existing-query-readback' };
    const scope = nativeSettingsScope({ ...base, settingsToken: hash([models, commands, current, confirmation, before]) });
    if (!scope) throw fail('native-settings-scope-unavailable');
    const match = current ? models.items.find(row => row.id === current.model || row.nativeResolvedModel === current.model) : null;
    const catalogMatches = !!match && match.effortCatalogComplete;
    return { scope, nativeRecordToken: hash(before), model: { available: !this.options.readOnly && this.options.writeVerified === true && idleHeld && models.complete && catalogMatches,
      catalogAvailable: models.complete, catalogComplete: models.complete, catalogSource: 'existing-native-query', current,
      currentConfirmed: current !== null, idleHeld, models: models.items, selectionMode: 'original-owner', ...(current ? { selectionState: 'native' } : {}),
      reason: this.options.readOnly ? 'native-read-only' : !current ? 'native-current-settings-unconfirmed' : !models.complete ? 'native-model-catalog-unavailable'
        : !catalogMatches ? 'native-current-model-off-catalog' : !idleHeld ? 'native-settings-state-unverified' : this.options.writeVerified !== true ? 'native-settings-gate-unverified' : null },
    commands: { available: commands.complete, complete: commands.complete, source: 'existing-native-query', items: commands.items, executionAvailable: false },
    confirmation, nativeRecordSequences: { modelRecordSeq: before.modelRecordSeq, modelChangeSeq: before.modelChangeSeq } };
  }
  /** The initialized owner delegate enters synchronously; no renderer request can arrive late.
   * @param {Value} value @param {Value} query @param {Value} scope @param {'setModel'|'setEffort'} method @param {unknown} argument @param {string|null} expectedEffort @param {string} recordToken @returns {Promise<Value>} */
  async setter(value, query, scope, method, argument, expectedEffort, recordToken) {
    const manager = this.options.manager, nativeMethod = method === 'setModel' ? 'setModel' : 'applyFlagSettings';
    /** @type {Value[]} */ const saved = [];
    const observation = /** @type {Value} */ ({ managerCalls: 0, acknowledgements: [], reached: false });
    const initialRecord = hash(this.record(value)), settings = this;
    if (initialRecord !== recordToken) throw fail('settings-conflict');
    const operation = /** @type {Value} */ ({ active: true, cancel: () => {} }); this.pending.add(operation);
    let invoked = false; /** @type {Error|null} */ let gateFailure = null;
    const own = () => settings.context.getStore() === operation;
    /** @param {Value} host @param {string} name @param {(original:Function)=>Function} wrap */
    const guard = (host, name, wrap) => {
      const original = host[name], descriptor = Object.getOwnPropertyDescriptor(host, name);
      if (typeof original !== 'function') throw fail('native-settings-route-unavailable');
      const replacement = wrap(original);
      Object.defineProperty(host, name, { value: replacement, configurable: true, writable: true, enumerable: descriptor?.enumerable ?? false });
      saved.push({ host, name, descriptor, replacement });
    };
    const assert = () => { if (!operation.active || settings.closed) throw fail('native-settings-ack-expired', invoked);
      this.options.assertCurrent(value, query, scope);
      const deps = manager.sessionModelSettings?.deps;
      if (typeof deps?.getSession !== 'function' || deps.getSession(value.sessionId) !== value) throw fail('native-settings-owner-unproven', operation.active && observation.reached);
      this.options.assertWritable?.(value); this.options.assertCurrent(value, query, scope); };
    /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer;
    const cleanup = () => {
      if (operation.cleaned) return; operation.cleaned = true; operation.active = false; clearTimeout(timer); this.pending.delete(operation);
      for (const row of saved.reverse()) if (row.host[row.name] === row.replacement) {
        if (row.descriptor) Object.defineProperty(row.host, row.name, row.descriptor); else delete row.host[row.name];
      }
    };
    try {
      guard(manager, method, original => function (/** @type {unknown[]} */ ...args) {
        if (args[0] === value.sessionId && args[1] === argument) {
          observation.managerCalls++;
          if (observation.managerCalls === 1) {
            try { assert(); if (hash(settings.record(value)) !== initialRecord) throw fail('settings-conflict'); }
            catch (error) { gateFailure = error instanceof Error ? error : fail('settings-conflict'); throw gateFailure; }
            observation.reached = true; return settings.context.run(operation, () => original.apply(manager, args));
          }
          observation.superseded = true;
        }
        return original.apply(manager, args);
      });
      const otherMethod = method === 'setModel' ? 'setEffort' : 'setModel';
      guard(manager, otherMethod, original => function (/** @type {unknown[]} */ ...args) {
        if (args[0] === value.sessionId && !own()) observation.superseded = true;
        return original.apply(manager, args);
      });
      if (typeof manager.emitSessionUpdated === 'function') guard(manager, 'emitSessionUpdated', original => function (/** @type {any[]} */ ...args) {
        const result = original.apply(manager, args);
        if (args[0] === value && own()) assert();
        return result;
      });
      if (method === 'setModel' && manager.sessionModelSettings) guard(manager.sessionModelSettings, 'applyModelChange', original => function (/** @type {any[]} */ ...args) {
        if (args[0] === value && own()) assert();
        return original.apply(manager.sessionModelSettings, args);
      });
      guard(query, nativeMethod, original => async function (/** @type {any[]} */ ...args) {
        if (!own()) { observation.superseded = true; return original.apply(query, args); }
        assert();
        if (observation.managerCalls !== 1) throw fail('native-settings-dispatch-unconfirmed', observation.reached);
        const nativeValue = method === 'setModel' ? label(args[0]) : args[0]?.effortLevel === undefined || args[0]?.effortLevel === null ? null : label(args[0]?.effortLevel, 128);
        if (method === 'setModel' && !nativeValue || method === 'setEffort' && (typeof args[0] !== 'object' || !Object.hasOwn(args[0], 'effortLevel')))
          throw fail('native-settings-ack-unavailable', observation.reached);
        if (method === 'setEffort' && nativeValue !== expectedEffort) throw fail('native-effort-policy-changed', observation.reached);
        const seq = Number.isSafeInteger(value.modelChangeSeq) ? value.modelChangeSeq : null;
        let result; try { result = await original.apply(query, args); }
        catch (error) { if (!operation.active || settings.closed) throw fail('native-settings-ack-expired', true); throw error; }
        if (!operation.active || settings.closed) throw fail('native-settings-ack-expired', true);
        settings.options.assertCurrent(value, query, scope);
        observation.acknowledgements.push({ value: nativeValue, modelChangeSeq: seq }); return result;
      });
      assert();
      const deadline = new Promise((_, reject) => { operation.cancel = () => { cleanup(); reject(fail('native-settings-ack-expired', invoked)); };
        timer = setTimeout(operation.cancel, Math.max(1, Math.min(this.options.ackTimeoutMs ?? 3000, 3000))); });
      // The wrapper and delegate call are one owner stack, including the record-token fence.
      invoked = true; await Promise.race([manager[method](value.sessionId, argument), deadline]); assert();
      if (observation.superseded) throw fail('settings-superseded', observation.reached);
      return observation;
    } catch (error) {
      throw preserveEffect(gateFailure ?? error, observation.reached);
    } finally {
      cleanup();
    }
  }
  /** @param {Value} value @param {Value} payload @returns {Promise<Value>} */
  async update(value, payload) {
    if (this.closed) throw fail('native-bridge-deactivated');
    if (this.options.readOnly) throw fail('native-read-only');
    if (this.kind !== 'code' || this.options.writeVerified !== true && this.options.probeIdleEffort !== true) throw fail('native-settings-gate-unverified');
    if (this.busy) throw fail('native-settings-operation-busy');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw fail('invalid-settings');
    const expected = nativeSettingsScope(payload.expectedScope);
    if (!expected || !label(payload.model) || !label(payload.expectedModel)
      || payload.reasoningEffort !== null && !EFFORTS.includes(payload.reasoningEffort)
      || payload.expectedReasoningEffort !== null && !EFFORTS.includes(payload.expectedReasoningEffort)
      || Object.keys(payload).some(key => !['model', 'reasoningEffort', 'expectedModel', 'expectedReasoningEffort', 'expectedScope'].includes(key))) throw fail('invalid-settings');
    this.busy = true; let effect = false;
    try {
      const liveScope = this.options.scope(value);
      if (expected.appMode !== 'code' || !sameScopeIdentity(expected, liveScope)) throw fail('settings-conflict');
      const before = await this.read(value), current = before.model.current;
      const probe = this.options.probeIdleEffort === true && this.options.writeVerified !== true;
      const writable = before.model.available || probe && before.model.idleHeld && before.model.catalogComplete && !!current;
      if (!sameNativeSettingsScope(before.scope, expected) || !writable || current.model !== payload.expectedModel
        || current.reasoningEffort !== payload.expectedReasoningEffort || !before.model.models.some((/** @type {Value} */ row) => row.id === payload.model || row.nativeResolvedModel === payload.model)) throw fail('settings-conflict');
      if (probe && payload.model !== current.model) throw fail('native-model-settings-gate-unverified');
      const query = value.query, identityScope = { ...before.scope };
      this.options.assertCurrent(value, query, identityScope);
      const selected = before.model.models.find((/** @type {Value} */ row) => row.id === payload.model || row.nativeResolvedModel === payload.model);
      if (selected.supportsEffort !== true || selected.effortCatalogComplete !== true) throw fail('native-effort-catalog-unavailable');
      const askedEffort = payload.reasoningEffort === null ? undefined : payload.reasoningEffort;
      const clamped = this.options.mode().clampSessionEffort(this.kind, selected.nativeResolvedModel ?? selected.id, askedEffort);
      if (!selected.reasoningEfforts.includes(clamped)) throw fail('native-effort-catalog-unavailable');
      let modelAck = current.model === (selected.nativeResolvedModel ?? selected.id), effortAck = false, effectiveModel = current.model, seq = before.nativeRecordSequences.modelChangeSeq;
      if (!modelAck) {
        const observed = await this.setter(value, query, identityScope, 'setModel', payload.model, null, before.nativeRecordToken); effect ||= observed.reached;
        modelAck = observed.managerCalls === 1 && observed.acknowledgements.length === 1;
        seq = observed.acknowledgements[0]?.modelChangeSeq ?? seq;
        const acknowledgedModel = observed.acknowledgements[0]?.value ?? null;
        effectiveModel = acknowledgedModel === selected.id && selected.nativeResolvedModel ? selected.nativeResolvedModel : acknowledgedModel;
        if (value.modelChangeSeq !== seq || value.modelRecordSeq !== seq) throw fail('settings-superseded', effect);
      }
      // An early facade return cannot turn a missing model ACK into a settings success.
      if (!modelAck) throw fail('native-settings-ack-unconfirmed', effect);
      const actualTarget = this.options.mode().clampSessionEffort(this.kind, value.model, askedEffort);
      if (!selected.reasoningEfforts.includes(actualTarget)) throw fail('native-effort-policy-changed', effect);
      const postModelRecord = current.model === (selected.nativeResolvedModel ?? selected.id) ? before.nativeRecordToken : hash(this.record(value));
      const observed = await this.setter(value, query, identityScope, 'setEffort', payload.reasoningEffort, actualTarget, postModelRecord); effect ||= observed.reached;
      effortAck = observed.managerCalls === 1 && observed.acknowledgements.length === 1;
      const controls = await this.read(value);
      const effective = controls.model.current, nativeEffort = observed.acknowledgements[0]?.value;
      const recordSeq = current.model === (selected.nativeResolvedModel ?? selected.id) ? before.nativeRecordSequences.modelRecordSeq : seq;
      const complete = modelAck && effortAck && !!effective && effective.model === effectiveModel && effective.reasoningEffort === nativeEffort
        && hash(before.model.models) === hash(controls.model.models)
        && sameNativeSettingsScope(expected, controls.scope, false) && controls.nativeRecordSequences.modelChangeSeq === seq
        && controls.nativeRecordSequences.modelRecordSeq === recordSeq;
      return { applied: true, settingsReadbackConfirmed: complete, controls,
        ...(complete ? { nativeSettingsEvidence: { version: 1, expectedScope: expected, confirmedScope: controls.scope,
          modelAckConfirmed: true, effortAckConfirmed: true, effectiveModel: effective.model, effectiveReasoningEffort: effective.reasoningEffort } } : {}) };
    } catch (error) {
      throw preserveEffect(error, effect);
    } finally { this.busy = false; }
  }
  /** Revoke pending owner operations; late native replies cannot republish ACKs. */
  close() { this.closed = true; this.busy = false; for (const operation of this.pending) operation.cancel(); }
}
