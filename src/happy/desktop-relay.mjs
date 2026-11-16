import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { RoomServiceClient } from 'livekit-server-sdk';
import { BridgeError } from '../errors.mjs';

async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw Error('desktop-port-unavailable');
  const port = address.port; await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve(undefined))); return port;
}

/** Local media is an owned SFU process; external SFUs remain user-owned. */
export class DesktopRelay {
  /** @param {{binary:string,state:string}} options */
  constructor(options) { this.options = options; this.child = /** @type {import('node:child_process').ChildProcess|null} */ (null); this.configPath = ''; }
  /** @param {{mode:string,url:string,apiKey:string,apiSecret:string}} config */
  async start(config) {
    if (config.mode === 'external') return this.connection(config.url, config.apiKey, config.apiSecret);
    const port = await freePort(), tcpPort = await freePort();
    const apiKey = 'CL' + randomBytes(12).toString('hex'), apiSecret = randomBytes(32).toString('hex');
    await mkdir(this.options.state, { recursive: true, mode: 0o700 });
    this.configPath = join(this.options.state, 'livekit-' + randomBytes(12).toString('hex') + '.json');
    // Local signaling is loopback-only; ICE media must reach the paired LAN phone.
    const configuration = { port, bind_addresses: ['127.0.0.1'], rtc: { tcp_port: tcpPort, udp_port: tcpPort, use_external_ip: false },
      keys: { [apiKey]: apiSecret }, logging: { level: 'error' } };
    await writeFile(this.configPath, JSON.stringify(configuration), { mode: 0o600 });
    const child = spawn(this.options.binary, ['--config', this.configPath], { stdio: ['ignore', 'ignore', 'ignore'] }); this.child = child;
    let failed = false; child.once('error', () => { failed = true; }); child.once('exit', () => { failed = true; });
    const url = 'ws://127.0.0.1:' + port;
    const client = this.connection(url, apiKey, apiSecret);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !failed) {
      try { await client.rooms.listRooms(); return client; } catch { await new Promise(resolve => setTimeout(resolve, 150)); }
    }
    await this.close(); throw new BridgeError('desktop-relay-unavailable', 'The desktop media relay could not start.', 503);
  }
  /** @param {string} url @param {string} apiKey @param {string} apiSecret */
  connection(url, apiKey, apiSecret) {
    return { url, apiKey, apiSecret, rooms: new RoomServiceClient(url.replace(/^ws/u, 'http'), apiKey, apiSecret) };
  }
  async close() {
    const child = this.child; this.child = null;
    if (child && child.exitCode == null && child.signalCode == null) {
      const done = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000); await done; clearTimeout(timer);
    }
    if (this.configPath) { await unlink(this.configPath).catch(() => {}); this.configPath = ''; }
  }
}
