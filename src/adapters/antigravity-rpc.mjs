import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { BridgeError } from '../errors.mjs';
import { discoverAntigravityRuntime } from './antigravity-discovery.mjs';

/** @typedef {Record<string,any>} Value */
const exec = promisify(execFile);
export const ANTIGRAVITY_SERVICE = '/exa.language_server_pb.LanguageServerService/';
const MAX_RESPONSE = 16 * 1024 * 1024;

/** @param {string} code */
function unavailable(code = 'antigravity-unavailable') { return new BridgeError(code, 'The original Antigravity desktop owner is unavailable.', 503); }

/** Read a locally owned process identity without exposing its argument/token text.
 * @param {number} pid @returns {Promise<Value>} */
export async function antigravityProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw unavailable();
  const result = await exec('/bin/ps', ['-p', String(pid), '-o', 'pid=,ppid=,lstart=,comm='], { maxBuffer: 4096, env: { ...process.env, LC_ALL: 'C' } }).catch(() => { throw unavailable(); });
  const parsed = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+?)\s*$/.exec(result.stdout);
  if (!parsed || Number(parsed[1]) !== pid) throw unavailable();
  const executable = parsed[4], startTime = parsed[3].replace(/\s+/g, ' '), parentPid = Number(parsed[2]);
  if (!isAbsolute(executable) || !startTime || !Number.isSafeInteger(parentPid)) throw unavailable();
  return { pid, executable, startTime, parentPid };
}

/** The owner generation is bound to the operating-system process lifetime.
 * @param {Value} identity */
export function antigravityOwnerGeneration(identity) {
  return 'antigravity:' + createHash('sha256').update(JSON.stringify([identity.pid, identity.startTime, identity.executable])).digest('hex');
}

/** No target code is started here. A configured local endpoint must still match
 * the original desktop-owned process before it is used.
 * @param {string} path @param {(pid:number)=>Promise<Value>} [processIdentity] @returns {Promise<Value>} */
export async function readAntigravityRuntime(path, processIdentity = antigravityProcessIdentity) {
  if (!isAbsolute(path)) throw unavailable('invalid-antigravity-runtime');
  let file, value;
  try {
    file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink() || file.size > 64 * 1024 || file.mode & 0o077 || process.getuid && file.uid !== process.getuid()) throw unavailable('invalid-antigravity-runtime');
    value = /** @type {Value} */ (JSON.parse(await readFile(path, 'utf8')));
  } catch (error) { if (error instanceof BridgeError) throw error; throw unavailable(); }
  const binary = value.binary ?? value.executable;
  if (value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof binary !== 'string' || !isAbsolute(binary) ||
      typeof value.csrfToken !== 'string' || !value.csrfToken || value.csrfToken.length > 4096 || typeof value.origin !== 'string') throw unavailable('invalid-antigravity-runtime');
  let origin;
  try { origin = new URL(value.origin); } catch { throw unavailable('invalid-antigravity-runtime'); }
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || !origin.port ||
      origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw unavailable('invalid-antigravity-runtime');
  const identity = await processIdentity(value.pid), expected = await realpath(binary).catch(() => { throw unavailable(); });
  const observed = await realpath(identity.executable).catch(() => { throw unavailable(); });
  if (expected !== observed || value.startTime && value.startTime !== identity.startTime || value.parentPid && value.parentPid !== identity.parentPid) throw unavailable('source-epoch-changed');
  const generation = antigravityOwnerGeneration({ ...identity, executable: expected });
  return { ...value, binary: expected, origin: origin.origin, generation, startTime: identity.startTime };
}

/** Stable native storage namespace, independent of process restarts. This keeps
 * a copied app's equal conversation IDs separate from the original app.
 * @param {Value} runtime */
export function antigravityHostId(runtime) {
  const binary = runtime.binary ?? runtime.executable;
  if (typeof binary !== 'string' || !isAbsolute(binary) || typeof runtime.home !== 'string' || !isAbsolute(runtime.home) ||
      typeof runtime.appDataDir !== 'string' || !runtime.appDataDir || runtime.appDataDir.length > 512) throw unavailable('invalid-antigravity-runtime');
  return 'local:antigravity:' + createHash('sha256').update(JSON.stringify([binary, runtime.home, runtime.appDataDir])).digest('hex');
}

/** Connect-compatible JSON unary RPC on the owner's loopback listener. The
 * Codelync sealed transport is the only phone-facing transport.
 */
export class AntigravityRpcClient {
  /** @param {{runtimePath?:string,readRuntime?:()=>Promise<Value>,fetch?:typeof fetch,timeoutMs?:number}} [options] */
  constructor(options = {}) {
    const path = options.runtimePath ?? process.env.CODELYNC_ANTIGRAVITY_RUNTIME;
    this.readRuntime = options.readRuntime ?? (path ? () => readAntigravityRuntime(path) : () => this.discoverRuntime());
    this.fetch = options.fetch ?? fetch; this.timeoutMs = options.timeoutMs ?? 15000;
    /** @type {Value|null} */ this.latestRuntime = null;
    /** @type {Promise<Value>|null} */ this.discoveryFlight = null;
    /** @type {Promise<Value>|null} */ this.runtimeFlight = null;
    /** @type {Set<()=>Promise<void>>} */ this.summaryClosers = new Set();
    /** @type {Set<AbortController>} */ this.summaryControllers = new Set();
    this.disposed = false;
  }
  /** Coalesce concurrent fallback runtime discovery probes into one active flight.
   * @returns {Promise<Value>} */
  discoverRuntime() {
    if (this.disposed) return Promise.reject(unavailable());
    if (!this.discoveryFlight) {
      const flight = (async () => {
        const cached = this.latestRuntime;
        if (cached) {
          const identity = await antigravityProcessIdentity(cached.pid).catch(() => null);
          if (identity && identity.executable === cached.binary && identity.startTime === cached.startTime && identity.parentPid === cached.parentPid) return cached;
        }
        const runtime = await discoverAntigravityRuntime(); if (!runtime) throw unavailable(); return runtime;
      })().finally(() => { if (this.discoveryFlight === flight) this.discoveryFlight = null; });
      this.discoveryFlight = flight;
    }
    return this.discoveryFlight;
  }
  async runtime() {
    if (this.disposed) throw unavailable();
    if (!this.runtimeFlight) {
      const flight = Promise.resolve().then(() => this.readRuntime()).then(runtime => {
        if (this.disposed) throw unavailable();
        this.latestRuntime = runtime;
        return runtime;
      }).finally(() => { if (this.runtimeFlight === flight) this.runtimeFlight = null; });
      this.runtimeFlight = flight;
    }
    return this.runtimeFlight;
  }
  generation() { return this.latestRuntime?.generation ?? null; }
  /** Only the shipped local read stream; callers cannot select a cloud backend.
   * @param {{expectedGeneration:string,expectedHostId:string,signal?:AbortSignal}} options
   * @returns {Promise<{response:Response,scope:{hostId:string,generation:string},close:()=>Promise<void>}>} */
  async subscribeSummaries(options) {
    if (this.disposed) throw unavailable('antigravity-summary-stream-unavailable');
    const controller = new AbortController(), abort = () => controller.abort();
    this.summaryControllers.add(controller); options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const timer = setTimeout(abort, this.timeoutMs);
    timer.unref?.();
    /** @type {Response|undefined} */ let response;
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      controller.abort(); clearTimeout(timer);
      this.summaryControllers.delete(controller);
      this.summaryClosers.delete(close);
      options.signal?.removeEventListener('abort', abort);
      await response?.body?.cancel().catch(() => {});
    };
    this.summaryClosers.add(close);
    try {
      const runtime = await this.runtime(), hostId = antigravityHostId(runtime);
      if (hostId !== options.expectedHostId || runtime.generation !== options.expectedGeneration) throw new BridgeError('source-epoch-changed', 'The native summary owner changed before observation.', 409);
      if (this.disposed || controller.signal.aborted) throw unavailable('antigravity-summary-stream-unavailable');
      const body = Buffer.from('{}'), framed = Buffer.alloc(7); framed.writeUInt32BE(2, 1); body.copy(framed, 5);
      response = await this.fetch(runtime.origin + ANTIGRAVITY_SERVICE + 'JetboxSubscribeToSummaries', { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/connect+json', 'Connect-Protocol-Version': '1', 'X-Codeium-Csrf-Token': runtime.csrfToken,
          'X-Jetski-Via-Remote-Control': 'true', 'X-Jetski-Remote-Control-Transport': 'codelync' }, body: framed });
      if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/connect+json' || !response.body?.getReader) throw unavailable('antigravity-summary-stream-unavailable');
      const after = await this.runtime();
      if (after.generation !== runtime.generation || antigravityHostId(after) !== hostId) throw new BridgeError('source-epoch-changed', 'The native summary owner changed during observation.', 409);
      if (this.disposed || controller.signal.aborted) throw unavailable('antigravity-summary-stream-unavailable');
      clearTimeout(timer);
      return { response, scope: { hostId, generation: runtime.generation }, close };
    } catch (error) {
      await close();
      throw error instanceof BridgeError ? error : unavailable('antigravity-summary-stream-unavailable');
    }
  }
  /** @param {string} method @param {Value} [body] @param {{expectedGeneration?:string|null,expectedHostId?:string,mutation?:boolean}} [options] @returns {Promise<Value>} */
  async call(method, body = {}, options = {}) {
    if (!/^[A-Z][A-Za-z0-9]{0,99}$/.test(method)) throw new BridgeError('unsupported-action', 'A known native Antigravity method is required.');
    if (this.disposed) throw Object.assign(unavailable(), { effectMayHaveOccurred: false });
    let runtime;
    try {
      runtime = await this.runtime();
      if (options.expectedHostId !== undefined && options.expectedHostId !== antigravityHostId(runtime)) throw new BridgeError('source-epoch-changed', 'The Antigravity instance changed before dispatch.', 409);
      if (options.expectedGeneration !== undefined && options.expectedGeneration !== runtime.generation) throw new BridgeError('source-epoch-changed', 'The Antigravity owner changed before dispatch.', 409);
    } catch (error) { if (error instanceof BridgeError) Object.assign(error, { effectMayHaveOccurred: false }); throw error; }
    try {
      const response = await this.fetch(runtime.origin + ANTIGRAVITY_SERVICE + method, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'X-Codeium-Csrf-Token': runtime.csrfToken,
          'X-Jetski-Via-Remote-Control': 'true', 'X-Jetski-Remote-Control-Transport': 'codelync' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
      const length = Number(response.headers.get('content-length') ?? 0);
      if (length > MAX_RESPONSE) { await response.body?.cancel().catch(() => {}); throw unavailable('antigravity-response-too-large'); }
      if (!response.ok) {
        // Error bodies can contain private input, URLs or paths. Never propagate them.
        if (options.mutation) throw new BridgeError('delivery-unknown', 'The native response did not confirm the Antigravity operation.');
        throw unavailable(response.status === 404 ? 'antigravity-method-unavailable' : 'antigravity-rpc-unavailable');
      }
      const reader = response.body?.getReader();
      if (!reader) throw unavailable('antigravity-invalid-response');
      /** @type {Uint8Array[]} */ const chunks = []; let bytes = 0;
      while (true) {
        const next = await reader.read(); if (next.done) break;
        bytes += next.value.length; if (bytes > MAX_RESPONSE) { await reader.cancel(); throw unavailable('antigravity-response-too-large'); }
        chunks.push(next.value);
      }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw unavailable('antigravity-invalid-response');
      const after = await this.runtime();
      if (after.generation !== runtime.generation || options.expectedHostId !== undefined && antigravityHostId(after) !== options.expectedHostId) throw new BridgeError(options.mutation ? 'delivery-unknown' : 'source-epoch-changed', 'The Antigravity owner changed during the native request.', 409);
      return result;
    } catch (error) {
      this.latestRuntime = null;
      if (options.mutation && !(error instanceof BridgeError && error.code === 'delivery-unknown')) throw new BridgeError('delivery-unknown', 'The Antigravity operation may have occurred and will not be replayed.');
      if (error instanceof BridgeError) throw error;
      throw unavailable('antigravity-rpc-unavailable');
    }
  }
  async dispose() {
    this.disposed = true;
    for (const controller of this.summaryControllers) controller.abort();
    await Promise.allSettled([...this.summaryClosers].map(close => close()));
    this.summaryClosers.clear();
    this.summaryControllers.clear();
    this.latestRuntime = null;
  }
}
