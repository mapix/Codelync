import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { BridgeError } from '../errors.mjs';

const MAX_STDOUT_LINE_BYTES = 262_144;
const LONG_TIMEOUT_OPERATIONS = new Set(['start', 'quality', 'display', 'space', 'windows', 'window', 'heartbeat']);
const HOST_CONFLICT_CODES = new Set([
  'desktop-virtual-display-unavailable',
  'desktop-virtual-display-required',
  'desktop-accessibility-required',
  'desktop-window-unavailable',
  'desktop-window-unresponsive',
  'desktop-restore-persist-failed',
  'desktop-view-changed',
  'desktop-display-changed',
  'desktop-screen-permission-required',
  'desktop-input-permission-required',
  'desktop-locked',
  'desktop-disconnected',
  'desktop-not-active',
  'desktop-not-ready',
  'desktop-input-replayed',
  'desktop-sequence-out-of-order',
  'desktop-space-shortcut-disabled',
  'desktop-space-shortcut-unavailable',
]);

/** @param {string} code */
function hostErrorStatus(code) {
  if (code.startsWith('invalid-desktop-')) return 400;
  if (code === 'desktop-input-busy' || code === 'desktop-request-busy') return 429;
  if (HOST_CONFLICT_CODES.has(code)) return 409;
  return 503;
}

/** Owns only the bundled desktop helper; stdout contains framed local RPC, never logs. */
export class DesktopHostProcess extends EventEmitter {
  /** @param {{binary:string,state?:string}} options */
  constructor(options) {
    super(); this.options = options; this.closed = false;
    this.closing = /** @type {Promise<void>|null} */ (null);
    this.pending = /** @type {Map<string,{resolve:(value:any)=>void,reject:(error:Error)=>void,timer:ReturnType<typeof setTimeout>}>} */ (new Map());
    this.child = /** @type {import('node:child_process').ChildProcessWithoutNullStreams|null} */ (null);
  }
  start() {
    if (this.child) return;
    if (this.closed) throw new BridgeError('desktop-host-unavailable', 'The remote desktop helper is unavailable.', 503);
    const args = typeof this.options.state === 'string' && this.options.state.trim().length > 0
      ? ['--state-dir=' + this.options.state]
      : [];
    const child = spawn(this.options.binary, args, { stdio: ['pipe', 'pipe', 'pipe'] }); this.child = child;
    child.stdin.on('error', () => {});
    // Vendor/WebRTC stderr may contain connection details; discard it, never store it.
    child.stderr.resume();
    const reader = createInterface({ input: child.stdout });
    reader.on('line', line => {
      if (Buffer.byteLength(line) > MAX_STDOUT_LINE_BYTES) return;
      let value; try { value = JSON.parse(line); } catch { return; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      if (value.type === 'desktop-stopped') { this.emit('stopped'); return; }
      if (value.type === 'desktop-view-invalidated') { this.emit('view-invalidated', value.connectionId); return; }
      if (typeof value.id !== 'string') return;
      const pending = this.pending.get(value.id); if (!pending) return;
      this.pending.delete(value.id); clearTimeout(pending.timer);
      if (value.ok === true) pending.resolve(value.result);
      else {
        const code = typeof value.error === 'string' && /^[a-z][a-z0-9-]{0,80}$/u.test(value.error) ? value.error : 'desktop-host-failed';
        pending.reject(new BridgeError(code, 'The desktop operation could not be completed.', hostErrorStatus(code)));
      }
    });
    const failed = () => {
      this.child = null; reader.close();
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new BridgeError('desktop-host-unavailable', 'The desktop helper disconnected.', 503)); }
      this.pending.clear(); this.emit('stopped');
    };
    child.once('error', failed); child.once('exit', failed);
  }
  /** @param {string} operation @param {Record<string,any>} [value] */
  request(operation, value = {}) {
    if (this.closed) return Promise.reject(new BridgeError('desktop-host-unavailable', 'The remote desktop helper is unavailable.', 503));
    this.start();
    return new Promise((resolve, reject) => {
      if (this.closed || !this.child) { reject(new BridgeError('desktop-host-unavailable', 'The remote desktop helper is unavailable.', 503)); return; }
      if (this.pending.size >= 8) { reject(new BridgeError('desktop-input-busy', 'Wait for the current desktop action.', 429)); return; }
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id); this.child?.kill('SIGTERM');
        reject(new BridgeError('desktop-operation-unknown', 'The desktop action result is unconfirmed.', 503));
      }, LONG_TIMEOUT_OPERATIONS.has(operation) ? 20_000 : 5_000);
      this.pending.set(id, { resolve, reject, timer });
      const failWrite = (/** @type {unknown} */ error) => {
        clearTimeout(timer); this.pending.delete(id);
        reject(error instanceof BridgeError ? error : new BridgeError('desktop-host-unavailable', 'The desktop helper disconnected.', 503));
      };
      try {
        this.child.stdin.write(JSON.stringify({ ...value, id, operation }) + '\n', error => {
          if (error) failWrite(error);
        });
      } catch (error) { failWrite(error); }
    });
  }
  interrupt() { this.child?.kill('SIGTERM'); }
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new BridgeError('desktop-host-unavailable', 'The desktop helper disconnected.', 503)); }
    this.pending.clear();
    this.closing = (async () => {
      const child = this.child;
      if (!child || child.exitCode !== null || child.signalCode !== null) { this.child = null; return; }
      await new Promise(resolve => {
        /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer;
        const finish = () => { clearTimeout(timer); child.removeListener('exit', finish); child.removeListener('error', finish); resolve(undefined); };
        timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 5_000);
        timer.unref();
        child.once('exit', finish);
        child.once('error', finish);
        try { child.stdin.end(); } catch { /* stdin may already be closed */ }
        if (child.exitCode !== null || child.signalCode !== null) finish();
      });
      this.child = null;
    })();
    return this.closing;
  }
}
