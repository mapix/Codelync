import { createHash } from 'node:crypto';
import { nativeTaskDigestText, nativeTaskSignal, nativeTaskTransfer, NATIVE_TASK_SNAPSHOT_MAX_BYTES } from '@codelync/wire/native-tasks';
import { BridgeError } from '../errors.mjs';

/** @typedef {Record<string,any>} Value */
const SCOPE_KEYS = ['app', 'nativeCollection', 'hostId', 'parentConversationId', 'ownerGeneration', 'runtimeGeneration', 'queryToken', 'cliSessionId'];
const DIGEST = /^[a-f0-9]{64}$/;
/** @param {Value} scope */
const scopeKey = scope => JSON.stringify(SCOPE_KEYS.map(key => scope[key]));

/** Materialized selected-source baselines only; no conversations or operations. */
export class NativeTaskTransfers {
  /** @type {Map<string,{value:Value,bytes:number}>} */ snapshots = new Map();
  bytes = 0;
  /** @type {string|null} */ scope = null;
  /** @param {{maxSnapshots?:number,maxBytes?:number}} [options] */
  constructor(options = {}) {
    this.maxSnapshots = options.maxSnapshots ?? 8; this.maxBytes = options.maxBytes ?? NATIVE_TASK_SNAPSHOT_MAX_BYTES;
    if (!Number.isSafeInteger(this.maxSnapshots) || this.maxSnapshots < 1 || this.maxSnapshots > 8
      || !Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > NATIVE_TASK_SNAPSHOT_MAX_BYTES) throw new BridgeError('invalid-native-task-cache', 'Native task cache limits must stay within their fixed bounds.');
  }
  /** @param {Value} value */
  validate(value) {
    let text;
    try { text = nativeTaskDigestText(value); nativeTaskSignal(value); } catch { throw new BridgeError('invalid-native-task-snapshot', 'The native task snapshot structure is invalid.'); }
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > this.maxBytes) throw new BridgeError('native-task-response-too-large', 'The native task snapshot exceeds its byte bound.', 503);
    const digest = createHash('sha256').update(text).digest('hex');
    if (value.digest !== digest) throw new BridgeError('invalid-native-task-snapshot', 'The native task snapshot digest is invalid.');
    return bytes;
  }
  /** @param {Value} value @param {number} bytes @param {string} scope */
  #rememberValidated(value, bytes, scope) {
    if (scope !== this.scope) { this.snapshots.clear(); this.bytes = 0; this.scope = scope; }
    const old = this.snapshots.get(value.digest); if (old) this.bytes -= old.bytes;
    this.snapshots.delete(value.digest); this.snapshots.set(value.digest, { value: structuredClone(value), bytes }); this.bytes += bytes;
    while (this.snapshots.size > this.maxSnapshots || this.bytes > this.maxBytes) {
      const key = this.snapshots.keys().next().value; if (key === undefined) break;
      this.bytes -= this.snapshots.get(key)?.bytes ?? 0; this.snapshots.delete(key);
    }
  }
  /** @param {Value} value */
  remember(value) {
    const bytes = this.validate(value);
    this.#rememberValidated(value, bytes, scopeKey(value.scope));
  }
  /** Capture the baseline before retaining the target. A hint alone cannot
   * manufacture an unchanged response after cache loss.
   * @param {Value} value @param {string|undefined} since */
  response(value, since) {
    const bytes = this.validate(value), scope = scopeKey(value.scope);
    const sinceDigest = typeof since === 'string' && DIGEST.test(since) ? since : null;
    const previous = scope === this.scope && sinceDigest ? this.snapshots.get(sinceDigest)?.value ?? null : null;
    this.#rememberValidated(value, bytes, scope);
    return nativeTaskTransfer(previous, value);
  }
  clear() { this.snapshots.clear(); this.bytes = 0; this.scope = null; }
}
