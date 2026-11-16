import { readFile, stat, realpath } from 'node:fs/promises';
import { isAbsolute, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BridgeError } from '../errors.mjs';
import { nativeSettingsScope } from '../happy/native-settings-scope.mjs';

/** @typedef {Record<string,any>} Value */
const exec = promisify(execFile), MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** @type {Map<string,{stamp:string,sha256:string}>} */ const artifactCache = new Map();
const fail = (code = 'claude-desktop-unavailable') => new BridgeError(code, 'The original Claude Desktop owner is unavailable.', 503);
export const CLAUDE_NATIVE_TASK_METHODS = Object.freeze(['code.taskFeed', 'cowork.taskFeed', 'code.taskOutput', 'code.stopTask', 'cowork.stopTask']);
const TASK_METHODS = new Set(CLAUDE_NATIVE_TASK_METHODS);
const READ_ONLY_METHODS = new Set(['owner.status', 'owner.provenance', 'owner.deactivate', 'code.list', 'cowork.list', 'code.snapshot', 'cowork.snapshot',
  'code.page', 'cowork.page', 'code.events', 'cowork.events', 'code.taskFeed', 'cowork.taskFeed', 'code.taskOutput', 'code.controls', 'cowork.controls']);
/** Exact model settings routes; a mutation mislabeled as a read never reaches the owner.
 * @param {string} method @param {Value} params @param {Value} options */
function settingsRequest(method, params, options) {
  if (!['code.controls', 'cowork.controls', 'code.settings', 'cowork.settings'].includes(method)) throw new BridgeError('unsupported-action', 'This original settings operation is unavailable.');
  const update = method.endsWith('.settings'), keys = ['sessionId', 'expectedOwnerGeneration', 'expectedExecutionToken', ...(update ? ['payload'] : [])];
  const identity = (/** @type {unknown} */ value, max = 512) => typeof value === 'string' && !!value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
  if (!identity(params.sessionId) || Object.keys(params).some(key => !keys.includes(key)) || update !== (options.mutation === true)
    || params.expectedOwnerGeneration !== undefined && !identity(params.expectedOwnerGeneration)
    || params.expectedExecutionToken !== undefined && params.expectedExecutionToken !== null && !identity(params.expectedExecutionToken)) throw Object.assign(new BridgeError('invalid-settings', 'An exact original settings route and owner context are required.'), { effectMayHaveOccurred: false });
  if (!update) return;
  const payload = params.payload, scope = nativeSettingsScope(payload?.expectedScope);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !scope || scope.nativeConversationId !== params.sessionId
    || scope.nativeCollection !== (method.startsWith('code.') ? 'claude-code-sessions' : 'local-agent-mode-sessions')
    || scope.ownerGeneration !== params.expectedOwnerGeneration || scope.queryToken !== params.expectedExecutionToken
    || !identity(payload.model) || !identity(payload.expectedModel)
    || !Object.hasOwn(payload, 'reasoningEffort') || !Object.hasOwn(payload, 'expectedReasoningEffort')
    || payload.reasoningEffort !== null && !['low', 'medium', 'high', 'xhigh', 'max'].includes(payload.reasoningEffort)
    || payload.expectedReasoningEffort !== null && !identity(payload.expectedReasoningEffort, 128)
    || Object.keys(payload).some(key => !['model', 'reasoningEffort', 'expectedModel', 'expectedReasoningEffort', 'expectedScope'].includes(key))
    || !/^[A-Za-z0-9_-]{8,128}$/.test(options.commandId ?? '')) throw Object.assign(new BridgeError('invalid-settings', 'A stable command ID and exact displayed Query settings are required.'), { effectMayHaveOccurred: false });
}
/** Task operations have a fixed route and argument allowlist independent of arbitrary owner methods.
 * @param {string} method @param {Value} params @param {Value} options */
function taskRequest(method, params, options) {
  if (!TASK_METHODS.has(method)) throw new BridgeError('unsupported-action', 'This original Claude task operation is unavailable.');
  const feed = method.endsWith('.taskFeed'), stop = method.endsWith('.stopTask');
  const keys = feed ? ['sessionId', 'cursor', 'limit', 'expectedOwnerGeneration', 'expectedExecutionToken'] : ['sessionId', 'taskId', 'expectedOwnerGeneration', 'expectedExecutionToken'];
  const identity = (/** @type {unknown} */ value, max = 512) => typeof value === 'string' && !!value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
  if (!identity(params.sessionId) || Object.keys(params).some(key => !keys.includes(key)) ||
    !feed && (!identity(params.taskId, 256) || !identity(params.expectedOwnerGeneration) || !identity(params.expectedExecutionToken)) ||
    feed && (params.cursor !== undefined && (!Number.isSafeInteger(params.cursor) || params.cursor < 0) || params.limit !== undefined && (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 128))) {
    throw new BridgeError('invalid-task-request', 'A bounded original task identity and owner/query context are required.');
  }
  if (stop !== (options.mutation === true)) throw new BridgeError('invalid-task-request', 'The original task mutation classification is required.');
}

/** @param {number} pid @returns {Promise<Value>} */
export async function claudeDesktopProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) throw fail('invalid-claude-owner');
  const { stdout } = await exec('/bin/ps', ['-ww', '-p', String(pid), '-o', 'pid=,ppid=,lstart=,comm=']);
  const match = stdout.trim().match(/^(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.+)$/);
  if (!match) throw fail();
  return { pid: Number(match[1]), parentPid: Number(match[2]), startTime: match[3], executable: match[4] };
}
/** @param {Value} runtime */
export function claudeDesktopOwnerGeneration(runtime) {
  return 'claude-desktop:' + createHash('sha256').update(JSON.stringify([runtime.executable, runtime.pid, runtime.parentPid, runtime.startTime, runtime.bootEpoch])).digest('hex');
}
/** The transport is profile-scoped; public sources additionally bind the native collection.
 * @param {Value} runtime @param {string|null} [collection] */
export function claudeDesktopHostId(runtime, collection = null) {
  const identity = [runtime.storagePath, runtime.profileNamespace ?? 'default'];
  if (collection !== null) identity.push(collection);
  return 'local:claude-desktop:' + createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
/** Private, explicitly installed owner bridge. No app discovery, runner or credential repair.
 * @param {string} path @param {(pid:number)=>Promise<Value>} [identity] @returns {Promise<Value>} */
export async function readClaudeDesktopRuntime(path, identity = claudeDesktopProcessIdentity) {
  if (!isAbsolute(path)) throw fail('invalid-claude-runtime');
  const file = await stat(path); if (!file.isFile() || (file.mode & 0o077) !== 0) throw fail('invalid-claude-runtime');
  let value; try { value = JSON.parse(await readFile(path, 'utf8')); } catch { throw fail('invalid-claude-runtime'); }
  if (value?.version !== 1 || value.protocol !== 'claude-desktop-native' || !Number.isSafeInteger(value.pid) || value.pid < 2
    || !Number.isSafeInteger(value.parentPid) || typeof value.executable !== 'string' || !isAbsolute(value.executable)
    || typeof value.storagePath !== 'string' || !isAbsolute(value.storagePath) || typeof value.startTime !== 'string'
    || !/^[a-f0-9]{32,128}$/.test(value.bootEpoch ?? '') || !/^[a-f0-9]{64}$/.test(value.accessToken ?? '')) throw fail('invalid-claude-runtime');
  if (value.appVersion !== undefined && value.appVersion !== '4.16336.0') throw fail('unsupported-claude-version');
  if (value.readOnly !== undefined && typeof value.readOnly !== 'boolean' || value.mutationAllowed !== undefined && typeof value.mutationAllowed !== 'boolean') throw fail('invalid-claude-runtime');
  if (value.asarSha256 !== undefined && !/^[a-f0-9]{64}$/.test(value.asarSha256)) throw fail('invalid-claude-runtime');
  let origin; try { origin = new URL(value.origin); } catch { throw fail('invalid-claude-runtime'); }
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw fail('invalid-claude-runtime');
  const process = await identity(value.pid), executable = await realpath(value.executable), observed = await realpath(process.executable);
  if (observed !== executable || process.parentPid !== value.parentPid || process.startTime !== value.startTime) throw fail('source-epoch-changed');
  const storagePath = await realpath(value.storagePath);
  if (value.asarSha256) {
    const artifact = join(dirname(executable), '..', 'Resources', 'app.asar'), info = await stat(artifact);
    const stamp = JSON.stringify([info.ino, info.size, info.mtimeMs]); let saved = artifactCache.get(artifact);
    if (!saved || saved.stamp !== stamp) { saved = { stamp, sha256: createHash('sha256').update(await readFile(artifact)).digest('hex') }; artifactCache.set(artifact, saved); }
    if (saved.sha256 !== value.asarSha256) throw fail('source-artifact-changed');
  }
  return { ...value, origin: origin.origin, executable, storagePath, generation: claudeDesktopOwnerGeneration({ ...value, executable }) };
}

/** Native bridge only: the original desktop owns all processes and operations. */
export class ClaudeDesktopRpcClient {
  /** @param {{runtimePath?:string,readRuntime?:()=>Promise<Value>,fetch?:typeof fetch,timeoutMs?:number}} [options] */
  constructor(options = {}) {
    this.runtimePath = options.runtimePath ?? process.env.CODELIGHT_CLAUDE_DESKTOP_RUNTIME;
    this.readRuntime = options.readRuntime ?? (() => this.runtimePath ? readClaudeDesktopRuntime(this.runtimePath) : Promise.reject(fail()));
    this.fetch = options.fetch ?? fetch; this.timeoutMs = options.timeoutMs ?? 15000;
    /** @type {Value|null} */ this.latestRuntime = null;
    /** @type {Value|null} */ this.ownerPolicy = null;
  }
  async runtime() { const runtime = await this.readRuntime(); this.latestRuntime = runtime; return runtime; }
  generation() { return this.latestRuntime?.generation ?? null; }
  hostId() { return this.latestRuntime ? claudeDesktopHostId(this.latestRuntime) : null; }
  isReadOnly() { const runtime = this.latestRuntime; return runtime?.readOnly === true || runtime?.mutationAllowed === false
    || this.ownerPolicy?.generation === this.generation() && this.ownerPolicy?.hostId === this.hostId() && this.ownerPolicy?.readOnly === true; }
  /** @param {string} method @param {Value} [params] @param {{expectedGeneration?:string|null,expectedHostId?:string,collection?:string,mutation?:boolean,commandId?:string}} [options] @returns {Promise<Value>} */
  async call(method, params = {}, options = {}) {
    if (!/^(owner|code|cowork|chat)\.[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(method)) throw new BridgeError('unsupported-action', 'A verified Claude Desktop native operation is required.');
    if (/\.(?:task|stopTask|getTask)/.test(method)) taskRequest(method, params, options);
    if (/\.(?:controls|settings)$/.test(method)) settingsRequest(method, params, options);
    const runtime = await this.runtime();
    if (options.expectedGeneration !== undefined && options.expectedGeneration !== runtime.generation || options.expectedHostId !== undefined && options.expectedHostId !== claudeDesktopHostId(runtime, options.collection ?? null)) throw fail('source-epoch-changed');
    if (this.isReadOnly() && (options.mutation === true || !READ_ONLY_METHODS.has(method))) throw Object.assign(new BridgeError('native-read-only', 'The original Claude Desktop bridge is read-only.'), { effectMayHaveOccurred: false });
    if (options.mutation && !/^[A-Za-z0-9_-]{8,128}$/.test(options.commandId ?? '')) throw new BridgeError('invalid-command-id', 'A stable native operation ID is required.');
    let sent = false;
    try {
      sent = true;
      const response = await this.fetch(runtime.origin + '/rpc', { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + runtime.accessToken },
        body: JSON.stringify({ version: 1, method, params, ...(options.commandId ? { commandId: options.commandId } : {}) }), signal: AbortSignal.timeout(this.timeoutMs) });
      if (response.status === 401) throw fail('claude-bridge-authentication-failed');
      const reader = response.body?.getReader(); if (!reader) throw fail('claude-invalid-response');
      const chunks = []; let bytes = 0;
      while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length;
        if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw fail('claude-response-too-large'); } chunks.push(chunk.value); }
      let answer; try { answer = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('claude-invalid-response'); }
      const after = await this.runtime(); if (after.generation !== runtime.generation || claudeDesktopHostId(after) !== claudeDesktopHostId(runtime)) throw fail('source-epoch-changed');
      if (!answer || answer.version !== 1 || answer.ownerGeneration !== runtime.generation || answer.hostId !== claudeDesktopHostId(runtime)) throw fail('claude-invalid-response');
      if (options.mutation && answer.commandId !== options.commandId) throw fail('claude-invalid-response');
      if (answer.ok !== true) {
        const code = /^[a-z][a-z0-9-]{0,80}$/.test(answer.error?.code ?? '') ? answer.error.code : 'claude-native-operation-failed';
        const error = new BridgeError(code, 'The original Claude Desktop owner did not accept this operation.');
        if (answer.effectMayHaveOccurred === false) Object.assign(error, { effectMayHaveOccurred: false });
        throw error;
      }
      if (!response.ok) throw fail('claude-bridge-request-failed');
      if (!answer.result || typeof answer.result !== 'object' || Array.isArray(answer.result)) throw fail('claude-invalid-response');
      if (method === 'owner.status' && (typeof answer.result.readOnly === 'boolean' || typeof answer.result.mutationAllowed === 'boolean')) {
        this.ownerPolicy = { generation: runtime.generation, hostId: claudeDesktopHostId(runtime), readOnly: answer.result.readOnly === true || answer.result.mutationAllowed === false };
      }
      return answer.result;
    } catch (error) {
      if (options.mutation && sent && !(error instanceof BridgeError && /** @type {Value} */ (error).effectMayHaveOccurred === false)) {
        const unknown = new BridgeError('delivery-unknown', 'The original Claude Desktop operation may have occurred; it cannot be replayed.');
        if (error instanceof BridgeError) Object.assign(unknown, { nativeCause: error.code }); throw unknown;
      }
      throw error instanceof BridgeError ? error : fail('claude-bridge-request-failed');
    }
  }
  async dispose() { this.latestRuntime = null; this.ownerPolicy = null; }
}
