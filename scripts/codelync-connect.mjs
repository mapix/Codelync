import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { CodexBackend } from '../src/adapters/codex-backend.mjs';
import { CodelyncSessionTransport } from '../src/codelync/session-transport.mjs';
import { NativeHappyConnector } from '../src/codelync/native-connector.mjs';
import { CommandReceipts } from '../src/commands.mjs';
import { SourceRegistry } from '../src/codelync/source-registry.mjs';
import { machinePresence } from '../src/codelync/machine-presence.mjs';

const lockfile = createRequire(import.meta.url)('proper-lockfile');
const ALLOWED_CONNECT_FLAGS = new Set(['--account', '--binding', '--state-dir']);

/** Parse and validate CLI flags for codelync-connect.
 * @param {string[]} argv */
export function parseConnectFlags(argv) {
  /** @type {Map<string, string>} */
  const flags = new Map();
  for (const arg of argv) {
    if (!arg.startsWith('--')) throw Error(`Unknown Codelync connect option: ${arg}.`);
    const at = arg.indexOf('=');
    const key = at < 0 ? arg : arg.slice(0, at);
    if (!ALLOWED_CONNECT_FLAGS.has(key)) throw Error(`Unknown Codelync connect option: ${key}.`);
    if (flags.has(key)) throw Error(`Duplicate Codelync connect option: ${key}.`);
    const value = at < 0 ? '' : arg.slice(at + 1);
    if (at < 0 || !value.trim()) throw Error(`${key} requires an explicit value using ${key}=value.`);
    flags.set(key, value);
  }
  const accountPath = flags.get('--account'), bindingPath = flags.get('--binding');
  if (!accountPath || !bindingPath) {
    throw Error('Usage: node scripts/codelync-connect.mjs --account=/private/account.json --binding=/private/source-binding.json');
  }
  return { accountPath, bindingPath, stateDir: flags.get('--state-dir') };
}

export async function runConnectCli(argv = process.argv.slice(2)) {
  const { accountPath, bindingPath, stateDir: rawStateDir } = parseConnectFlags(argv);
  const account = JSON.parse(await readFile(resolve(accountPath), 'utf8'));
  const binding = JSON.parse(await readFile(resolve(bindingPath), 'utf8'));
  if (binding.source?.app !== 'codex' || binding.source.hostId !== 'local') throw Error('This launcher binds only a verified local Codex source.');
  const stateDir = resolve(rawStateDir ?? join(dirname(resolve(bindingPath)), 'connector'));
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const nativeId = binding.source.id;
  const scope = createHash('sha256').update(`codex:local:${nativeId}`).digest('hex');
  const marker = join(stateDir, `${scope}.source`);
  await writeFile(marker, '', { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  let ownsLease = true;
  const releaseLease = await lockfile.lock(marker, { realpath: false, stale: 10000, update: 2000, retries: 0,
    onCompromised: () => { ownsLease = false; } });

  /** @type {CodexBackend | null} */ let backend = null;
  /** @type {CodelyncSessionTransport | null} */ let transport = null;
  /** @type {ReturnType<typeof machinePresence> | null} */ let presence = null;
  /** @type {NativeHappyConnector | null} */ let connector = null;
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    ownsLease = false;
    await connector?.close().catch(() => {});
    await transport?.close().catch(() => {});
    presence?.close();
    backend?.dispose();
    await releaseLease().catch(() => {});
  }
  const onSignal = () => { close().then(() => process.exit(0), () => process.exit(1)); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    backend = new CodexBackend();
    const machine = await new SourceRegistry({ directory: dirname(resolve(bindingPath)), account }).machine();
    if (binding.metadata.machineId !== machine.id) throw Error('The source binding belongs to another connector machine.');
    presence = machinePresence({ serverUrl: account.serverUrl, token: account.token, machineId: machine.id });
    const key = new Uint8Array(Buffer.from(binding.sessionKey, 'base64'));
    transport = new CodelyncSessionTransport({ serverOrigin: account.serverUrl, token: account.token,
      sessionId: binding.happySessionId, encryptionKey: key, statePath: join(stateDir, `${scope}-transport.json`), initialMetadata: binding.metadata });
    const activeBackend = backend;
    const generation = () => {
      // 原 IPC 订阅拥有 owner cache，并在断开/owner 退出时清空；不为每个流 chunk 重做 discovery。
      const owner = activeBackend.ipc.owners.get(nativeId);
      return owner ? `${owner.hostId}:${owner.ownerClientId}` : null;
    };
    connector = new NativeHappyConnector({ transport, adapter: backend, nativeId, sourceIdentity: binding.source,
      bindingId: `codelync:${binding.happySessionId}`, metadata: binding.metadata, encryptionKey: key,
      statePath: join(stateDir, `${scope}-projection.json`), receipts: await CommandReceipts.load(join(stateDir, `${scope}-receipts.json`)),
      getGeneration: generation, assertLease: () => ownsLease, supportsNativeProjection: true });
    connector.on('diagnostic', value => console.log(JSON.stringify({ service: 'Codelync', diagnostic: value.code })));
    await connector.start();
    console.log(JSON.stringify({ service: 'Codelync', nativeId, happySessionId: binding.happySessionId,
      ownerGeneration: await generation(), modelRunnerStarted: false, status: connector.status() }));
  } catch (error) {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runConnectCli();
}
