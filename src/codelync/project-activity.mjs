import { randomUUID } from 'node:crypto';
import { CodexActivityObserver } from '../adapters/codex-activity.mjs';
import { CodexIpcAdapter } from '../adapters/codex-ipc.mjs';
import { AntigravityBackend, AntigravityActivityObserver } from '../adapters/antigravity-backend.mjs';
import { ClaudeActivityObserver } from '../adapters/claude-activity.mjs';
import { BridgeError } from '../errors.mjs';
import { isCodelyncNativeSource } from './source-scope.mjs';
import { sourceCatalogVisible } from './source-catalog-scope.mjs';

/** @typedef {Record<string, any>} Value */
/** @typedef {{id:string,nativeId:string|null}} SessionRow */
/** @typedef {{id:string,projectKey:string,hostId:string,app?:string,sessions?:SessionRow[]}} Group */
/** @typedef {{requestSeq:number,fingerprint:string,groups:Group[],expiresAt:number,retainUntil:number}} Interest */
/** @typedef {{source:Value,observer:Value,starting:boolean,queued:boolean,closed:boolean,forceRefresh?:boolean,requestedDeadline?:number,visible?:boolean,lastAttempt?:number,retryAt?:number}} Entry */
const MAX_CLIENTS = 256;
const TOMBSTONE_MS = 120000;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_SESSION_ROWS = 64;
const APPS = ['codex', 'antigravity', 'claude-desktop'];

/** @param {unknown} value @param {number} limit */
function validString(value, limit) { return typeof value === 'string' && !!value.trim() && value.length <= limit; }
/** Legacy local session records preserve their native fallback; explicit other modes do not.
 * @param {Value} source */
function nativeSession(source) {
  // 多处显式 mode 必须分别满足 native 边界；null 或别处的 session 不能掩盖不支持的元数据。
  return isCodelyncNativeSource(source, source) && isCodelyncNativeSource(source, source.metadata) && (source.kind === undefined || source.kind === 'session') &&
    typeof source.id === 'string' && !!source.id && source.id.length <= 512 && source.available !== false && source.removed !== true && source.archived !== true;
}
/** @param {Value} source */
function nativeSource(source) { return nativeSession(source) && source.isSubagent !== true && source.metadata?.nativeSession?.isSubagent !== true; }
/** @param {Value} source */
function key(source) { return JSON.stringify([source.app ?? 'codex', source.hostId ?? 'local', source.id]); }
/** @param {Value} source @param {Group} group */
function member(source, group) {
  return (source.app ?? 'codex') === (group.app ?? 'codex') && (source.hostId ?? 'local') === group.hostId && (source.project?.key || source.workspace || '/') === group.projectKey;
}
/** @param {Value|undefined} source @param {Group} group @param {SessionRow} row */
function rowMember(source, group, row) { return !!source && row.nativeId !== null && source.id === row.nativeId && source.relayId === row.id && member(source, group); }
/** Directory time only chooses bounded observation targets, never runtime state.
 * @param {Value} source */
function directoryTime(source) {
  const value = source.updatedAt;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Shared, foreground interest owner. Poll never waits for native discovery or history.
 * @param {unknown} value @returns {Group[]} */
function parseGroups(value) {
  if (!Array.isArray(value) || value.length > 16) throw new BridgeError('invalid-activity-interest', 'At most sixteen project descriptors are allowed.');
  const ids = new Set();
  let rowCount = 0;
  const groups = value.map(group => {
    if (!group || !validString(group.id, 8192) || !validString(group.projectKey, 4096) || !validString(group.hostId, 256) || ids.has(group.id)) throw new BridgeError('invalid-activity-interest', 'Project activity needs unique UI IDs and explicit project/host identities.');
    if (group.app !== undefined && !['codex', 'antigravity', 'claude-desktop'].includes(group.app)) throw new BridgeError('invalid-activity-interest', 'A supported source application is required.');
    ids.add(group.id);
    /** @type {SessionRow[]|undefined} */ let sessions;
    if (group.sessions !== undefined) {
      if (!Array.isArray(group.sessions) || (rowCount += group.sessions.length) > MAX_SESSION_ROWS) throw new BridgeError('invalid-activity-interest', 'At most sixty-four visible session rows are allowed per poll.');
      const rowIds = new Set();
      sessions = group.sessions.map((/** @type {Value} */ row) => {
        if (!row || !validString(row.id, 8192) || rowIds.has(row.id)) throw new BridgeError('invalid-activity-interest', 'Visible session rows need unique phone IDs.');
        rowIds.add(row.id);
        // 缺失或非法 nativeId 只能得到此 phone ID 的 unknown，不能退回任意已绑定会话。
        return { id: row.id, nativeId: validString(row.nativeId, 512) ? row.nativeId : null };
      });
    }
    return { id: group.id, projectKey: group.projectKey, hostId: group.hostId, ...(group.app === undefined ? {} : { app: group.app }), ...(sessions === undefined ? {} : { sessions }) };
  });
  return groups;
}

export class NativeProjectActivityService {
  /** @param {{sources:()=>Value[],inventoryAvailable:(app?:string)=>boolean,ownedAvailable?:()=>boolean,observedSources?:()=>Value[],observerFactory?:(options:Value)=>Value,ipcFactory?:(hostId:string)=>Value,nativeAdapter?:(source:Value)=>Value,now?:()=>number,leaseMs?:number,maxSources?:number,concurrency?:number,backgroundSources?:number,intrinsicRefreshMs?:number,epoch?:string}} options */
  constructor(options) {
    if (!options || typeof options.sources !== 'function' || typeof options.inventoryAvailable !== 'function') throw new BridgeError('invalid-activity-service', 'A native source inventory is required.');
    this.sources = options.sources; this.inventoryAvailable = options.inventoryAvailable;
    this.ownedAvailable = options.ownedAvailable ?? (() => true);
    this.observedSources = options.observedSources ?? (() => []);
    this.now = options.now ?? Date.now; this.leaseMs = options.leaseMs ?? 30000;
    this.maxSources = options.maxSources ?? 128; this.concurrency = options.concurrency ?? 4;
    this.backgroundSources = options.backgroundSources ?? 16; this.intrinsicRefreshMs = options.intrinsicRefreshMs ?? 5000;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1 || this.leaseMs > 30000 || !Number.isSafeInteger(this.maxSources) || this.maxSources < 1 || this.maxSources > 128 || !Number.isSafeInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 4) throw new BridgeError('invalid-activity-limit', 'Activity leases, observer count and concurrency must fit their bounds.');
    if (!Number.isSafeInteger(this.backgroundSources) || this.backgroundSources < 0 || this.backgroundSources > this.maxSources ||
      !Number.isSafeInteger(this.intrinsicRefreshMs) || this.intrinsicRefreshMs < 1000 || this.intrinsicRefreshMs > 60000) throw new BridgeError('invalid-activity-limit', 'Mac activity maintenance must fit its observer and timer bounds.');
    this.antigravity = options.nativeAdapter ? null : new AntigravityBackend();
    this.nativeAdapter = options.nativeAdapter ?? (() => /** @type {AntigravityBackend} */ (this.antigravity));
    this.observerFactory = options.observerFactory ?? (options => options.app === 'antigravity' ? new AntigravityActivityObserver(/** @type {any} */ (options))
      : options.app === 'claude-desktop' ? new ClaudeActivityObserver(/** @type {any} */ (options)) : new CodexActivityObserver(/** @type {any} */ (options)));
    this.ipcFactory = options.ipcFactory ?? (hostId => new CodexIpcAdapter({ hostId }));
    this.borrowNativeIpc = !options.ipcFactory && !!options.nativeAdapter;
    this.epoch = options.epoch ?? randomUUID(); this.sequence = 0; this.closed = false;
    this.interests = /** @type {Map<string,Interest>} */ (new Map());
    this.entries = /** @type {Map<string,Entry>} */ (new Map());
    this.ipcs = /** @type {Map<string,Value>} */ (new Map());
    this.borrowedIpcHosts = /** @type {Set<string>} */ (new Set());
    this.inFlight = 0; this.attemptOrder = 0; this.scheduled = false;
    this.timer = /** @type {ReturnType<typeof setTimeout>|null} */ (null);
    this.intrinsicTimer = /** @type {ReturnType<typeof setInterval>|null} */ (null);
    this.intrinsicIdentities = /** @type {Set<string>} */ (new Set());
    this.observedIdentities = /** @type {Set<string>} */ (new Set());
  }
  /** Mac-owned maintenance; no phone lease or native read is awaited. */
  intrinsicRefresh() {
    if (this.closed) return;
    const now = this.now(); this.expire(now); this.reconcile(this.inventory(), now);
    if ((this.backgroundSources || this.observedIdentities.size) && !this.intrinsicTimer) {
      this.intrinsicTimer = setInterval(() => this.intrinsicRefresh(), this.intrinsicRefreshMs);
      this.intrinsicTimer.unref();
    }
    this.queueUnknown(); this.schedule(); this.armTimer(now);
  }
  /** Reserve ordering synchronously, including releases, before any outside asynchronous scope check.
   * @param {{clientId:string,requestSeq:number,groups:Group[]}} request */
  poll(request) {
    if (this.closed) throw new BridgeError('activity-service-closed', 'Project activity is unavailable.', 503);
    if (!request || !validString(request.clientId, 256) || !Number.isSafeInteger(request.requestSeq) || request.requestSeq < 0) throw new BridgeError('invalid-activity-interest', 'A stable client identity and monotonic request sequence are required.');
    const groups = parseGroups(request.groups), now = this.now();
    if (Buffer.byteLength(JSON.stringify({ clientId: request.clientId, requestSeq: request.requestSeq, groups }), 'utf8') > MAX_REQUEST_BYTES) throw new BridgeError('invalid-activity-interest', 'Project activity descriptors exceeded their size budget.');
    this.expire(now);
    const fingerprint = JSON.stringify(groups), previous = this.interests.get(request.clientId);
    if (previous && request.requestSeq < previous.requestSeq) throw new BridgeError('stale-activity-interest', 'A newer foreground interest has already been received.', 409);
    if (previous && request.requestSeq === previous.requestSeq) {
      if (fingerprint !== previous.fingerprint) throw new BridgeError('activity-interest-conflict', 'An activity request sequence cannot be reused for another interest.', 409);
      // 同序号重试不延长旧 lease，更不能使已释放或过期的兴趣重新出现。
    } else {
      if (!previous && this.interests.size >= MAX_CLIENTS) throw new BridgeError('activity-interest-limit', 'The bounded activity client registry is full.', 503);
      this.interests.set(request.clientId, { requestSeq: request.requestSeq, fingerprint, groups, expiresAt: groups.length ? now + this.leaseMs : now,
        retainUntil: now + (groups.length ? this.leaseMs : 0) + TOMBSTONE_MS });
    }
    const inventory = this.inventory();
    this.reconcile(inventory, now);
    this.queueUnknown();
    const summaries = groups.map(group => this.summary(group, inventory, now));
    this.schedule(); this.armTimer(now);
    return { ok: true, version: 1, epoch: this.epoch, sequence: ++this.sequence, observedAt: now, groups: summaries };
  }
  inventory() {
    let available = false;
    /** @type {Value[]} */ let sources = [];
    /** @type {Value[]} */ let sessionSources = [];
    try {
      available = this.inventoryAvailable() === true;
      const current = this.sources();
      if (!Array.isArray(current)) available = false;
      else {
        const distinct = new Map();
        for (const source of current) if (source && nativeSession(source)) distinct.set(key(source), source);
        sessionSources = [...distinct.values()]; sources = sessionSources.filter(nativeSource);
      }
    } catch { available = false; }
    return { available, sources, sessionSources };
  }
  ownerAvailable() { try { return this.ownedAvailable() === true; } catch { return false; } }
  /** Find the latest valid inventory descriptor matching `source` without rebuilding the full catalog inventory.
   * @param {Value} source @returns {Value|null} */
  currentSource(source) {
    let raw;
    try { raw = this.sources(); } catch { return null; }
    if (!Array.isArray(raw)) return null;
    const targetApp = source.app ?? 'codex', targetHost = source.hostId ?? 'local', targetId = source.id;
    for (let index = raw.length - 1; index >= 0; index -= 1) {
      const candidate = raw[index];
      if (candidate && (candidate.app ?? 'codex') === targetApp && (candidate.hostId ?? 'local') === targetHost
        && candidate.id === targetId && nativeSession(candidate)) return candidate;
    }
    return null;
  }
  /** Read an already admitted same-source replica; never schedule a native read.
   * @param {Value|undefined} source @returns {Value|null} */
  cachedSourceStatus(source) {
    if (this.closed || !this.ownerAvailable() || !source || !nativeSession(source) || !sourceCatalogVisible(source, source.metadata)
      || !this.inventoryAvailable(source.app ?? 'codex')) return null;
    const identity = key(source), entry = this.entries.get(identity);
    if (!entry || entry.closed) return null;
    const current = this.currentSource(source);
    if (!current || !sourceCatalogVisible(current, current.metadata) || ['protocol', 'runtimeGeneration', 'appMode', 'nativeCollection'].some(field => current[field] !== source[field])) return null;
    try {
      const status = entry.observer.status(), known = status?.known === true;
      return { sameSource: true, known, active: known && status.active === true, waiting: known && status.waiting === true,
        status: known ? 'ready' : status?.status ?? 'unavailable' };
    } catch { return null; }
  }
  /** Existing message actors contribute status interests, never the reverse.
   * @param {{available:boolean,sources:Value[],sessionSources?:Value[]}} inventory */
  observedSelection(inventory) {
    const selected = /** @type {Map<string,Value>} */ (new Map());
    if (!this.ownerAvailable()) return selected;
    let observed; try { observed = this.observedSources(); } catch { return selected; }
    if (!Array.isArray(observed)) return selected;
    const current = new Map((inventory.sessionSources ?? inventory.sources).map(source => [key(source), source]));
    for (const source of observed) {
      if (!source || !nativeSession(source)) continue;
      const identity = key(source), value = current.get(identity);
      if (!value || ['protocol', 'runtimeGeneration', 'appMode', 'nativeCollection'].some(field => value[field] !== source[field])) continue;
      if (!this.inventoryAvailable(value.app ?? 'codex') && !(this.observedIdentities.has(identity) && this.entries.has(identity))) continue;
      if (selected.size < 16) selected.set(identity, value);
    }
    return selected;
  }
  /** @param {{available:boolean,sources:Value[]}} inventory */
  intrinsicSelection(inventory) {
    const selected = /** @type {Map<string,Value>} */ (new Map());
    if (!this.backgroundSources || !this.ownerAvailable()) return selected;
    const ranked = inventory.sources.filter(source => this.inventoryAvailable(source.app ?? 'codex') ||
      this.intrinsicIdentities.has(key(source)) && this.entries.has(key(source)))
      .sort((a, b) => directoryTime(b) - directoryTime(a) || key(a).localeCompare(key(b)));
    for (const app of APPS) {
      const source = ranked.find(source => (source.app ?? 'codex') === app);
      if (source && selected.size < this.backgroundSources) selected.set(key(source), source);
    }
    for (const source of ranked) if (selected.size < this.backgroundSources) selected.set(key(source), source);
    return selected;
  }
  queueUnknown() {
    if (!this.ownerAvailable()) return;
    for (const entry of this.entries.values()) {
      // A failed index can retain an existing subscriber, but cannot start a new native read.
      if (!this.inventoryAvailable(entry.source.app ?? 'codex')) continue;
      try { if (!entry.starting && !entry.observer.status().known && this.now() >= (entry.retryAt ?? 0) && this.observerNeedsRefresh(entry)) entry.queued = true; } catch { /* Unknown stays unknown. */ }
    }
  }
  /** @param {number} now */
  expire(now) {
    for (const [client, interest] of this.interests) {
      if (interest.expiresAt <= now) interest.groups = [];
      if (interest.retainUntil <= now) this.interests.delete(client);
    }
  }
  /** @param {{available:boolean,sources:Value[],sessionSources?:Value[]}} inventory @param {number} now */
  reconcile(inventory, now) {
    const groups = [...this.interests.values()].filter(interest => interest.expiresAt > now).flatMap(interest => interest.groups);
    const desired = new Map(), visibleIdentities = new Set();
    const intrinsic = this.intrinsicSelection(inventory);
    const observed = this.observedSelection(inventory);
    if (this.ownerAvailable() && (inventory.available || inventory.sources.some(source => this.inventoryAvailable(source.app ?? 'codex')))) {
      const indexed = new Map(inventory.sources.map(source => [key(source), source]));
      // 可见行先分配全机共享预算；native/relay/project/host 四项都命中才能获得优先级。
      for (const group of groups) for (const row of group.sessions ?? []) {
        const source = row.nativeId === null ? undefined : indexed.get(key({ app: group.app ?? 'codex', id: row.nativeId, hostId: group.hostId }));
        if (this.inventoryAvailable(group.app ?? 'codex') && rowMember(source, group, row) && desired.size < this.maxSources) { const identity = key(/** @type {Value} */ (source)); desired.set(identity, source); visibleIdentities.add(identity); }
      }
      for (const [identity, source] of observed) if (desired.size < this.maxSources) desired.set(identity, source);
      // Visible phone rows remain first; preserve one admitted source per app before project fill.
      for (const source of intrinsic.values()) if (!([...desired.values()].some(value => (value.app ?? 'codex') === (source.app ?? 'codex'))) && desired.size < this.maxSources) desired.set(key(source), source);
      for (const source of inventory.sources) {
        if (this.inventoryAvailable(source.app ?? 'codex') && groups.some(group => member(source, group)) && desired.size < this.maxSources) desired.set(key(source), source);
      }
    }
    for (const [identity, source] of observed) if (desired.size < this.maxSources) desired.set(identity, source);
    for (const [identity, source] of intrinsic) if (desired.size < this.maxSources) desired.set(identity, source);
    this.intrinsicIdentities = new Set([...intrinsic.keys()].filter(identity => desired.has(identity)));
    this.observedIdentities = new Set([...observed.keys()].filter(identity => desired.has(identity)));
    for (const [identity, entry] of this.entries) if (!desired.has(identity)) {
      entry.closed = true; entry.observer.close(); this.entries.delete(identity);
    }
    for (const [identity, source] of desired) if (!this.entries.has(identity)) {
      const hostId = source.hostId ?? 'local';
      let ipc;
      if ((source.app ?? 'codex') === 'codex') {
        ipc = this.ipcs.get(hostId);
        if (!ipc) {
          if (this.borrowNativeIpc) {
            try {
              const shared = /** @type {Value} */ (this.nativeAdapter(source))?.ipc;
              if (shared?.hostId === hostId && typeof shared.subscribe === 'function' && typeof shared.generation === 'function') { ipc = shared; this.borrowedIpcHosts.add(hostId); }
            } catch { /* A missing shared IPC keeps the existing bounded fallback. */ }
          }
          ipc ??= this.ipcFactory(hostId); this.ipcs.set(hostId, ipc);
        }
      }
      try {
        const observer = this.observerFactory({ id: source.id, hostId, app: source.app ?? 'codex', ipc, ...(['antigravity', 'claude-desktop'].includes(source.app) ? { backend: this.nativeAdapter(source), expectedHostId: hostId } : {}), now: this.now, requestRefresh: () => this.queueRefresh(identity), onChange: () => {
          const current = this.entries.get(identity);
          if (current && !current.closed && current.observer.observationReady?.() === true) current.retryAt = 0;
        } });
        this.entries.set(identity, { source: { app: source.app ?? 'codex', id: source.id, hostId }, observer, starting: false, queued: true, closed: false });
      } catch { /* 不支持的源保留在 total/unknown，不伪装成 idle。 */ }
    }
    // 同时按可见优先顺序启动；已有冷任务不能把新滚入屏幕的行一直排在队尾。
    const ordered = /** @type {Map<string,Entry>} */ (new Map());
    for (const identity of desired.keys()) { const entry = this.entries.get(identity); if (entry) { entry.visible = visibleIdentities.has(identity); ordered.set(identity, entry); } }
    this.entries = ordered;
    const hosts = new Set([...this.entries.values()].map(entry => entry.source.hostId ?? 'local'));
    for (const [hostId, ipc] of this.ipcs) if (!hosts.has(hostId)) { if (!this.borrowedIpcHosts.delete(hostId)) ipc.dispose?.(); this.ipcs.delete(hostId); }
  }
  /** @param {Group} group @param {{available:boolean,sources:Value[]}} inventory @param {number} _now */
  summary(group, inventory, _now) {
    const inventoryAvailable = this.ownerAvailable() && this.inventoryAvailable(group.app ?? 'codex');
    const members = [...new Map(inventory.sources.filter(source => member(source, group)).map(source => [key(source), source])).values()];
    const byNativeId = new Map(members.map(source => [source.id, source]));
    const states = /** @type {Map<string,Value|null>} */ (new Map());
    let active = 0, waiting = 0, unknown = 0, refreshing = false;
    for (const source of members) {
      const entry = this.entries.get(key(source));
      let status;
      try { status = inventoryAvailable && entry && !entry.closed ? entry.observer.status() : null; } catch { status = null; }
      states.set(source.id, status);
      if (!status?.known) { unknown++; refreshing ||= status?.status === 'refreshing' || !!entry?.queued || !!entry?.starting; }
      else { if (status.active === true) active++; if (status.waiting === true) waiting++; }
    }
    return { id: group.id, total: members.length, active, waiting, unknown,
      status: !inventoryAvailable ? 'unavailable' : unknown ? refreshing ? 'refreshing' : 'unavailable' : 'ready',
      ...(group.sessions === undefined ? {} : { sessions: group.sessions.map(row => {
        const source = row.nativeId === null ? undefined : byNativeId.get(row.nativeId);
        const state = inventoryAvailable && rowMember(source, group, row) ? states.get(/** @type {string} */ (row.nativeId)) : null;
        const known = state?.known === true;
        return { id: row.id, known, active: known && state?.active === true, waiting: known && state?.waiting === true };
      }) }) };
  }
  schedule() {
    if (this.closed || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.pump(); });
  }
  /** Native gaps share the same concurrency bound as initial reads.
   * @param {string} identity */
  queueRefresh(identity) {
    const entry = this.entries.get(identity);
    if (this.closed || !entry || entry.closed || entry.starting) return;
    entry.queued = true; this.schedule();
  }
  pump() {
    if (this.closed) return;
    const now = this.now();
    this.expire(now);
    // 后台 completion 只检查当前兴趣，不能从旧任务捕获的 sources 重建已释放兴趣。
    this.reconcile(this.inventory(), now);
    for (const entry of this.entries.values()) {
      const due = this.refreshDeadline(entry);
      if (!entry.starting && due !== null && due <= now) { entry.queued = true; entry.forceRefresh = true; }
    }
    const candidates = [...this.entries.values()].sort((a, b) => Number(b.visible === true) - Number(a.visible === true)
      || Number(b.forceRefresh === true) - Number(a.forceRefresh === true) || (a.lastAttempt ?? 0) - (b.lastAttempt ?? 0));
    for (const entry of candidates) {
      const due = this.refreshDeadline(entry);
      if (this.inFlight >= this.concurrency) break;
      if (entry.closed || entry.starting || !entry.queued || now < (entry.retryAt ?? 0)) continue;
      if (!this.ownerAvailable() || !this.inventoryAvailable(entry.source.app ?? 'codex')) continue;
      let status;
      try { status = entry.observer.status(); } catch { continue; }
      if (!entry.forceRefresh && (status.known || !this.observerNeedsRefresh(entry))) { entry.queued = false; continue; }
      if (entry.forceRefresh && due !== null) entry.requestedDeadline = due;
      entry.starting = true; entry.queued = false; entry.forceRefresh = false; entry.lastAttempt = ++this.attemptOrder; this.inFlight++;
      Promise.resolve().then(() => entry.closed ? undefined : entry.observer.refresh()).catch(() => {}).finally(() => {
        entry.starting = false; this.inFlight--;
        if (!entry.closed && typeof entry.observer.needsRefresh === 'function' && this.observerNeedsRefresh(entry)) entry.retryAt = this.now() + 5000;
        else entry.retryAt = 0;
        if (!this.closed) this.schedule();
      });
    }
    this.armTimer(now);
  }
  /** A healthy push baseline can have honestly unknown aggregate coverage.
   * @param {Entry} entry */
  observerNeedsRefresh(entry) {
    if (typeof entry.observer.needsRefresh !== 'function') return true;
    try { return entry.observer.needsRefresh() !== false; } catch { return true; }
  }
  /** @param {Entry} entry @returns {number|null} */
  refreshDeadline(entry) {
    if (entry.closed || entry.starting || typeof entry.observer.refreshDueAt !== 'function') return null;
    try { const at = entry.observer.refreshDueAt(); return Number.isFinite(at) && at >= 0 && at !== entry.requestedDeadline ? at : null; } catch { return null; }
  }
  /** @param {number} now */
  armTimer(now) {
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    if (this.closed) return;
    const deadlines = [...this.interests.values()].map(interest => interest.groups.length ? interest.expiresAt : interest.retainUntil);
    for (const entry of this.entries.values()) {
      if (entry.queued && (entry.retryAt ?? 0) > now) deadlines.push(/** @type {number} */ (entry.retryAt));
      const at = this.refreshDeadline(entry);
      // Completion callbacks and next-poll triggers already wake blocked/overdue
      // entries; only genuine future deadlines should arm the background timer.
      if (at !== null && at > now) deadlines.push(at);
    }
    if (!deadlines.length) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, Math.max(1, Math.min(2147483647, Math.min(...deadlines) - now)));
    this.timer.unref();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    if (this.intrinsicTimer) clearInterval(this.intrinsicTimer); this.intrinsicTimer = null;
    this.intrinsicIdentities.clear();
    this.observedIdentities.clear();
    this.interests.clear();
    for (const entry of this.entries.values()) { entry.closed = true; entry.observer.close(); }
    this.entries.clear();
    for (const [hostId, ipc] of this.ipcs) if (!this.borrowedIpcHosts.has(hostId)) ipc.dispose?.();
    this.ipcs.clear();
    this.borrowedIpcHosts.clear();
    void this.antigravity?.dispose();
  }
}
