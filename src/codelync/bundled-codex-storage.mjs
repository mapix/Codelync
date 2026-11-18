import { Worker } from 'node:worker_threads';
import { SessionStorage } from '../storage.mjs';
import { BridgeError } from '../errors.mjs';
import { resolveCodelyncProjects } from './project-identity.mjs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

/** @param {unknown} offset @returns {number} */
function normalizeOffset(offset) {
  const value = Number(offset);
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.trunc(value), 0), 100000) + 0;
}

/** Mac package index adapter: asynchronous worker IO, no external Python runtime. */
export class BundledCodexStorage extends SessionStorage {
  /** @param {{codex?:string,zcode?:string,python?:string,loadIndex?:(offset:number)=>Promise<Record<string,any>[]>,signature?:()=>Promise<string>,now?:()=>number}} [options] */
  constructor(options = {}) {
    super(options);
    this.loader = options.loadIndex ?? (offset => this.readIndex(offset));
    this.signature = options.signature ?? (() => this.indexSignature());
    this.now = options.now ?? Date.now;
    /** @type {Map<number,{signature:string,until:number,rows:Record<string,any>[]}>} */ this.cache = new Map();
    /** @type {Map<string,Promise<Record<string,any>[]>>} */ this.flights = new Map();
    /** @type {Map<number,number>} */ this.versions = new Map();
  }
  async indexSignature() {
    const values = await Promise.all(['state_5.sqlite', 'state_5.sqlite-wal', '.codex-global-state.json'].map(async name => {
      try { const file = await stat(join(this.roots.codex, name), { bigint: true }); return `${name}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`; }
      catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT' && name !== 'state_5.sqlite') return `${name}:missing`; throw error; }
    }));
    return values.join('|');
  }
  /** @param {'codex'|'zcode'} app @param {number} [offset] @returns {Promise<Record<string,any>[]>} */
  async list(app, offset = 0) {
    if (app !== 'codex') throw new BridgeError('unsupported-source', 'The Mac package exposes Codex sessions.');
    const pageOffset = normalizeOffset(offset);
    const signature = await this.signature(), saved = this.cache.get(pageOffset);
    if (saved?.signature === signature && saved.until > this.now()) return structuredClone(saved.rows);
    const key = signature + ':' + pageOffset;
    let flight = this.flights.get(key);
    if (!flight) {
      const version = (this.versions.get(pageOffset) ?? 0) + 1; this.versions.set(pageOffset, version);
      const operation = this.loader(pageOffset).then(rows => {
        if (this.versions.get(pageOffset) === version) {
          this.cache.delete(pageOffset); this.cache.set(pageOffset, { signature, until: this.now() + 60000, rows });
          while (this.cache.size > 8) {
            const oldest = this.cache.keys().next().value;
            if (oldest === undefined) break;
            this.cache.delete(oldest); this.versions.delete(oldest);
          }
        }
        return rows;
      }).finally(() => { if (this.flights.get(key) === operation) this.flights.delete(key); });
      flight = operation; this.flights.set(key, flight);
    }
    return structuredClone(await flight);
  }
  /** @param {number} offset @returns {import('node:events').EventEmitter} */
  createIndexWorker(offset) {
    return new Worker(new URL('./codex-index-worker.mjs', import.meta.url), { execArgv: [], workerData: { root: this.roots.codex, offset, now: this.now() } });
  }
  /** @param {number} offset @returns {Promise<Record<string,any>[]>} */
  async readIndex(offset) {
    const pageOffset = normalizeOffset(offset);
    const rows = await new Promise((resolve, reject) => {
      const worker = this.createIndexWorker(pageOffset);
      let settled = false;
      /** @param {()=>void} apply */
      const finish = (apply) => {
        if (settled) return;
        settled = true;
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
        apply();
      };
      /** @param {Record<string,any>|null|undefined} value */
      const onMessage = (value) => finish(() => value?.ok === true && Array.isArray(value.rows)
        ? resolve(value.rows)
        : reject(new BridgeError('session-store-unavailable', 'The Codex index could not be read.')));
      const onError = () => finish(() => reject(new BridgeError('session-store-unavailable', 'The Codex index worker failed.')));
      const onExit = () => finish(() => reject(new BridgeError('session-store-unavailable', 'The Codex index worker exited before returning a result.')));
      worker.once('message', onMessage);
      worker.once('error', onError);
      worker.once('exit', onExit);
    });
    return resolveCodelyncProjects(rows, this.roots.codex);
  }
}
