import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { BridgeError } from '../errors.mjs';

/** @typedef {Record<string, any>} Value */

export const TMUX_CONTROL_LIMITS = Object.freeze({ lineBytes: 1024 * 1024, blockBytes: 2 * 1024 * 1024, queuedCommands: 32, commandBytes: 128 * 1024 });

/** Decodes tmux's octal byte escaping, without losing a split UTF-8 sequence.
 * @param {string} value */
export function decodeTmuxOutput(value) {
  if (typeof value !== 'string') throw new BridgeError('tui-malformed-output', 'Invalid terminal output frame.');
  const parts = []; let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '\\') continue;
    if (index > start) parts.push(Buffer.from(value.slice(start, index), 'utf8'));
    const octal = value.slice(index + 1, index + 4);
    if (!/^[0-7]{3}$/u.test(octal)) throw new BridgeError('tui-malformed-output', 'Invalid terminal output escape.');
    const byte = Number.parseInt(octal, 8);
    if (byte > 255) throw new BridgeError('tui-malformed-output', 'Invalid terminal output byte.');
    parts.push(Buffer.from([byte])); index += 3; start = index + 1;
  }
  if (start < value.length) parts.push(Buffer.from(value.slice(start), 'utf8'));
  return Buffer.concat(parts);
}

/** Bounded incremental control framing. Notifications never occur within a block. */
export class TmuxControlParser extends EventEmitter {
  /** @param {{maxLineBytes?:number,maxBlockBytes?:number}} [options] */
  constructor(options = {}) {
    super(); this.maxLineBytes = options.maxLineBytes ?? TMUX_CONTROL_LIMITS.lineBytes;
    this.maxBlockBytes = options.maxBlockBytes ?? TMUX_CONTROL_LIMITS.blockBytes;
    /** @type {Buffer[]} */ this.parts = []; this.partBytes = 0;
    /** @type {Value|null} */ this.block = null;
  }

  /** @param {Buffer|Uint8Array|string} chunk */
  feed(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] !== 10) continue;
      this.addPart(bytes.subarray(start, index));
      const line = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.partBytes);
      this.parts = []; this.partBytes = 0; this.readLine(line.toString('utf8')); start = index + 1;
    }
    this.addPart(bytes.subarray(start));
  }

  /** @param {Buffer} bytes */
  addPart(bytes) {
    if (!bytes.length) return;
    this.partBytes += bytes.length;
    if (this.partBytes > this.maxLineBytes) throw new BridgeError('tui-frame-too-large', 'Terminal control frame exceeds its bound.');
    this.parts.push(bytes);
  }

  /** @param {string} line */
  readLine(line) {
    const header = /^%(begin|end|error) (\d+) (\d+) (\d+)$/u.exec(line);
    if (this.block) {
      if (header && header[1] !== 'begin' && header.slice(2).join(':') === this.block.key) {
        const block = this.block; this.block = null;
        this.emit('block', { time: block.time, number: block.number, flags: block.flags, ok: header[1] === 'end', lines: block.lines }); return;
      }
      this.block.bytes += Buffer.byteLength(line) + 1;
      if (this.block.bytes > this.maxBlockBytes) throw new BridgeError('tui-block-too-large', 'Terminal control response exceeds its bound.');
      this.block.lines.push(line); return;
    }
    if (header) {
      if (header[1] !== 'begin') throw new BridgeError('tui-protocol-desync', 'Unexpected terminal control response.');
      this.block = { key: header.slice(2).join(':'), time: Number(header[2]), number: Number(header[3]), flags: Number(header[4]), lines: [], bytes: 0 }; return;
    }
    const output = /^%output (%\d+) ?(.*)$/u.exec(line);
    if (output) { this.emit('notification', { kind: 'output', paneId: output[1], bytes: decodeTmuxOutput(output[2]) }); return; }
    const extended = /^%extended-output (%\d+) (\d+) (?:[^:]*: )?(.*)$/u.exec(line);
    if (extended) { this.emit('notification', { kind: 'output', paneId: extended[1], ageMs: Number(extended[2]), bytes: decodeTmuxOutput(extended[3]) }); return; }
    const paneState = /^%(pause|continue) (%\d+)$/u.exec(line);
    if (paneState) { this.emit('notification', { kind: paneState[1] === 'pause' ? 'paused' : 'continued', paneId: paneState[2] }); return; }
    if (line.startsWith('%exit')) { this.emit('notification', { kind: 'exit' }); return; }
    const event = /^%([a-z-]+)(?: |$)/u.exec(line);
    if (event) { this.emit('notification', { kind: 'native-event', name: event[1] }); return; }
    if (line !== '') throw new BridgeError('tui-protocol-desync', 'Unexpected terminal control notification.');
  }

  finish() {
    if (this.partBytes || this.block) throw new BridgeError('tui-incomplete-frame', 'Terminal control stream ended within a response.');
  }
}

/** @param {string} code @param {boolean} emitted */
function commandError(code, emitted) {
  const error = /** @type {Value} */ (new BridgeError(code, emitted ? 'Terminal command result remains unconfirmed.' : 'Terminal command was not dispatched.', 409));
  error.effectMayHaveOccurred = emitted; return error;
}

/** A control client attaches only to a configured existing tmux server/session. */
export class TmuxControlClient extends EventEmitter {
  /** @param {{binaryPath:string,socketPath:string,sessionId:string,timeoutMs?:number,spawn?:typeof spawn}} options */
  constructor(options) {
    super(); this.options = options; this.timeoutMs = options.timeoutMs ?? 5000;
    if (!/^\$\d+$/u.test(options.sessionId)) throw new BridgeError('tui-invalid-session', 'Invalid native tmux session identity.');
    this.parser = new TmuxControlParser(); this.connected = false; this.closed = false;
    /** @type {Value|null} */ this.pending = null;
    /** @type {Value[]} */ this.queue = [];
    /** @type {Value|null} */ this.child = null;
    /** @type {Promise<void>|null} */ this.connecting = null;
    this.parser.on('block', block => this.onBlock(block));
    this.parser.on('notification', value => { this.emit('notification', value); if (value.kind === 'exit') this.close(); });
  }

  connect() {
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;
    if (this.closed) return Promise.reject(commandError('tui-client-closed', false));
    this.connecting = new Promise((resolve, reject) => {
      const env = { ...process.env }; delete env.TMUX; delete env.TMUX_PANE;
      const child = (this.options.spawn ?? spawn)(this.options.binaryPath, ['-N', '-C', '-S', this.options.socketPath,
        'attach-session', '-E', '-f', 'ignore-size,pause-after=2', '-t', this.options.sessionId], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      const timer = setTimeout(() => { reject(commandError('tui-connect-timeout', false)); this.close(); }, this.timeoutMs);
      const ready = () => { clearTimeout(timer); this.connected = true; resolve(); this.pump(); };
      this.once('ready', ready);
      child.stdout.on('data', (/** @type {Buffer} */ bytes) => {
        try { this.parser.feed(bytes); } catch (error) { this.emit('protocol-error', error); reject(error); this.close(); }
      });
      // stderr is drained but not published: it can contain private socket paths.
      child.stderr.on('data', () => {});
      child.once('error', () => { clearTimeout(timer); reject(commandError('tui-client-unavailable', false)); this.close(); });
      child.once('close', () => { clearTimeout(timer); reject(commandError('tui-client-unavailable', false)); this.close(); });
    });
    return this.connecting;
  }

  /** @param {string} command @param {{onBlock?:(block:Value)=>void}} [options] */
  async run(command, options = {}) {
    if (typeof command !== 'string' || !command || /[\r\n\0]/u.test(command) || Buffer.byteLength(command) > TMUX_CONTROL_LIMITS.commandBytes) {
      throw commandError('tui-invalid-command', false);
    }
    await this.connect();
    if (this.closed || this.queue.length >= TMUX_CONTROL_LIMITS.queuedCommands) throw commandError('tui-command-unavailable', false);
    return new Promise((resolve, reject) => {
      this.queue.push({ command, marker: `CODELYNC_TMUX_DONE_${randomBytes(16).toString('hex')}`, blocks: [], bytes: 0, emitted: false, resolve, reject, onBlock: options.onBlock });
      this.pump();
    });
  }

  pump() {
    if (!this.connected || this.closed || this.pending || !this.queue.length) return;
    const item = this.queue.shift(); if (!item) return;
    this.pending = item; item.emitted = true;
    item.timer = setTimeout(() => { item.reject(commandError('tui-command-unknown', true)); this.pending = null; this.close(); }, this.timeoutMs);
    // if-shell -F inserts its branch before this marker. Completing the first
    // block alone would incorrectly acknowledge the guard before its input.
    this.child?.stdin.write(`${item.command} ; display-message -p ${item.marker}\n`, (/** @type {Error|null|undefined} */ error) => {
      if (error && this.pending === item) { clearTimeout(item.timer); item.reject(commandError('tui-command-unknown', true)); this.pending = null; this.close(); }
    });
  }

  /** @param {Value} block */
  onBlock(block) {
    if (!this.connected) { if (block.ok) this.emit('ready'); else this.close(); return; }
    const item = this.pending;
    if (!item) { this.emit('protocol-error', commandError('tui-unexpected-response', false)); this.close(); return; }
    if (block.ok && block.lines.length === 1 && block.lines[0] === item.marker) {
      clearTimeout(item.timer); this.pending = null;
      item.resolve({ blocks: item.blocks, commandNumber: block.number }); this.pump(); return;
    }
    item.bytes += block.lines.reduce((/** @type {number} */ size, /** @type {string} */ line) => size + Buffer.byteLength(line) + 1, 0);
    if (item.blocks.length >= 32 || item.bytes > TMUX_CONTROL_LIMITS.blockBytes) {
      clearTimeout(item.timer); item.reject(commandError('tui-command-unknown', true)); this.pending = null; this.close(); return;
    }
    item.onBlock?.(block);
    item.blocks.push(block);
  }

  close() {
    if (this.closed) return;
    this.closed = true; this.connected = false;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(commandError('tui-command-unknown', this.pending.emitted)); this.pending = null; }
    for (const item of this.queue.splice(0)) item.reject(commandError('tui-command-unavailable', false));
    this.child?.stdin.destroy(); this.child?.kill('SIGTERM'); this.emit('closed');
  }
}
