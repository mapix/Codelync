import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { writeDurablePrivateJson as writePrivateJson } from './discovery-persistence.mjs';
import { deriveContentKeyPair, encryptRecord, sealDataKey, unsealDataKey, decryptRecord } from './session-transport.mjs';
import { isCodelyncNativeSource } from './source-scope.mjs';
import { sourceArchived } from './source-catalog-scope.mjs';

/** @typedef {Record<string,any>} Value */
export const SOURCE_APPS = Object.freeze(['codex', 'zcode', 'claude-desktop', 'cursor', 'antigravity', 'windsurf', 'vscode', 'zed', 'trae', 'terminal', 'iterm', 'warp']);
/** @param {Value} source */
function projectMetadata(source) { return source.project ? { projectKey: source.project.key, projectPath: source.project.path, projectLabel: source.project.label } : {}; }
/** Stable source identity includes the host: equal filesystem paths are not identities. @param {Value} source */
export function sourceKey(source) {
  if (!SOURCE_APPS.includes(source.app) || typeof source.id !== 'string' || !source.id || typeof source.hostId !== 'string' || !source.hostId) throw Error('A verified application/source/host identity is required.');
  return createHash('sha256').update(JSON.stringify([source.app, source.hostId, source.id])).digest('hex');
}

export class SourceRegistry {
  /** @param {{directory:string,account:Value,fetch?:typeof fetch,allowDeferredSources?:boolean}} options */
  constructor(options) {
    this.directory = resolve(options.directory); this.account = options.account; this.fetch = options.fetch ?? fetch;
    this.allowDeferredSources = options.allowDeferredSources === true;
    this.flights = /** @type {Map<string,Promise<Value>>} */ (new Map());
    this.metadataFlights = /** @type {Map<string,Promise<void>>} */ (new Map());
  }
  /** @param {Value} source @param {unknown} [metadata] */
  assertScope(source, metadata) {
    if (!this.allowDeferredSources && !isCodelyncNativeSource(source, metadata)) throw Object.assign(Error('Only supported native desktop session sources are supported.'), { code: 'unsupported-source' });
  }
  fingerprint() { const key = Buffer.from(this.account.secret ?? '', 'base64url'); if (key.length !== 32) throw Error('The Codelync account key is invalid.'); return createHash('sha256').update(key).digest('hex'); }
  /** Read-only cold-start candidates; the caller confirms current machine ownership.
   * @returns {Promise<Value[]>} */
  async savedBindings() {
    let entries;
    try { entries = await readdir(this.directory, { withFileTypes: true }); }
    catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return []; throw error; }
    const files = entries.filter(entry => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name)).map(entry => entry.name).sort();
    const accountFingerprint = this.fingerprint(), bindings = /** @type {Value[]} */ ([]);
    // 冷启动只读已提交 binding；限制并发文件读取，原子写入留下的临时文件不参与恢复。
    for (let offset = 0; offset < files.length; offset += 32) {
      const batch = await Promise.all(files.slice(offset, offset + 32).map(async file => {
        const bindingPath = join(this.directory, file), key = file.slice(0, -5);
        try {
          const saved = /** @type {Value} */ (JSON.parse(await readFile(bindingPath, 'utf8')));
          if (typeof saved?.happySessionId !== 'string' || !saved.happySessionId ||
            saved.accountFingerprint !== accountFingerprint || saved.serverUrl !== this.account.serverUrl ||
            typeof saved.machineId !== 'string' || !saved.machineId ||
            typeof saved.sessionKey !== 'string' || Buffer.from(saved.sessionKey, 'base64').length !== 32 ||
            (saved.metadataVersion !== undefined && (!Number.isSafeInteger(saved.metadataVersion) || saved.metadataVersion < 0)) ||
            !isCodelyncNativeSource(saved.source, saved.metadata) || sourceKey(saved.source) !== key) return null;
          const metadata = this.checkedMetadata(saved, saved.metadata);
          if (!isCodelyncNativeSource(metadata.bridge.source, metadata) || sourceKey(metadata.bridge.source) !== key ||
            (metadata.bridge.sourceKey !== undefined && metadata.bridge.sourceKey !== key)) return null;
          return { ...saved, bindingPath };
        } catch { return null; }
      }));
      for (const binding of batch) if (binding) bindings.push(binding);
    }
    return bindings;
  }
  /** @param {string} path @param {Value} body */
  async post(path, body) {
    const response = await this.fetch(`${this.account.serverUrl}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${this.account.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error(`Codelync source registration failed (${response.status}).`);
    return /** @type {Value} */ (await response.json());
  }
  /** Registers only presence; this machine never advertises a model runner. */
  async machine() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, 'machine.json');
    let saved; try { saved = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error; saved = { id: randomUUID() }; }
    const accountFingerprint = this.fingerprint(); if (saved.accountFingerprint && saved.accountFingerprint !== accountFingerprint) throw Error('This machine profile belongs to another Codelync account.');
    const metadata = { host: 'Codelync Mac', platform: process.platform, arch: process.arch, happyCliVersion: 'codelync/0.2.0',
      happyHomeDir: this.directory, homeDir: this.directory, machineKind: 'noninvasive-bridge', displayName: 'Codelync Mac',
      codelync: { codexOnly: false, sourceApps: ['codex', 'antigravity', 'claude-desktop'], projectActivityVersion: 1 },
      cliAvailability: { codex: false, claude: false, gemini: false, openclaw: false, rig: false, detectedAt: Date.now() } };
    // Stable machine identity is durable before the first network attempt.
    await writePrivateJson(path, { ...saved, accountFingerprint, metadata });
    const { machine } = await this.post('/v1/machines', { id: saved.id, metadata: encryptRecord(metadata, new Uint8Array(Buffer.from(this.account.secret, 'base64url')), 'legacy') });
    await writePrivateJson(path, { ...saved, accountFingerprint, metadata, record: machine });
    return { ...saved, accountFingerprint, metadata, record: machine };
  }
  /** @param {Value} source @param {string} machineId @returns {Promise<Value>} */
  register(source, machineId) {
    this.assertScope(source, source.metadata);
    if (sourceArchived(source, source.metadata)) throw Object.assign(Error('Archived native sources are not part of the default directory.'), { code: 'source-archived' });
    const key = sourceKey(source);
    if (this.flights.has(key)) return /** @type {Promise<Value>} */ (this.flights.get(key));
    const flight = this.registerSource(source, machineId).finally(() => this.flights.delete(key)); this.flights.set(key, flight); return flight;
  }
  /** @param {Value} source @param {string} machineId */
  async registerSource(source, machineId) {
    this.assertScope(source, source.metadata);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, `${sourceKey(source)}.json`);
    let saved; try { saved = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error; }
    const accountFingerprint = this.fingerprint(); if (saved?.accountFingerprint && saved.accountFingerprint !== accountFingerprint) throw Error('The source binding belongs to another Codelync account.');
    if (saved?.happySessionId) {
      if (sourceKey(saved.source) !== sourceKey(source) || saved.serverUrl !== this.account.serverUrl || saved.machineId !== machineId) throw Error('The saved binding belongs to another source, server, or machine.');
      this.assertScope(saved.source, saved.metadata);
      return { ...saved, bindingPath: path };
    }
    const tag = `codelync:${machineId}:${sourceKey(source)}`;
    const metadata = saved?.metadata ?? { path: source.workspace ?? '', host: 'Codelync Mac', flavor: source.app, machineId,
      summary: { text: source.title || source.app, updatedAt: source.updatedAt ?? Date.now() }, nativeSession: { title: source.title || source.app, updatedAt: source.updatedAt ?? Date.now(), parentId: source.parentId ?? null, agentName: source.agentName ?? '', isSubagent: source.isSubagent === true, preview: source.preview ?? '', isPinned: source.isPinned ?? false, archived: false, catalogueAvailable: true, ...projectMetadata(source) }, client: { id: 'noninvasive-bridge', name: 'Codelync', version: '0.2.0' },
      capabilities: { abort: false, attachments: { enabled: false, maxBytes: 0, mediaTypes: [] }, files: { browse: false, read: false, search: false, write: false }, messageReceipts: true,
        modelSelection: false, reasoningSelection: false, permissionModeSelection: false, resume: false, rpcMethods: [], shell: false, steering: false },
      bridge: { version: 1, source: { app: source.app, id: source.id, hostId: source.hostId, ...(source.kind ? { kind: source.kind } : {}), runtimeGeneration: source.runtimeGeneration ?? null, windowGeneration: source.windowGeneration ?? null, ...(source.protocol ? { protocol: source.protocol } : {}),
        ...(source.app === 'claude-desktop' ? { appMode: source.appMode, nativeCollection: source.nativeCollection,
          ...(typeof source.appVersion === 'string' && source.appVersion.length <= 64 ? { appVersion: source.appVersion } : {}) } : {}) },
        currentTurnId: null, controlMode: source.kind === 'window' || !isCodelyncNativeSource(source, source.metadata) ? 'window' : 'session', sourceStatus: 'owner-unavailable',
        controller: 'machine', sourceKey: sourceKey(source) } };
    const pending = saved ?? { version: 1, tag, serverUrl: this.account.serverUrl, machineId, source: metadata.bridge.source, metadata, sessionKey: randomBytes(32).toString('base64') };
    this.assertScope(pending.source, metadata);
    pending.accountFingerprint = accountFingerprint;
    if (pending.tag !== tag || sourceKey(pending.source) !== sourceKey(source) || pending.serverUrl !== this.account.serverUrl) throw Error('The pending source plan does not match.');
    await writePrivateJson(path, pending);
    const secret = new Uint8Array(Buffer.from(this.account.secret, 'base64url')), pair = deriveContentKeyPair(secret), proposed = new Uint8Array(Buffer.from(pending.sessionKey, 'base64'));
    const { session } = await this.post('/v1/sessions', { tag, metadata: encryptRecord(metadata, proposed), dataEncryptionKey: Buffer.from(sealDataKey(proposed, pair.publicKey)).toString('base64') });
    // ACK loss/tag reuse must recover the server's original DEK, never replace it with a new random key.
    const key = unsealDataKey(new Uint8Array(Buffer.from(session.dataEncryptionKey ?? '', 'base64')), pair.secretKey);
    if (!key || !session.id) throw Error('The registered source encryption key could not be recovered.');
    const observedMetadata = /** @type {Value|null} */ (decryptRecord(session.metadata, key));
    if (!observedMetadata || sourceKey(observedMetadata.bridge.source) !== sourceKey(source)) throw Error('The existing server tag is bound to another source.');
    this.assertScope(observedMetadata.bridge.source, observedMetadata);
    const binding = { ...pending, happySessionId: session.id, sessionKey: Buffer.from(key).toString('base64'), metadata: observedMetadata };
    await writePrivateJson(path, binding);
    return { ...binding, bindingPath: path };
  }
  /** Discovery is the sole owner of index labels/recency; CAS preserves the active owner's capabilities.
   * @param {Value} binding @param {Value} source @param {import('socket.io-client').Socket} socket @returns {Promise<void>} */
  refreshMetadata(binding, source, socket) {
    this.assertScope(source, source.metadata);
    if (sourceKey(binding.source) !== sourceKey(source)) throw Error('The discovery source does not match its binding.');
    return this.queueMetadata(binding, socket, metadata => {
      const nativeSession = { ...metadata.nativeSession, title: source.title || source.app, updatedAt: source.updatedAt ?? 0,
        parentId: source.parentId ?? null, agentName: source.agentName ?? '', preview: source.preview ?? '', isPinned: source.isPinned ?? false,
        isSubagent: source.isSubagent === true,
        archived: sourceArchived(source, source.metadata), catalogueAvailable: !sourceArchived(source, source.metadata), ...projectMetadata(source) };
      if (nativeSession.sourceDisabled === true || Object.hasOwn(nativeSession, 'sourceDisabledCatalogueAvailable')) {
        delete nativeSession.sourceDisabledCatalogueAvailable; nativeSession.sourceDisabled = false;
      }
      if (!source.project) for (const field of ['projectKey', 'projectPath', 'projectLabel']) delete nativeSession[field];
      const nativeSource = { ...metadata.bridge.source, ...(source.kind ? { kind: source.kind } : {}), ...(source.protocol ? { protocol: source.protocol } : {}),
        ...(source.app === 'claude-desktop' ? { appMode: source.appMode, nativeCollection: source.nativeCollection,
          ...(typeof source.appVersion === 'string' && source.appVersion.length <= 64 ? { appVersion: source.appVersion } : {}) } : {}),
        archived: sourceArchived(source, source.metadata), ...(source.runtimeGeneration ? { runtimeGeneration: source.runtimeGeneration } : {}) };
      return { ...metadata, bridge: { ...metadata.bridge, source: nativeSource }, path: source.workspace ?? '', summary: { ...metadata.summary, text: nativeSession.title, updatedAt: nativeSession.updatedAt }, nativeSession };
    });
  }
  /** Confirmed index absence hides the catalog entry while retaining its owner/history evidence.
   * @param {Value} binding @param {import('socket.io-client').Socket} socket @returns {Promise<void>} */
  markUnavailable(binding, socket) {
    return this.queueMetadata(binding, socket, metadata => ({ ...metadata, nativeSession: { ...metadata.nativeSession, catalogueAvailable: false } }));
  }
  /** A local source choice is not archive or native index-absence evidence.
   * @param {Value} binding @param {import('socket.io-client').Socket} socket @returns {Promise<void>} */
  markDisabled(binding, socket) {
    return this.queueMetadata(binding, socket, metadata => {
      const native = metadata.nativeSession ?? {};
      const previous = native.sourceDisabled === true ? native.sourceDisabledCatalogueAvailable : native.catalogueAvailable;
      const capabilities = { ...metadata.capabilities, readOnly: true, abort: false, send: false, steering: false, modelSelection: false,
        reasoningSelection: false, permissionModeSelection: false, resume: false, shell: false, windowControl: false, rpcMethods: [] };
      delete capabilities.nativeTaskControls;
      if (capabilities.files) capabilities.files = { ...capabilities.files, write: false };
      return { ...metadata, nativeSession: { ...native, sourceDisabled: true, sourceDisabledCatalogueAvailable: typeof previous === 'boolean' ? previous : null, catalogueAvailable: false },
        bridge: { ...metadata.bridge, sourceStatus: 'disconnected' }, capabilities,
        ...(metadata.nativeControls ? { nativeControls: { ...metadata.nativeControls, model: { ...metadata.nativeControls.model, available: false } } } : {}) };
    });
  }
  /** Restore cached descriptor visibility only; controls remain unconfirmed.
   * @param {Value} binding @param {import('socket.io-client').Socket} socket @returns {Promise<void>} */
  markEnabled(binding, socket) {
    return this.queueMetadata(binding, socket, metadata => {
      if (metadata.nativeSession?.sourceDisabled !== true) return metadata;
      const nativeSession = { ...metadata.nativeSession, sourceDisabled: false };
      if (typeof nativeSession.sourceDisabledCatalogueAvailable === 'boolean') nativeSession.catalogueAvailable = nativeSession.sourceDisabledCatalogueAvailable;
      else delete nativeSession.catalogueAvailable;
      delete nativeSession.sourceDisabledCatalogueAvailable;
      return { ...metadata, nativeSession };
    });
  }
  /** Explicit archive evidence hides an existing mirror without deleting its
   * keys/history or journal. @param {Value} binding @param {import('socket.io-client').Socket} socket @param {Value} [source] */
  markArchived(binding, socket, source) {
    if (source) return this.refreshMetadata(binding, { ...source, archived: true }, socket);
    return this.queueMetadata(binding, socket, metadata => ({ ...metadata,
      bridge: { ...metadata.bridge, source: { ...metadata.bridge.source, archived: true } },
      nativeSession: { ...metadata.nativeSession, archived: true, catalogueAvailable: false } }));
  }
  /** Reads a previously registered binding only; never registers a hidden ID.
   * @param {Value} source @param {string} machineId @returns {Promise<Value|null>} */
  async existingBinding(source, machineId) {
    const key = sourceKey(source), path = join(this.directory, `${key}.json`);
    try {
      const saved = /** @type {Value} */ (JSON.parse(await readFile(path, 'utf8')));
      if (!saved.happySessionId || saved.machineId !== machineId || saved.serverUrl !== this.account.serverUrl ||
          saved.accountFingerprint !== this.fingerprint() || sourceKey(saved.source) !== key) return null;
      this.assertScope(saved.source, saved.metadata); return { ...saved, bindingPath: path };
    } catch { return null; }
  }
  /** @param {Value} binding @param {import('socket.io-client').Socket} socket @param {(metadata:Value)=>Value} update @returns {Promise<void>} */
  queueMetadata(binding, socket, update) {
    this.assertScope(binding.source, binding.metadata);
    const key = binding.happySessionId;
    if (typeof key !== 'string' || !key) throw Error('A registered source binding is required.');
    // 移除与重发现共用同一写入队列，不能用不同快照并发覆盖 catalogue 状态。
    const previous = this.metadataFlights.get(key) ?? Promise.resolve();
    const flight = previous.catch(() => {}).then(() => this.updateMetadata(binding, socket, update));
    this.metadataFlights.set(key, flight);
    return flight.finally(() => { if (this.metadataFlights.get(key) === flight) this.metadataFlights.delete(key); });
  }
  /** @param {Value} binding @param {unknown} metadata @returns {Value} */
  checkedMetadata(binding, metadata) {
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) throw Error('source-metadata-update-failed');
    const value = /** @type {Value} */ (metadata);
    if (!value.bridge?.source || sourceKey(value.bridge.source) !== sourceKey(binding.source)) throw Error('source-metadata-update-failed');
    this.assertScope(value.bridge.source, value);
    return value;
  }
  /** @param {Value} binding @param {Value} metadata @param {number} version */
  async saveMetadata(binding, metadata, version) {
    // 服务端 ACK 后仍可能持久化失败；先保存再推进内存，重试可从 CAS 冲突恢复最新证据。
    await writePrivateJson(binding.bindingPath, { ...binding, source: metadata.bridge.source, metadata, metadataVersion: version });
    binding.source = metadata.bridge.source; binding.metadata = metadata; binding.metadataVersion = version;
  }
  /** @param {Value} binding @param {import('socket.io-client').Socket} socket @param {(metadata:Value)=>Value} update */
  async updateMetadata(binding, socket, update) {
    const key = new Uint8Array(Buffer.from(binding.sessionKey, 'base64'));
    let metadata = this.checkedMetadata(binding, binding.metadata), version = binding.metadataVersion ?? 0, observed = false;
    if (!Number.isSafeInteger(version) || version < 0) throw Error('source-metadata-update-failed');
    for (let attempt = 0; attempt < 5; attempt++) {
      const value = update(metadata);
      if (JSON.stringify(value) === JSON.stringify(metadata)) {
        if (observed) await this.saveMetadata(binding, metadata, version);
        return;
      }
      const answer = await socket.timeout(15000).emitWithAck('update-metadata', { sid: binding.happySessionId, expectedVersion: version, metadata: encryptRecord(value, key) });
      if (!Number.isSafeInteger(answer?.version) || answer.version < version || !['success', 'version-mismatch'].includes(answer.result) ||
        (answer.result === 'success' && answer.version === version)) throw Error('source-metadata-update-failed');
      metadata = this.checkedMetadata(binding, decryptRecord(answer.metadata, key)); version = answer.version; observed = true;
      const applied = JSON.stringify(update(metadata)) === JSON.stringify(metadata);
      if (answer.result === 'success' || applied) {
        if (!applied) throw Error('source-metadata-update-failed');
        await this.saveMetadata(binding, metadata, version); return;
      }
    }
    throw Error('source-metadata-conflict');
  }
}
