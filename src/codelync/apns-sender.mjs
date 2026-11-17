import { readFile } from 'node:fs/promises';
import { createPrivateKey, sign } from 'node:crypto';
import { connect } from 'node:http2';
import { isAbsolute } from 'node:path';
import { readOptionalPrivateJson } from './discovery-persistence.mjs';
/** @typedef {Record<string,any>} Value */
/** Registered device environment is the delivery authority. @param {unknown} environment */
export function apnsDeliveryOrigin(environment) {
  if (!['development', 'production'].includes(/** @type {string} */ (environment))) throw Error('invalid-apns-environment');
  return environment === 'development' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
}
/** Private local publisher configuration. @param {string} path */
export async function loadAPNsSender(path) {
  const config = await readOptionalPrivateJson(path);
  if (!config) return null;
  if (!isAbsolute(config.keyPath ?? '') || !/^[A-Z0-9]{10}$/u.test(config.keyId ?? '') || !/^[A-Z0-9]{10}$/u.test(config.teamId ?? '') || config.topic !== 'com.learnings.codelync' || !['development', 'production'].includes(config.environment)) throw Error('invalid-apns-configuration');
  const privateKey = createPrivateKey(await readFile(config.keyPath));
  if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw Error('invalid-apns-key');
  let jwt = '', signedAt = 0;
  return { environment: config.environment, multiEnvironment: true,
    /** @param {string} token @param {Value} event @param {string} [environment] */
    async send(token, event, environment = config.environment) {
      const now = Math.floor(Date.now() / 1000);
      if (!jwt || now - signedAt > 3000) {
        const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: config.keyId })).toString('base64url');
        const claims = Buffer.from(JSON.stringify({ iss: config.teamId, iat: now })).toString('base64url');
        const unsigned = header + '.' + claims;
        jwt = unsigned + '.' + sign('sha256', Buffer.from(unsigned), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url'); signedAt = now;
      }
      const client = connect(apnsDeliveryOrigin(environment));
      try { return await new Promise((resolve, reject) => {
        client.once('error', () => reject(Error('apns-transport-failed')));
        const req = client.request({ ':method': 'POST', ':path': `/3/device/${token}`, authorization: 'bearer ' + jwt, 'apns-topic': config.topic, 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-expiration': String(now + 3600), 'apns-collapse-id': event.id.slice(0, 64) });
        let status = 0, body = '';
        req.setTimeout(15000, () => { req.close(); reject(Error('apns-timeout')); });
        req.on('response', headers => { status = Number(headers[':status']); });
        req.on('data', chunk => { body = (body + chunk.toString()).slice(0, 4096); });
        req.on('error', () => reject(Error('apns-transport-failed')));
        req.on('end', () => {
          let reason = ''; try { reason = JSON.parse(body).reason ?? ''; } catch { /* HTTP status remains authoritative. */ }
          resolve({ ok: status === 200, invalidToken: status === 410 || ['BadDeviceToken', 'DeviceTokenNotForTopic'].includes(reason), retry: status === 429 || status >= 500, reason: /^[A-Za-z]{1,80}$/u.test(reason) ? reason : 'APNsUnavailable' });
        });
        req.end(JSON.stringify({ aps: { alert: { title: 'Codelync', body: event.kind === 'test' ? 'Notifications are ready.' : event.kind === 'completed' ? 'A session has finished.' : event.kind === 'failed' ? 'A session needs attention.' : 'A session is waiting for your input.' }, sound: 'default' }, sessionId: event.sessionId, eventId: event.id, origin: event.origin, peerId: event.peerId }));
      }); } finally { client.destroy(); }
    }
  };
}
