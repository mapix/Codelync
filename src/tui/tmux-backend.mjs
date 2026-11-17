import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, lstat, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { BridgeError } from '../errors.mjs';
import { TmuxControlClient } from './tmux-control.mjs';
import { TerminalReceiptJournal, terminalCommandDigest } from './receipts.mjs';

/** @typedef {Record<string, any>} Value */
const execute = promisify(execFile);
const PANE_FORMAT = '#{pane_id}\t#{session_id}\t#{window_id}\t#{pane_pid}\t#{pid}\t#{pane_width}\t#{pane_height}\t#{pane_dead}\t#{cursor_x}\t#{cursor_y}\t#{window_panes}\t#{alternate_on}\t#{pane_current_command}';
const SYMBOLIC_KEYS = Object.freeze({ enter: 'Enter', tab: 'Tab', escape: 'Escape', backspace: 'BSpace', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  home: 'Home', end: 'End', pageUp: 'PPage', pageDown: 'NPage', interrupt: 'C-c', eof: 'C-d', clear: 'C-l' });
const MAX_INPUT_BYTES = 16 * 1024, MAX_OUTPUT_BATCH = 128 * 1024, MAX_PANES = 512;

/** @param {string} id */
function paneId(id) { if (!/^%\d+$/u.test(id)) throw new BridgeError('tui-invalid-pane', 'A native tmux pane ID is required.'); return id; }

/** @param {string} line @param {Value} socket */
function parsePane(line, socket) {
  const fields = line.split('\t');
  if (fields.length < 13 || !/^%\d+$/u.test(fields[0]) || !/^\$\d+$/u.test(fields[1]) || !/^@\d+$/u.test(fields[2])
    || fields.slice(3, 12).some(value => !/^\d+$/u.test(value))) throw new BridgeError('tui-invalid-inventory', 'The native terminal inventory is invalid.');
  const [, sessionId, windowId] = fields, [pid, serverPid, columns, rows, dead, cursorX, cursorY, windowPanes, alternate] = fields.slice(3, 12).map(Number);
  if (pid <= 0 || serverPid <= 0 || columns < 1 || columns > 1000 || rows < 1 || rows > 500 || windowPanes < 1) throw new BridgeError('tui-invalid-inventory', 'The native terminal dimensions or owner are invalid.');
  const ownerGeneration = `tmux:${serverPid}:${socket.fingerprint}:${fields[0]}:${pid}`;
  return { paneId: fields[0], sessionId, windowId, pid, serverPid, columns, rows, dead: dead !== 0, cursorX, cursorY, windowPanes, alternate: alternate !== 0,
    command: fields.slice(12).join('\t').replace(/[\x00-\x1f\x7f]/gu, '').slice(0, 128), ownerGeneration, socket };
}

/** @param {string} code @param {boolean} [effectMayHaveOccurred] */
function failure(code, effectMayHaveOccurred = false) {
  const error = /** @type {Value} */ (new BridgeError(code, effectMayHaveOccurred ? 'The terminal operation remains unconfirmed.' : 'The original terminal owner is unavailable or changed.', 409));
  error.effectMayHaveOccurred = effectMayHaveOccurred; return error;
}

/** Existing native tmux panes only. No server, pane or model runner is created. */
export class TuiTmuxBackend {
  /** @param {{binaryPath:string,socketPath:string,stateDirectory:string,timeoutMs?:number,execute?:typeof execute,clientFactory?:(options:Value)=>TmuxControlClient}} options */
  constructor(options) {
    this.options = options; this.execute = options.execute ?? execute; this.journal = new TerminalReceiptJournal(options.stateDirectory);
    /** @type {Map<string,Value>} */ this.observers = new Map();
    /** @type {Map<string,Value>} */ this.inFlight = new Map();
    /** @type {Map<string,Value>} */ this.bindings = new Map();
    this.disposed = false;
  }

  async socketIdentity() {
    if (!['darwin', 'linux'].includes(process.platform) || !isAbsolute(this.options.binaryPath) || !isAbsolute(this.options.socketPath)) throw failure('tui-unconfigured');
    await access(this.options.binaryPath);
    const socketPath = await realpath(this.options.socketPath), socket = await lstat(socketPath), parent = await stat(dirname(socketPath));
    const uid = process.getuid?.();
    if (!socket.isSocket() || uid === undefined || socket.uid !== uid || parent.uid !== uid || (parent.mode & 0o077) !== 0) throw failure('tui-unsafe-socket');
    const fingerprint = createHash('sha256').update(`${socketPath}\0${socket.dev}:${socket.ino}:${socket.birthtimeMs}`).digest('hex').slice(0, 24);
    return { socketPath, fingerprint };
  }

  /** @param {string[]} args @param {Value} socket */
  async readCommand(args, socket) {
    try {
      const { stdout } = await this.execute(this.options.binaryPath, ['-N', '-S', socket.socketPath, ...args],
        { timeout: this.options.timeoutMs ?? 5000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
      return String(stdout);
    } catch { throw failure('tui-native-unavailable'); }
  }

  async nativePanes() {
    const socket = await this.socketIdentity();
    const output = await this.readCommand(['list-panes', '-a', '-F', PANE_FORMAT], socket);
    const lines = output.replace(/\n$/u, '').split('\n').filter(Boolean);
    if (lines.length > MAX_PANES) throw failure('tui-inventory-too-large');
    const unique = new Map();
    for (const line of lines) { const binding = parsePane(line, socket); if (!unique.has(binding.paneId)) unique.set(binding.paneId, binding); }
    return [...unique.values()];
  }

  /** @param {string} id @param {string|undefined} expectedOwner */
  async nativePane(id, expectedOwner) {
    paneId(id); const socket = await this.socketIdentity();
    const binding = parsePane((await this.readCommand(['display-message', '-p', '-t', id, PANE_FORMAT], socket)).replace(/\n$/u, ''), socket);
    if (binding.paneId !== id || expectedOwner && binding.ownerGeneration !== expectedOwner) throw failure('tui-owner-changed');
    this.bindings.set(id, binding); return binding;
  }

  async status() {
    try { const panes = await this.nativePanes(); return { connected: true, running: true, protocol: 'tmux-control', panes: panes.length, reason: null }; }
    catch (error) { return { connected: false, running: false, protocol: 'tmux-control', reason: /** @type {Value} */ (error).code ?? 'tui-unavailable' }; }
  }

  async list() {
    const panes = await this.nativePanes();
    return panes.map(binding => {
      this.bindings.set(binding.paneId, binding);
      return { id: binding.paneId, app: 'terminal', kind: 'terminal', protocol: 'tmux-control', adapterKey: 'tui', hostId: 'local',
        title: `${binding.command || 'Terminal'} · ${binding.paneId}`, available: !binding.dead, runtimeGeneration: binding.ownerGeneration,
        nativePane: { paneId: binding.paneId, serverPid: binding.serverPid, pid: binding.pid, sessionId: binding.sessionId, windowId: binding.windowId },
        columns: binding.columns, rows: binding.rows, state: binding.dead ? 'exited' : 'terminal-running',
        capabilities: { messages: false, terminalScreen: true, terminalInput: !binding.dead, terminalResize: !binding.dead && binding.windowPanes === 1, modelAcceptance: false, subagents: false } };
    });
  }

  /** @param {Value} binding */
  observer(binding) {
    const existing = this.observers.get(binding.paneId);
    if (existing && existing.binding.ownerGeneration === binding.ownerGeneration && !existing.closed) return existing;
    if (existing) this.closeObserver(existing);
    if (this.observers.size >= 32) {
      for (const observer of this.observers.values()) if (!observer.listeners.size && !observer.operations) this.closeObserver(observer);
      if (this.observers.size >= 32) throw failure('tui-observer-budget');
    }
    const value = { binding, streamId: randomUUID(), sequence: 0, listeners: new Set(), closed: false, published: false, captured: false,
      bytes: 0, chunks: [], timer: null, reconnectTimer: null, reconnectAttempt: 0, idleTimer: null, operations: 0, starting: null, client: null, screen: null };
    this.observers.set(binding.paneId, value); return value;
  }

  /** @param {Value} observer */
  client(observer) {
    if (observer.client && !observer.client.closed) return observer.client;
    if (observer.client) {
      clearTimeout(observer.reconnectTimer); observer.reconnectTimer = null;
      clearTimeout(observer.timer); observer.timer = null;
      observer.streamId = randomUUID(); observer.sequence = 0; observer.captured = false; observer.published = false; observer.chunks = []; observer.bytes = 0;
    }
    const options = { binaryPath: this.options.binaryPath, socketPath: observer.binding.socket.socketPath, sessionId: observer.binding.sessionId, timeoutMs: this.options.timeoutMs };
    const client = (this.options.clientFactory ?? (value => new TmuxControlClient(/** @type {any} */ (value))))(options);
    observer.client = client;
    client.on('notification', value => { if (value.kind === 'output' && value.paneId === observer.binding.paneId) this.output(observer, value.bytes); });
    client.on('closed', () => {
      if (observer.closed || this.disposed || observer.client !== client) return;
      observer.published = false; this.emit(observer, { type: 'connection', connected: false, reason: 'tui-stream-disconnected', ownerGeneration: observer.binding.ownerGeneration });
      this.scheduleReconnect(observer);
    });
    return client;
  }

  /** @param {string} id @param {{expectedOwnerGeneration?:string,since?:Value}} [options] */
  async snapshot(id, options = {}) {
    const binding = await this.nativePane(id, options.expectedOwnerGeneration);
    const observer = this.observer(binding), view = await this.refreshScreen(observer);
    if (options.since?.ownerGeneration === view.ownerGeneration && options.since?.screenHash === view.screenHash && options.since?.streamId === view.streamId) {
      return { type: 'terminal-screen', unchanged: true, ownerGeneration: view.ownerGeneration, streamId: view.streamId, sequence: view.sequence, screenHash: view.screenHash };
    }
    return structuredClone(view);
  }

  /** @param {Value} observer */
  async refreshScreen(observer) {
    if (observer.starting) return observer.starting;
    observer.operations += 1; clearTimeout(observer.idleTimer); observer.idleTimer = null;
    observer.starting = (async () => {
      const binding = await this.nativePane(observer.binding.paneId, observer.binding.ownerGeneration);
      const client = this.client(observer); observer.captured = false; observer.published = false; observer.chunks = []; observer.bytes = 0;
      /** @type {Value} */ const captured = { metadata: null, screen: null, blockIndex: 0 };
      const response = await client.run(`display-message -p -t ${binding.paneId} "${PANE_FORMAT}" ; capture-pane -p -e -t ${binding.paneId}`, {
        onBlock: (/** @type {Value} */ block) => {
          if (!block.ok) return;
          if (captured.blockIndex++ === 0) captured.metadata = parsePane(block.lines.join('\n'), binding.socket);
          else if (captured.screen === null) { captured.screen = block.lines.join('\n'); observer.chunks = []; observer.bytes = 0; observer.captured = true; }
        }
      });
      const metadata = captured.metadata, capture = captured.screen;
      if (response.blocks.some((/** @type {Value} */ block) => !block.ok) || !metadata || typeof capture !== 'string' || metadata.ownerGeneration !== binding.ownerGeneration) throw failure('tui-screen-unavailable');
      await this.nativePane(binding.paneId, binding.ownerGeneration);
      observer.sequence += 1;
      const screenHash = createHash('sha256').update(capture).update(JSON.stringify([metadata.columns, metadata.rows, metadata.cursorX, metadata.cursorY, metadata.alternate])).digest('hex');
      const view = { type: 'terminal-screen', connected: true, app: 'terminal', protocol: 'tmux-control', paneId: binding.paneId,
        ownerGeneration: binding.ownerGeneration, streamId: observer.streamId, sequence: observer.sequence, columns: metadata.columns, rows: metadata.rows,
        cursor: { x: metadata.cursorX, y: metadata.cursorY }, alternate: metadata.alternate, screen: capture, screenHash, complete: true, historyComplete: false };
      observer.screen = view; this.emit(observer, view); observer.published = true; observer.reconnectAttempt = 0;
      if (observer.bytes) this.scheduleFlush(observer);
      return view;
    })().finally(() => { observer.starting = null; observer.operations -= 1; this.retireUnviewed(observer); });
    return observer.starting;
  }

  /** @param {string} id @param {(event:Value)=>void|Promise<void>} callback @param {{expectedOwnerGeneration?:string}} [context] */
  async subscribe(id, callback, context = {}) {
    const binding = await this.nativePane(id, context.expectedOwnerGeneration), observer = this.observer(binding);
    if (observer.listeners.size >= 32) throw failure('tui-subscriber-budget');
    clearTimeout(observer.idleTimer); observer.idleTimer = null;
    const listener = { callback, busy: false, needsResync: false }; observer.listeners.add(listener);
    try { await this.refreshScreen(observer); } catch (error) { observer.listeners.delete(listener); if (!observer.listeners.size) this.closeObserver(observer); throw error; }
    return () => { observer.listeners.delete(listener); if (!observer.listeners.size) this.closeObserver(observer); };
  }

  /** @param {Value} observer @param {Value} event */
  emit(observer, event) {
    for (const listener of observer.listeners) {
      if (listener.busy) { listener.needsResync = true; continue; }
      this.deliver(observer, listener, event);
    }
  }

  /** @param {Value} observer @param {Value} listener @param {Value} event */
  deliver(observer, listener, event) {
      try {
        const result = listener.callback(structuredClone(event));
        if (result?.then) {
          listener.busy = true;
          Promise.resolve(result).catch(() => { listener.needsResync = true; }).finally(() => {
            listener.busy = false;
            if (listener.needsResync && observer.listeners.has(listener)) { listener.needsResync = false;
              this.deliver(observer, listener, { type: 'resync-required', reason: 'slow-subscriber', ownerGeneration: observer.binding.ownerGeneration });
            }
          });
        }
      } catch { listener.needsResync = true; }
  }

  /** @param {Value} observer @param {Buffer} bytes */
  output(observer, bytes) {
    if (observer.closed || !observer.captured) return;
    observer.bytes += bytes.length;
    if (observer.bytes > MAX_OUTPUT_BATCH) {
      observer.chunks = []; observer.bytes = 0; observer.captured = false;
      this.emit(observer, { type: 'resync-required', reason: 'output-budget', ownerGeneration: observer.binding.ownerGeneration }); return;
    }
    observer.chunks.push(bytes); if (observer.published) this.scheduleFlush(observer);
  }

  /** @param {Value} observer */
  scheduleFlush(observer) {
    if (observer.timer || observer.closed) return;
    observer.timer = setTimeout(() => { observer.timer = null; void this.flush(observer); }, 20);
  }

  /** @param {Value} observer */
  async flush(observer) {
    if (observer.closed || !observer.published || !observer.bytes) return;
    const bytes = Buffer.concat(observer.chunks, observer.bytes); observer.chunks = []; observer.bytes = 0;
    try { await this.nativePane(observer.binding.paneId, observer.binding.ownerGeneration); }
    catch { observer.captured = false; observer.published = false; this.emit(observer, { type: 'connection', connected: false, reason: 'tui-owner-changed', ownerGeneration: observer.binding.ownerGeneration }); return; }
    if (observer.closed) return;
    observer.sequence += 1;
    this.emit(observer, { type: 'terminal-output', paneId: observer.binding.paneId, ownerGeneration: observer.binding.ownerGeneration,
      streamId: observer.streamId, sequence: observer.sequence, encoding: 'base64', data: bytes.toString('base64'), byteCount: bytes.length });
    if (observer.bytes) this.scheduleFlush(observer);
  }

  /** @param {Value} observer */
  scheduleReconnect(observer) {
    if (observer.closed || observer.reconnectTimer || !observer.listeners.size || observer.reconnectAttempt >= 8) return;
    const delay = Math.min(10000, 250 * 2 ** observer.reconnectAttempt++);
    observer.reconnectTimer = setTimeout(() => {
      observer.reconnectTimer = null;
      void (async () => {
        try { await this.nativePane(observer.binding.paneId, observer.binding.ownerGeneration); observer.streamId = randomUUID(); observer.sequence = 0; await this.refreshScreen(observer); }
        catch (error) { if (/** @type {Value} */ (error).code !== 'tui-owner-changed') this.scheduleReconnect(observer); }
      })();
    }, delay);
  }

  /** @param {string} id @param {string} expectedOwnerGeneration */
  async reconnect(id, expectedOwnerGeneration) {
    const binding = await this.nativePane(id, expectedOwnerGeneration), observer = this.observer(binding);
    const client = observer.client; observer.client = null; client?.close(); observer.streamId = randomUUID(); observer.sequence = 0;
    return structuredClone(await this.refreshScreen(observer));
  }

  /** @param {string} id @param {string} action @param {Value} payload @param {string} commandId @param {string} expectedOwnerGeneration */
  async command(id, action, payload, commandId, expectedOwnerGeneration) {
    if (!expectedOwnerGeneration || this.disposed) throw failure('tui-owner-required');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw failure('tui-invalid-payload');
    const capturedPayload = structuredClone(payload);
    const digest = terminalCommandDigest(action, capturedPayload, id, expectedOwnerGeneration), existing = await this.journal.get(commandId);
    if (existing) {
      if (existing.digest !== digest || existing.paneId !== id || existing.ownerGeneration !== expectedOwnerGeneration) throw failure('tui-command-id-conflict');
      return existing.receipt ?? { commandId, status: 'unknown', kind: 'terminal-server-receipt', effectMayHaveOccurred: true };
    }
    const current = this.inFlight.get(commandId);
    if (current) { if (current.digest !== digest || current.paneId !== id || current.ownerGeneration !== expectedOwnerGeneration) throw failure('tui-command-id-conflict'); return current.promise; }
    const operation = this.dispatch(id, action, capturedPayload, commandId, expectedOwnerGeneration, digest).finally(() => this.inFlight.delete(commandId));
    this.inFlight.set(commandId, { promise: operation, digest, paneId: id, ownerGeneration: expectedOwnerGeneration }); return operation;
  }

  /** @param {string} id @param {string} action @param {Value} payload @param {string} commandId @param {string} expectedOwner @param {string} digest */
  async dispatch(id, action, payload, commandId, expectedOwner, digest) {
    const binding = await this.nativePane(id, expectedOwner); if (binding.dead) throw failure('tui-pane-exited');
    let body;
    if (action === 'input') {
      if (typeof payload.text !== 'string' || !payload.text || Buffer.byteLength(payload.text) > MAX_INPUT_BYTES || Buffer.from(payload.text, 'utf8').toString('utf8') !== payload.text
        || Object.keys(payload).some(key => key !== 'text')) throw failure('tui-invalid-input');
      body = `send-keys -H -t ${id} ${[...Buffer.from(payload.text, 'utf8')].map(byte => byte.toString(16).padStart(2, '0')).join(' ')}`;
    } else if (action === 'key') {
      const key = typeof payload.key === 'string' && Object.hasOwn(SYMBOLIC_KEYS, payload.key) ? SYMBOLIC_KEYS[/** @type {keyof typeof SYMBOLIC_KEYS} */ (payload.key)] : null;
      if (!key || Object.keys(payload).some(field => field !== 'key')) throw failure('tui-invalid-key');
      body = `send-keys -t ${id} ${key}`;
    } else if (action === 'resize') {
      if (!Number.isInteger(payload.columns) || payload.columns < 20 || payload.columns > 300 || !Number.isInteger(payload.rows) || payload.rows < 5 || payload.rows > 100
        || Object.keys(payload).some(key => !['columns', 'rows'].includes(key))) throw failure('tui-invalid-size');
      if (binding.windowPanes !== 1) throw failure('tui-split-resize-unsupported');
      body = `resize-window -t ${binding.windowId} -x ${payload.columns} -y ${payload.rows}`;
    } else throw failure('tui-unsupported-action');
    const record = { commandId, paneId: id, ownerGeneration: expectedOwner, action, digest }, saved = await this.journal.begin(record);
    if (!saved.created) return saved.record.receipt ?? { commandId, status: 'unknown', kind: 'terminal-server-receipt', effectMayHaveOccurred: true };
    const observer = this.observer(binding), stale = `CODELYNC_TMUX_STALE_${randomBytes(16).toString('hex')}`;
    observer.operations += 1; clearTimeout(observer.idleTimer); observer.idleTimer = null;
    const ownerCondition = `#{&&:#{==:#{pid},${binding.serverPid}},#{&&:#{==:#{pane_pid},${binding.pid}},#{==:#{pane_dead},0}}}`;
    const condition = action === 'resize' ? `#{&&:${ownerCondition},#{&&:#{==:#{window_id},${binding.windowId}},#{==:#{window_panes},1}}}` : ownerCondition;
    const guard = `if-shell -F -t ${id} "${condition}" "${body}" "display-message -p ${stale}"`;
    try {
      const response = await this.client(observer).run(guard);
      const rejected = response.blocks.some((/** @type {Value} */ block) => block.lines.includes(stale));
      if (response.blocks.some((/** @type {Value} */ block) => !block.ok)) throw failure('tui-command-unknown', true);
      const receipt = { commandId, status: rejected ? 'rejected' : 'completed', kind: 'terminal-server-receipt', ownerGeneration: expectedOwner,
        paneId: id, nativeCommandNumber: response.commandNumber, acceptedBy: rejected ? null : 'tmux-server', applicationAccepted: null,
        effectMayHaveOccurred: !rejected, ...(rejected ? { reason: 'tui-target-changed' } : {}) };
      if (action === 'resize' && !rejected) { const after = await this.nativePane(id, expectedOwner); Object.assign(receipt, { columns: after.columns, rows: after.rows, applied: after.columns === payload.columns && after.rows === payload.rows }); }
      return await this.journal.finish(record, receipt);
    } catch (error) {
      if (/** @type {Value} */ (error).effectMayHaveOccurred === false) {
        return this.journal.finish(record, { commandId, status: 'rejected', kind: 'terminal-server-receipt', ownerGeneration: expectedOwner,
          paneId: id, acceptedBy: null, applicationAccepted: null, effectMayHaveOccurred: false, reason: /** @type {Value} */ (error).code ?? 'tui-not-dispatched' });
      }
      return { commandId, status: 'unknown', kind: 'terminal-server-receipt', ownerGeneration: expectedOwner, paneId: id, effectMayHaveOccurred: true };
    } finally { observer.operations -= 1; this.retireUnviewed(observer); }
  }

  /** @param {string} commandId */
  async getReceipt(commandId) { const value = await this.journal.get(commandId); return value?.receipt ?? (value ? { commandId, status: 'unknown', kind: 'terminal-server-receipt', effectMayHaveOccurred: true } : null); }

  /** A read-only snapshot does not keep all previously viewed panes attached.
   * @param {Value} observer */
  retireUnviewed(observer) {
    if (observer.closed || observer.listeners.size || observer.operations || observer.idleTimer) return;
    observer.idleTimer = setTimeout(() => { observer.idleTimer = null; if (!observer.listeners.size && !observer.operations) this.closeObserver(observer); }, 500);
  }

  /** @param {Value} observer */
  closeObserver(observer) {
    observer.closed = true; clearTimeout(observer.timer); clearTimeout(observer.reconnectTimer); clearTimeout(observer.idleTimer); observer.listeners.clear(); observer.chunks = []; observer.bytes = 0;
    observer.client?.close(); if (this.observers.get(observer.binding.paneId) === observer) this.observers.delete(observer.binding.paneId);
  }

  async dispose() { this.disposed = true; for (const observer of this.observers.values()) this.closeObserver(observer); this.bindings.clear(); }
}
