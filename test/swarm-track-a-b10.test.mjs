import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tunnelHealth } from '../src/codelync/tunnel-health.mjs';
import { GatewayMetrics } from '../src/codelync/gateway-metrics.mjs';
import { closeOwnedResources, stopOwnedChildren } from '../src/codelync/owned-shutdown.mjs';

/** @typedef {Record<string,any>} Value */

async function flush() {
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
}

test('R091: tunnelHealth validates DoH response.ok, enforces 16KB stream limit, and falls back with pinned servername', async t => {
  let mode = 'json-ok';
  let dohBytesDelivered = 0;
  const dohServer = createServer(async (_req, res) => {
    if (mode === 'http-502') {
      res.writeHead(502, { 'Content-Type': 'text/html' }).end('<html>bad gateway</html>');
      return;
    }
    if (mode === 'oversize-stream') {
      res.writeHead(200, { 'Content-Type': 'application/dns-json' });
      const chunk = Buffer.alloc(4096, 0x61);
      for (let i = 0; i < 16; i++) {
        if (res.destroyed || res.closed) break;
        dohBytesDelivered += chunk.length;
        res.write(chunk);
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/dns-json' })
      .end(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: '127.0.0.1' }] }));
  });
  dohServer.listen(0, '127.0.0.1');
  await once(dohServer, 'listening');
  t.after(async () => {
    dohServer.closeAllConnections?.();
    await new Promise(resolve => dohServer.close(resolve));
  });
  const addr = dohServer.address();
  assert.ok(addr && typeof addr !== 'string');
  const dohUrl = `http://127.0.0.1:${addr.port}/dns-query`;

  // Invalid origin and non-trycloudflare origin return false safely.
  assert.equal(await tunnelHealth('not a valid url', { fetch: async () => new Response('no', { status: 500 }) }), false);
  assert.equal(await tunnelHealth('https://example.com', { fetch: async () => new Response('no', { status: 500 }) }), false);

  // Direct /health 200 short-circuits cleanly and cancels unread body.
  let cancelledDirect = false;
  const directBody = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
    cancel() { cancelledDirect = true; },
  });
  assert.equal(await tunnelHealth('https://demo.trycloudflare.com', {
    fetch: async () => new Response(directBody, { status: 200 }),
  }), true);
  assert.equal(cancelledDirect, true);

  // Real local DoH 502 returns false cleanly instead of throwing SyntaxError.
  mode = 'http-502';
  assert.equal(await tunnelHealth('https://demo.trycloudflare.com', {
    dohUrl,
    fetch: async (input, init) => {
      if (String(input).startsWith('https://demo.trycloudflare.com')) throw new Error('ENOTFOUND');
      return globalThis.fetch(input, init);
    },
  }), false);

  // Oversized streaming DoH response aborts early without buffering full stream.
  mode = 'oversize-stream';
  dohBytesDelivered = 0;
  assert.equal(await tunnelHealth('https://demo.trycloudflare.com', {
    dohUrl,
    fetch: async (input, init) => {
      if (String(input).startsWith('https://demo.trycloudflare.com')) throw new Error('ENOTFOUND');
      return globalThis.fetch(input, init);
    },
  }), false);
  assert.ok(dohBytesDelivered < 64 * 1024);

  // Valid DoH A record triggers fallback httpsGet with exact TLS servername and resolved IPv4.
  mode = 'json-ok';
  /** @type {Value} */ let observedTls = {};
  const ok = await tunnelHealth('https://demo.trycloudflare.com', {
    dohUrl,
    fetch: async (input, init) => {
      if (String(input).startsWith('https://demo.trycloudflare.com')) throw new Error('ENOTFOUND');
      return globalThis.fetch(input, init);
    },
    httpsGet: /** @type {any} */ ((/** @type {Value} */ url, /** @type {Value} */ opts, /** @type {(res:Value)=>void} */ cb) => {
      opts.lookup('demo.trycloudflare.com', {}, (/** @type {unknown} */ _err, /** @type {string} */ ip) => {
        observedTls = { url: String(url), servername: opts.servername, ip };
      });
      const res = Object.assign(new EventEmitter(), { statusCode: 200, resume() {} });
      queueMicrotask(() => cb(res));
      return Object.assign(new EventEmitter(), { setTimeout() {}, destroy() {} });
    }),
  });
  assert.equal(ok, true);
  assert.deepEqual(observedTls, { url: 'https://demo.trycloudflare.com/health', servername: 'demo.trycloudflare.com', ip: '127.0.0.1' });
});

test('R091: GatewayMetrics backs off background flush retries after write errors while close() still flushes', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 0;
  let attempts = 0;
  let shouldFail = true;
  /** @type {Value[]} */ const saved = [];

  const metrics = new GatewayMetrics({
    path: '/fixture/metrics-backoff.json',
    clock: () => now,
    flushIntervalMs: 5000,
    writeThresholdBytes: 10,
    storage: {
      async read() { return null; },
      async write(_path, value) {
        attempts++;
        if (shouldFail) throw new Error('simulated ENOSPC');
        saved.push({ ...value });
      },
    },
  });
  t.after(() => metrics.close());

  const socket = Object.assign(new EventEmitter(), { bytesRead: 20, bytesWritten: 0, destroyed: false });
  metrics.trackSocket(/** @type {any} */ (socket));
  await flush();
  assert.equal(attempts, 1);
  assert.equal(metrics.flushFailures, 1);

  // Repeated snapshots & threshold triggers inside 5s backoff window do NOT hammer storage.write.
  for (let i = 0; i < 10; i++) {
    now += 200;
    socket.bytesRead += 50;
    metrics.snapshot();
    await flush();
  }
  assert.equal(attempts, 1);

  // Advance past initial 5s backoff (while storage still fails -> next backoff doubles to 10s).
  now = 5000;
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(attempts, 2);
  assert.equal(metrics.flushFailures, 2);

  // 5s later (now = 10000 < 15000), periodic timer respects doubled 10s backoff!
  now = 10_000;
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(attempts, 2);

  // Storage recovers before next retry; once 10s elapses (now = 15000), write succeeds and resets failure count.
  shouldFail = false;
  now = 15_000;
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(attempts, 3);
  assert.equal(metrics.flushFailures, 0);
  assert.equal(saved.length, 1);

  // Backoff active again, yet close() flushes immediately when storage recovers right before shutdown.
  shouldFail = true;
  socket.bytesRead += 50;
  metrics.snapshot();
  await flush();
  assert.equal(attempts, 4);
  shouldFail = false;
  socket.bytesRead += 25;
  await metrics.close();
  assert.equal(attempts, 5);
  assert.equal(saved[saved.length - 1].totalReceivedBytes, socket.bytesRead);
});

test('R096: stopOwnedChildren bounds post-SIGKILL exit wait and refuses lease release when child never exits', async () => {
  /** @type {Value} */ const stuckChild = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    killed: /** @type {string[]} */ ([]),
    kill(/** @type {string} */ signal) {
      this.killed.push(signal);
      return true;
    },
  });

  let leaseReleased = false;
  const startedAt = performance.now();
  await assert.rejects(
    closeOwnedResources([], () => stopOwnedChildren([/** @type {any} */ (stuckChild)], 15, 25), async () => {
      leaseReleased = true;
    }),
    /owned-child-stop-unconfirmed/,
  );
  const elapsed = performance.now() - startedAt;
  assert.deepEqual(stuckChild.killed, ['SIGTERM', 'SIGKILL']);
  assert.equal(leaseReleased, false);
  assert.ok(elapsed < 1000, `expected bounded post-SIGKILL timeout, took ${elapsed}ms`);
});

test('R096: mac-app-service discards >64KB stdin lines cleanly and keeps processing valid commands', async t => {
  const state = await mkdtemp(join(tmpdir(), 'codelync-b10-stdin-'));
  const child = spawn(process.execPath, [
    'src/codelync/mac-app-service.mjs',
    '--state=' + state,
    '--settings-only=1',
    '--node=/missing-test-node',
    '--backend=/missing-test-backend',
    '--cloudflared=/missing-test-tunnel',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await exit;
    await rm(state, { recursive: true, force: true });
  });

  let tail = '';
  /** @type {Value[]} */ const frames = [];
  child.stdout.on('data', chunk => {
    tail += chunk.toString();
    const lines = tail.split('\n');
    tail = lines.pop() ?? '';
    for (const line of lines) if (line) frames.push(JSON.parse(line));
  });

  const waitFor = async (/** @type {()=>boolean} */ predicate) => {
    for (let i = 0; i < 400; i++) {
      if (predicate()) return;
      if (child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(predicate(), 'expected frame was not emitted');
  };

  await waitFor(() => frames.some(f => f.type === 'settings-ready'));

  // Write an 80KB single line split across chunks (exceeds 65,536 byte cap), followed by a valid command.
  const oversizeHalf = 'x'.repeat(40_000);
  child.stdin.write('{"type":"unknown","pad":"' + oversizeHalf);
  await new Promise(resolve => setTimeout(resolve, 10));
  child.stdin.write(oversizeHalf + '"}\n');
  child.stdin.write(JSON.stringify({ type: 'set-source-subscriptions', requestId: 'b10-stdin-ok-1', apps: ['codex'] }) + '\n');

  await waitFor(() => frames.some(f => f.requestId === 'b10-stdin-ok-1'));
  const reply = frames.find(f => f.requestId === 'b10-stdin-ok-1');
  assert.equal(reply?.ok, true);
  const persisted = JSON.parse(await readFile(join(state, 'source-subscriptions.json'), 'utf8'));
  assert.deepEqual(persisted.enabledApps, ['codex']);

  child.stdin.end();
  assert.equal((await exit)[0], 0);
});
