import { EventEmitter, once } from 'node:events';
import { createHash } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { isPrivateHost, peerMaterial } from '@codelync/wire/codelync';
import { BridgeError } from '../errors.mjs';
import { ConnectionChannelsManager } from '../network/connection-channels.mjs';
import { DeviceProofVerifier } from '../network/device-proof.mjs';
import { EntryProbes } from '../network/public-access.mjs';
import { createPairingGateway } from './pairing-gateway.mjs';
import { CodelyncRecentService } from './recent-data.mjs';
import { NativeActivityTransport } from './activity-transport.mjs';
import { isCodelyncNativeSource } from './source-scope.mjs';
import { readLanListenerPorts, writeLanListenerPorts } from './lan-listener-ports.mjs';

/** @typedef {Record<string,any>} Value */
/** @typedef {'local'|'cloudflare'|'relay'} Kind */
/** @typedef {ConstructorParameters<typeof ConnectionChannelsManager>[0]} ManagerOptions */
/** @typedef {Record<string,{address:string,family:string|number,internal:boolean}[]|undefined>} Interfaces */
/** @typedef {{state:string,cloudflared:string,upstream:string,account:Value,devices:import('./device-registry.mjs').DeviceRegistry,invitations:import('./pairing-gateway.mjs').PairingInvitations,daemon:import('./mac-daemon.mjs').CodelyncMacDaemon,metrics?:Pick<import('./gateway-metrics.mjs').GatewayMetrics,'request'|'trackSocket'>,notificationsAvailable?:boolean|(()=>boolean),interfaces?:()=>Interfaces,networkWatchMs?:number,gatewayFactory?:typeof createPairingGateway,managerFactory?:(options:ManagerOptions)=>ConnectionChannelsManager}} Options */

/** @param {unknown} url @returns {string} */
function localUrlHostname(url) {
  if (typeof url !== 'string' || !url) return '';
  try { return new URL(url).hostname; } catch { return ''; }
}

/** Only real private IPv4 interfaces become LAN listeners; the public entries have separate gateways.
 * @param {Interfaces} [interfaces] */
export function privateLANAddresses(interfaces = networkInterfaces()) {
  const addresses = new Set();
  for (const [name, rows] of Object.entries(interfaces)) for (const row of rows ?? []) {
    if (/^(?:utun|tun|tap|ppp|ipsec)\d*(?:$|[._-])/iu.test(name)) continue;
    if (!row || row.internal || !['IPv4', '4'].includes(String(row.family)) || isIP(row.address) !== 4 || !isPrivateHost(row.address)
      || row.address === '127.0.0.1' || row.address === 'localhost') continue;
    addresses.add(row.address);
  }
  return [...addresses].sort().slice(0, 3);
}

/** Composes network-only entries around one existing Mac account, daemon and proof owner. */
export class MacConnectionService extends EventEmitter {
  /** @param {Options & {remoteDesktop?:import('./remote-desktop.mjs').RemoteDesktop}} options */
  constructor(options) {
    super(); this.options = options; this.closed = false; this.cancel = new AbortController();
    this.gateways = /** @type {Set<ReturnType<typeof createPairingGateway>>} */ (new Set());
    this.publicGateways = /** @type {Map<Kind,{gateway:ReturnType<typeof createPairingGateway>,origin:string}>} */ (new Map());
    this.gatewayClosures = /** @type {WeakMap<ReturnType<typeof createPairingGateway>,Promise<void>>} */ (new WeakMap());
    this.probes = new Map(/** @type {Kind[]} */ (['local', 'cloudflare', 'relay']).map(kind => [kind, new EntryProbes()]));
    this.started = /** @type {Promise<Value>|null} */ (null); this.lastPairing = /** @type {string|null} */ (null);
    this.closing = /** @type {Promise<void>|null} */ (null);
    this.lanPortWrites = Promise.resolve();
    this.networkWatchMs = options.networkWatchMs ?? 3000;
    if (!Number.isSafeInteger(this.networkWatchMs) || this.networkWatchMs !== 0 && this.networkWatchMs < 1000) throw Error('invalid-network-watch-interval');
    this.networkFingerprint = '';
    this.networkTimer = /** @type {ReturnType<typeof setInterval>|null} */ (null);
    this.networkRefresh = /** @type {Promise<boolean>|null} */ (null);
    const managerOptions = /** @type {ManagerOptions} */ ({ state: options.state, cloudflared: options.cloudflared,
      upstreamFor: kind => { const gateway = this.publicGateways.get(kind); if (!gateway) throw Error('connection-gateway-unavailable'); return gateway.origin; },
      probesFor: kind => /** @type {EntryProbes} */ (this.probes.get(kind)), startLocal: signal => this.startLocal(signal) });
    this.manager = options.managerFactory?.(managerOptions) ?? new ConnectionChannelsManager(managerOptions);
    this.proof = new DeviceProofVerifier({ key: options.invitations.pair.secretKey, devices: options.devices,
      origins: () => this.candidates().map(row => row.url) });
    const publicKey = Buffer.from(options.invitations.pair.publicKey).toString('base64url');
    this.peerIdentity = createHash('sha256').update(peerMaterial(publicKey, options.account.secret)).digest('hex');
    this.recent = new CodelyncRecentService({ sources: () => this.sources(), resolveSource: id => this.resolveSource(id),
      available: () => this.catalogueAvailable(), readAvailable: () => this.readAvailable(), machineId: () => this.options.daemon.machine?.id ?? null,
      catalogRefreshMs: 5000,
      retainSource: (id, execute) => this.options.daemon.useSource(this.source(id).key, execute) });
    this.sourceSubscriptionsChanged = () => { if (!this.closed) this.recent.refreshCatalog(); };
    this.options.daemon.on?.('source-subscriptions', this.sourceSubscriptionsChanged);
    this.activityTransport = new NativeActivityTransport({ poll: request => {
      if (!this.readAvailable() || !this.options.daemon.activity) throw new BridgeError('source-unavailable', 'Native activity is unavailable.', 503);
      return this.options.daemon.activity.poll(request);
    }, machineId: () => this.options.daemon.machine?.id ?? null });
    this.manager.on('configuration', value => { if (!this.closed) this.emit('configuration', value); });
    this.manager.on('channels', value => { if (!this.closed) this.emit('channels', value); });
  }

  start() { if (!this.started) this.started = this.initialize(); return this.started; }

  async initialize() {
    this.recent.startCatalogMaintenance();
    await Promise.allSettled(/** @type {Kind[]} */ (['cloudflare', 'relay']).map(async kind => {
      try {
        const gateway = await this.gateway(kind, '127.0.0.1', () => this.kindOrigin(kind), this.cancel.signal);
        const address = gateway.address(); if (!address || typeof address === 'string') throw Error('connection-gateway-unavailable');
        if (this.closed) throw Error('connection-service-cancelled');
        this.publicGateways.set(kind, { gateway, origin: 'http://127.0.0.1:' + address.port });
      } catch { if (!this.closed) this.emit('diagnostic', { code: 'connection-gateway-unavailable', kind }); }
    }));
    if (this.closed) throw Error('connection-service-cancelled');
    const configuration = await this.manager.load();
    this.networkFingerprint = JSON.stringify(privateLANAddresses(this.options.interfaces?.()));
    if (!this.closed && this.networkWatchMs) {
      this.networkTimer = setInterval(() => {
        void this.refreshNetwork().catch(() => { if (!this.closed) this.emit('diagnostic', { code: 'local-network-refresh-unavailable', kind: 'local' }); });
      }, this.networkWatchMs);
      this.networkTimer.unref();
    }
    return configuration;
  }

  /** A cheap interface scan owns local listener reconciliation. Existing peer,
   * public tunnels and original runtime state are untouched. */
  refreshNetwork() {
    if (this.networkRefresh) return this.networkRefresh;
    const refreshing = (async () => {
      if (this.closed || !this.manager.initialized) return false;
      const hosts = privateLANAddresses(this.options.interfaces?.()), fingerprint = JSON.stringify(hosts);
      const changed = fingerprint !== this.networkFingerprint; this.networkFingerprint = fingerprint;
      if (!this.manager.saved.enabledChannels.includes('local')) return false;
      const entry = this.manager.entries.get('local');
      const bound = this.manager.candidates().filter(row => row.kind === 'local').map(row => localUrlHostname(row.url)).sort();
      const complete = JSON.stringify(bound) === fingerprint && (!hosts.length || entry?.state === 'ready');
      if (!changed && complete && !entry?.transport?.needsRefresh?.(hosts)) return false;
      return this.manager.refreshLocal();
    })().finally(() => { if (this.networkRefresh === refreshing) this.networkRefresh = null; });
    this.networkRefresh = refreshing; return refreshing;
  }

  candidates() { return this.closed ? [] : this.manager.candidates(); }
  primaryOrigin() { return this.manager.preferredOrigin() || this.candidates()[0]?.url || ''; }
  peerId() { return this.peerIdentity; }
  /** @param {Kind} kind */
  kindOrigin(kind) { return this.candidates().find(row => row.kind === kind)?.url ?? null; }

  /** Only changes, explicit refresh and expiry renewal rotate the invitation, not every authenticated request.
   * @param {boolean} [force] */
  pairing(force = false) {
    const channels = this.candidates(), origin = this.primaryOrigin(), fingerprint = JSON.stringify([origin, channels]);
    if (!force && fingerprint === this.lastPairing) return null;
    if (!channels.length || !origin || this.closed) { this.lastPairing = fingerprint; return { origin: '', pairingUrl: '', channels: [] }; }
    const invitation = this.options.invitations.issue(origin, channels); this.lastPairing = fingerprint;
    return { origin, pairingUrl: invitation.url, expires: invitation.expires, channels };
  }

  available() { const daemon = this.options.daemon; return !this.closed && !daemon.closed && daemon.ownsLease && daemon.inventoryAvailable; }
  catalogueAvailable() { const daemon = this.options.daemon; return !this.closed && !daemon.closed && daemon.ownsLease
    && daemon.sourceConfigurationKnown?.() !== false && daemon.registrationAvailable === true && typeof daemon.machine?.id === 'string' && !!daemon.machine.id; }
  readAvailable() { const daemon = this.options.daemon; return !this.closed && !daemon.closed && daemon.ownsLease; }
  sources() { return [...this.options.daemon.sources].filter(([, entry]) => this.options.daemon.sourceEnabled?.(entry.source) !== false).map(([key, entry]) => ({ ...entry, actor: this.options.daemon.actors.get(key) })); }

  /** @param {string} id */
  source(id) {
    const match = [...this.options.daemon.sources].find(([, entry]) => entry.binding.happySessionId === id);
    if (!match || this.options.daemon.sourceEnabled?.(match[1].source) === false || !isCodelyncNativeSource(match[1].source, match[1].binding.metadata) || match[1].binding.metadata?.nativeSession?.catalogueAvailable === false) throw new BridgeError('source-unavailable', 'The selected native source is unavailable.', 503);
    return { key: match[0], entry: match[1] };
  }

  /** Preparation reuses the existing source actor and never calls desktop navigation.
   * @param {string} id @returns {Promise<{source:Value,binding:Value,actor:Value}>} */
  async resolveSource(id) {
    const { key } = this.source(id), daemon = this.options.daemon;
    return /** @type {Promise<{source:Value,binding:Value,actor:Value}>} */ (daemon.useSource(key, async () => {
      const actor = await daemon.prepareSource(key); await daemon.startSource(key, actor);
      const { entry } = this.source(id); return { ...entry, actor };
    }));
  }

  /** Peer routes contain read-only selection/history data, not a second command admission path.
   * @param {string} path @param {string} method @param {Value} body @param {string} device @returns {Promise<Value>} */
  async peerApi(path, method, body, device, origin = this.primaryOrigin()) {
    if (this.closed || !this.options.devices.publicKey(device)) throw new BridgeError('unknown-device', 'The approved device is unavailable.', 401);
    let url;
    try { url = new URL(path, 'http://127.0.0.1'); } catch { throw new BridgeError('invalid-peer-route', 'The peer route is invalid.', 400); }
    if ((!path.startsWith('/api/peer/') && url.pathname !== '/network-probe') || url.origin !== 'http://127.0.0.1') throw new BridgeError('invalid-peer-route', 'The peer route is invalid.', 400);
    if (url.pathname === '/network-probe') {
      if (method !== 'GET') throw new BridgeError('invalid-peer-method', 'The network probe uses GET.', 405);
      if (url.search || !body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length) throw new BridgeError('invalid-peer-request', 'The network probe does not take a body or query.', 400);
      return { version: 1 };
    }
    if (url.pathname === '/api/peer/channels' && method === 'GET') return { version: 2, channels: this.candidates() };
    const desktopAction = url.pathname.match(/^\/api\/peer\/desktop\/(status|displays|join|ready|heartbeat|quality|display|space|input|leave)$/u);
    if (desktopAction && !url.search && this.options.remoteDesktop) return this.options.remoteDesktop.api(desktopAction[1], method, body, device, origin);
    const params = Object.fromEntries(url.searchParams);
    if (url.pathname === '/api/peer/activity' && method === 'POST') {
      if (Object.keys(params).length) throw new BridgeError('invalid-peer-request', 'Activity uses a bounded request body.');
      return this.activityTransport.request(device, body);
    }
    const catalog = url.pathname === '/api/peer/catalog' && method === 'GET';
    if (Object.keys(params).some(key => !(catalog ? ['limit', 'cursor', 'catalogVersion', 'since'] : ['limit', 'cursor']).includes(key))) throw new BridgeError('invalid-peer-request', 'The peer query is invalid.', 400);
    if (catalog) return this.recent.catalog(params);
    const selected = url.pathname.match(/^\/api\/peer\/sessions\/([^/]+)\/(recent|history)$/u);
    if (!selected || selected[2] === 'recent' && method !== 'POST' || selected[2] === 'history' && method !== 'GET') throw new BridgeError('unsupported-peer-route', 'The peer route is unavailable.', 404);
    let id;
    try { id = decodeURIComponent(selected[1]); } catch { throw new BridgeError('invalid-session', 'A selected native session is required.', 400); }
    if (!id || id.length > 200 || id.includes('/')) throw new BridgeError('invalid-session', 'A selected native session is required.');
    if (selected[2] === 'recent' && (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).some(key => !['limit', 'readPolicy'].includes(key))
      || body.readPolicy !== undefined && !['fresh', 'cache-first'].includes(body.readPolicy))) throw new BridgeError('invalid-peer-request', 'The recent request is invalid.');
    if (selected[2] === 'history' && body != null && (Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length > 0)) throw new BridgeError('invalid-peer-request', 'History reads use query parameters only.');
    const { key } = this.source(id);
    // resolveSource 的准备阶段结束后仍需保留 pin；否则另一手机的容量回收会在实际 readRecent 前关闭 observer。
    return this.options.daemon.useSource(key, () => selected[2] === 'recent' ? this.recent.recent(id, body) : this.recent.history(id, params));
  }

  /** @param {Kind} kind @param {string} host @param {()=>string|null} origin @param {AbortSignal} signal @param {number} [port] */
  async gateway(kind, host, origin, signal, port = 0) {
    if (this.closed || signal.aborted) throw Error('connection-service-cancelled');
    const remoteDesktop = this.options.remoteDesktop;
    const options = { upstream: this.options.upstream, invitations: this.options.invitations, devices: this.options.devices,
      metrics: this.options.metrics, notificationsAvailable: this.options.notificationsAvailable,
      entryProbe: (/** @type {unknown} */ challenge) => this.probes.get(kind)?.response(challenge) ?? null,
      proof: this.proof, expectedOrigin: () => origin() ?? 'https://unavailable.invalid',
      onVerified: () => { const value = origin(); if (value) this.manager.confirm(kind, value); },
      peerApi: (/** @type {string} */ path, /** @type {string} */ method, /** @type {Value} */ body, /** @type {string} */ device) => this.peerApi(path, method, body, device, origin() ?? ''),
      desktopMedia: remoteDesktop ? (/** @type {string} */ path) => remoteDesktop.mediaUpstream(path) : undefined,
      peerId: () => this.peerId() };
    const gateway = (this.options.gatewayFactory ?? createPairingGateway)(options); this.gateways.add(gateway);
    gateway.on('error', error => {
      // Occupied saved ports are an expected local fallback, not a loss of the
      // complete channel. The occupying process never becomes our gateway.
      if (!this.closed && !(kind === 'local' && port > 0 && /** @type {NodeJS.ErrnoException} */ (error).code === 'EADDRINUSE')) this.emit('diagnostic', { code: 'connection-gateway-unavailable', kind });
    });
    try {
      const listening = once(gateway, 'listening', { signal }); gateway.listen(port, host); await listening;
      if (this.closed || signal.aborted) throw Error('connection-service-cancelled');
      return gateway;
    } catch (error) { await this.closeGateway(gateway); throw error; }
  }

  /** @param {AbortSignal} signal */
  async startLocal(signal) {
    /** @type {Map<string,{gateway:ReturnType<typeof createPairingGateway>,origin:string,port:number}>} */ const listeners = new Map();
    let closed = false;
    /** @type {Promise<Value>|null} */ let refreshFlight = null;
    /** @type {Promise<void>|null} */ let closeFlight = null;
    const currentChannels = () => [...listeners].filter(([, entry]) => entry.gateway.listening)
      .map(([host, entry]) => ({ id: 'lan_' + createHash('sha256').update(host).digest('hex').slice(0, 16), kind: /** @type {'local'} */ ('local'), url: entry.origin, label: 'Local network' })).sort((a, b) => a.id.localeCompare(b.id));
    const transport = Object.assign(new EventEmitter(), { channels: /** @type {{id:string,kind:'local',url:string,label:string}[]} */ ([]),
      needsRefresh: (/** @type {string[]} */ hosts) => closed || !Array.isArray(hosts) || hosts.some(host => !listeners.get(host)?.gateway.listening) || [...listeners].some(([host]) => !hosts.includes(host)),
      refresh: (/** @type {AbortSignal} */ refreshSignal) => {
        if (refreshFlight) return refreshFlight;
        const refreshing = (async () => {
          const cancel = AbortSignal.any([signal, refreshSignal, this.cancel.signal]);
          const hosts = privateLANAddresses(this.options.interfaces?.());
          if (cancel.aborted || this.closed || closed) throw Error('local-network-unavailable');
          // Retire only departed/dead interfaces; retained owned sockets and
          // their exact advertised ports continue serving existing phones.
          await Promise.allSettled([...listeners].filter(([host, entry]) => !hosts.includes(host) || !entry.gateway.listening).map(async ([host, entry]) => {
            listeners.delete(host); await this.closeGateway(entry.gateway);
          }));
          await this.lanPortWrites.catch(() => {});
          const saved = await readLanListenerPorts(this.options.state);
          /** @type {Set<string>} */ const newlyBound = new Set();
          const dropNewlyBound = async () => {
            await Promise.allSettled([...newlyBound].map(async host => {
              const entry = listeners.get(host); if (!entry) return;
              listeners.delete(host); await this.closeGateway(entry.gateway);
            }));
          };
          await Promise.allSettled(hosts.filter(host => !listeners.has(host)).map(async host => {
            let origin = '';
            try {
              const preferred = saved.get(host) ?? 0;
              let gateway;
              try { gateway = await this.gateway('local', host, () => origin, cancel, preferred); }
              catch (error) {
                if (!preferred || cancel.aborted || this.closed || closed || /** @type {NodeJS.ErrnoException} */ (error).code !== 'EADDRINUSE') throw error;
                gateway = await this.gateway('local', host, () => origin, cancel);
              }
              const address = gateway.address();
              if (cancel.aborted || this.closed || closed || !address || typeof address === 'string') { await this.closeGateway(gateway); throw Error('local-network-unavailable'); }
              origin = `http://${host}:${address.port}`; listeners.set(host, { gateway, origin, port: address.port }); newlyBound.add(host);
              const owned = gateway;
              owned.once('close', () => {
                if (this.closed || closed || signal.aborted || listeners.get(host)?.gateway !== owned) return;
                listeners.delete(host); transport.channels = currentChannels(); transport.emit('channels', transport.channels);
              });
            } catch { if (!cancel.aborted && !this.closed && !closed) this.emit('diagnostic', { code: 'local-network-unavailable', kind: 'local' }); }
          }));
          if (cancel.aborted || this.closed || closed) { await dropNewlyBound(); throw Error('local-network-unavailable'); }
          // A network can change again while sockets are binding. Never promote
          // a late listener for an interface already absent from the fresh scan.
          const currentHosts = privateLANAddresses(this.options.interfaces?.());
          await Promise.allSettled([...listeners].filter(([host]) => !currentHosts.includes(host)).map(async ([host, entry]) => {
            listeners.delete(host); await this.closeGateway(entry.gateway);
          }));
          transport.channels = currentChannels();
          // With no interface, dormant owned-port hints can help the same host
          // return. They never supply a bind or an advertised route by themselves.
          if (listeners.size) {
            const snapshot = [...listeners].map(([host, entry]) => ({ host, port: entry.port }));
            const saving = this.lanPortWrites.catch(() => {}).then(async () => {
              if (!cancel.aborted && !this.closed && !closed) await writeLanListenerPorts(this.options.state, snapshot);
            });
            this.lanPortWrites = saving;
            await saving.catch(() => { if (!cancel.aborted && !this.closed && !closed) this.emit('diagnostic', { code: 'lan-listener-state-unavailable', kind: 'local' }); });
          }
          if (cancel.aborted || this.closed || closed) { await dropNewlyBound(); transport.channels = currentChannels(); throw Error('local-network-unavailable'); }
          return { channels: transport.channels };
        })().finally(() => { if (refreshFlight === refreshing) refreshFlight = null; });
        refreshFlight = refreshing; return refreshing;
      },
      close: () => {
        if (!closeFlight) {
          closed = true;
          closeFlight = (async () => {
            await refreshFlight?.catch(() => {});
            await Promise.allSettled([...listeners.values()].map(entry => this.closeGateway(entry.gateway))); listeners.clear(); transport.channels = [];
          })();
        }
        return closeFlight;
      } });
    try { await transport.refresh(signal); if (!transport.channels.length) throw Error('local-network-unavailable'); return transport; }
    catch (error) { await transport.close(); throw error; }
  }

  /** @param {ReturnType<typeof createPairingGateway>} gateway */
  closeGateway(gateway) {
    const previous = this.gatewayClosures.get(gateway); if (previous) return previous;
    gateway.closeAllConnections();
    const closing = new Promise(resolve => gateway.close(() => { this.gateways.delete(gateway); resolve(undefined); }));
    this.gatewayClosures.set(gateway, closing); return closing;
  }

  close() {
    if (this.closing) return this.closing; this.closed = true; this.cancel.abort();
    this.activityTransport.close(); this.recent.close(); this.options.daemon.removeListener?.('source-subscriptions', this.sourceSubscriptionsChanged);
    if (this.networkTimer) clearInterval(this.networkTimer); this.networkTimer = null;
    this.closing = (async () => {
      await this.manager.close(); await Promise.allSettled([...this.gateways].map(gateway => this.closeGateway(gateway)));
      await this.networkRefresh?.catch(() => {});
      await this.lanPortWrites.catch(() => {});
      this.publicGateways.clear(); this.proof.seen.clear();
    })();
    return this.closing;
  }
}
