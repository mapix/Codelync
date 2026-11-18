import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = dirname(fileURLToPath(import.meta.url));
const ALLOWED_ENV_KEYS = new Set(['MEDIA_DOMAIN', 'RELAY_DOMAIN', 'TURN_DOMAIN', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'REGISTRATION_TOKEN']);
const MAX_ENV_BYTES = 65_536;

/** Read private settings without logging their values. @param {string} directory */
export async function readSettings(directory = root) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw Error('Use Node 24 or later.');
  const path = join(directory, '.env');
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw Error('.env must be a regular file.');
  if (metadata.size > MAX_ENV_BYTES) throw Error('.env exceeds the maximum supported size.');
  /** @type {Record<string,string>} */ const settings = {};
  for (const [name, value] of Object.entries(parseEnv(await readFile(path, 'utf8')))) {
    if (!ALLOWED_ENV_KEYS.has(name)) throw Error(`Unknown setting in .env: ${name}.`);
    if (value !== undefined) {
      if (/[\r\n\0]/u.test(value)) throw Error(`${name} contains unsupported control characters.`);
      settings[name] = value;
    }
  }
  for (const name of ['MEDIA_DOMAIN', 'RELAY_DOMAIN', 'TURN_DOMAIN']) {
    const value = settings[name] ?? '';
    if (value && (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(value)
      || /(?:^|\.)example\.(?:com|net|org)$/u.test(value) || /\.(?:example|invalid|localhost|local|test)$/u.test(value))) {
      throw Error(`Set ${name} to your real DNS hostname, without a scheme or port.`);
    }
    settings[name] = value;
  }
  if (!settings.MEDIA_DOMAIN && !settings.RELAY_DOMAIN) throw Error('Set MEDIA_DOMAIN or RELAY_DOMAIN.');
  if (new Set([settings.MEDIA_DOMAIN, settings.RELAY_DOMAIN, settings.TURN_DOMAIN].filter(Boolean)).size
    !== [settings.MEDIA_DOMAIN, settings.RELAY_DOMAIN, settings.TURN_DOMAIN].filter(Boolean).length) throw Error('Use different hostnames for the services.');
  if (settings.TURN_DOMAIN && !settings.MEDIA_DOMAIN) throw Error('TURN_DOMAIN requires MEDIA_DOMAIN.');
  settings.LIVEKIT_API_KEY ||= 'codelync_key';
  if (!/^[A-Za-z0-9_-]{4,128}$/u.test(settings.LIVEKIT_API_KEY)) throw Error('LIVEKIT_API_KEY has an invalid format.');
  for (const name of ['LIVEKIT_API_SECRET', 'REGISTRATION_TOKEN']) {
    if (settings[name] && !/^[A-Za-z0-9_-]{32,256}$/u.test(settings[name])) throw Error(`${name} must have 32–256 letters, digits, underscores or hyphens.`);
  }
  if (settings.LIVEKIT_API_SECRET && settings.LIVEKIT_API_SECRET === settings.REGISTRATION_TOKEN) throw Error('Use independent media and network credentials.');
  return settings;
}

/** Render owned configuration, preserving existing secrets. @param {string} directory */
export async function configure(directory = root) {
  const settings = await readSettings(directory);
  settings.LIVEKIT_API_SECRET ||= randomBytes(32).toString('hex');
  settings.REGISTRATION_TOKEN ||= randomBytes(32).toString('hex');
  const env = ['MEDIA_DOMAIN', 'RELAY_DOMAIN', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'REGISTRATION_TOKEN', 'TURN_DOMAIN']
    .map(name => `${name}=${settings[name]}`).join('\n') + '\n';
  const caddy = [];
  if (settings.MEDIA_DOMAIN) caddy.push(`${settings.MEDIA_DOMAIN} {\n    reverse_proxy 127.0.0.1:7880\n}`);
  if (settings.RELAY_DOMAIN) caddy.push(`${settings.RELAY_DOMAIN} {\n    reverse_proxy 127.0.0.1:8081 {\n        flush_interval -1\n    }\n}`);
  /** @type {Record<string,unknown>} */
  const media = { port: 7880, bind_addresses: ['127.0.0.1'], rtc: { tcp_port: 7881, udp_port: 7882, use_external_ip: true },
    keys: { [settings.LIVEKIT_API_KEY]: settings.LIVEKIT_API_SECRET } };
  // JSON is accepted by LiveKit's YAML loader; avoid custom secret interpolation.
  if (settings.TURN_DOMAIN) media.turn = { enabled: true, domain: settings.TURN_DOMAIN, udp_port: 3478, tls_port: 5349,
    cert_file: '/etc/livekit/certs/fullchain.pem', key_file: '/etc/livekit/certs/privkey.pem' };
  await mkdir(join(directory, 'certs'), { recursive: true, mode: 0o700 });
  for (const [name, content] of [['.env', env], ['Caddyfile', caddy.join('\n\n') + '\n'], ['livekit.yaml', JSON.stringify(media, null, 2) + '\n']]) {
    const temporary = join(directory, name + '.' + randomBytes(6).toString('hex') + '.tmp');
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(directory, name));
  }
  return settings;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const settings = await configure();
    process.stdout.write('Configuration generated. Existing credentials were retained.\n');
    process.stdout.write(`Enabled domains: ${[settings.MEDIA_DOMAIN && 'media', settings.RELAY_DOMAIN && 'network'].filter(Boolean).join(', ')}\n`);
    if (settings.TURN_DOMAIN) process.stdout.write('TURN/TLS requires matching certificate files in certs/ before startup.\n');
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'Configuration failed.'}\n`); process.exitCode = 1; }
}
