import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { claudeDesktopProcessIdentity } from './claude-desktop-rpc.mjs';
import { BridgeError } from '../errors.mjs';

/** @typedef {Record<string,any>} Value */
const exec = promisify(execFile);
const fail = (/** @type {string} */ code) => new BridgeError(code, 'The attested native Claude Desktop debugger is unavailable.', 503);

/** Find only loopback listeners owned by this exact existing main process.
 * No app is launched, no port is killed and no raw inspector URL is logged.
 * @param {{pid:number,executable:string,fetch?:typeof fetch}} options */
export async function findClaudeNativeDebugger(options) {
  const identity = await claudeDesktopProcessIdentity(options.pid);
  if (identity.executable !== options.executable) throw fail('source-epoch-changed');
  let stdout; try { ({ stdout } = await exec('/usr/sbin/lsof', ['-nP', '-a', '-p', String(options.pid), '-iTCP', '-sTCP:LISTEN'])); }
  catch { throw fail('native-debugger-not-enabled'); }
  const ports = [...new Set([...stdout.matchAll(/127\.0\.0\.1:(\d+)/g)].map(match => Number(match[1])))];
  const fetcher = options.fetch ?? fetch;
  for (const port of ports) {
    try {
      const response = await fetcher(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
      if (!response.ok) continue; const targets = await response.json();
      if (!Array.isArray(targets)) continue;
      for (const target of targets) {
        if (target?.type !== 'node' || typeof target.webSocketDebuggerUrl !== 'string') continue;
        const endpoint = new URL(target.webSocketDebuggerUrl);
        if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || Number(endpoint.port) !== port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) continue;
        return { identity, endpoint: endpoint.href };
      }
    } catch { /* Another listener of the same main process is not an inspector. */ }
  }
  throw fail('native-debugger-not-enabled');
}

/** Local-only transport to the vendor-enabled main debugger. */
export class ClaudeNativeDebugger {
  /** @param {{endpoint:string,timeoutMs?:number}} options */
  constructor(options) {
    const url = new URL(options.endpoint);
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash) throw fail('invalid-native-debugger');
    this.endpoint = options.endpoint; this.timeoutMs = options.timeoutMs ?? 10000; this.next = 0;
    /** @type {WebSocket|null} */ this.socket = null;
    /** @type {Map<number,{resolve:(value:Value)=>void,reject:(error:Error)=>void,timer:ReturnType<typeof setTimeout>}>} */ this.pending = new Map();
  }
  async connect() {
    const socket = new WebSocket(this.endpoint); this.socket = socket;
    socket.addEventListener('message', event => {
      let packet; try { packet = JSON.parse(String(event.data)); } catch { return; }
      const waiter = this.pending.get(packet.id); if (!waiter) return;
      this.pending.delete(packet.id); clearTimeout(waiter.timer);
      packet.error ? waiter.reject(fail('native-debugger-command-failed')) : waiter.resolve(packet.result);
    });
    socket.addEventListener('close', () => { for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(fail('native-debugger-disconnected')); } this.pending.clear(); });
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', () => reject(fail('native-debugger-connection-failed')), { once: true }); });
  }
  /** @param {string} method @param {Value} [params] @returns {Promise<Value>} */
  call(method, params = {}) {
    const socket = this.socket; if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(fail('native-debugger-disconnected'));
    return new Promise((resolve, reject) => { const id = ++this.next, timer = setTimeout(() => { this.pending.delete(id); reject(fail('native-debugger-timeout')); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
  }
  /** No error descriptions/native objects are included in caller diagnostics.
   * @param {string} expression @returns {Promise<Value>} */
  async evaluate(expression) {
    const reply = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (reply.exceptionDetails || !reply.result || reply.result.type !== 'object' || !reply.result.value) throw fail('native-debugger-evaluation-failed');
    return reply.result.value;
  }
  close() { this.socket?.close(); this.socket = null; }
}

/** Attest the actual main/profile/version/Gateway and read native headers only.
 * @param {ClaudeNativeDebugger} debuggerClient @param {{identity:Value,appRoot:string,profilePath:string,asarSha256:string}} expected */
export async function attestClaudeStockOwner(debuggerClient, expected) {
  const appPath = join(expected.appRoot, 'Contents', 'Resources', 'app.asar');
  const facts = await debuggerClient.evaluate(`(async()=>{const require=process.mainModule.require.bind(process.mainModule),electron=require('electron'),path=require('node:path'),fs=require('original-fs'),crypto=require('node:crypto'),root=electron.app.getAppPath(),main=require(path.join(root,'.vite/build/index.chunk-Du-Wqi0E.js')),config=main.Lut(),mode=main.Hft(),code=require(path.join(root,'.vite/build/index.chunk-CqaSnEfn.js')).claudeCodeSessionManager,lam=require(path.join(root,'.vite/build/index.chunk-vuRwhTdh.js')).n;
const a=await code.getSessionList(),b=await lam.getSessionList(),codeRows=Array.isArray(a)?a:a.sessions,lamRows=Array.isArray(b)?b:b.sessions;return {pid:process.pid,parentPid:process.ppid,executable:process.execPath,profile:electron.app.getPath('userData'),appPath:root,appVersion:electron.app.getVersion(),asarSha256:crypto.createHash('sha256').update(fs.readFileSync(root)).digest('hex'),nativeGateway:mode.type==='3p'&&main.bdt(config)&&config.inference?.provider==='gateway'&&mode.getProvider()?.creds?.provider==='gateway'&&mode.managesProviderRouting?.()===true,sourceLocal:main.Fut()?.type==='local',codeHeaders:codeRows.length,lamHeaders:lamRows.length,active:codeRows.filter(row=>row.isRunning===true||row.starting===true||row.hasBackgroundWork===true).length+lamRows.filter(row=>row.isRunning===true||row.starting===true||row.hasBackgroundWork===true).length,pending:code.permissionBroker.pendingPermissions.size+lamRows.reduce((total,row)=>total+(Array.isArray(row.pendingToolPermissions)?row.pendingToolPermissions.length:0),0),extractedModules:Object.keys(require('node:module')._cache).filter(value=>value.startsWith(root.replace(/\\.asar$/,'')+'/')).length};})()`);
  if (facts.pid !== expected.identity.pid || facts.parentPid !== expected.identity.parentPid || facts.executable !== expected.identity.executable
    || facts.profile !== expected.profilePath || facts.appPath !== appPath || facts.appVersion !== '4.16336.0' || facts.asarSha256 !== expected.asarSha256
    || facts.nativeGateway !== true || facts.sourceLocal !== true || facts.extractedModules !== 0) throw fail('native-owner-attestation-failed');
  return { pid: facts.pid, appVersion: facts.appVersion, asarSha256: facts.asarSha256, gatewayVerified: true, sourceLocal: true,
    codeHeaders: facts.codeHeaders, lamHeaders: facts.lamHeaders, active: facts.active, pending: facts.pending, idle: facts.active === 0 && facts.pending === 0 };
}
