import { createHash } from 'node:crypto';

/** @typedef {Record<string,any>} Value */
/** Admission belongs to one desktop boot. Repeated IDs share the same native work. */
export class ClaudeCommandReceipts {
  constructor() { /** @type {Map<string,{fingerprint:string,promise:Promise<Value>}>} */ this.receipts = new Map(); }
  /** @param {string} id @param {string} method @param {Value} params @param {()=>Promise<Value>} invoke */
  admit(id, method, params, invoke) {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(id ?? '')) throw Object.assign(Error('invalid-command-id'), { effectMayHaveOccurred: false });
    const fingerprint = createHash('sha256').update(JSON.stringify([method, params])).digest('hex');
    const prior = this.receipts.get(id);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw Object.assign(Error('command-id-conflict'), { effectMayHaveOccurred: false });
      return prior.promise;
    }
    // Store before scheduling invocation, including when the native operation throws.
    const promise = Promise.resolve().then(invoke);
    promise.catch(() => {});
    this.receipts.set(id, { fingerprint, promise });
    return promise;
  }
  /** A deadline does not cancel original-owner work or erase its receipt.
   * @param {Promise<Value>} promise @param {number} timeoutMs @returns {Promise<Value>} */
  async wait(promise, timeoutMs) {
    /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(Error('native-operation-timeout'), { effectMayHaveOccurred: true })), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }
}
