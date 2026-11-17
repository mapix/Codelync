/** Runtime-only stock-renderer candidate. No app module imports or runner launch.
 * This prototype is not enabled by discovery and requires copied-owner verification.
 */
/** @typedef {Record<string,any>} Value */
/** @param {unknown} value */
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Value} */ (value) : {};
/** @param {unknown} value */
const label = value => typeof value === 'string' && value.length <= 512 && !/[\x00-\x1f]/.test(value) ? value : null;
/** @param {string} code @param {boolean} [effect] */
const failure = (code, effect = false) => Object.assign(Error(code), { code, effectMayHaveOccurred: effect });

/** Project visible transcript fields only; never return native provider/account objects.
 * @param {Value} row @returns {Value} */
function message(row) {
  const body = record(row.message);
  const content = typeof body.content === 'string' ? [{ type: 'text', text: body.content }] : Array.isArray(body.content)
    ? body.content.filter(block => block?.type === 'text').map(block => ({ type: 'text', text: typeof block.text === 'string' ? block.text : '' })) : [];
  if (content.some(block => block.text.length > 1024 * 1024)) throw failure('native-text-too-large');
  return { type: label(row.type), uuid: label(row.uuid), timestamp: label(row.timestamp), message: { id: label(body.id), role: label(body.role), content } };
}

/** Pure native endpoint used by the renderer socket. Owner proof must come from
 * the local Codelync installer, not from website titles or inferred window IDs.
 * @param {Value} native @param {{ownerEpoch:string,gatewayVerified:boolean,executionToken?:(id:string,mode:string)=>Promise<string|null>}} proof */
export function createClaudeRendererEndpoint(native, proof) {
  if (!native?.LocalSessions || !native?.LocalAgentModeSessions || !proof.ownerEpoch) throw failure('native-renderer-unavailable');
  let active = true;
  /** @type {Map<string,{fingerprint:string,promise:Promise<Value>}>} */ const commands = new Map();
  /** @param {string} mode */
  const api = mode => mode === 'code' ? native.LocalSessions : mode === 'chat' ? native.LocalAgentModeSessions : (() => { throw failure('unsupported-native-mode'); })();
  /** @param {Value} packet @returns {Promise<Value>} */
  async function invoke(packet) {
    if (!active) throw failure('renderer-follower-deactivated');
    if (packet.ownerEpoch !== proof.ownerEpoch) throw failure('source-epoch-changed');
    const mode = packet.appMode, owner = api(mode), params = record(packet.params), id = label(params.sessionId);
    if (packet.method === 'list') {
      const reply = await owner.getSessionList(), rows = Array.isArray(reply) ? reply : reply.sessions;
      if (!Array.isArray(rows) || rows.length > 10000) throw failure('native-invalid-response');
      return { sessions: rows.filter(row => mode === 'code' || row.sessionType === 'chat').map(row => ({ sessionId: label(row.sessionId), title: label(row.title), cwd: label(row.cwd),
        sessionType: label(row.sessionType), isRunning: typeof row.isRunning === 'boolean' ? row.isRunning : null, createdAt: row.createdAt })) };
    }
    if (!id) throw failure('invalid-native-session');
    const header = await owner.getSession(id, mode === 'chat' ? { metadataOnly: true } : undefined);
    if (!header || header.sessionId !== id || mode === 'chat' && header.sessionType !== 'chat') throw failure('source-epoch-changed');
    if (packet.method === 'snapshot') {
      const tail = mode === 'code' ? await owner.getTranscriptTail(id, 32) : { messages: await owner.getTranscript(id, { limit: 33, maxScan: 1024 * 1024 }), hasMore: null };
      if (!Array.isArray(tail.messages) || tail.messages.length > 500) throw failure('native-invalid-response');
      return { sessionId: id, isRunning: header.isRunning === true, messages: tail.messages.slice(-32).map(message),
        hasMore: tail.messages.length > 32 ? true : typeof tail.hasMore === 'boolean' ? tail.hasMore : null };
    }
    if (packet.method === 'send') {
      if (!proof.gatewayVerified) throw failure('gateway-route-not-proven');
      if (header.isRunning !== false) throw failure('active-native-input-unverified');
      if (typeof params.text !== 'string' || !params.text.trim() || params.text.length > 1024 * 1024 || !label(params.messageUuid)) throw failure('invalid-native-input');
      if (mode === 'code') await owner.sendMessage(id, params.text, undefined, undefined, undefined, undefined, undefined, params.messageUuid, undefined, undefined, undefined, undefined, undefined, undefined, { personSent: true, rejectUndelivered: true });
      else {
        const result = await owner.sendMessage(id, params.text, undefined, undefined, params.messageUuid);
        if (result?.dispatched === false) throw failure('native-admission-unconfirmed', true);
      }
      return { nativeDispatchConfirmed: true, messageUuid: params.messageUuid };
    }
    if (packet.method === 'interrupt') {
      const token = await proof.executionToken?.(id, mode);
      if (!token || token !== params.queryToken || header.isRunning !== true) throw failure('native-query-token-unavailable');
      if (mode === 'code') await owner.interrupt(id); else await owner.stop(id);
      return { cancelRequested: true };
    }
    throw failure('unsupported-native-action');
  }
  return {
    /** Unknown operations are retained; disconnect never causes replay.
     * @param {Value} packet @returns {Promise<Value>} */
    request(packet) {
      if (!active) return Promise.reject(failure('renderer-follower-deactivated'));
      if (!['send', 'interrupt'].includes(packet.method)) return invoke(packet);
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(packet.commandId ?? '')) return Promise.reject(failure('invalid-command-id'));
      const fingerprint = JSON.stringify([packet.ownerEpoch, packet.appMode, packet.method, packet.params]);
      const prior = commands.get(packet.commandId);
      if (prior) return prior.fingerprint === fingerprint ? prior.promise : Promise.reject(failure('command-id-conflict'));
      const promise = Promise.resolve().then(() => invoke(packet)); promise.catch(() => {});
      commands.set(packet.commandId, { fingerprint, promise }); return promise;
    },
    deactivate() { active = false; },
    active() { return active; },
  };
}

/** @param {Value} native @param {{socketUrl:string,nonce:string,ownerEpoch:string,gatewayVerified:boolean,WebSocket?:typeof WebSocket,events?:EventTarget}} options */
export function installClaudeRendererFollower(native, options) {
  const url = new URL(options.socketUrl);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/claude-native-follower') throw failure('invalid-local-bridge');
  if (!/^[a-f0-9]{64}$/.test(options.nonce ?? '')) throw failure('invalid-local-bridge');
  const endpoint = createClaudeRendererEndpoint(native, options), Socket = options.WebSocket ?? WebSocket, socket = new Socket(url.href);
  let closed = false;
  const deactivate = () => { if (closed) return; closed = true; endpoint.deactivate(); socket.close(); options.events?.removeEventListener('beforeunload', deactivate); };
  socket.addEventListener('open', () => socket.send(JSON.stringify({ version: 1, kind: 'hello', nonce: options.nonce, ownerEpoch: options.ownerEpoch })));
  socket.addEventListener('close', deactivate); socket.addEventListener('error', deactivate);
  socket.addEventListener('message', async event => {
    if (closed || typeof event.data !== 'string' || event.data.length > 131072) return;
    let packet;
    try {
      packet = JSON.parse(event.data); const result = await endpoint.request(packet);
      if (!closed) socket.send(JSON.stringify({ version: 1, requestId: packet.requestId, ok: true, result }));
    } catch (error) {
      const detail = record(error);
      if (!closed) socket.send(JSON.stringify({ version: 1, requestId: packet?.requestId, ok: false, error: { code: /^[a-z][a-z-]{0,64}$/.test(detail.code ?? '') ? detail.code : 'native-operation-unavailable' }, effectMayHaveOccurred: detail.effectMayHaveOccurred !== false }));
    }
  });
  options.events?.addEventListener('beforeunload', deactivate);
  return { deactivate, endpoint, socket };
}
