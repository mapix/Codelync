import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, isAbsolute } from 'node:path';

/** @typedef {Record<string,any>} Value */
const exec = promisify(execFile);
const INSPECTED_COMMAND_VERSIONS = new Set(['26.1103.60933']);
let versionCache = /** @type {{at:number,value:Promise<string|null>}|null} */ (null);

/** Resolve only a running native Codex app process; helpers and CLIs do not
 * establish the desktop version. @param {string} processes */
export function codexAppInfoPaths(processes) {
  const found = new Set();
  for (const row of processes.split('\n')) {
    const path = row.trim();
    if (!isAbsolute(path) || !/\.app\/Contents\/MacOS\/(?:Codex|ChatGPT)$/.test(path)) continue;
    found.add(join(dirname(dirname(path)), 'Info.plist'));
  }
  return [...found];
}

/** Read the actual running app's public bundle identity. No target code runs.
 * @param {{processes?:()=>Promise<string>,readInfo?:(path:string)=>Promise<Value>}} [options] */
export async function readCodexAppVersion(options = {}) {
  if (process.platform !== 'darwin' && !options.processes) return null;
  try {
    const rows = await (options.processes ?? (async () => (await exec('/bin/ps', ['-axo', 'comm='], { maxBuffer: 4 * 1024 * 1024 })).stdout))();
    const paths = codexAppInfoPaths(rows);
    const readInfo = options.readInfo ?? (async path => JSON.parse((await exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path], { maxBuffer: 64 * 1024 })).stdout));
    const values = await Promise.all(paths.map(async path => { try { return await readInfo(path); } catch { return null; } }));
    const matching = values.filter(value => value?.CFBundleIdentifier === 'com.openai.codex');
    if (matching.length !== 1) return null;
    const version = matching[0]?.CFBundleShortVersionString;
    return typeof version === 'string' && /^[0-9][A-Za-z0-9._-]{0,63}$/.test(version) ? version : null;
  } catch { return null; }
}

async function currentAppVersion() {
  if (!versionCache || Date.now() - versionCache.at > 5000) versionCache = { at: Date.now(), value: readCodexAppVersion() };
  return versionCache.value;
}

/** A minimal version-bound catalogue derived from the original desktop. It is
 * not a complete skills catalogue. @param {{hostId:string,ownerGeneration:string|null,modelAvailable?:boolean,readVersion?:()=>Promise<string|null>}} options */
export async function readNativeCodexCatalogue(options) {
  const local = options.hostId === 'local';
  const appVersion = local ? await (options.readVersion ?? currentAppVersion)() : null;
  const owner = typeof options.ownerGeneration === 'string' && !!options.ownerGeneration;
  const supported = local && owner;
  const knownCommands = supported && appVersion !== null && INSPECTED_COMMAND_VERSIONS.has(appVersion);
  return {
    compatibility: { app: 'codex', appVersion, protocol: 'codex-owner-ipc', protocolVersion: 'stream:11/settings:1', supported },
    commands: { available: knownCommands, source: 'original-codex', complete: false, skillsAvailable: false,
      ...(knownCommands ? {} : { reason: owner ? 'unverified-desktop-command-version' : 'original-owner-unavailable' }),
      items: knownCommands ? [
        { name: 'compact', description: 'Compact this chat context', type: 'system', execution: 'native-action', requiresIdle: true },
        { name: 'model', description: 'Choose this chat model and reasoning', type: 'system', execution: options.modelAvailable ? 'model-picker' : 'unsupported' },
        { name: 'goal', description: 'Open the goal editor in Codex Desktop', type: 'system', execution: 'unsupported' },
      ] : [] },
  };
}
