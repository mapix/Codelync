import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BridgeError } from '../errors.mjs';
import { antigravityProcessIdentity, antigravityOwnerGeneration } from './antigravity-rpc.mjs';

/** @typedef {Record<string,any>} Value */
const exec = promisify(execFile);

function unavailable() { return new BridgeError('antigravity-discovery-unavailable', 'The current Antigravity desktop endpoint could not be verified.', 503); }

/** Parse an exact executable's process row. Arguments are kept on this Mac.
 * @param {string} text @param {string} binary */
export function antigravityOwnerRows(text, binary) {
  return text.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match || !match[2].startsWith(binary + ' ')) return [];
    const args = match[2].slice(binary.length);
    if (/^\s*multicall(?:\s|$)/.test(args)) return [];
    const csrf = /(?:^|\s)--csrf_token(?:=|\s+)([^\s]+)/.exec(args);
    const appDataDir = /(?:^|\s)--app_data_dir(?:=|\s+)([^\s]+)/.exec(args);
    return [{ pid: Number(match[1]), csrfToken: csrf?.[1], appDataDir: appDataDir?.[1] }];
  });
}

/** Discover the already-running original desktop. This neither starts a runner
 * nor writes its credentials into a manifest. Explicit probe manifests are
 * handled by AntigravityRpcClient instead.
 * @param {{appPath?:string,home?:string,processes?:()=>Promise<string>,readLog?:(path:string)=>Promise<string>,processIdentity?:(pid:number)=>Promise<Value>,resolvePath?:(path:string)=>Promise<string>}} [options]
 * @returns {Promise<Value|null>} */
export async function discoverAntigravityRuntime(options = {}) {
  if (process.platform !== 'darwin' && !options.processes) return null;
  const app = options.appPath ?? '/Applications/Antigravity.app';
  const binary = join(app, 'Contents/Resources/bin/language_server');
  const processes = options.processes ?? (async () => (await exec('/bin/ps', ['-axo', 'pid=,command='], { maxBuffer: 4 * 1024 * 1024 })).stdout);
  const rows = antigravityOwnerRows(await processes(), binary);
  if (!rows.length) return null;
  if (rows.length !== 1 || !rows[0].csrfToken) throw unavailable();
  const row = rows[0];
  const identity = await (options.processIdentity ?? antigravityProcessIdentity)(row.pid);
  const resolvePath = options.resolvePath ?? realpath;
  const expected = await resolvePath(binary), observed = await resolvePath(identity.executable);
  if (expected !== observed) throw unavailable();
  const parent = await (options.processIdentity ?? antigravityProcessIdentity)(identity.parentPid);
  if (await resolvePath(parent.executable) !== await resolvePath(join(app, 'Contents/MacOS/Antigravity'))) throw unavailable();
  const home = options.home ?? homedir();
  const logPath = join(home, 'Library/Logs/Antigravity/language_server.log');
  const log = await (options.readLog ?? (path => readFile(path, 'utf8')))(logPath).catch(() => { throw unavailable(); });
  if (!new RegExp('Starting language server process with pid ' + row.pid + '\\b').test(log)) throw unavailable();
  const ports = [...log.matchAll(/listening on \w+ port at (\d+) for HTTP\b/g)];
  const port = Number(ports.at(-1)?.[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw unavailable();
  return { version: 1, ...identity, executable: expected, binary: expected,
    origin: `http://127.0.0.1:${port}`, csrfToken: row.csrfToken, home, logPath,
    appDataDir: row.appDataDir ?? 'antigravity',
    generation: antigravityOwnerGeneration({ ...identity, executable: expected }) };
}
