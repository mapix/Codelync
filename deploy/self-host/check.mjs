import { createHmac } from 'node:crypto';
import { readSettings } from './configure.mjs';

/** @param {Record<string,string>} settings */
async function checkMedia(settings) {
  if (!settings.LIVEKIT_API_SECRET) throw Error('Run node configure.mjs first.');
  const now = Math.floor(Date.now() / 1000);
  const encode = (/** @type {unknown} */ value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode({ iss: settings.LIVEKIT_API_KEY, sub: 'deployment-check',
    nbf: now - 5, exp: now + 60, video: { roomList: true } });
  const token = body + '.' + createHmac('sha256', settings.LIVEKIT_API_SECRET).update(body).digest('base64url');
  const response = await fetch(`https://${settings.MEDIA_DOMAIN}/twirp/livekit.RoomService/ListRooms`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}',
    redirect: 'error', signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw Error(`RoomService returned HTTP ${response.status}.`);
  const result = await response.json();
  if (result.rooms !== undefined && !Array.isArray(result.rooms)) throw Error('Invalid RoomService response.');
  // Do not print rooms, participant names or authorization material.
}

/** @param {Record<string,string>} settings */
async function checkNetwork(settings) {
  /** @type {RequestInit} */ const options = { redirect: 'error', signal: AbortSignal.timeout(10_000) };
  const response = await fetch(`https://${settings.RELAY_DOMAIN}/relay/v1/info`, options);
  if (!response.ok) throw Error(`Relay discovery returned HTTP ${response.status}.`);
  const info = await response.json();
  if (info.service !== 'codelync-network-relay' || info.version !== 1 || info.http !== true
    || info.websocket !== true || info.requiresToken !== true) throw Error('Wrong relay service or protocol.');
  const health = await fetch(`https://${settings.RELAY_DOMAIN}/healthz`, { ...options, signal: AbortSignal.timeout(10_000) });
  if (!health.ok || (await health.text()).trim() !== 'ok') throw Error('Relay health check failed.');
}

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
