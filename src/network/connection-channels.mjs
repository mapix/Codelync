import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { channelList, channelOrigin, isPrivateHost, CHANNEL_KINDS } from '@slopus/happy-wire/codelight';
import { readOptionalPrivateJson, writeDurablePrivateJson } from '../happy/discovery-persistence.mjs';
import { CloudflareAccess } from './public-access.mjs';
import { RelayTunnelClient, normalizeRelayAddress } from './relay-client.mjs';

/** @typedef {Record<string,any>} Value */
/** @typedef {'local'|'cloudflare'|'relay'} Kind */
/** @typedef {{id:string,kind:Kind,url:string,label?:string}} Channel */
/** @typedef {{state:string,cloudflared:string,upstreamFor:(kind:Kind)=>string,probesFor:(kind:Kind)=>{verify:(url:string,signal?:AbortSignal)=>Promise<void>},startLocal:(signal:AbortSignal)=>Promise<Value>,transportFactory?:(config:Value,seed:Uint8Array)=>Value,retryInitialMs?:number,retryMaxMs?:number}} Options */

/** One configuration owner, independent transport lifecycles and no business/runtime state. */
export class ConnectionChannelsManager extends EventEmitter {
  /** @param {Options} options */
  constructor(options) {
    super(); this.options = options; this.closed = false; this.initialized = false;
    this.saved = /** @type {Value} */ ({ version: 2, enabledChannels: ['local', 'cloudflare'], relay: null });
    this.entries = /** @type {Map<Kind,Value>} */ (new Map());
    this.pending = /** @type {Map<Kind,Value>} */ (new Map());
    this.states = /** @type {Map<Kind,string>} */ (new Map());
    this.generations = /** @type {Map<Kind,number>} */ (new Map());
    this.closingResources = /** @type {Set<Promise<void>>} */ (new Set());
    this.seed = /** @type {Uint8Array|null} */ (null);
    this.loading = /** @type {Promise<Value>|null} */ (null);
    this.closing = /** @type {Promise<void>|null} */ (null);
    this.localRefresh = /** @type {Promise<boolean>|null} */ (null);
    this.retryInitialMs = options.retryInitialMs ?? 1000;
    this.retryMaxMs = options.retryMaxMs ?? 30000;
    if (!Number.isSafeInteger(this.retryInitialMs) || this.retryInitialMs < 1 || !Number.isSafeInteger(this.retryMaxMs)
      || this.retryMaxMs < this.retryInitialMs || this.retryMaxMs > 60000) throw Error('invalid-channel-retry-interval');
    this.retryTimers = /** @type {Map<Kind,ReturnType<typeof setTimeout>>} */ (new Map());
    this.retryDelays = /** @type {Map<Kind,number>} */ (new Map());
    this.writes = Promise.resolve();
  }

  load() {
    if (!this.loading) this.loading = this.initialize();
    return this.loading;
  }

  async initialize() {
    if (this.closed) throw Error('connection-channels-cancelled');
    const identityPath = join(this.options.state, 'network-identity.json');
    let identity = await readOptionalPrivateJson(identityPath);
    if (!identity) {
      identity = { seed: randomBytes(32).toString('base64url') };
      await writeDurablePrivateJson(identityPath, identity);
    }
    if (typeof identity.seed !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(identity.seed)) throw Error('invalid-network-identity');
    this.seed = new Uint8Array(Buffer.from(identity.seed, 'base64url'));
    if (this.seed.length !== 32) throw Error('invalid-network-identity');
    const configured = await readOptionalPrivateJson(join(this.options.state, 'connection-channels.json'));
    if (configured) {
      if (configured.version !== 2 || !Array.isArray(configured.enabledChannels)) throw Error('invalid-connection-configuration');
      const relay = this.relayConfiguration(configured.relay);
      this.saved = { version: 2, enabledChannels: this.enabledKinds(configured.enabledChannels, !!relay), relay };
    } else {
      const legacy = await readOptionalPrivateJson(join(this.options.state, 'network-access.json'));
      const relay = this.relayConfiguration(legacy?.serverUrl ? legacy : null);
      this.saved = { version: 2, enabledChannels: relay ? [...CHANNEL_KINDS] : ['local', 'cloudflare'], relay };
      await writeDurablePrivateJson(join(this.options.state, 'connection-channels.json'), this.saved);
    }
    if (this.closed) { this.seed.fill(0); throw Error('connection-channels-cancelled'); }
    this.initialized = true;
    this.emit('configuration', this.summary());
    this.reconcile();
    return this.summary();
  }

  /** @param {Value|null|undefined} input */
  relayConfiguration(input) {
    if (!input) return null;
    if (typeof input.serverUrl !== 'string' || !input.serverUrl.trim()) throw Error('invalid-relay-address');
    return { serverUrl: normalizeRelayAddress(input.serverUrl), token: typeof input.token === 'string' ? input.token : '' };
  }

  /** @param {unknown} input @param {boolean} configured @returns {Kind[]} */
  enabledKinds(input, configured) {
    if (!Array.isArray(input) || input.some(kind => !CHANNEL_KINDS.includes(kind)) || new Set(input).size !== input.length) throw Error('invalid-enabled-channels');
    if (input.includes('relay') && !configured) throw Error('relay-not-configured');
    return /** @type {Kind[]} */ (CHANNEL_KINDS.filter(kind => input.includes(kind)));
  }

  summary() {
    return { enabledChannels: [...this.saved.enabledChannels], relayConfigured: !!this.saved.relay,
      serverUrl: this.saved.relay?.serverUrl ?? '', hasToken: !!this.saved.relay?.token };
  }

  snapshot() {
    const channels = /** @type {(Channel & {state:string})[]} */ ([]);
    if (!this.closed) for (const kind of /** @type {Kind[]} */ (this.saved.enabledChannels)) {
      const entry = this.entries.get(kind), state = entry?.state ?? this.states.get(kind) ?? 'starting';
      const rows = entry?.channels?.length ? entry.channels : [{ id: kind, kind, url: '', label: this.label(kind) }];
      for (const row of rows) channels.push({ ...row, state });
    }
    const overallState = channels.some(row => row.state === 'ready') ? 'ready'
      : channels.some(row => row.state === 'unverified') ? 'unverified'
        : channels.some(row => ['starting', 'reconnecting'].includes(row.state)) ? 'connecting'
          : channels.length ? 'unavailable' : 'disabled';
    return { channels, overallState };
  }

  /** Known enabled candidates may be proven by a paired phone even if this Mac cannot resolve one. */
  candidates() { return this.snapshot().channels.filter(row => row.url).map(({ state: _state, ...row }) => row); }

  /** Prefer the stable public route for legacy callers; a v2 phone proves and selects its own route. */
  preferredOrigin() {
    const rows = this.snapshot().channels;
    for (const kind of ['relay', 'cloudflare', 'local']) {
      const ready = rows.find(row => row.kind === kind && row.state === 'ready' && row.url);
      if (ready) return ready.url;
    }
    return '';
  }

  /** The caller must first authenticate the paired device through this exact owned kind/URL.
   * @param {Kind} kind @param {string} url */
  confirm(kind, url) {
    const entry = this.entries.get(kind);
    if (!entry || this.closed || !this.saved.enabledChannels.includes(kind)
      || !entry.channels.some((/** @type {Channel} */ row) => row.url === url)) return false;
    entry.probeCancel?.abort(); entry.confirmed = true; entry.verification++; entry.state = 'ready'; this.cancelRetry(kind, true); this.publish(); return true;
  }

  /** @param {Kind} kind */
  label(kind) { return kind === 'local' ? 'Local network' : kind === 'cloudflare' ? 'Cloudflare' : 'Relay'; }
  publish() { if (!this.closed) this.emit('channels', this.snapshot()); }

  /** Serialize only durable choices. Channel handshakes never hold this writer queue.
   * @param {(saved:Value)=>Value} update */
  commit(update) {
    const operation = this.writes.catch(() => {}).then(async () => {
      if (this.closed) throw Error('connection-channels-cancelled');
      const next = update(this.saved);
      await writeDurablePrivateJson(join(this.options.state, 'connection-channels.json'), next);
      if (this.closed) throw Error('connection-channels-cancelled');
      this.saved = next; this.emit('configuration', this.summary());
      return this.summary();
    });
    this.writes = operation.then(() => undefined, () => undefined); return operation;
  }

  /** @param {unknown} input */
  async setEnabled(input) {
    if (!this.initialized || !this.seed) throw Error('connection-channels-not-loaded');
    const kinds = this.enabledKinds(input, !!this.saved.relay);
    let disablingRelay = false;
    await this.commit(saved => {
      disablingRelay = saved.enabledChannels.includes('relay') && !kinds.includes('relay');
      return { ...saved, enabledChannels: kinds };
    });
    if (disablingRelay) this.stopKind('relay');
    this.reconcile(); return this.summary();
  }

  /** @param {{serverUrl:string,token?:string}} input */
  async configureRelay(input) {
    if (!this.initialized || !this.seed || this.closed) throw Error('connection-channels-not-loaded');
    const committing = this.pending.get('relay');
    // 已开始持久化的候选先完成提交和发布，新候选不能把磁盘配置与实际入口拆开。
    if (committing?.stage === 'committing') await committing.finished;
    if (this.closed) throw Error('connection-channels-cancelled');
    const serverUrl = normalizeRelayAddress(input.serverUrl);
    const token = typeof input.token === 'string' ? input.token : serverUrl === this.saved.relay?.serverUrl ? this.saved.relay.token : '';
    const config = { serverUrl, token };
    const current = this.entries.get('relay');
    if (current?.state === 'ready' && current.config.serverUrl === serverUrl && current.config.token === token) {
      const pending = this.pending.get('relay'); if (pending) this.disposeCandidate(pending);
      current.transport.pauseReconnect?.(false); this.cancelRetry('relay', true); return this.summary();
    }
    const candidate = this.candidate('relay', config, 'configure');
    candidate.finished = new Promise(resolve => { candidate.finish = resolve; });
    try {
      if (current?.config.serverUrl === serverUrl) current.transport.pauseReconnect?.(true);
      const origin = await candidate.transport.start();
      this.check(candidate);
      candidate.channels = [{ id: 'relay', kind: 'relay', url: channelOrigin(origin, 'relay'), label: 'Relay' }];
      await this.verifyEntry(candidate, origin);
      this.check(candidate);
      candidate.stage = 'committing';
      await this.commit(saved => {
        this.check(candidate);
        const enabledChannels = saved.relay ? saved.enabledChannels : [...saved.enabledChannels, 'relay'];
        return { ...saved, enabledChannels: this.enabledKinds(enabledChannels, true), relay: config };
      });
      this.check(candidate);
      if (this.saved.enabledChannels.includes('relay')) this.promote(candidate, 'ready');
      else { this.pending.delete('relay'); await this.closeEntry(candidate); }
      this.publish(); return this.summary();
    } catch (error) {
      this.disposeCandidate(candidate);
      const newer = this.pending.get('relay');
      if (this.entries.get('relay') === current && (!newer || newer.config.serverUrl !== current?.config.serverUrl)) current?.transport.pauseReconnect?.(false);
      if (!this.entries.has('relay')) this.states.set('relay', 'unavailable');
      this.publish(); throw error;
    } finally { candidate.finish?.(); }
  }

  reconcile() {
    for (const kind of /** @type {Kind[]} */ (CHANNEL_KINDS)) {
      // 保存尚未启用的 Relay 配置是独立操作；其他通道的勾选不能误取消这次校验。
      if (!this.saved.enabledChannels.includes(kind)) { if (this.pending.get(kind)?.purpose !== 'configure') this.stopKind(kind); }
      else if (!this.entries.has(kind) && !this.pending.has(kind)) {
        const config = kind === 'relay' ? this.saved.relay : {};
        try {
          const candidate = this.candidate(kind, config);
          // 各入口自行完成启动；一个公网 DNS/握手失败不能串行阻塞本地或另一个公网入口。
          void this.startCandidate(candidate).catch(() => {});
        } catch { this.states.set(kind, 'unavailable'); this.scheduleRetry(kind); }
      }
    }
    this.publish();
  }

  /** Refresh only the running owned LAN resource; network changes never restart
   * the account, daemon or public transport resources. */
  refreshLocal() {
    if (this.localRefresh) return this.localRefresh;
    const refreshing = (async () => {
      if (this.closed || !this.initialized || !this.saved.enabledChannels.includes('local')) return false;
      const entry = this.entries.get('local');
      if (!entry) {
        if (this.pending.has('local')) return false;
        const candidate = this.candidate('local', {});
        await this.startCandidate(candidate);
        return this.entries.get('local') === candidate;
      }
      if (typeof entry.transport?.refresh !== 'function') return false;
      const refreshed = await entry.transport.refresh(entry.cancel.signal);
      if (this.closed || entry.cancel.signal.aborted || this.entries.get('local') !== entry || !this.saved.enabledChannels.includes('local')) return false;
      const channels = this.localChannels(refreshed.channels, true);
      const state = channels.length ? 'ready' : 'unavailable';
      if (JSON.stringify(entry.channels) === JSON.stringify(channels) && entry.state === state) return false;
      entry.channels = channels; entry.state = state; entry.confirmed = false; entry.verification++;
      this.publish(); return true;
    })().finally(() => { if (this.localRefresh === refreshing) this.localRefresh = null; });
    this.localRefresh = refreshing; return refreshing;
  }

  /** @param {unknown} value @param {boolean} [allowEmpty] */
  localChannels(value, allowEmpty = false) {
    if (allowEmpty && Array.isArray(value) && value.length === 0) return [];
    const channels = channelList(value);
    if (channels.length > 6 || channels.some(row => row.kind !== 'local' || ['cloudflare', 'relay'].includes(row.id) || !isPrivateHost(new URL(row.url).hostname)
      || ['localhost', '127.0.0.1', '[::1]'].includes(new URL(row.url).hostname))) throw Error('invalid-private-LAN-channel');
    return channels;
  }

  /** @param {Kind} kind @param {Value} config @param {string} [purpose] */
  candidate(kind, config, purpose = 'startup') {
    this.cancelRetry(kind, purpose === 'configure');
    const old = this.pending.get(kind); if (old) this.disposeCandidate(old);
    const generation = (this.generations.get(kind) ?? 0) + 1; this.generations.set(kind, generation);
    const entry = /** @type {Value} */ ({ kind, generation, config, purpose, state: 'starting', stage: 'connecting', confirmed: false, verification: 0, disconnected: false, channels: /** @type {Channel[]} */ ([]),
      cancel: new AbortController(), transport: /** @type {Value|null} */ (null) });
    if (kind !== 'local') entry.transport = this.options.transportFactory?.({ ...config, kind, mode: kind, upstream: this.options.upstreamFor(kind) }, /** @type {Uint8Array} */ (this.seed))
      ?? (kind === 'relay' ? new RelayTunnelClient({ serverUrl: config.serverUrl, token: config.token, seed: /** @type {Uint8Array} */ (this.seed), upstream: this.options.upstreamFor(kind) })
        : new CloudflareAccess({ binary: this.options.cloudflared, upstream: this.options.upstreamFor(kind), state: this.options.state }));
    this.pending.set(kind, entry); this.states.set(kind, 'starting'); this.attachLifecycle(entry); this.publish(); return entry;
  }

  /** @param {Value} candidate */
  check(candidate) {
    if (this.closed || candidate.cancel.signal.aborted || this.generations.get(candidate.kind) !== candidate.generation
      || this.pending.get(candidate.kind) !== candidate) throw Error('connection-channels-cancelled');
    if (candidate.disconnected) throw Error('connection-channel-unavailable');
  }

  /** @param {Value} entry */
  async startCandidate(entry) {
    try {
      if (entry.kind === 'local') {
        const local = await this.options.startLocal(entry.cancel.signal); entry.transport = local; this.attachLifecycle(entry);
        this.check(entry);
        const channels = this.localChannels(local.channels);
        entry.channels = channels; this.promote(entry, 'ready'); return;
      }
      const origin = await entry.transport.start(); this.check(entry);
      entry.channels = [{ id: entry.kind, kind: entry.kind, url: channelOrigin(origin, entry.kind), label: this.label(entry.kind) }];
      if (entry.kind === 'cloudflare') this.promote(entry, 'unverified');
      const verification = entry.verification;
      try {
        await this.verifyEntry(entry, origin);
        if (entry.kind === 'cloudflare') { if (this.entries.get(entry.kind) === entry && !entry.cancel.signal.aborted && entry.verification === verification) { entry.state = 'ready'; this.cancelRetry(entry.kind, true); this.publish(); } }
        else { this.check(entry); this.promote(entry, 'ready'); }
      } catch (error) {
        // 进程已给出地址但本机 DNS/探针不可达时保留候选，状态必须是未验证，手机可另行证明同一 Mac。
        if (entry.kind === 'cloudflare' && this.entries.get(entry.kind) === entry && !entry.cancel.signal.aborted) {
          if (!entry.confirmed && entry.verification === verification) entry.state = 'unverified'; this.publish(); return;
        }
        throw error;
      }
    } catch {
      this.disposeCandidate(entry);
      if (!this.closed && this.saved.enabledChannels.includes(entry.kind) && !this.entries.has(entry.kind)
        && this.generations.get(entry.kind) === entry.generation) { this.states.set(entry.kind, 'unavailable'); this.publish(); this.scheduleRetry(entry.kind); }
    }
  }

  /** @param {Value} entry @param {string} state */
  promote(entry, state) {
    this.check(entry);
    const previous = this.entries.get(entry.kind);
    this.pending.delete(entry.kind); this.entries.set(entry.kind, entry); this.states.delete(entry.kind); entry.state = state;
    if (state === 'ready') this.cancelRetry(entry.kind, true);
    entry.transport?.activate?.();
    if (previous && previous !== entry) { previous.cancel.abort(); void this.closeEntry(previous); }
    this.publish();
  }

  /** @param {Value} entry */
  attachLifecycle(entry) {
    if (entry.kind === 'local') {
      entry.transport?.on?.('channels', (/** @type {unknown} */ channels) => {
        if (this.closed || entry.cancel.signal.aborted || this.entries.get('local') !== entry || !this.saved.enabledChannels.includes('local')) return;
        try { entry.channels = this.localChannels(channels, true); }
        catch { entry.channels = []; }
        entry.confirmed = false; entry.verification++; entry.state = entry.channels.length ? 'ready' : 'unavailable'; this.publish();
      });
      return;
    }
    entry.transport?.on?.('disconnected', () => {
      entry.probeCancel?.abort();
      entry.disconnected = true; entry.verification++;
      if (this.closed || this.entries.get(entry.kind) !== entry) return;
      if (entry.kind === 'cloudflare') {
        // CloudflareAccess has no reconnect loop after its owned process exits.
        // Retire its dead address before scheduling another isolated transport.
        this.entries.delete(entry.kind); entry.cancel.abort(); void this.closeEntry(entry);
        this.states.set(entry.kind, 'unavailable'); this.publish(); this.scheduleRetry(entry.kind); return;
      }
      entry.confirmed = false; entry.state = entry.kind === 'relay' ? 'reconnecting' : 'unavailable'; this.publish();
    });
    entry.transport?.on?.('connected', () => {
      entry.disconnected = false;
      if (this.closed || this.entries.get(entry.kind) !== entry || !entry.channels.length) return;
      const verification = ++entry.verification;
      entry.confirmed = false; entry.state = 'unverified'; this.publish();
      void this.verifyEntry(entry, entry.channels[0].url).then(() => {
        // 连接再次断开后，上一代只读探针的迟到成功不能把入口伪造为 ready。
        if (!this.closed && this.entries.get(entry.kind) === entry && !entry.cancel.signal.aborted && entry.verification === verification) { entry.state = 'ready'; this.cancelRetry(entry.kind, true); this.publish(); }
      }, () => {});
    });
  }

  /** Keep only the current read-only proof and contain synchronous factory errors.
   * @param {Value} entry @param {string} origin */
  verifyEntry(entry, origin) {
    entry.probeCancel?.abort();
    const cancel = new AbortController(); entry.probeCancel = cancel;
    const signal = AbortSignal.any([entry.cancel.signal, cancel.signal]);
    return Promise.resolve().then(() => {
      if (signal.aborted) throw Error('connection-proof-cancelled');
      return this.options.probesFor(entry.kind).verify(origin, signal);
    }).finally(() => { if (entry.probeCancel === cancel) entry.probeCancel = null; });
  }

  /** @param {Value|null|undefined} transport */
  closeResource(transport) {
    const closing = Promise.resolve().then(() => transport?.close()).then(() => undefined, () => undefined);
    this.closingResources.add(closing); void closing.then(() => this.closingResources.delete(closing)); return closing;
  }

  /** @param {Value} entry */
  closeEntry(entry) {
    entry.probeCancel?.abort();
    if (!entry.transport || entry.closedTransport === entry.transport) return Promise.resolve();
    entry.closedTransport = entry.transport; return this.closeResource(entry.transport);
  }

  /** @param {Value} entry */
  disposeCandidate(entry) {
    entry.cancel.abort();
    if (this.pending.get(entry.kind) === entry) this.pending.delete(entry.kind);
    void this.closeEntry(entry);
  }

  /** Recovery owns transports only; no forwarded stream or native operation is retained.
   * @param {Kind} kind */
  scheduleRetry(kind) {
    if (this.closed || !this.saved.enabledChannels.includes(kind) || this.entries.has(kind) || this.pending.has(kind) || this.retryTimers.has(kind)) return;
    const delay = this.retryDelays.get(kind) ?? this.retryInitialMs;
    this.retryDelays.set(kind, Math.min(delay * 2, this.retryMaxMs));
    const timer = setTimeout(() => {
      this.retryTimers.delete(kind);
      if (this.closed || !this.saved.enabledChannels.includes(kind) || this.entries.has(kind) || this.pending.has(kind)) return;
      try { void this.startCandidate(this.candidate(kind, kind === 'relay' ? this.saved.relay : {})).catch(() => {}); }
      catch { this.states.set(kind, 'unavailable'); this.publish(); this.scheduleRetry(kind); }
    }, delay);
    timer.unref(); this.retryTimers.set(kind, timer);
  }

  /** @param {Kind} kind @param {boolean} [reset] */
  cancelRetry(kind, reset = false) {
    const timer = this.retryTimers.get(kind); if (timer) clearTimeout(timer);
    this.retryTimers.delete(kind); if (reset) this.retryDelays.delete(kind);
  }

  /** @param {Kind} kind */
  stopKind(kind) {
    this.cancelRetry(kind, true);
    this.generations.set(kind, (this.generations.get(kind) ?? 0) + 1);
    const pending = this.pending.get(kind); if (pending) this.disposeCandidate(pending);
    const entry = this.entries.get(kind);
    if (entry) { this.entries.delete(kind); entry.cancel.abort(); void this.closeEntry(entry); }
    this.states.delete(kind);
  }

  close() {
    if (this.closing) return this.closing; this.closed = true;
    for (const kind of /** @type {Kind[]} */ (CHANNEL_KINDS)) this.stopKind(kind);
    this.closing = (async () => {
      await this.localRefresh?.catch(() => {});
      await this.writes.catch(() => {}); await Promise.allSettled([...this.closingResources]); this.seed?.fill(0);
    })();
    return this.closing;
  }
}
