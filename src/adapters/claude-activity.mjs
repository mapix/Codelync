import { BridgeError } from '../errors.mjs';

/** @typedef {Record<string,any>} Value */
/** Shared header data only; selected transcript readers are never invoked. */
const headers = /** @type {WeakMap<object,Value>} */ (new WeakMap());
const epochs = /** @type {WeakMap<object,Promise<unknown>>} */ (new WeakMap());

/** @param {Value} backend @param {string} hostId @param {number} now */
async function readHeaders(backend, hostId, now) {
  if (typeof backend.rpc?.runtime === 'function') {
    let checking = epochs.get(backend);
    if (!checking) { checking = Promise.resolve().then(() => backend.rpc.runtime()).finally(() => { if (epochs.get(backend) === checking) epochs.delete(backend); }); epochs.set(backend, checking); }
    await checking;
  }
  const generation = backend.generation();
  const prior = headers.get(backend);
  if (prior?.hostId === hostId && prior.generation === generation && prior.at + 1000 > now && prior.rows) return { rows: prior.rows, observedAt: prior.at };
  if (prior?.hostId === hostId && prior.generation === generation && prior.flight) return prior.flight;
  const entry = { hostId, generation, at: now, rows: /** @type {Value[]|null} */ (null), flight: /** @type {Promise<{rows:Value[],observedAt:number}>|null} */ (null) };
  const flight = Promise.resolve().then(() => backend.list({ expectedHostId: hostId })).then((/** @type {Value[]} */ rows) => {
    if (!Array.isArray(rows) || rows.length > 10000 || backend.hostId() !== hostId || backend.generation() !== generation) throw new BridgeError('source-epoch-changed', 'The original Claude header namespace changed.');
    for (const row of rows) if (Number.isSafeInteger(row.nativeActivityObservedAt) && row.nativeActivityObservedAt > 0) entry.at = Math.min(entry.at, row.nativeActivityObservedAt);
    entry.rows = rows; return { rows, observedAt: entry.at };
  }).finally(() => { entry.flight = null; });
  entry.flight = flight; headers.set(backend, entry); return flight;
}

/** Foreground header replica; it never claims a model runner or reads history. */
export class ClaudeActivityObserver {
  /** @param {{id:string,backend:Value,expectedHostId:string,now?:()=>number}} options */
  constructor(options) {
    this.options = options; this.now = options.now ?? Date.now; this.closed = false;
    this.at = 0; this.owner = /** @type {string|null} */ (null); this.nativeStatus = 'unknown'; this.refreshing = false;
  }
  status() {
    const known = !this.closed && this.owner !== null && this.at + 5000 > this.now()
      && this.options.backend.hostId() === this.options.expectedHostId && this.options.backend.generation(this.options.id) === this.owner
      && ['idle', 'running', 'waiting'].includes(this.nativeStatus);
    return { known, active: known && ['running', 'waiting'].includes(this.nativeStatus), waiting: known && this.nativeStatus === 'waiting',
      status: known ? 'ready' : this.refreshing ? 'refreshing' : 'unavailable', observedAt: this.at };
  }
  async refresh() {
    if (this.closed || this.refreshing) return;
    this.refreshing = true;
    try {
      const snapshot = await readHeaders(this.options.backend, this.options.expectedHostId, this.now());
      const row = snapshot.rows.find((/** @type {Value} */ item) => item.id === this.options.id && item.hostId === this.options.expectedHostId);
      if (this.closed) return;
      if (!row || typeof row.runtimeGeneration !== 'string' || this.options.backend.generation(this.options.id) !== row.runtimeGeneration
        || this.options.backend.hostId() !== this.options.expectedHostId) throw new BridgeError('source-epoch-changed', 'The original Claude header owner changed.');
      this.owner = row.runtimeGeneration; this.nativeStatus = row.nativeStatus; this.at = snapshot.observedAt;
    } catch { this.owner = null; this.nativeStatus = 'unknown'; }
    finally { this.refreshing = false; }
  }
  close() { this.closed = true; this.owner = null; }
}
