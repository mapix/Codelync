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
/** @param {unknown} raw */
export function desktopQuality(raw) {
  const value = /** @type {Value} */ (raw);
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'fps,width'
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
      if (this.active && (this.now() - this.active.lastSeen > 15_000 || !options.devices.publicKey(this.active.device))) { this.host?.interrupt?.(); void this.run(() => this.stop()); }
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
      permissions: this.active?.permissions ?? null };
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
      const host = this.options.hostFactory?.() ?? new DesktopHostProcess({ binary: this.options.hostBinary });
      host.on('stopped', () => { if (this.active) void this.run(() => this.stop()); }); this.host = host;
      host.on('view-invalidated', (/** @type {string} */ connectionId) => {
        if (this.active?.id === connectionId) { this.active.ready = false; this.active.viewPending = true; }
      });
    }
    return this.host;
  }
  /** @param {Value} active @param {Value} result */
  adoptView(active, result) {
    if (typeof result.geometry !== 'string' || !result.geometry || typeof result.trackSid !== 'string' || !result.trackSid) throw new BridgeError('desktop-capture-unavailable', 'The desktop view could not be confirmed.', 503);
    if (result.geometry !== active.geometry || result.trackSid !== active.trackSid || result.viewPending === true) active.ready = false;
    active.geometry = result.geometry; active.trackSid = result.trackSid; active.viewPending = result.viewPending === true;
    active.display = { ...active.display, geometry: result.geometry }; active.permissions = result.permissions;
  }
  /** @param {Value} packet @param {string} device */
  openRequest(packet, device) {
    const key = this.options.devices.publicKey(device);
    if (!key || !packet || Object.keys(packet).sort().join(',') !== 'ciphertext,nonce,version' || packet.version !== 1
      || typeof packet.nonce !== 'string' || !/^[A-Za-z0-9_-]{32}$/u.test(packet.nonce)
      || typeof packet.ciphertext !== 'string' || packet.ciphertext.length > 12_000) throw new BridgeError('invalid-desktop-request', 'A sealed desktop request is required.', 400);
    const plain = nacl.box.open(Buffer.from(packet.ciphertext, 'base64url'), Buffer.from(packet.nonce, 'base64url'), Buffer.from(key, 'base64url'), this.options.macSecretKey);
    if (!plain) throw new BridgeError('invalid-desktop-request', 'The desktop request did not authenticate.', 401);
    let body; try { body = JSON.parse(Buffer.from(plain).toString()); } catch { throw new BridgeError('invalid-desktop-request', 'The desktop request is invalid.'); }
    if (body?.version !== 1 || !Number.isSafeInteger(body.at) || Math.abs(this.now() - body.at) > 30_000) throw new BridgeError('desktop-request-expired', 'The desktop request expired.', 409);
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
      if (action === 'status' && method === 'GET') return this.status();
      if (!this.config.enabled) throw new BridgeError('desktop-disabled', 'Enable remote desktop on your Mac.', 409);
      if (method !== 'POST') throw new BridgeError('invalid-desktop-request', 'The desktop request method is invalid.');
      const body = this.openRequest(packet, device);
      if (body.action !== action) throw new BridgeError('invalid-desktop-request', 'The desktop request action does not match.');
      if (action === 'displays') return this.ensureHost().request('displays');
      if (action === 'join') return this.join(body, device, origin);
      const active = this.active;
      if (!active || active.device !== device || body.connectionId !== active.id || body.generation !== active.generation) throw new BridgeError('desktop-disconnected', 'This desktop connection is no longer active.', 409);
      if (action === 'leave') { await this.stop(); return { stopped: true }; }
      if (action === 'ready') {
        if (body.trackSid !== active.trackSid || body.geometry !== active.geometry || active.viewPending) throw new BridgeError('desktop-not-ready', 'Wait for the current display picture.', 409);
        const result = await this.ensureHost().request('heartbeat', { connectionId: active.id, geometry: active.geometry });
        this.adoptView(active, result);
        if (!result.viewerConnected || !result.capturing || !result.connected || active.viewPending || body.trackSid !== active.trackSid || body.geometry !== active.geometry) throw new BridgeError('desktop-not-ready', 'Wait for the live desktop picture.', 409);
        active.ready = true; active.lastSeen = this.now(); return { ready: true };
      }
      if (action === 'heartbeat') {
        const result = await this.ensureHost().request('heartbeat', { connectionId: active.id, geometry: active.geometry });
        this.adoptView(active, result);
        active.lastSeen = this.now(); active.permissions = result.permissions; return { ...result, generation: active.generation };
      }
      if (action === 'space') {
        if (!['previous', 'next', 'overview'].includes(body.kind) || !Number.isSafeInteger(body.sequence)
          || body.sequence <= active.sequence || body.sequence > active.sequence + 1024) throw new BridgeError('invalid-desktop-space', 'The desktop navigation request is invalid.');
        if (body.geometry !== active.geometry || !active.ready || active.viewPending) throw new BridgeError('desktop-view-changed', 'Wait for the current desktop picture.', 409);
        active.sequence = body.sequence; active.ready = false; active.lastSeen = this.now();
        try {
          const result = await this.ensureHost().request('space', { connectionId: active.id, geometry: active.geometry, kind: body.kind, sequence: body.sequence });
          this.adoptView(active, result); active.lastSeen = this.now(); return result;
        } catch (error) {
          if (['desktop-space-shortcut-disabled', 'desktop-space-shortcut-unavailable', 'desktop-input-permission-required'].includes(/** @type {Value} */ (error)?.code)) {
            if (!active.viewPending) active.ready = true;
          }
          throw error;
        }
      }
      if (action === 'quality') {
        const quality = desktopQuality(body.quality);
        active.ready = false;
        let result;
        try { result = await this.ensureHost().request('quality', { connectionId: active.id, geometry: active.geometry, quality }); }
        catch (error) { await this.stop(); throw error; }
        if (typeof result?.trackSid !== 'string' || !result.trackSid) { await this.stop(); throw new BridgeError('desktop-capture-unavailable', 'The desktop view could not be confirmed.', 503); }
        active.trackSid = result.trackSid;
        active.viewPending = result.viewPending === true;
        this.quality = quality; active.lastSeen = this.now(); this.emit('status', this.status()); return { ...result, quality };
      }
      if (action === 'display') {
        if (typeof body.displayId !== 'string' || !/^\d{1,10}$/u.test(body.displayId)) throw new BridgeError('invalid-desktop-display', 'Select an available display.');
        active.ready = false;
        let result;
        try { result = await this.ensureHost().request('display', { connectionId: active.id, geometry: active.geometry, displayId: body.displayId }); }
        catch (error) { await this.stop(); throw error; }
        if (!result?.display || result.display.id !== body.displayId || typeof result.display.geometry !== 'string' || !result.display.geometry
          || typeof result.trackSid !== 'string' || !result.trackSid) { await this.stop(); throw new BridgeError('desktop-display-unavailable', 'The display could not be confirmed.', 503); }
        active.geometry = result.display.geometry; active.display = result.display; active.trackSid = result.trackSid;
        active.viewPending = result.viewPending === true; active.lastSeen = this.now();
        this.emit('status', this.status()); return result;
      }
      if (action === 'input' && (body.geometry !== active.geometry || active.viewPending)) throw new BridgeError('desktop-view-changed', 'Wait for the current desktop picture.', 409);
      if (action !== 'input' || !Number.isSafeInteger(body.sequence)
        || body.sequence <= active.sequence || body.sequence > active.sequence + 1024) throw new BridgeError('desktop-input-replayed', 'The desktop input is stale or was already sent.', 409);
      if (!active.ready) throw new BridgeError('desktop-not-ready', 'Wait for the live desktop picture.', 409);
      // Reserve before dispatch. A missing receipt never permits redispatch.
      active.sequence = body.sequence; active.lastSeen = this.now();
      const input = body.input;
      if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some(key => !['action', 'x', 'y', 'phase', 'button', 'deltaY', 'text', 'key', 'modifiers'].includes(key))) throw new BridgeError('invalid-desktop-input', 'The desktop input is invalid.');
      return this.ensureHost().request('input', { ...input, connectionId: active.id, geometry: active.geometry, sequence: body.sequence });
    });
  }
  /** @param {Value} body @param {string} device @param {string} origin */
  async join(body, device, origin) {
    if (this.active) throw new BridgeError('desktop-in-use', 'End the current desktop connection first.', 409);
    if (typeof body.displayId !== 'string' || !/^\d{1,10}$/u.test(body.displayId)) throw new BridgeError('invalid-desktop-display', 'Select an available display.');
    const quality = desktopQuality(body.quality ?? DEFAULT_QUALITY), host = this.ensureHost();
    const inventory = await host.request('displays');
    const display = inventory.displays?.find((/** @type {Value} */ row) => row.id === body.displayId);
    if (!display) throw new BridgeError('desktop-display-unavailable', 'The selected display is unavailable.', 409);
    if (!inventory.permissions?.screenRecording) throw new BridgeError('desktop-screen-permission-required', 'Allow screen recording on your Mac.', 409);
    if (inventory.permissions.locked) throw new BridgeError('desktop-locked', 'Unlock your Mac to use remote desktop.', 409);
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
      const result = await host.request('start', { url: media.url, token: await publisher.toJwt(), key, connectionId: id, viewer, displayId: display.id, quality });
      if (typeof result?.trackSid !== 'string' || !result.trackSid || typeof result.geometry !== 'string' || !result.geometry) throw new BridgeError('desktop-capture-unavailable', 'The desktop publisher could not be confirmed.', 503);
      display.geometry = result.geometry;
      this.active = { id, generation, key, device, room, viewer, viewerToken, display, trackSid: result.trackSid, geometry: result.geometry, sequence: 0, lastSeen: this.now(), permissions: result.permissions, ready: false, viewPending: result.viewPending === true };
      this.quality = quality; this.emit('status', this.status());
      return { version: 1, connectionId: id, generation, key, token: viewerToken, hostIdentity, display,
        url: this.config.mode === 'local' ? origin.replace(/\/$/u, '') + '/api/peer/desktop/media' : media.url, quality, trackSid: result.trackSid };
    } catch (error) { await this.stop(); throw error; }
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
