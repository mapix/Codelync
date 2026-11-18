import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { createRequire } from 'node:module';
import WebSocket, { WebSocketServer } from 'ws';
import { RelayChannel, WINDOW_BYTES, FRAME_BYTES, streamId } from '../src/network/relay-protocol.mjs';
import { RelayTunnelClient } from '../src/network/relay-client.mjs';
import { createNetworkRelay } from '../src/network/relay-server.mjs';
import { CodelyncSessionTransport, CodelyncTransportError } from '../src/codelync/session-transport.mjs';

/** @typedef {Record<string,any>} Value */

test('R011: RelayChannel.pipe slices chunks exceeding WINDOW_BYTES and skips empty chunks cleanly', async t => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', perMessageDeflate: false });
  await once(wss, 'listening');
  const address = wss.address();
  assert.ok(address && typeof address !== 'string');

  let serverChannel = /** @type {RelayChannel | null} */ (null);
  const receivedChunks = /** @type {Buffer[]} */ ([]);
  const sink = new PassThrough();
  sink.on('data', chunk => receivedChunks.push(chunk));
  let ended = false;
  const endPromise = new Promise(resolve => {
    sink.on('end', () => { ended = true; resolve(undefined); });
  });

  const id = streamId();
  wss.on('connection', ws => {
    serverChannel = new RelayChannel(ws, () => {});
    const stream = serverChannel.add(id, {});
    stream.writable = sink;
  });

  const clientWs = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await once(clientWs, 'open');
  const clientChannel = new RelayChannel(clientWs, () => {});
  const clientStream = clientChannel.add(id, { bodyLimit: 2 * 1024 * 1024 });

  t.after(async () => {
    clientChannel.close();
    serverChannel?.close();
    clientWs.terminate();
    for (const c of wss.clients) c.terminate();
    await new Promise(resolve => wss.close(resolve));
  });

  // Push empty chunk + chunk > WINDOW_BYTES (512 KiB > 256 KiB) to verify frame slicing and no 1008 close.
  const large = randomBytes(WINDOW_BYTES * 2 + 123);
  const source = new Readable({
    read() {
      this.push(Buffer.alloc(0));
      this.push(large);
      this.push(null);
    },
  });
  clientChannel.pipe(clientStream, source);

  await endPromise;
  assert.equal(ended, true);
  assert.equal(clientWs.readyState, WebSocket.OPEN);
  const combined = Buffer.concat(receivedChunks);
  assert.equal(combined.length, large.length);
  assert.equal(createHash('sha256').update(combined).digest('hex'), createHash('sha256').update(large).digest('hex'));

  // Sending a frame that would exceed bodyLimit drops before emitting the excess frame.
  const overId = streamId();
  const overStream = clientChannel.add(overId, { bodyLimit: 100 });
  assert.ok(FRAME_BYTES > 100);
  let aborted = false;
  overStream.onAbort = () => { aborted = true; };
  const overSource = Readable.from([Buffer.alloc(101, 1)]);
  clientChannel.pipe(overStream, overSource);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(aborted, true);
});

test('R011: RelayTunnelClient prevents overlapping sockets in pauseReconnect/connect and fences stale errors', async t => {
  const backend = createServer((_req, res) => res.end('ok'));
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const backendAddr = backend.address();
  assert.ok(backendAddr && typeof backendAddr !== 'string');

  // Custom WS relay endpoint that stalls the registration challenge so the socket remains OPEN & !ready.
  let tunnelConnections = 0;
  let closedTunnelConnections = 0;
  const server = createServer((req, res) => {
    if (req.url === '/relay/v1/info') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ service: 'codelync-network-relay', version: 1, http: true, websocket: true, requiresToken: true }));
      return;
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/relay/v1/tunnel') {
      wss.handleUpgrade(req, socket, head, ws => {
        tunnelConnections++;
        ws.once('close', () => { closedTunnelConnections++; });
      });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const relayAddr = server.address();
  assert.ok(relayAddr && typeof relayAddr !== 'string');

  const client = new RelayTunnelClient({
    serverUrl: `http://127.0.0.1:${relayAddr.port}`,
    token: 't'.repeat(43),
    seed: randomBytes(32),
    upstream: `http://127.0.0.1:${backendAddr.port}`,
  });

  let disconnectEvents = 0;
  client.on('disconnected', () => { disconnectEvents++; });

  t.after(async () => {
    client.close();
    for (const c of wss.clients) c.terminate();
    wss.close();
    server.closeAllConnections();
    backend.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => backend.close(resolve));
  });

  client.activate();
  client.delay = 20;
  const startPromise = client.start();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(tunnelConnections, 1);

  // Calling pauseReconnect(false) while socket is still OPEN/CONNECTING must NOT arm an overlapping timer.
  client.pauseReconnect(false);
  assert.equal(client.timer, null);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(tunnelConnections, 1);

  // Calling connect() directly replaces and terminates the previous socket cleanly and fences its close/error events.
  const firstSocket = client.socket;
  client.connect();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(tunnelConnections, 2);
  assert.equal(closedTunnelConnections, 1);
  assert.equal(disconnectEvents, 0);
  firstSocket?.emit('error', new Error('stale-error'));

  // Also test real network relay roundtrip remains intact.
  client.close();
  await assert.rejects(startPromise, /relay-closed/);

  const realRelay = createNetworkRelay({ token: 't'.repeat(43) });
  realRelay.listen(0, '127.0.0.1');
  await once(realRelay, 'listening');
  const realAddr = realRelay.address();
  assert.ok(realAddr && typeof realAddr !== 'string');
  const realClient = new RelayTunnelClient({
    serverUrl: `http://127.0.0.1:${realAddr.port}`,
    token: 't'.repeat(43),
    seed: randomBytes(32),
    upstream: `http://127.0.0.1:${backendAddr.port}`,
  });
  t.after(() => {
    realClient.close();
    realRelay.close();
  });
  const base = await realClient.start();
  assert.equal(await (await fetch(base + '/health')).text(), 'ok');
});

test('R016: #fetch normalizes malformed transfer URLs and rejects oversized Content-Length before reading body', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codelync-r016-fetch-'));
  const token = 'fixture-token';
  const key = new Uint8Array(32).fill(9);
  const sessionId = 'session-r016';
  let bodyBytesReadOnOversized = 0;

  let downloadUrlMode = /** @type {'malformed'|'oversized'} */ ('malformed');
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === `/v1/sessions/${sessionId}/messages`) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ messages: [], hasMore: false }));
      return;
    }
    if (url.pathname === `/v1/sessions/${sessionId}/attachments/request-download`) {
      res.setHeader('Content-Type', 'application/json');
      const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
      res.end(JSON.stringify({
        downloadUrl: downloadUrlMode === 'malformed' ? 'not-a-valid-url' : `http://127.0.0.1:${addr.port}/huge-blob`,
      }));
      return;
    }
    if (url.pathname === '/huge-blob') {
      // Declare 20 MiB > 10 MiB limit and refuse to send body if client cancels promptly.
      res.writeHead(200, { 'Content-Length': String(20 * 1024 * 1024) });
      res.flushHeaders();
      req.on('close', () => { bodyBytesReadOnOversized = res.socket?.bytesWritten ?? 0; });
      return;
    }
    res.writeHead(404).end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');

  const transport = new CodelyncSessionTransport({
    serverOrigin: `http://127.0.0.1:${addr.port}`,
    token,
    sessionId,
    encryptionKey: key,
    statePath: join(dir, 'checkpoint.json'),
    pollMs: 0,
    requestTimeoutMs: 2000,
  });

  t.after(async () => {
    await transport.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  await transport.start({ connectSocket: false });
  const ref = `sessions/${sessionId}/attachments/00000000-0000-0000-0000-000000000001.enc`;

  downloadUrlMode = 'malformed';
  await assert.rejects(
    transport.downloadAttachment(ref),
    err => err instanceof CodelyncTransportError && err.code === 'invalid-sync-url',
  );

  downloadUrlMode = 'oversized';
  await assert.rejects(
    transport.downloadAttachment(ref),
    err => err instanceof CodelyncTransportError && err.code === 'sync-response-limit',
  );
  assert.ok(bodyBytesReadOnOversized < 4096);
});

test('R016: transport.close() settles promptly despite unacked field or RPC emitWithAck and releases statePath', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codelync-r016-close-'));
  const require = createRequire(new URL('../packages/relay/package.json', import.meta.url));
  const { Server } = require(['socket', 'io'].join('.'));

  const backend = createServer((req, res) => {
    if (req.url?.includes('/messages')) {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET') res.end(JSON.stringify({ messages: [], hasMore: false }));
      else res.end(JSON.stringify({ messages: [] }));
      return;
    }
    res.writeHead(404).end('{}');
  });
  const ioServer = new Server(backend, { path: '/v1/updates', transports: ['websocket'] });
  ioServer.on('connection', (/** @type {Value} */ socket) => {
    // Intentionally never invoke ack callback for update-metadata or rpc-call.
    socket.on('update-metadata', () => {});
    socket.on('rpc-call', () => {});
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const addr = backend.address();
  assert.ok(addr && typeof addr !== 'string');

  const statePath = join(dir, 'checkpoint.json');
  const options = {
    serverOrigin: `http://127.0.0.1:${addr.port}`,
    token: 'fixture-token',
    sessionId: 'session-r016-close',
    encryptionKey: new Uint8Array(32).fill(5),
    statePath,
    pollMs: 0,
    requestTimeoutMs: 10000,
  };
  const first = new CodelyncSessionTransport(options);

  t.after(async () => {
    await first.close().catch(() => {});
    ioServer.close();
    backend.closeAllConnections();
    await new Promise(resolve => backend.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  await first.start({ connectSocket: true });
  const fieldFlight = first.updateMetadata({ summary: 'pending-ack' });
  const rpcFlight = first.callRpc('slowMethod', { a: 1 });

  // Give Socket.IO a moment to send the packets before closing.
  await new Promise(resolve => setTimeout(resolve, 25));

  const startedClose = Date.now();
  await first.close();
  const elapsedMs = Date.now() - startedClose;
  assert.ok(elapsedMs < 1500, `close() took ${elapsedMs}ms instead of aborting unacked flights promptly`);

  await assert.rejects(fieldFlight, { code: 'sync-state-unconfirmed' });
  await assert.rejects(rpcFlight, { code: 'delivery-unknown' });

  // Owner lock on statePath is released immediately upon close.
  const second = new CodelyncSessionTransport(options);
  try {
    await second.start({ connectSocket: false });
  } finally {
    await second.close();
  }
});
