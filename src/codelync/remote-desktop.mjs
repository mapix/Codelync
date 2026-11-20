import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { AccessToken, TokenVerifier } from 'livekit-server-sdk';
import { BridgeError } from '../errors.mjs';
import { readOptionalPrivateJson, writeDurablePrivateJson } from './discovery-persistence.mjs';
import { DesktopHostProcess } from './desktop-host.mjs';
import { DesktopRelay } from './desktop-relay.mjs';

/** @typedef {Record<string,any>} Value */
const DEFAULTS = { version: 1, enabled: false, mode: 'local', url: '', apiKey: '', apiSecret: '' };
const DEFAULT_QUALITY = { width: 1920, fps: 30 };
const DEFAULT_VIRTUAL_VIEWPORT = { width: 540, height: 1080 };
const ENVELOPE_KEYS = ['version', 'at', 'action'];
const INPUT_KEYS = ['action', 'x', 'y', 'phase', 'button', 'deltaY', 'text', 'key', 'modifiers'];
const HOST_CONFLICT_CODES = new Set([
  'desktop-virtual-display-unavailable',
  'desktop-virtual-display-required',
  'desktop-accessibility-required',
  'desktop-window-unavailable',
  'desktop-window-unresponsive',
  'desktop-restore-persist-failed',
  'desktop-view-changed',
  'desktop-display-changed',
  'desktop-disconnected',
  'desktop-not-active',
  'desktop-not-ready',
  'desktop-locked',
  'desktop-screen-permission-required',
  'desktop-input-permission-required',
  'desktop-space-shortcut-disabled',
  'desktop-space-shortcut-unavailable',
  'desktop-input-replayed',
  'desktop-sequence-out-of-order',
]);
const PRE_MUTATION_WINDOW_CODES = new Set([
  'desktop-virtual-display-unavailable',
  'desktop-virtual-display-required',
  'desktop-accessibility-required',
  'desktop-window-unavailable',
  'desktop-window-unresponsive',
  'desktop-restore-persist-failed',
  'desktop-input-permission-required',
]);

/** @param {unknown} raw @returns {raw is Value} */
function isPlainObject(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const proto = Object.getPrototypeOf(raw);
  return proto === Object.prototype || proto === null;
}

/** @param {Value} body @param {string[]} allowed */
function hasOnlyBodyKeys(body, allowed) {
  return Object.keys(body).every(key => ENVELOPE_KEYS.includes(key) || allowed.includes(key));
}

/** @param {unknown} error @param {string} [fallbackCode] */
function normalizeHostError(error, fallbackCode = 'desktop-host-failed') {
  const code = typeof (/** @type {Value} */ (error))?.code === 'string' ? /** @type {Value} */ (error).code : '';
  const message = error instanceof Error && error.message ? error.message : 'The desktop operation could not be completed.';
  if (HOST_CONFLICT_CODES.has(code)) {
    return error instanceof BridgeError && error.status === 409 ? error : new BridgeError(code, message, 409);
  }
  if (code === 'desktop-input-busy' || code === 'desktop-request-busy') {
    return error instanceof BridgeError && error.status === 429 ? error : new BridgeError(code, message, 429);
  }
  if (/^invalid-desktop-[a-z0-9-]+$/u.test(code)) {
    return error instanceof BridgeError && error.status === 400 ? error : new BridgeError(code, message, 400);
  }
  if (error instanceof BridgeError) return error;
  if (/^[a-z][a-z0-9-]{0,80}$/u.test(code)) return new BridgeError(code, message, 503);
  return new BridgeError(fallbackCode, message, 503);
}

/** @param {unknown} raw @returns {string} */
export function desktopDisplayId(raw) {
  if (typeof raw !== 'string' || (raw !== 'virtual' && !/^\d{1,10}$/u.test(raw))) {
    throw new BridgeError('invalid-desktop-display', 'Select an available display.', 400);
  }
  return raw;
}

/** @param {unknown} raw @returns {{width:number,height:number}} */
export function desktopViewport(raw) {
  if (!isPlainObject(raw) || Object.keys(raw).sort().join(',') !== 'height,width'
    || !Number.isInteger(raw.width) || !Number.isInteger(raw.height)
    || raw.width < 100 || raw.width > 10_000
    || raw.height < 100 || raw.height > 10_000
    || raw.height < raw.width) {
    throw new BridgeError('invalid-desktop-viewport', 'Provide valid portrait viewport dimensions.', 400);
  }
  return { width: raw.width, height: raw.height };
}

/** @param {unknown} raw @returns {Value} */
export function desktopInput(raw) {
  if (!isPlainObject(raw) || typeof raw.action !== 'string'
    || Object.keys(raw).some(key => !INPUT_KEYS.includes(key))) {
    throw new BridgeError('invalid-desktop-input', 'The desktop input is invalid.', 400);
  }
  if (raw.action === 'scroll') {
    if (Object.keys(raw).some(key => !['action', 'deltaY', 'x', 'y'].includes(key))
      || !Number.isSafeInteger(raw.deltaY) || raw.deltaY < -1200 || raw.deltaY > 1200) {
      throw new BridgeError('invalid-desktop-input', 'The desktop input is invalid.', 400);
    }
    const hasX = 'x' in raw, hasY = 'y' in raw;
    if (hasX !== hasY) throw new BridgeError('invalid-desktop-input', 'Scroll coordinates require both x and y.', 400);
    if (!hasX) return { action: 'scroll', deltaY: raw.deltaY + 0 };
    if (typeof raw.x !== 'number' || typeof raw.y !== 'number' || !Number.isFinite(raw.x) || !Number.isFinite(raw.y)
      || raw.x < 0 || raw.x > 1 || raw.y < 0 || raw.y > 1) {
      throw new BridgeError('invalid-desktop-input', 'Scroll coordinates must be normalized in 0..1.', 400);
    }
    return { action: 'scroll', deltaY: raw.deltaY + 0, x: raw.x + 0, y: raw.y + 0 };
  }
  if (!['pointer', 'text', 'key'].includes(raw.action)) {
    throw new BridgeError('invalid-desktop-input', 'The desktop input is invalid.', 400);
  }
  return { ...raw };
}

/** @param {unknown} body @returns {{connectionId:string,generation?:string,geometry:string,sequence:number,mode:'fill'|'restore',windowId?:string}} */
export function desktopWindowRequest(body) {
  if (!isPlainObject(body) || (body.mode !== 'fill' && body.mode !== 'restore')) {
    throw new BridgeError('invalid-desktop-window', 'Choose a supported desktop window action.', 400);
  }
  const allowed = body.mode === 'fill'
    ? ['connectionId', 'generation', 'geometry', 'sequence', 'mode', 'windowId']
    : ['connectionId', 'generation', 'geometry', 'sequence', 'mode'];
  if (!hasOnlyBodyKeys(body, allowed)
    || typeof body.connectionId !== 'string' || !body.connectionId
    || (body.generation !== undefined && (typeof body.generation !== 'string' || !body.generation))
    || typeof body.geometry !== 'string' || !body.geometry
    || !Number.isSafeInteger(body.sequence)
    || (body.mode === 'fill' && (typeof body.windowId !== 'string' || !/^\d{1,10}:\d{1,10}$/u.test(body.windowId)))) {
    throw new BridgeError('invalid-desktop-window', 'The desktop window request is invalid.', 400);
  }
  return {
    connectionId: body.connectionId,
    ...(body.generation !== undefined ? { generation: body.generation } : {}),
    geometry: body.geometry,
    sequence: body.sequence + 0,
    mode: body.mode,
    ...(body.mode === 'fill' ? { windowId: body.windowId } : {}),
  };
}

/** @param {unknown} raw */
export function desktopQuality(raw) {
  const value = /** @type {Value} */ (raw);
  if (!isPlainObject(value) || Object.keys(value).sort().join(',') !== 'fps,width'
    || ![1280, 1920, 2560].includes(value.width) || ![15, 30, 60].includes(value.fps)) throw new BridgeError('invalid-desktop-quality', 'Choose a supported desktop quality.');
  return { width: value.width, fps: value.fps };
}
/** @param {unknown} raw */
export function desktopConfiguration(raw) {
  const value = /** @type {Value} */ (raw);
  if (!value || Array.isArray(value) || Object.keys(value).some(key => !Object.keys(DEFAULTS).includes(key))
    || typeof value.enabled !== 'boolean' || !['local', 'external'].includes(value.mode)) throw new BridgeError('invalid-desktop-configuration', 'The remote desktop settings are invalid.');
  if (value.mode === 'local') return { ...DEFAULTS, enabled: value.enabled };
  let url; try { url = new URL(value.url); } catch { throw new BridgeError('invalid-desktop-server', 'Enter a valid LiveKit server URL.'); }
  if (url.protocol !== 'https:' && url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash
    || typeof value.apiKey !== 'string' || !/^[A-Za-z0-9_-]{4,128}$/u.test(value.apiKey)
    || typeof value.apiSecret !== 'string' || value.apiSecret.length < 32 || value.apiSecret.length > 256) throw new BridgeError('invalid-desktop-server', 'Use a secure LiveKit URL and valid API credentials.');
  return { version: 1, enabled: value.enabled, mode: 'external', url: url.href.replace(/\/$/u, ''), apiKey: value.apiKey, apiSecret: value.apiSecret };
}

/** A machine-scoped desktop connection, independent of native sessions and source actors. */
export class RemoteDesktop extends EventEmitter {
  /** @param {{state:string,hostBinary:string,relayBinary:string,devices:Value,macSecretKey:Uint8Array,hostFactory?:()=>Value,relayFactory?:()=>Value,now?:()=>number}} options */
  constructor(options) {
    super(); this.options = options; this.config = { ...DEFAULTS }; this.now = options.now ?? Date.now;
    this.host = /** @type {Value|null} */ (null); this.relay = /** @type {Value|null} */ (null);
    this.media = /** @type {Value|null} */ (null); this.active = /** @type {Value|null} */ (null);
    this.closed = false; this.serial = Promise.resolve(); this.quality = { ...DEFAULT_QUALITY };
    this.requestNonces = /** @type {Map<string,number>} */ (new Map());
    this.devicesChanged = () => { if (this.active && !options.devices.publicKey(this.active.device)) { this.host?.interrupt?.(); void this.run(() => this.stop()); } };
    options.devices.on('changed', this.devicesChanged);
    this.watch = setInterval(() => {
      if (!this.active) return;
      const revoked = !options.devices.publicKey(this.active.device);
      const idleExpired = !this.active.inFlight && this.now() - this.active.lastSeen > 15_000;
      if (revoked || idleExpired) { this.host?.interrupt?.(); void this.run(() => this.stop()); }
    }, 1000); this.watch.unref();
  }
  /** @template T @param {()=>Promise<T>} work @returns {Promise<T>} */
  run(work) { const next = this.serial.then(work); this.serial = next.then(() => {}, () => {}); return next; }
  async load() {
    const saved = await readOptionalPrivateJson(join(this.options.state, 'remote-desktop.json'));
    if (saved) this.config = desktopConfiguration(saved);
    return this.status();
  }
  status() {
    return { version: 1, enabled: this.config.enabled, mode: this.config.mode, url: this.config.url, apiKey: this.config.apiKey,
      hasSecret: !!this.config.apiSecret, connected: !!this.active, quality: this.quality,
      permissions: this.active?.permissions ?? null, display: this.active?.display ?? null };
  }
  /** @param {Value} raw */
  configure(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return Promise.reject(new BridgeError('invalid-desktop-configuration', 'The remote desktop settings are invalid.'));
    }
    try {
      const candidate = desktopConfiguration({ ...this.config, ...raw });
      if (candidate.mode === 'external' && (candidate.url !== this.config.url || candidate.apiKey !== this.config.apiKey) && !raw.apiSecret) {
        throw new BridgeError('desktop-server-secret-required', 'Enter the API secret for this media server.');
      }
      if (!candidate.enabled || candidate.mode !== this.config.mode || candidate.url !== this.config.url
        || candidate.apiKey !== this.config.apiKey || candidate.apiSecret !== this.config.apiSecret) this.host?.interrupt?.();
    } catch (error) { return Promise.reject(error); }
    return this.run(async () => {
      const next = desktopConfiguration({ ...this.config, ...raw });
      if (next.mode === 'external' && (next.url !== this.config.url || next.apiKey !== this.config.apiKey) && !raw.apiSecret) {
        throw new BridgeError('desktop-server-secret-required', 'Enter the API secret for this media server.');
      }
      await writeDurablePrivateJson(join(this.options.state, 'remote-desktop.json'), next);
      await this.stop(); this.config = next; this.emit('status', this.status()); return this.status();
    });
  }
  ensureHost() {
    if (!this.host) {
      const host = this.options.hostFactory?.() ?? new DesktopHostProcess({ binary: this.options.hostBinary, state: this.options.state });
      host.on('stopped', () => { if (this.active) void this.run(() => this.stop()); }); this.host = host;
      host.on('view-invalidated', (/** @type {string} */ connectionId) => {
        if (this.active?.id === connectionId) { this.active.ready = false; this.active.viewPending = true; }
      });
    }
    return this.host;
  }
  /** @param {Value} active @param {string} operation @param {Value} [value] */
  async requestActiveHost(active, operation, value = {}) {
    active.lastSeen = this.now();
    active.inFlight = (active.inFlight ?? 0) + 1;
    try {
      return await this.ensureHost().request(operation, value);
    } finally {
      active.inFlight = Math.max(0, (active.inFlight ?? 1) - 1);
      if (this.active === active) active.lastSeen = this.now();
    }
  }
  /** @param {Value} active @param {Value} result */
  adoptView(active, result) {
    const geometry = typeof result?.geometry === 'string' && result.geometry
      ? result.geometry
      : isPlainObject(result?.display) && typeof result.display.geometry === 'string'
        ? result.display.geometry
        : '';
    if (!geometry || typeof result?.trackSid !== 'string' || !result.trackSid) {
      throw new BridgeError('desktop-capture-unavailable', 'The desktop view could not be confirmed.', 503);
    }
    const viewPending = result.viewPending === true;
    if (geometry !== active.geometry || result.trackSid !== active.trackSid || viewPending) active.ready = false;
    active.geometry = geometry;
    active.trackSid = result.trackSid;
    active.viewPending = viewPending;
    if (isPlainObject(result.display)) {
      active.display = typeof result.display.id === 'string' && result.display.id !== active.display?.id
        ? { ...result.display, geometry }
        : { ...active.display, ...result.display, geometry };
    } else if (isPlainObject(active.display)) {
      active.display = { ...active.display, geometry };
    }
    if (result.permissions !== undefined) active.permissions = result.permissions;
  }
  /** @param {Value} packet @param {string} device */
  openRequest(packet, device) {
    const key = this.options.devices.publicKey(device);
    if (!key || !isPlainObject(packet) || Object.keys(packet).sort().join(',') !== 'ciphertext,nonce,version' || packet.version !== 1
      || typeof packet.nonce !== 'string' || !/^[A-Za-z0-9_-]{32}$/u.test(packet.nonce)
      || typeof packet.ciphertext !== 'string' || packet.ciphertext.length > 12_000) throw new BridgeError('invalid-desktop-request', 'A sealed desktop request is required.', 400);
    const plain = nacl.box.open(Buffer.from(packet.ciphertext, 'base64url'), Buffer.from(packet.nonce, 'base64url'), Buffer.from(key, 'base64url'), this.options.macSecretKey);
    if (!plain) throw new BridgeError('invalid-desktop-request', 'The desktop request did not authenticate.', 401);
    let body; try { body = JSON.parse(Buffer.from(plain).toString()); } catch { throw new BridgeError('invalid-desktop-request', 'The desktop request is invalid.', 400); }
    if (!isPlainObject(body)) throw new BridgeError('invalid-desktop-request', 'The desktop request is invalid.', 400);
    if (body.version !== 1 || !Number.isSafeInteger(body.at) || Math.abs(this.now() - body.at) > 30_000) throw new BridgeError('desktop-request-expired', 'The desktop request expired.', 409);
    for (const [nonce, expires] of this.requestNonces) if (expires < this.now()) this.requestNonces.delete(nonce);
    const identity = device + ':' + packet.nonce;
    if (this.requestNonces.has(identity)) throw new BridgeError('desktop-request-replayed', 'The desktop request was already processed.', 409);
    if (this.requestNonces.size >= 4096) throw new BridgeError('desktop-request-busy', 'Wait before sending more desktop requests.', 429);
    this.requestNonces.set(identity, this.now() + 60_000);
    return body;
  }
  /** @param {string} action @param {string} method @param {Value} packet @param {string} device @param {string} origin */
  api(action, method, packet, device, origin) {
    return this.run(async () => {
      if (this.closed || !this.options.devices.publicKey(device)) throw new BridgeError('unknown-device', 'The approved device is unavailable.', 401);
      if (action === 'status') {
        if (method !== 'GET') throw new BridgeError('invalid-desktop-request', 'The desktop request method is invalid.', 400);
        return this.status();
      }
      if (!this.config.enabled) throw new BridgeError('desktop-disabled', 'Enable remote desktop on your Mac.', 409);
      if (method !== 'POST') throw new BridgeError('invalid-desktop-request', 'The desktop request method is invalid.', 400);
      const body = this.openRequest(packet, device);
      if (body.action !== action) throw new BridgeError('invalid-desktop-request', 'The desktop request action does not match.', 400);
      if (action === 'displays') {
        if (!hasOnlyBodyKeys(body, [])) throw new BridgeError('invalid-desktop-request', 'The desktop request is invalid.', 400);
        try {
          const result = this.active && this.active.device === device
            ? await this.requestActiveHost(this.active, 'displays')
            : await this.ensureHost().request('displays');
          return {
            displays: Array.isArray(result?.displays) ? result.displays : [],
            permissions: result?.permissions ?? null,
            virtualDisplaySupported: Boolean(result?.virtualDisplaySupported),
          };
        } catch (error) { throw normalizeHostError(error); }
      }
      if (action === 'join') return this.join(body, device, origin);
      const active = this.active;
      if (action === 'windows') {
        if (!hasOnlyBodyKeys(body, ['connectionId', 'generation'])
          || (body.connectionId !== undefined && (typeof body.connectionId !== 'string' || !body.connectionId))
          || (body.generation !== undefined && (typeof body.generation !== 'string' || !body.generation))) {
          throw new BridgeError('invalid-desktop-request', 'The desktop windows request is invalid.', 400);
        }
        if (!active || active.device !== device
          || (body.connectionId !== undefined && body.connectionId !== active.id)
          || (body.generation !== undefined && body.generation !== active.generation)) {
          throw new BridgeError('desktop-not-active', 'No active remote desktop connection.', 409);
        }
        try {
          const result = await this.requestActiveHost(active, 'windows', { connectionId: active.id });
          return {
            windows: Array.isArray(result?.windows) ? result.windows : [],
            activeWindowId: result?.activeWindowId ?? null,
          };
        } catch (error) { throw normalizeHostError(error); }
      }
      if (action === 'window') {
        const req = desktopWindowRequest(body);
        if (!active || active.device !== device || req.connectionId !== active.id
          || (req.generation !== undefined && req.generation !== active.generation)) {
          throw new BridgeError('desktop-disconnected', 'This desktop connection is no longer active.', 409);
        }
        if (active.display?.id !== 'virtual' && active.display?.kind !== 'virtual') {
          throw new BridgeError('desktop-virtual-display-required', 'Select Phone Screen before filling a window.', 409);
        }
        if (req.sequence <= active.sequence || req.sequence > active.sequence + 1024) {
          throw new BridgeError('desktop-sequence-out-of-order', 'The desktop window sequence is out of order.', 409);
        }
        if (active.viewPending) throw new BridgeError('desktop-view-changed', 'Wait for the current desktop picture.', 409);
        if (req.geometry !== active.geometry) throw new BridgeError('desktop-display-changed', 'The desktop display geometry changed.', 409);
        if (!active.ready) throw new BridgeError('desktop-not-ready', 'Wait for the live desktop picture.', 409);
        // Reserve before dispatch. Unknown window placement outcomes are never replayed.
        active.sequence = req.sequence;
        active.ready = false;
        try {
          const result = await this.requestActiveHost(active, 'window', {
            connectionId: active.id,
            geometry: active.geometry,
            sequence: req.sequence,
            mode: req.mode,
            ...(req.mode === 'fill' ? { windowId: req.windowId } : {}),
          });
          this.adoptView(active, result);
          return {
            ...(isPlainObject(result) ? result : {}),
            accepted: true,
            sequence: req.sequence,
            mode: req.mode,
            activeWindowId: result?.activeWindowId ?? null,
            upshifted: Boolean(result?.upshifted),
            display: active.display,
            geometry: active.geometry,
            trackSid: active.trackSid,
            viewPending: Boolean(active.viewPending),
            permissions: active.permissions,
            quality: active.quality,
          };
        } catch (error) {
          const normalized = normalizeHostError(error, 'desktop-operation-unknown');
          if (this.active === active && PRE_MUTATION_WINDOW_CODES.has(normalized.code) && !active.viewPending) active.ready = true;
          throw normalized;
        }
      }
      if (!active || active.device !== device || body.connectionId !== active.id || body.generation !== active.generation) throw new BridgeError('desktop-disconnected', 'This desktop connection is no longer active.', 409);
      if (action === 'leave') { await this.stop(); return { stopped: true }; }
      if (action === 'ready') {
        if (body.trackSid !== active.trackSid || body.geometry !== active.geometry || active.viewPending) throw new BridgeError('desktop-not-ready', 'Wait for the current display picture.', 409);
        const result = await this.requestActiveHost(active, 'heartbeat', { connectionId: active.id, geometry: active.geometry })
          .catch((/** @type {unknown} */ error) => { throw normalizeHostError(error); });
        this.adoptView(active, result);
        if (!result.viewerConnected || !result.capturing || !result.connected || active.viewPending || body.trackSid !== active.trackSid || body.geometry !== active.geometry) throw new BridgeError('desktop-not-ready', 'Wait for the live desktop picture.', 409);
        active.ready = true;
        return { ready: true, display: active.display, geometry: active.geometry, trackSid: active.trackSid };
      }
      if (action === 'heartbeat') {
        const result = await this.requestActiveHost(active, 'heartbeat', { connectionId: active.id, geometry: active.geometry })
          .catch((/** @type {unknown} */ error) => { throw normalizeHostError(error); });
        this.adoptView(active, result);
        return { ...result, display: active.display, geometry: active.geometry, trackSid: active.trackSid, viewPending: active.viewPending, permissions: active.permissions, generation: active.generation };
      }
      if (action === 'space') {
        if (!['previous', 'next', 'overview'].includes(body.kind) || !Number.isSafeInteger(body.sequence)
          || body.sequence <= active.sequence || body.sequence > active.sequence + 1024) throw new BridgeError('invalid-desktop-space', 'The desktop navigation request is invalid.', 400);
        if (body.geometry !== active.geometry || !active.ready || active.viewPending) throw new BridgeError('desktop-view-changed', 'Wait for the current desktop picture.', 409);
        active.sequence = body.sequence; active.ready = false;
        try {
          const result = await this.requestActiveHost(active, 'space', { connectionId: active.id, geometry: active.geometry, kind: body.kind, sequence: body.sequence });
          this.adoptView(active, result);
          return { ...result, display: active.display, geometry: active.geometry, trackSid: active.trackSid, viewPending: active.viewPending, permissions: active.permissions };
        } catch (error) {
          const normalized = normalizeHostError(error, 'desktop-operation-unknown');
          if (this.active === active && ['desktop-space-shortcut-disabled', 'desktop-space-shortcut-unavailable', 'desktop-input-permission-required'].includes(normalized.code)) {
            if (!active.viewPending) active.ready = true;
          }
          throw normalized;
        }
      }
      if (action === 'quality') {
        if (!hasOnlyBodyKeys(body, ['connectionId', 'generation', 'geometry', 'quality'])) throw new BridgeError('invalid-desktop-request', 'The desktop request is invalid.', 400);
        const quality = desktopQuality(body.quality);
        active.ready = false;
        let result;
        try { result = await this.requestActiveHost(active, 'quality', { connectionId: active.id, geometry: active.geometry, quality }); }
        catch (error) { await this.stop(); throw normalizeHostError(error); }
        if (typeof result?.trackSid !== 'string' || !result.trackSid) { await this.stop(); throw new BridgeError('desktop-capture-unavailable', 'The desktop view could not be confirmed.', 503); }
        try { this.adoptView(active, { ...result, geometry: result.geometry ?? active.geometry }); }
        catch (error) { await this.stop(); throw error; }
        this.quality = quality; active.quality = quality; this.emit('status', this.status());
        return { ...result, display: active.display, geometry: active.geometry, trackSid: active.trackSid, viewPending: active.viewPending, quality };
      }
      if (action === 'display') {
        if (!hasOnlyBodyKeys(body, ['connectionId', 'generation', 'geometry', 'displayId', 'viewport'])) throw new BridgeError('invalid-desktop-request', 'The desktop request is invalid.', 400);
        const displayId = desktopDisplayId(body.displayId);
        const viewport = body.viewport !== undefined ? desktopViewport(body.viewport) : displayId === 'virtual' ? { ...DEFAULT_VIRTUAL_VIEWPORT } : undefined;
        const wasVirtual = active.display?.id === 'virtual' || active.display?.kind === 'virtual';
        active.ready = false;
        let result;
        try {
          result = await this.requestActiveHost(active, 'display', {
            connectionId: active.id,
            geometry: active.geometry,
            displayId,
            ...(viewport ? { viewport } : {}),
          });
        } catch (error) { await this.stop(); throw normalizeHostError(error); }
        if (!isPlainObject(result?.display)
          || (result.display.id !== displayId
            && !(wasVirtual && displayId !== 'virtual' && typeof result.display.id === 'string' && /^\d{1,10}$/u.test(result.display.id) && result.display.kind !== 'virtual'))
          || typeof result.display.geometry !== 'string' || !result.display.geometry
          || typeof result.trackSid !== 'string' || !result.trackSid) {
          await this.stop();
          throw new BridgeError('desktop-display-unavailable', 'The display could not be confirmed.', 503);
        }
        this.adoptView(active, { ...result, geometry: result.display.geometry });
        this.emit('status', this.status());
        return { ...result, display: active.display, geometry: active.geometry, trackSid: active.trackSid, viewPending: active.viewPending, permissions: active.permissions, quality: active.quality };
      }
      if (action === 'input' && (body.geometry !== active.geometry || active.viewPending)) throw new BridgeError('desktop-view-changed', 'Wait for the current desktop picture.', 409);
      if (action !== 'input' || !Number.isSafeInteger(body.sequence)
        || body.sequence <= active.sequence || body.sequence > active.sequence + 1024) throw new BridgeError('desktop-input-replayed', 'The desktop input is stale or was already sent.', 409);
      if (!active.ready) throw new BridgeError('desktop-not-ready', 'Wait for the live desktop picture.', 409);
      if (!hasOnlyBodyKeys(body, ['connectionId', 'generation', 'geometry', 'sequence', 'input'])) throw new BridgeError('invalid-desktop-input', 'The desktop input is invalid.', 400);
      const input = desktopInput(body.input);
      // Reserve before dispatch. A missing receipt never permits redispatch.
      active.sequence = body.sequence;
      return this.requestActiveHost(active, 'input', { ...input, connectionId: active.id, geometry: active.geometry, sequence: body.sequence })
        .catch((/** @type {unknown} */ error) => { throw normalizeHostError(error, 'desktop-operation-unknown'); });
    });
  }
  /** @param {Value} body @param {string} device @param {string} origin */
  async join(body, device, origin) {
    if (this.active) throw new BridgeError('desktop-in-use', 'End the current desktop connection first.', 409);
    if (!hasOnlyBodyKeys(body, ['displayId', 'quality', 'viewport'])) throw new BridgeError('invalid-desktop-request', 'The desktop request is invalid.', 400);
    const displayId = desktopDisplayId(body.displayId);
    const viewport = body.viewport !== undefined ? desktopViewport(body.viewport) : displayId === 'virtual' ? { ...DEFAULT_VIRTUAL_VIEWPORT } : undefined;
    const quality = body.quality === undefined ? { ...DEFAULT_QUALITY } : desktopQuality(body.quality);
    const host = this.ensureHost();
    const inventory = await host.request('displays').catch((/** @type {unknown} */ error) => { throw normalizeHostError(error); });
    if (!isPlainObject(inventory) || !Array.isArray(inventory.displays) || !inventory.displays.every(isPlainObject)) {
      throw new BridgeError('desktop-host-failed', 'The desktop display inventory is invalid.', 503);
    }
    const listedDisplay = inventory.displays.find((/** @type {Value} */ row) => isPlainObject(row) && row.id === displayId);
    const virtualSupported = Boolean(inventory.virtualDisplaySupported);
    if (displayId === 'virtual' && !virtualSupported && (inventory.virtualDisplaySupported !== undefined || !listedDisplay)) {
      throw new BridgeError('desktop-virtual-display-unavailable', 'The virtual Phone Screen is unavailable on this Mac.', 409);
    }
    const baseDisplay = listedDisplay ?? (displayId === 'virtual' && virtualSupported
      ? { id: 'virtual', name: 'Phone Screen', kind: 'virtual', width: viewport ? viewport.width * 2 : 1080, height: viewport ? viewport.height * 2 : 2160, geometry: '' }
      : null);
    if (!baseDisplay) throw new BridgeError('desktop-display-unavailable', 'The selected display is unavailable.', 409);
    const permissions = isPlainObject(inventory.permissions) ? inventory.permissions : null;
    if (!permissions?.screenRecording) throw new BridgeError('desktop-screen-permission-required', 'Allow screen recording on your Mac.', 409);
    if (Boolean(permissions.locked)) throw new BridgeError('desktop-locked', 'Unlock your Mac to use remote desktop.', 409);
    const id = randomBytes(16).toString('hex'), generation = randomBytes(16).toString('hex'), key = randomBytes(32).toString('base64url');
    const room = 'codelync-desktop-' + id, viewer = 'viewer-' + device + '-' + id, hostIdentity = 'host-' + id;
    this.relay = this.options.relayFactory?.() ?? new DesktopRelay({ state: join(this.options.state, 'desktop-relay'), binary: this.options.relayBinary });
    try {
      const media = /** @type {Value} */ (await this.relay.start(this.config)); this.media = media;
      await media.rooms.createRoom({ name: room, maxParticipants: 2, emptyTimeout: 15, departureTimeout: 5 });
      const token = new AccessToken(media.apiKey, media.apiSecret, { identity: viewer, ttl: 60 });
      token.addGrant({ roomJoin: true, room, canPublish: false, canSubscribe: true, canPublishData: false, canUpdateOwnMetadata: false });
      const publisher = new AccessToken(media.apiKey, media.apiSecret, { identity: hostIdentity, ttl: 60 });
      publisher.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: false, canPublishData: false });
      const viewerToken = await token.toJwt();
      const result = await host.request('start', {
        url: media.url,
        token: await publisher.toJwt(),
        key,
        connectionId: id,
        viewer,
        displayId,
        quality,
        ...(viewport ? { viewport } : {}),
      });
      const geometry = typeof result?.geometry === 'string' && result.geometry
        ? result.geometry
        : isPlainObject(result?.display) && typeof result.display.geometry === 'string'
          ? result.display.geometry
          : '';
      if (typeof result?.trackSid !== 'string' || !result.trackSid || !geometry) {
        throw new BridgeError('desktop-capture-unavailable', 'The desktop publisher could not be confirmed.', 503);
      }
      const activeDisplay = isPlainObject(result.display)
        ? (typeof result.display.id === 'string' && result.display.id !== baseDisplay.id
          ? { ...result.display, geometry }
          : { ...baseDisplay, ...result.display, geometry })
        : { ...baseDisplay, geometry };
      this.active = {
        id, generation, key, device, room, viewer, viewerToken,
        display: activeDisplay,
        quality,
        trackSid: result.trackSid,
        geometry,
        sequence: 0,
        lastSeen: this.now(),
        inFlight: 0,
        permissions: isPlainObject(result.permissions) ? result.permissions : permissions,
        ready: false,
        viewPending: result.viewPending === true,
      };
      this.quality = quality; this.emit('status', this.status());
      return {
        version: 1, connectionId: id, generation, key, token: viewerToken, hostIdentity,
        display: activeDisplay,
        url: this.config.mode === 'local' ? origin.replace(/\/$/u, '') + '/api/peer/desktop/media' : media.url,
        quality,
        trackSid: result.trackSid,
      };
    } catch (error) { await this.stop(); throw normalizeHostError(error); }
  }
  /** Validate the short-lived issued viewer token at the local signaling proxy.
   * @param {string} path */
  async mediaUpstream(path) {
    const url = new URL(path, 'http://127.0.0.1'), active = this.active, media = this.media;
    if (!this.config.enabled || this.config.mode !== 'local' || !active || !media || !['/api/peer/desktop/media/rtc', '/api/peer/desktop/media/rtc/v1'].includes(url.pathname)
      || !this.options.devices.publicKey(active.device) || url.searchParams.get('access_token') !== active.viewerToken) throw new BridgeError('desktop-media-unauthorized', 'The desktop media grant is unavailable.', 401);
    const claims = await new TokenVerifier(media.apiKey, media.apiSecret).verify(active.viewerToken);
    if (claims.sub !== active.viewer || claims.video?.room !== active.room) throw new BridgeError('desktop-media-unauthorized', 'The desktop media grant does not match.', 401);
    return { origin: media.url.replace(/^ws/u, 'http'), path: url.pathname.endsWith('/v1') ? '/rtc/v1' + url.search : '/rtc' + url.search, device: active.device };
  }
  /** @param {string} permission */
  requestPermission(permission) {
    return this.run(async () => {
      if (!this.config.enabled || !['screenRecording', 'accessibility'].includes(permission)) throw new BridgeError('desktop-disabled', 'Enable remote desktop first.', 409);
      const result = await this.ensureHost().request('request-permissions', { permission });
      this.emit('status', { ...this.status(), permissions: result.permissions }); return result;
    });
  }
  async stop() {
    const active = this.active; this.active = null;
    await this.host?.request('stop').catch(() => {});
    if (active && this.media) await this.media.rooms.deleteRoom(active.room).catch(() => {});
    await this.relay?.close(); this.relay = null; this.media = null;
    this.emit('status', this.status());
  }
  async close() {
    if (this.closed) return; this.closed = true; clearInterval(this.watch);
    this.host?.interrupt?.();
    this.options.devices.off('changed', this.devicesChanged);
    await this.run(async () => { await this.stop(); await this.host?.close(); this.host = null; });
  }
}
