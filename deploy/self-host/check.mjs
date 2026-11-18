import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readSettings } from './configure.mjs';

const MAX_JSON_RESPONSE_BYTES = 65_536;
const MAX_HEALTH_RESPONSE_BYTES = 1_024;

/** Build and verify an HTTPS endpoint URL for a validated self-hosted domain.
 * @param {string} domain @param {string} pathname */
export function buildHttpsEndpoint(domain, pathname) {
  const url = new URL(`https://${domain}${pathname}`);
  if (url.protocol !== 'https:' || url.hostname !== domain) {
    throw Error('Endpoint URL must use HTTPS on the configured domain.');
  }
  return url.toString();
}

/** Read a bounded UTF-8 response body without buffering unbounded payloads into memory.
 * @param {Response} response @param {number} maxBytes */
export async function readBoundedResponseText(response, maxBytes = MAX_JSON_RESPONSE_BYTES) {
  const lengthHeader = response.headers?.get?.('content-length');
  if (lengthHeader !== null && lengthHeader !== undefined && Number(lengthHeader) > maxBytes) {
    await response.body?.cancel?.().catch(() => {});
    throw Error('Response body exceeded byte limit.');
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw Error('Response body exceeded byte limit.');
    return text;
  }
  const reader = response.body.getReader();
  /** @type {Uint8Array[]} */ const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw Error('Response body exceeded byte limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

/** @param {Record<string,string>} settings @param {typeof fetch} [fetchImpl] */
export async function checkMedia(settings, fetchImpl = fetch) {
  if (!settings.LIVEKIT_API_SECRET) throw Error('Run node configure.mjs first.');
  const endpoint = buildHttpsEndpoint(settings.MEDIA_DOMAIN, '/twirp/livekit.RoomService/ListRooms');
  const now = Math.floor(Date.now() / 1000);
  const encode = (/** @type {unknown} */ value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode({ iss: settings.LIVEKIT_API_KEY, sub: 'deployment-check',
    nbf: now - 5, exp: now + 60, video: { roomList: true } });
  const token = body + '.' + createHmac('sha256', settings.LIVEKIT_API_SECRET).update(body).digest('base64url');
  const response = await fetchImpl(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}',
    redirect: 'error', signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw Error(`RoomService returned HTTP ${response.status}.`);
  const result = JSON.parse(await readBoundedResponseText(response, MAX_JSON_RESPONSE_BYTES));
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || result.rooms !== undefined && !Array.isArray(result.rooms)) throw Error('Invalid RoomService response.');
  // Do not print rooms, participant names or authorization material.
}

/** @param {Record<string,string>} settings @param {typeof fetch} [fetchImpl] */
export async function checkNetwork(settings, fetchImpl = fetch) {
  /** @type {RequestInit} */ const options = { redirect: 'error', signal: AbortSignal.timeout(10_000) };
  const infoEndpoint = buildHttpsEndpoint(settings.RELAY_DOMAIN, '/relay/v1/info');
  const response = await fetchImpl(infoEndpoint, options);
  if (!response.ok) throw Error(`Relay discovery returned HTTP ${response.status}.`);
  const info = JSON.parse(await readBoundedResponseText(response, MAX_JSON_RESPONSE_BYTES));
  if (!info || typeof info !== 'object' || Array.isArray(info)
    || info.service !== 'codelync-network-relay' || info.version !== 1 || info.http !== true
    || info.websocket !== true || info.requiresToken !== true) throw Error('Wrong relay service or protocol.');
  const healthEndpoint = buildHttpsEndpoint(settings.RELAY_DOMAIN, '/healthz');
  const health = await fetchImpl(healthEndpoint, { ...options, signal: AbortSignal.timeout(10_000) });
  if (!health.ok || (await readBoundedResponseText(health, MAX_HEALTH_RESPONSE_BYTES)).trim() !== 'ok') {
    throw Error('Relay health check failed.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const settings = await readSettings();
    /** @type {[string,()=>Promise<void>][]} */ const checks = [];
    if (settings.MEDIA_DOMAIN) checks.push(['LiveKit RoomService', () => checkMedia(settings)]);
    if (settings.RELAY_DOMAIN) checks.push(['Codelync Relay HTTP discovery', () => checkNetwork(settings)]);
    const results = await Promise.allSettled(checks.map(async ([label, check]) => {
      await check(); process.stdout.write(`${label}: passed\n`);
    }));
    results.forEach((result, index) => {
      if (result.status === 'rejected') { process.stderr.write(`${checks[index][0]}: failed (${result.reason.message})\n`); process.exitCode = 1; }
    });
    process.stdout.write('These checks do not verify media ports, TURN, relay WebSocket registration or phone desktop input.\n');
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'Endpoint check failed.'}\n`); process.exitCode = 1; }
}
