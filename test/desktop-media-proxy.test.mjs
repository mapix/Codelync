import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import nacl from 'tweetnacl';
import { createPairingGateway, PairingInvitations } from '../src/happy/pairing-gateway.mjs';

test('desktop media uses its token gate, preserves v0/v1 signaling and rejects unrelated upgrades', async t => {
  const upstream = createServer(), media = new WebSocketServer({ noServer: true });
  const paths = /** @type {string[]} */ ([]);
  upstream.on('upgrade', (request, socket, head) => {
    paths.push(request.url ?? ''); media.handleUpgrade(request, socket, head, ws => ws.on('message', value => ws.send(value)));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const address = upstream.address(); assert.ok(address && typeof address !== 'string');
  const invitations = new PairingInvitations({ key: nacl.box.keyPair().secretKey, credentials: { secret: 'fixture', token: 'fixture', deviceId: 'fixture' } });
  const options = { upstream: 'http://127.0.0.1:' + address.port, invitations,
    desktopMedia: async (/** @type {string} */ path) => {
      const url = new URL(path, 'http://fixture');
      if (url.searchParams.get('access_token') !== 'issued-fixture-token') throw Error('unauthorized');
      return { origin: 'http://127.0.0.1:' + address.port, path: url.pathname.endsWith('/v1') ? '/rtc/v1' : '/rtc', device: 'fixture' };
    } };
  const gateway = createPairingGateway(options);
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const listener = gateway.address(); assert.ok(listener && typeof listener !== 'string');
  t.after(async () => { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); media.close(); await new Promise(resolve => upstream.close(resolve)); });
  const origin = 'ws://127.0.0.1:' + listener.port;
  for (const path of ['/api/peer/desktop/media/rtc', '/api/peer/desktop/media/rtc/v1']) {
    const rejected = new WebSocket(origin + path + '?access_token=wrong');
    await assert.rejects(once(rejected, 'open')); rejected.terminate();
    const accepted = new WebSocket(origin + path + '?access_token=issued-fixture-token');
    await once(accepted, 'open'); const response = once(accepted, 'message'); accepted.send('opaque-native-signaling');
    assert.equal((await response)[0].toString(), 'opaque-native-signaling'); accepted.terminate();
  }
  assert.deepEqual(paths, ['/rtc', '/rtc/v1']);
  const unrelated = new WebSocket(origin + '/api/peer/desktop/media/other?access_token=issued-fixture-token');
  await assert.rejects(once(unrelated, 'open')); unrelated.terminate();
});
