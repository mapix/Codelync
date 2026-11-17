import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { BridgeError } from '../errors.mjs';

/** Owns only the bundled desktop helper; stdout contains framed local RPC, never logs. */
export class DesktopHostProcess extends EventEmitter {
  /** @param {{binary:string}} options */
  constructor(options) {
    super(); this.options = options; this.closed = false;
    this.pending = /** @type {Map<string,{resolve:(value:any)=>void,reject:(error:Error)=>void,timer:ReturnType<typeof setTimeout>}>} */ (new Map());
    this.child = /** @type {import('node:child_process').ChildProcessWithoutNullStreams|null} */ (null);
  }
  start() {
    if (this.child) return;
    if (this.closed) throw new BridgeError('desktop-host-unavailable', 'The remote desktop helper is unavailable.', 503);
    const child = spawn(this.options.binary, [], { stdio: ['pipe', 'pipe', 'pipe'] }); this.child = child;
    // Vendor/WebRTC stderr may contain connection details; discard it, never store it.
    child.stderr.resume();
    const reader = createInterface({ input: child.stdout });
    reader.on('line', line => {
      if (Buffer.byteLength(line) > 32_768) return;
      let value; try { value = JSON.parse(line); } catch { return; }
      if (value.type === 'desktop-stopped') { this.emit('stopped'); return; }
      if (value.type === 'desktop-view-invalidated') { this.emit('view-invalidated', value.connectionId); return; }
      const pending = this.pending.get(value.id); if (!pending) return;
      this.pending.delete(value.id); clearTimeout(pending.timer);
      if (value.ok === true) pending.resolve(value.result);
      else pending.reject(new BridgeError(/^[a-z][a-z0-9-]{0,80}$/u.test(value.error) ? value.error : 'desktop-host-failed', 'The desktop operation could not be completed.', 503));
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
    this.start();
    return new Promise((resolve, reject) => {
      if (this.pending.size >= 8) { reject(new BridgeError('desktop-input-busy', 'Wait for the current desktop action.', 429)); return; }
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id); this.child?.kill('SIGTERM');
        reject(new BridgeError('desktop-operation-unknown', 'The desktop action result is unconfirmed.', 503));
      }, ['start', 'quality', 'display', 'space', 'heartbeat'].includes(operation) ? 20_000 : 5_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child?.stdin.write(JSON.stringify({ ...value, id, operation }) + '\n', error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } });
    });
  }
  interrupt() { this.child?.kill('SIGTERM'); }
  async close() {
    if (this.closed) return; this.closed = true;
    const child = this.child;
    if (!child) return;
    const done = new Promise(resolve => child.once('exit', resolve));
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    await done; clearTimeout(timer);
  }
}
