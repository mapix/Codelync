import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import { channelPath } from '@codelync/wire/codelync';
import { decodeCompactPeerPlaintext, PEER_RESPONSE_CODEC_HEADER, PEER_RESPONSE_CODEC_VALUE } from '@codelync/wire/peer-codec';
import { BridgeError } from '../src/errors.mjs';
import { DesktopHostProcess } from '../src/codelync/desktop-host.mjs';
import {
  RemoteDesktop,
  desktopDisplayId,
  desktopViewport,
  desktopInput,
  desktopWindowRequest,
} from '../src/codelync/remote-desktop.mjs';
import { MacConnectionService } from '../src/codelync/mac-connection-service.mjs';
import { ConnectionChannelsManager } from '../src/network/connection-channels.mjs';
import { PairingInvitations, createPairingGateway } from '../src/codelync/pairing-gateway.mjs';
import { DeviceRegistry } from '../src/codelync/device-registry.mjs';

/** @typedef {Record<string,any>} Value */

const FAKE_HOST_SOURCE = [
  "import { createInterface } from 'node:readline';",
  'const argv = process.argv.slice(2);',
  'const reader = createInterface({ input: process.stdin });',
  'function makeWindows(count) {',
  '  const rows = [];',
  '  for (let i = 1; i <= count; i++) {',
  '    rows.push({',
  '      id: (1000 + i) + ":" + (5000 + i),',
  '      pid: 1000 + i,',
  '      windowId: 5000 + i,',
  '      appName: "WorkspaceEditorApp_" + i,',
  '      bundleId: "example.codelync.editor.app" + i,',
  '      title: "ProjectDocument_" + i + "_" + "w".repeat(420) + ".swift",',
  '      bounds: { x: 40 + (i % 10) * 12, y: 60 + (i % 8) * 14, width: 1280, height: 820 },',
  '      minimized: i % 7 === 0,',
  '      onVirtualDisplay: i === 1,',
  '    });',
  '  }',
  '  return rows;',
  '}',
  "reader.on('line', line => {",
  '  let msg; try { msg = JSON.parse(line); } catch { return; }',
  "  if (msg.behavior === 'hang') return;",
  "  if (msg.behavior === 'crash') { process.exit(1); }",
  "  if (msg.behavior === 'domain-error') {",
  '    const payload = msg.omitError ? { id: msg.id, ok: false } : { id: msg.id, ok: false, error: msg.code };',
  "    process.stdout.write(JSON.stringify(payload) + '\\n');",
  '    return;',
  '  }',
  "  if (msg.behavior === 'oversized-and-primitives-then-reply') {",
  "    process.stdout.write('null\\n');",
  "    process.stdout.write('[]\\n');",
  "    process.stdout.write('42\\n');",
  "    process.stdout.write('{not-json}\\n');",
  "    process.stdout.write(JSON.stringify({ id: 12345, ok: true, result: { ignoredNumericId: true } }) + '\\n');",
  "    process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { pad: 'x'.repeat(270_000) } }) + '\\n');",
  "    process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { survived: true, argv } }) + '\\n');",
  '    return;',
  '  }',
  "  if (msg.behavior === 'windows-large' || (msg.operation === 'windows' && process.env.FAKE_HOST_LARGE_WINDOWS === '1')) {",
  '    const windows = makeWindows(msg.count ?? 130);',
  "    process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { windows, activeWindowId: '1001:5001' } }) + '\\n');",
  '    return;',
  '  }',
  "  if (msg.operation === 'displays') {",
  '    process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {',
  '      argv,',
  "      displays: [{ id: 'virtual', name: 'Phone Screen', kind: 'virtual', width: 1080, height: 2160, logicalWidth: 540, logicalHeight: 1080, geometry: 'v-geo-1' }],",
  '      permissions: { screenRecording: true, accessibility: true, locked: false },',
  '      virtualDisplaySupported: true,',
  "    } }) + '\\n');",
  '    return;',
  '  }',
  "  if (msg.operation === 'start' || msg.operation === 'heartbeat') {",
  '    process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {',
  '      capturing: true, connected: true, viewerConnected: true,',
  '      permissions: { screenRecording: true, accessibility: true, locked: false },',
  "      display: { id: 'virtual', name: 'Phone Screen', kind: 'virtual', width: 1080, height: 2160, logicalWidth: 540, logicalHeight: 1080, geometry: 'v-geo-1' },",
  "      geometry: 'v-geo-1', trackSid: 'track-sub-1', viewPending: false,",
  "    } }) + '\\n');",
  '    return;',
  '  }',
  "  if (msg.operation === 'window' && msg.windowId === '9999:9999') return;",
  "  process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { argv, operation: msg.operation } }) + '\\n');",
  '});',
  "process.stdin.on('end', () => process.exit(0));",
].join('\n');

/** @param {import('node:test').TestContext} t */
async function createFakeHostBinary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'codelync-virtual-host-'));
  const scriptPath = join(dir, 'fake-host.mjs');
  const shPath = join(dir, 'fake-host.sh');
  await writeFile(scriptPath, FAKE_HOST_SOURCE, 'utf8');
  await writeFile(shPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, { mode: 0o755 });
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  return { dir, shPath };
}

/** @param {{width:number,height:number}} viewport @param {number} [minLogicalWidth] @param {number} [rev] */
function computeVirtualDisplay(viewport, minLogicalWidth = 540, rev = 1) {
  const ratio = Math.min(2.5, Math.max(1.0, viewport.height / viewport.width));
  let logicalWidth = 1080;
  for (let candidate = Math.max(540, minLogicalWidth); candidate <= 1080; candidate += 10) {
    if (Math.round(candidate * ratio) >= 800) {
      logicalWidth = candidate;
      break;
    }
  }
  const logicalHeight = Math.round(logicalWidth * ratio);
  return {
    id: 'virtual',
    name: 'Phone Screen',
    kind: 'virtual',
    width: logicalWidth * 2,
    height: logicalHeight * 2,
    logicalWidth,
    logicalHeight,
    geometry: 'virtual-geo-' + rev,
  };
}

/** @param {import('node:test').TestContext} t @param {Value} [overrides] */
async function virtualDesktopFixture(t, overrides = {}) {
  const state = await mkdtemp(join(tmpdir(), 'codelync-virtual-desktop-'));
  const mac = nacl.box.keyPair(), phone = nacl.box.keyPair(), other = nacl.box.keyPair();
  const devices = Object.assign(new EventEmitter(), {
    revoked: false,
    publicKey(/** @type {string} */ id) {
      if (id === 'phone' && !this.revoked) return Buffer.from(phone.publicKey).toString('base64url');
      if (id === 'other') return Buffer.from(other.publicKey).toString('base64url');
      return null;
    },
  });
  const calls = /** @type {Value[]} */ ([]);
  const relayCalls = /** @type {Value[]} */ ([]);
  const permissions = { screenRecording: true, accessibility: true, locked: false, ...(overrides.permissions ?? {}) };
  const physical1 = { id: '1', name: 'Main display', kind: 'physical', width: 3000, height: 2000, geometry: 'phys-geo-1' };
  const physical2 = { id: '2', name: 'Display 2', kind: 'physical', width: 2560, height: 1440, geometry: 'phys-geo-2' };
  let virtualSupported = overrides.virtualDisplaySupported !== undefined ? overrides.virtualDisplaySupported : true;
  let omitVirtualSupportedProp = Boolean(overrides.omitVirtualSupportedProp);
  let omitVirtualRow = Boolean(overrides.omitVirtualRow);
  const physicalDisplays = /** @type {Value[]} */ (overrides.physicalDisplays ?? [physical1, physical2]);

  let geoRev = 1;
  let track = 0;
  let lastViewport = { width: 540, height: 1080 };
  let virtualRow = computeVirtualDisplay(lastViewport, 540, geoRev);
  let currentDisplay = /** @type {Value} */ (physicalDisplays[0] ?? virtualRow);
  let activeWindowId = /** @type {string|null} */ (null);
  let nextWindowFailure = /** @type {{error:Error,invalidateFirst?:boolean}|null} */ (null);
  let windowsResultOverride = /** @type {Value|null} */ (null);
  let displaysResultOverride = /** @type {{set:boolean,value:unknown}|null} */ (null);
  let nextDisplayResult = /** @type {Value|null} */ (null);
  let pendingAsyncUpshiftWidth = /** @type {number|null} */ (null);
  let viewPending = false;

  const sampleWindows = [
    {
      id: '1001:5001', pid: 1001, windowId: 5001, appName: 'Notes', bundleId: 'com.apple.Notes',
      title: 'Design Notes', bounds: { x: 80, y: 80, width: 520, height: 900 }, minimized: false, onVirtualDisplay: false,
    },
    {
      id: '1002:5002', pid: 1002, windowId: 5002, appName: 'Xcode', bundleId: 'com.apple.dt.Xcode',
      title: 'Workspace.xcodeproj', bounds: { x: 120, y: 100, width: 700, height: 1100 }, minimized: false, onVirtualDisplay: false,
    },
  ];

  const host = Object.assign(new EventEmitter(), {
    async request(/** @type {string} */ operation, /** @type {Value} */ value = {}) {
      calls.push({ operation, value });
      if (operation === 'displays') {
        if (displaysResultOverride?.set) return displaysResultOverride.value;
        const rows = [...physicalDisplays];
        if (virtualSupported && !omitVirtualRow) rows.push(virtualRow);
        return omitVirtualSupportedProp
          ? { displays: rows, permissions }
          : { displays: rows, permissions, virtualDisplaySupported: virtualSupported };
      }
      if (operation === 'start') {
        track++;
        if (value.displayId === 'virtual') {
          if (!virtualSupported) throw new BridgeError('desktop-virtual-display-unavailable', 'Unavailable.', 409);
          lastViewport = value.viewport ?? { width: 540, height: 1080 };
          virtualRow = computeVirtualDisplay(lastViewport, 540, ++geoRev);
          currentDisplay = virtualRow;
        } else {
          const found = physicalDisplays.find(row => row.id === value.displayId);
          if (!found) throw new BridgeError('desktop-display-unavailable', 'Unavailable.', 503);
          currentDisplay = { ...found };
        }
        return {
          capturing: true, connected: true, viewerConnected: true, permissions,
          display: currentDisplay, geometry: currentDisplay.geometry, trackSid: 'track-' + track, viewPending: false,
        };
      }
      if (operation === 'display') {
        if (nextDisplayResult) {
          const override = nextDisplayResult;
          nextDisplayResult = null;
          track++;
          const resolvedTrackSid = override.trackSid !== undefined ? override.trackSid : 'track-' + track;
          if (override.adoptInMock && override.display && typeof override.display === 'object') {
            activeWindowId = null;
            currentDisplay = override.display;
          }
          const rest = { ...override };
          delete rest.adoptInMock;
          return {
            capturing: true, connected: true, viewerConnected: true, permissions, viewPending: false,
            ...rest,
            trackSid: resolvedTrackSid,
          };
        }
        track++;
        if (value.displayId === 'virtual') {
          if (!virtualSupported) throw new BridgeError('desktop-virtual-display-unavailable', 'Unavailable.', 409);
          lastViewport = value.viewport ?? { width: 540, height: 1080 };
          virtualRow = computeVirtualDisplay(lastViewport, 540, ++geoRev);
          currentDisplay = virtualRow;
        } else {
          activeWindowId = null;
          const found = physicalDisplays.find(row => row.id === value.displayId);
          if (!found) throw new BridgeError('desktop-display-unavailable', 'Unavailable.', 503);
          // Physical displays omit kind/logicalWidth/logicalHeight on legacy/minimal responses to test non-bleed.
          currentDisplay = { id: found.id, name: found.name, width: found.width, height: found.height, geometry: found.geometry };
        }
        return {
          capturing: true, connected: true, viewerConnected: true, permissions,
          display: currentDisplay, geometry: currentDisplay.geometry, trackSid: 'track-' + track, viewPending: false,
        };
      }
      if (operation === 'heartbeat') {
        if (pendingAsyncUpshiftWidth !== null) {
          virtualRow = computeVirtualDisplay(lastViewport, pendingAsyncUpshiftWidth, ++geoRev);
          currentDisplay = virtualRow;
          pendingAsyncUpshiftWidth = null;
          track++;
          viewPending = false;
        } else if (viewPending) {
          track++;
          viewPending = false;
        }
        return {
          capturing: true, connected: true, viewerConnected: true, permissions,
          display: currentDisplay, geometry: currentDisplay.geometry, trackSid: 'track-' + track, viewPending: false,
        };
      }
      if (operation === 'quality') {
        track++;
        return {
          capturing: true, connected: true, viewerConnected: true, permissions,
          display: currentDisplay, geometry: currentDisplay.geometry, trackSid: 'track-' + track, viewPending: false,
        };
      }
      if (operation === 'space') {
        currentDisplay = { ...currentDisplay, geometry: currentDisplay.id + '-space-' + ++geoRev };
        host.emit('view-invalidated', value.connectionId);
        track++;
        return {
          capturing: true, connected: true, viewerConnected: true, permissions,
          display: currentDisplay, geometry: currentDisplay.geometry, trackSid: 'track-' + track,
          viewPending: false, accepted: true, spaceChanged: true, kind: value.kind,
        };
      }
      if (operation === 'windows') {
        if (windowsResultOverride) return windowsResultOverride;
        return {
          windows: sampleWindows.map(win => ({ ...win, onVirtualDisplay: win.id === activeWindowId })),
          activeWindowId,
        };
      }
      if (operation === 'window') {
        if (nextWindowFailure) {
          const pendingFailure = nextWindowFailure;
          nextWindowFailure = null;
          if (pendingFailure.invalidateFirst) {
            viewPending = true;
            host.emit('view-invalidated', value.connectionId);
          }
          throw pendingFailure.error;
        }
        let upshifted = false;
        if (value.mode === 'fill') {
          activeWindowId = value.windowId;
          if (value.windowId === '1002:5002' && (currentDisplay.logicalWidth ?? 540) < 720) {
            upshifted = true;
            virtualRow = computeVirtualDisplay(lastViewport, 720, ++geoRev);
          } else {
            virtualRow = computeVirtualDisplay(lastViewport, currentDisplay.logicalWidth ?? 540, ++geoRev);
          }
          currentDisplay = virtualRow;
        } else {
          activeWindowId = null;
          virtualRow = computeVirtualDisplay(lastViewport, currentDisplay.logicalWidth ?? 540, ++geoRev);
          currentDisplay = virtualRow;
        }
        host.emit('view-invalidated', value.connectionId);
        track++;
        viewPending = false;
        return {
          capturing: true, connected: true, viewerConnected: true, permissions,
          display: currentDisplay, geometry: currentDisplay.geometry, trackSid: 'track-' + track,
          viewPending: false, activeWindowId, upshifted,
        };
      }
      if (operation === 'input') {
        return { accepted: true, sequence: value.sequence };
      }
      if (operation === 'stop') {
        activeWindowId = null;
        return { stopped: true };
      }
      return { ok: true };
    },
    async close() { calls.push({ operation: 'close' }); },
  });

  const rooms = {
    async createRoom(/** @type {Value} */ value) { relayCalls.push({ create: value }); },
    async deleteRoom(/** @type {string} */ value) { relayCalls.push({ delete: value }); },
  };
  const relay = {
    async start() {
      relayCalls.push({ start: true });
      return { url: 'ws://127.0.0.1:7999', apiKey: 'test-api-key', apiSecret: 'a'.repeat(64), rooms };
    },
    async close() { relayCalls.push({ close: true }); },
  };
  const desktop = new RemoteDesktop({
    state,
    devices,
    macSecretKey: mac.secretKey,
    hostBinary: '/unused-binary',
    relayBinary: '/unused-relay',
    hostFactory: () => host,
    relayFactory: () => relay,
  });
  t.after(async () => {
    await desktop.close();
    await rm(state, { recursive: true, force: true });
  });

  const seal = (/** @type {string} */ action, /** @type {Value} */ value = {}, pair = phone) => {
    const nonce = randomBytes(24);
    const plaintext = Buffer.from(JSON.stringify({ version: 1, at: Date.now(), action, ...value }));
    return {
      version: 1,
      nonce: nonce.toString('base64url'),
      ciphertext: Buffer.from(nacl.box(plaintext, nonce, mac.publicKey, pair.secretKey)).toString('base64url'),
    };
  };
  const sealRawJson = (/** @type {string} */ rawJson, pair = phone) => {
    const nonce = randomBytes(24);
    const plaintext = Buffer.from(rawJson, 'utf8');
    return {
      version: 1,
      nonce: nonce.toString('base64url'),
      ciphertext: Buffer.from(nacl.box(plaintext, nonce, mac.publicKey, pair.secretKey)).toString('base64url'),
    };
  };
  const request = (/** @type {string} */ action, /** @type {Value} */ value = {}, device = 'phone', pair = phone) =>
    desktop.api(action, 'POST', seal(action, value, pair), device, 'https://paired.example');

  const connectPhysical = async () => {
    await desktop.configure({ enabled: true });
    const grant = await request('join', { displayId: '1' });
    const binding = { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry };
    await request('ready', { ...binding, trackSid: grant.trackSid });
    return { grant, binding };
  };

  const connectVirtual = async (/** @type {{width:number,height:number}|undefined} */ viewport = undefined) => {
    await desktop.configure({ enabled: true });
    const joinPayload = viewport === undefined ? { displayId: 'virtual' } : { displayId: 'virtual', viewport };
    const grant = await request('join', joinPayload);
    const binding = { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry };
    await request('ready', { ...binding, trackSid: grant.trackSid });
    return { grant, binding };
  };

  return {
    state, mac, phone, other, devices, desktop, host, calls, relayCalls,
    seal, sealRawJson, request, connectPhysical, connectVirtual,
    setVirtualSupported: (/** @type {boolean} */ v) => { virtualSupported = v; },
    setOmitVirtualSupportedProp: (/** @type {boolean} */ v) => { omitVirtualSupportedProp = v; },
    setOmitVirtualRow: (/** @type {boolean} */ v) => { omitVirtualRow = v; },
    failNextWindow: (/** @type {Error} */ error, invalidateFirst = false) => {
      nextWindowFailure = { error, invalidateFirst };
    },
    setWindowsOverride: (/** @type {Value|null} */ v) => { windowsResultOverride = v; },
    setDisplaysOverride: (/** @type {unknown} */ value) => { displaysResultOverride = { set: true, value }; },
    clearDisplaysOverride: () => { displaysResultOverride = null; },
    setNextDisplayResult: (/** @type {Value|null} */ v) => { nextDisplayResult = v; },
    scheduleAsyncUpshift: (/** @type {number} */ width) => {
      pendingAsyncUpshiftWidth = width;
      viewPending = true;
      if (desktop.active) host.emit('view-invalidated', desktop.active.id);
    },
  };
}

class LoopbackTunnel extends EventEmitter {
  /** @param {string} origin */
  constructor(origin) { super(); this.origin = origin; }
  async start() { return this.origin; }
  activate() {}
  close() {}
}

/** @param {()=>boolean} predicate */
async function waitUntil(predicate) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(predicate());
}

/** @param {import('node:test').TestContext} t */
async function gatewayDesktopFixture(t) {
  const state = await mkdtemp(join(tmpdir(), 'codelync-virtual-gw-'));
  const phone = nacl.box.keyPair(), mac = nacl.box.keyPair();
  const token = 'synthetic-device-token';
  const account = { secret: randomBytes(32).toString('base64url') };
  const devices = new DeviceRegistry(join(state, 'devices.json'));
  const deviceId = await devices.approve(Buffer.from(phone.publicKey).toString('base64url'), 'Fixture phone', token);
  const invitations = new PairingInvitations({ key: mac.secretKey, credentials: { ...account, token, deviceId } });

  const backend = createServer((_req, res) => { res.end('ok'); });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const backendAddr = backend.address();
  assert.ok(backendAddr && typeof backendAddr !== 'string');

  let activeWindowId = /** @type {string|null} */ (null);
  let track = 0;
  let geoRev = 1;
  let largeWindows = false;
  const permissions = { screenRecording: true, accessibility: true, locked: false };
  const host = Object.assign(new EventEmitter(), {
    async request(/** @type {string} */ operation, /** @type {Value} */ value = {}) {
      if (operation === 'displays') {
        return {
          displays: [{ id: 'virtual', name: 'Phone Screen', kind: 'virtual', width: 1080, height: 2160, logicalWidth: 540, logicalHeight: 1080, geometry: 'v-gw-' + geoRev }],
          permissions,
          virtualDisplaySupported: true,
        };
      }
      if (operation === 'start' || operation === 'heartbeat') {
        if (operation === 'start') track++;
        const disp = { id: 'virtual', name: 'Phone Screen', kind: 'virtual', width: 1080, height: 2160, logicalWidth: 540, logicalHeight: 1080, geometry: 'v-gw-' + geoRev };
        return { capturing: true, connected: true, viewerConnected: true, permissions, display: disp, geometry: disp.geometry, trackSid: 'track-' + track, viewPending: false };
      }
      if (operation === 'windows') {
        const count = largeWindows ? 130 : 2;
        const windows = [];
        for (let i = 1; i <= count; i++) {
          windows.push({
            id: `${2000 + i}:${6000 + i}`,
            pid: 2000 + i,
            windowId: 6000 + i,
            appName: 'App_' + i,
            bundleId: 'example.app.' + i,
            title: 'Window_' + i + '_' + 'z'.repeat(largeWindows ? 350 : 10),
            bounds: { x: 0, y: 25, width: 540, height: 1055 },
            minimized: false,
            onVirtualDisplay: `${2000 + i}:${6000 + i}` === activeWindowId,
          });
        }
        return { windows, activeWindowId };
      }
      if (operation === 'window') {
        activeWindowId = value.mode === 'fill' ? value.windowId : null;
        geoRev++;
        track++;
        const disp = { id: 'virtual', name: 'Phone Screen', kind: 'virtual', width: 1200, height: 2400, logicalWidth: 600, logicalHeight: 1200, geometry: 'v-gw-' + geoRev };
        return {
          capturing: true, connected: true, viewerConnected: true, permissions,
          display: disp, geometry: disp.geometry, trackSid: 'track-' + track, viewPending: false,
          activeWindowId, upshifted: true,
        };
      }
      if (operation === 'stop') return { stopped: true };
      return { ok: true };
    },
    async close() {},
  });
  const relay = {
    async start() {
      return {
        url: 'ws://127.0.0.1:7999',
        apiKey: 'test-api-key',
        apiSecret: 'a'.repeat(64),
        rooms: { async createRoom() {}, async deleteRoom() {} },
      };
    },
    async close() {},
  };
  const remoteDesktop = new RemoteDesktop({
    state: join(state, 'desktop'),
    devices,
    macSecretKey: mac.secretKey,
    hostBinary: '/unused',
    relayBinary: '/unused',
    hostFactory: () => host,
    relayFactory: () => relay,
  });
  await remoteDesktop.configure({ enabled: true });

  const daemon = {
    sources: new Map(),
    actors: new Map(),
    closed: false,
    ownsLease: true,
    inventoryAvailable: true,
    registrationAvailable: true,
    machine: { id: 'machine-fixture' },
    useSource: async (/** @type {string} */ _key, /** @type {()=>Promise<Value>} */ op) => op(),
    prepareSource: async () => ({}),
    startSource: async () => {},
  };
  const lan = { en0: [{ address: '192.168.50.2', family: 'IPv4', internal: false }] };
  const service = new MacConnectionService({
    state,
    cloudflared: 'unused',
    upstream: 'http://127.0.0.1:' + backendAddr.port,
    account,
    devices,
    invitations,
    remoteDesktop,
    networkWatchMs: 0,
    daemon: /** @type {import('../src/codelync/mac-daemon.mjs').CodelyncMacDaemon} */ (/** @type {unknown} */ (daemon)),
    interfaces: () => lan,
    gatewayFactory: options => {
      const server = createPairingGateway(options);
      const listen = server.listen.bind(server);
      server.listen = /** @type {typeof server.listen} */ ((/** @type {number} */ port) => listen(port, '127.0.0.1'));
      return server;
    },
    managerFactory: options => new ConnectionChannelsManager({
      ...options,
      transportFactory: config => new LoopbackTunnel(config.kind === 'relay' ? config.serverUrl + '/r/' + 'a'.repeat(24) : 'https://fixture-public.example'),
      probesFor: () => ({ verify: async () => {} }),
    }),
  });

  t.after(async () => {
    await remoteDesktop.close();
    await service.close();
    invitations.close();
    backend.closeAllConnections();
    await new Promise(resolve => backend.close(resolve));
    await rm(state, { recursive: true, force: true });
  });

  await service.start();
  await waitUntil(() => service.candidates().some(row => row.kind === 'local'));
  const channel = service.candidates().find(row => row.kind === 'local');
  assert.ok(channel);
  const peerId = service.peerId();

  const authHeader = (/** @type {string} */ path, method = 'POST') => {
    const nonce = randomBytes(24);
    const payload = { version: 2, token, origin: channel.url, method, path: channelPath(channel.url, channel.url + path), at: Date.now() };
    const boxed = nacl.box(Buffer.from(JSON.stringify(payload)), nonce, mac.publicKey, phone.secretKey);
    return 'Codelync ' + Buffer.from(JSON.stringify({
      publicKey: Buffer.from(phone.publicKey).toString('base64url'),
      nonce: nonce.toString('base64url'),
      ciphertext: Buffer.from(boxed).toString('base64url'),
    })).toString('base64url');
  };

  const sealDesktop = (/** @type {string} */ action, /** @type {Value} */ value = {}) => {
    const nonce = randomBytes(24);
    const plaintext = Buffer.from(JSON.stringify({ version: 1, at: Date.now(), action, ...value }));
    return {
      version: 1,
      nonce: nonce.toString('base64url'),
      ciphertext: Buffer.from(nacl.box(plaintext, nonce, mac.publicKey, phone.secretKey)).toString('base64url'),
    };
  };

  const unsealPeer = (/** @type {unknown} */ packet) => {
    if (Array.isArray(packet)) {
      assert.equal(packet[0], 3);
      const plain = nacl.box.open(
        Buffer.from(packet[2], 'base64url'),
        Buffer.from(packet[1], 'base64url'),
        mac.publicKey,
        phone.secretKey,
      );
      assert.ok(plain);
      return /** @type {Value} */ (decodeCompactPeerPlaintext(plain, peerId));
    }
    const v2 = /** @type {Value} */ (packet);
    assert.equal(v2.version, 2);
    const plain = nacl.box.open(
      Buffer.from(v2.ciphertext, 'base64url'),
      Buffer.from(v2.nonce, 'base64url'),
      mac.publicKey,
      phone.secretKey,
    );
    assert.ok(plain);
    const parsed = JSON.parse(Buffer.from(plain).toString('utf8'));
    assert.equal(parsed.peerId, peerId);
    return /** @type {Value} */ (parsed.payload);
  };

  /**
   * @param {string} path
   * @param {Value|null} body
   * @param {string} [method]
   * @param {boolean} [compact]
   * @returns {Promise<{status:number,payload:Value,error?:string,raw:Value}>}
   */
  const sendHttp = async (path, body, method = 'POST', compact = false) => {
    const url = 'http://127.0.0.1:' + new URL(channel.url).port + path;
    /** @type {Record<string,string>} */
    const headers = { Authorization: authHeader(path, method) };
    if (compact) headers[PEER_RESPONSE_CODEC_HEADER] = PEER_RESPONSE_CODEC_VALUE;
    if (body !== null) headers['Content-Type'] = 'application/json';
    const response = await fetch(url, {
      method,
      headers,
      ...(body !== null ? { body: JSON.stringify(body) } : {}),
    });
    const json = /** @type {Value} */ (await response.json());
    if (response.status === 200) return { status: 200, payload: unsealPeer(json), raw: json };
    return { status: response.status, payload: {}, error: json.error, raw: json };
  };

  return {
    service,
    remoteDesktop,
    deviceId,
    sealDesktop,
    sendHttp,
    setLargeWindows: (/** @type {boolean} */ v) => { largeWindows = v; },
  };
}

test('DesktopHostProcess passes --state-dir=<state> iff state is non-empty and RemoteDesktop.ensureHost forwards options.state', async t => {
  const { shPath } = await createFakeHostBinary(t);
  const customStateDir = join(tmpdir(), 'codelync-state-arg-check');

  const withState = new DesktopHostProcess({ binary: shPath, state: customStateDir });
  t.after(async () => { await withState.close(); });
  const resWithState = await withState.request('status');
  assert.deepEqual(resWithState.argv, ['--state-dir=' + customStateDir]);
  await withState.close();

  const withoutState = new DesktopHostProcess({ binary: shPath });
  t.after(async () => { await withoutState.close(); });
  const resWithout = await withoutState.request('status');
  assert.deepEqual(resWithout.argv, []);
  await withoutState.close();

  const blankState = new DesktopHostProcess({ binary: shPath, state: '   ' });
  t.after(async () => { await blankState.close(); });
  const resBlank = await blankState.request('status');
  assert.deepEqual(resBlank.argv, []);
  await blankState.close();

  // Verify RemoteDesktop.ensureHost() (without hostFactory) passes options.state to DesktopHostProcess.
  const desktopState = await mkdtemp(join(tmpdir(), 'codelync-rd-state-'));
  const mac = nacl.box.keyPair(), phone = nacl.box.keyPair();
  const devices = Object.assign(new EventEmitter(), {
    publicKey(/** @type {string} */ id) {
      return id === 'phone' ? Buffer.from(phone.publicKey).toString('base64url') : null;
    },
  });
  const desktop = new RemoteDesktop({
    state: desktopState,
    devices,
    macSecretKey: mac.secretKey,
    hostBinary: shPath,
    relayBinary: '/unused',
  });
  t.after(async () => {
    await desktop.close();
    await rm(desktopState, { recursive: true, force: true });
  });
  await desktop.configure({ enabled: true });
  const nonce = randomBytes(24);
  const sealed = {
    version: 1,
    nonce: nonce.toString('base64url'),
    ciphertext: Buffer.from(nacl.box(
      Buffer.from(JSON.stringify({ version: 1, at: Date.now(), action: 'displays' })),
      nonce,
      mac.publicKey,
      phone.secretKey,
    )).toString('base64url'),
  };
  const inventory = await desktop.api('displays', 'POST', sealed, 'phone', 'https://paired.example');
  assert.equal(inventory.virtualDisplaySupported, true);
  assert.equal(inventory.displays[0].id, 'virtual');
  const rawProbe = await desktop.ensureHost().request('status');
  assert.deepEqual(rawProbe.argv, ['--state-dir=' + desktopState]);
});

test('DesktopHostProcess parses >32KB (130-window) NDJSON lines up to 262_144 bytes and survives oversized or non-object stdout lines', async t => {
  const { shPath } = await createFakeHostBinary(t);
  const host = new DesktopHostProcess({ binary: shPath, state: '/fixture/desktop-state' });
  t.after(async () => { await host.close(); });

  const large = await host.request('windows', { behavior: 'windows-large', count: 130 });
  const serializedBytes = Buffer.byteLength(JSON.stringify(large), 'utf8');
  assert.ok(serializedBytes > 65_536 && serializedBytes < 262_144, `expected 64KB..256KB payload, got ${serializedBytes}`);
  assert.equal(large.windows.length, 130);
  assert.equal(large.activeWindowId, '1001:5001');
  assert.equal(large.windows[129].id, '1130:5130');

  const survived = await host.request('status', { behavior: 'oversized-and-primitives-then-reply' });
  assert.equal(survived.survived, true);
  assert.deepEqual(survived.argv, ['--state-dir=/fixture/desktop-state']);
});

test('DesktopHostProcess assigns windows and window to the 20_000ms timeout tier while keeping fast ops at 5_000ms', async t => {
  const { shPath } = await createFakeHostBinary(t);

  for (const [operation, beforeMs] of /** @type {[string, number][]} */ ([
    ['displays', 4_999],
    ['windows', 19_999],
    ['window', 19_999],
  ])) {
    const host = new DesktopHostProcess({ binary: shPath });
    // Pre-spawn child before enabling mock timers so process startup uses real OS I/O.
    const warmup = await host.request('status');
    assert.equal(warmup.operation, 'status');

    t.mock.timers.enable({ apis: ['setTimeout'] });
    let settled = false;
    /** @type {unknown} */
    let rejection = null;
    try {
      const pending = host.request(operation, { behavior: 'hang' }).then(
        () => { settled = true; },
        err => { settled = true; rejection = err; },
      );
      await Promise.resolve();
      t.mock.timers.tick(beforeMs);
      await Promise.resolve();
      assert.equal(settled, false, `${operation} should still be pending at ${beforeMs}ms`);

      t.mock.timers.tick(1);
      await pending;
      assert.equal(settled, true, `${operation} should time out at ${beforeMs + 1}ms`);
      assert.ok(rejection instanceof BridgeError);
      assert.equal(rejection.code, 'desktop-operation-unknown');
      assert.equal(rejection.status, 503);
    } finally {
      t.mock.timers.reset();
      await host.close();
    }
  }
});

test('DesktopHostProcess maps deterministic domain error codes to 400/409/429 and crashes/unknown/non-string errors to 503', async t => {
  const { shPath } = await createFakeHostBinary(t);
  const host = new DesktopHostProcess({ binary: shPath });
  t.after(async () => { await host.close(); });

  const conflictCodes = [
    'desktop-virtual-display-unavailable',
    'desktop-virtual-display-required',
    'desktop-accessibility-required',
    'desktop-window-unavailable',
    'desktop-window-unresponsive',
    'desktop-restore-persist-failed',
    'desktop-view-changed',
    'desktop-display-changed',
    'desktop-screen-permission-required',
    'desktop-input-permission-required',
    'desktop-space-shortcut-disabled',
  ];
  for (const code of conflictCodes) {
    await assert.rejects(
      host.request('window', { behavior: 'domain-error', code }),
      (/** @type {any} */ err) => err instanceof BridgeError && err.code === code && err.status === 409,
    );
  }

  for (const badReqCode of ['invalid-desktop-input', 'invalid-desktop-viewport', 'invalid-desktop-window']) {
    await assert.rejects(
      host.request('input', { behavior: 'domain-error', code: badReqCode }),
      (/** @type {any} */ err) => err instanceof BridgeError && err.code === badReqCode && err.status === 400,
    );
  }

  await assert.rejects(
    host.request('input', { behavior: 'domain-error', code: 'desktop-input-busy' }),
    (/** @type {any} */ err) => err instanceof BridgeError && err.code === 'desktop-input-busy' && err.status === 429,
  );

  for (const unavailableCode of ['desktop-capture-unavailable', 'desktop-display-unavailable', 'desktop-operation-unknown']) {
    await assert.rejects(
      host.request('display', { behavior: 'domain-error', code: unavailableCode }),
      (/** @type {any} */ err) => err instanceof BridgeError && err.code === unavailableCode && err.status === 503,
    );
  }

  // Non-string or malformed error tokens fall back safely to 503 desktop-host-failed (never coercing undefined/null/false).
  for (const malformed of [
    { behavior: 'domain-error', omitError: true },
    { behavior: 'domain-error', code: null },
    { behavior: 'domain-error', code: false },
    { behavior: 'domain-error', code: 123 },
    { behavior: 'domain-error', code: 'BAD CODE!' },
  ]) {
    await assert.rejects(
      host.request('window', malformed),
      (/** @type {any} */ err) => err instanceof BridgeError && err.code === 'desktop-host-failed' && err.status === 503,
    );
  }

  // Broken/destroyed stdin rejects cleanly with 503 desktop-host-unavailable without uncaught stream errors.
  const brokenHost = new DesktopHostProcess({ binary: shPath });
  t.after(async () => { await brokenHost.close(); });
  await brokenHost.request('status');
  brokenHost.child?.stdin.destroy();
  await assert.rejects(
    brokenHost.request('status'),
    (/** @type {any} */ err) => err instanceof BridgeError && err.code === 'desktop-host-unavailable' && err.status === 503,
  );
  await brokenHost.close();

  // Child crash rejects pending request with 503 desktop-host-unavailable and emits 'stopped'.
  let stoppedCount = 0;
  host.on('stopped', () => { stoppedCount++; });
  await assert.rejects(
    host.request('window', { behavior: 'crash' }),
    (/** @type {any} */ err) => err instanceof BridgeError && err.code === 'desktop-host-unavailable' && err.status === 503,
  );
  assert.equal(stoppedCount, 1);
});

test('MacConnectionService routes sealed /api/peer/desktop/windows and /api/peer/desktop/window over HTTP (v2 & v3 codec) and rejects invalid methods, queries, or subroutes', async t => {
  const gw = await gatewayDesktopFixture(t);

  // Join virtual display and mark ready over real loopback HTTP.
  const joinRes = await gw.sendHttp('/api/peer/desktop/join', gw.sealDesktop('join', { displayId: 'virtual', viewport: { width: 393, height: 852 } }));
  assert.equal(joinRes.status, 200);
  const grant = joinRes.payload;
  assert.equal(grant.display.id, 'virtual');

  const readyRes = await gw.sendHttp('/api/peer/desktop/ready', gw.sealDesktop('ready', {
    connectionId: grant.connectionId,
    generation: grant.generation,
    geometry: grant.display.geometry,
    trackSid: grant.trackSid,
  }));
  assert.equal(readyRes.status, 200);
  assert.equal(readyRes.payload.ready, true);

  // Test v2 sealed response on /api/peer/desktop/windows.
  const winListV2 = await gw.sendHttp('/api/peer/desktop/windows', gw.sealDesktop('windows', { connectionId: grant.connectionId }), 'POST', false);
  assert.equal(winListV2.status, 200);
  assert.equal(winListV2.payload.windows.length, 2);
  assert.equal(winListV2.payload.activeWindowId, null);

  // Test >32KB (130-window) payload with v3 compact gzipped peer codec.
  gw.setLargeWindows(true);
  const winListV3 = await gw.sendHttp('/api/peer/desktop/windows', gw.sealDesktop('windows', { connectionId: grant.connectionId }), 'POST', true);
  assert.equal(winListV3.status, 200);
  assert.ok(Array.isArray(winListV3.raw));
  assert.equal(winListV3.payload.windows.length, 130);

  // Test /api/peer/desktop/window fill over v3 peer codec.
  const fillRes = await gw.sendHttp('/api/peer/desktop/window', gw.sealDesktop('window', {
    connectionId: grant.connectionId,
    geometry: grant.display.geometry,
    sequence: 1,
    mode: 'fill',
    windowId: '2001:6001',
  }), 'POST', true);
  assert.equal(fillRes.status, 200);
  assert.equal(fillRes.payload.accepted, true);
  assert.equal(fillRes.payload.activeWindowId, '2001:6001');
  assert.equal(fillRes.payload.upshifted, true);
  assert.equal(fillRes.payload.display.logicalWidth, 600);

  // Replaying sequence 1 over HTTP serializes deterministic 409 BridgeError code (never 400 peer-request-failed).
  const replayRes = await gw.sendHttp('/api/peer/desktop/window', gw.sealDesktop('window', {
    connectionId: grant.connectionId,
    geometry: fillRes.payload.geometry,
    sequence: 1,
    mode: 'fill',
    windowId: '2001:6001',
  }), 'POST', true);
  assert.equal(replayRes.status, 409);
  assert.equal(replayRes.error, 'desktop-sequence-out-of-order');

  // Method, query-parameter, and unknown subroute rejections.
  const wrongMethod = await gw.sendHttp('/api/peer/desktop/windows', null, 'GET');
  assert.equal(wrongMethod.status, 400);
  assert.equal(wrongMethod.error, 'invalid-desktop-request');

  const withQuery = await gw.sendHttp('/api/peer/desktop/windows?extra=1', gw.sealDesktop('windows', {}));
  assert.equal(withQuery.status, 400);
  assert.equal(withQuery.error, 'invalid-peer-request');

  const unknownAction = await gw.sendHttp('/api/peer/desktop/unknown', gw.sealDesktop('unknown', {}));
  assert.equal(unknownAction.status, 404);
  assert.equal(unknownAction.error, 'unsupported-peer-route');

  const nestedExtra = await gw.sendHttp('/api/peer/desktop/window/extra', gw.sealDesktop('window', {}));
  assert.equal(nestedExtra.status, 404);
  assert.equal(nestedExtra.error, 'unsupported-peer-route');
});

test('displays passes through virtualDisplaySupported boolean (including headless Mac with zero physical monitors) and join rejects unsupported virtual display with 409 desktop-virtual-display-unavailable', async t => {
  // 1. Headless Mac: 0 physical displays, virtualDisplaySupported = true -> [virtualRow] works for displays & join!
  const headless = await virtualDesktopFixture(t, { physicalDisplays: [], virtualDisplaySupported: true });
  await headless.desktop.configure({ enabled: true });
  const headlessInv = await headless.request('displays', {});
  assert.equal(headlessInv.virtualDisplaySupported, true);
  assert.equal(headlessInv.displays.length, 1);
  assert.equal(headlessInv.displays[0].id, 'virtual');
  const headlessGrant = await headless.request('join', { displayId: 'virtual', viewport: { width: 402, height: 874 } });
  assert.equal(headlessGrant.display.id, 'virtual');
  assert.equal(headlessGrant.display.kind, 'virtual');

  // 2. Unsupported Mac: virtualDisplaySupported = false -> coerced false, join('virtual') -> 409 desktop-virtual-display-unavailable.
  const unsupported = await virtualDesktopFixture(t, { virtualDisplaySupported: false });
  await unsupported.desktop.configure({ enabled: true });
  const unsupInv = await unsupported.request('displays', {});
  assert.equal(unsupInv.virtualDisplaySupported, false);
  assert.equal(unsupInv.displays.some((/** @type {Value} */ d) => d.id === 'virtual'), false);
  await assert.rejects(
    unsupported.request('join', { displayId: 'virtual' }),
    { code: 'desktop-virtual-display-unavailable', status: 409 },
  );
  // Physical display still connects normally when virtual display is unsupported.
  const physGrant = await unsupported.request('join', { displayId: '1' });
  assert.equal(physGrant.display.id, '1');

  // 3. Legacy host omitting virtualDisplaySupported -> coerced false; missing physical ID -> 409 desktop-display-unavailable.
  const legacy = await virtualDesktopFixture(t, { virtualDisplaySupported: false, omitVirtualSupportedProp: true });
  await legacy.desktop.configure({ enabled: true });
  const legacyInv = await legacy.request('displays', {});
  assert.equal(legacyInv.virtualDisplaySupported, false);
  await assert.rejects(
    legacy.request('join', { displayId: 'virtual' }),
    { code: 'desktop-virtual-display-unavailable', status: 409 },
  );
  await assert.rejects(
    legacy.request('join', { displayId: '99' }),
    { code: 'desktop-display-unavailable', status: 409 },
  );
});

test('join and display accept displayId="virtual" with portrait viewport, default to 540x1080 when omitted, and clean up virtual metadata when switching back to physical', async t => {
  const f = await virtualDesktopFixture(t);
  await f.desktop.configure({ enabled: true });

  // Join with omitted viewport on 'virtual' defaults to { width: 540, height: 1080 } (ratio 2.0 -> 540x1080 logical, 1080x2160 backing).
  const defaultGrant = await f.request('join', { displayId: 'virtual' });
  const startCall1 = f.calls.find(c => c.operation === 'start');
  assert.deepEqual(startCall1?.value.viewport, { width: 540, height: 1080 });
  assert.equal(defaultGrant.display.id, 'virtual');
  assert.equal(defaultGrant.display.kind, 'virtual');
  assert.equal(defaultGrant.display.logicalWidth, 540);
  assert.equal(defaultGrant.display.logicalHeight, 1080);
  assert.equal(defaultGrant.display.width, 1080);
  assert.equal(defaultGrant.display.height, 2160);
  await f.request('leave', { connectionId: defaultGrant.connectionId, generation: defaultGrant.generation });

  // Join with explicit portrait viewport (reversed key order + near-square boundary check via desktopViewport).
  assert.deepEqual(desktopViewport({ height: 100, width: 100 }), { width: 100, height: 100 });
  assert.deepEqual(desktopViewport({ width: 10_000, height: 10_000 }), { width: 10_000, height: 10_000 });
  assert.equal(desktopDisplayId('virtual'), 'virtual');
  assert.equal(desktopDisplayId('42'), '42');

  f.calls.length = 0;
  const grant = await f.request('join', { displayId: '1' });
  assert.equal('viewport' in f.calls.find(c => c.operation === 'start')?.value, false);
  const binding = { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry };
  await f.request('ready', { ...binding, trackSid: grant.trackSid });

  // Switch physical '1' -> 'virtual' with explicit portrait safe-area { height: 932, width: 430 }.
  const toVirtual = await f.request('display', { ...binding, displayId: 'virtual', viewport: { height: 932, width: 430 } });
  const displayCall1 = f.calls.filter(c => c.operation === 'display')[0];
  assert.deepEqual(displayCall1.value.viewport, { width: 430, height: 932 });
  assert.equal(toVirtual.display.id, 'virtual');
  assert.equal(toVirtual.display.kind, 'virtual');
  assert.equal(toVirtual.display.logicalWidth, 540);
  assert.equal(f.desktop.active?.ready, false);

  // Switch 'virtual' -> physical '2': virtual fields (kind: 'virtual', logicalWidth, logicalHeight) MUST NOT bleed onto physical display!
  const vBinding = { connectionId: grant.connectionId, generation: grant.generation, geometry: toVirtual.display.geometry };
  const toPhysical = await f.request('display', { ...vBinding, displayId: '2' });
  assert.equal(toPhysical.display.id, '2');
  assert.notEqual(toPhysical.display.kind, 'virtual');
  assert.equal('logicalWidth' in toPhysical.display, false);
  assert.equal('logicalHeight' in toPhysical.display, false);
  assert.equal(f.desktop.status().display?.id, '2');
});

test('join and display fail closed with 400 on malformed viewport, invalid displayId, or unexpected extra keys before host IPC', async t => {
  const f = await virtualDesktopFixture(t);
  await f.desktop.configure({ enabled: true });

  // Direct in-memory checks for non-JSON values (NaN, Infinity, prototype-inherited keys).
  for (const rawInvalid of [
    { width: Number.NaN, height: 1080 },
    { width: 540, height: Number.POSITIVE_INFINITY },
    Object.assign(Object.create({ width: 540 }), { height: 1080 }),
  ]) {
    assert.throws(() => desktopViewport(rawInvalid), { code: 'invalid-desktop-viewport', status: 400 });
  }

  const invalidViewports = [
    null,
    true,
    540,
    '540x1080',
    [],
    [540, 1080],
    {},
    { width: 540 },
    { height: 1080 },
    { width: 540, height: 1080, scale: 2 },
    { width: 540.5, height: 1080 },
    { width: 540, height: 1080.2 },
    { width: '540', height: 1080 },
    { width: null, height: 1080 },
    { width: 99, height: 800 },
    { width: 100, height: 99 },
    { width: 10_001, height: 10_001 },
    { width: 540, height: 10_001 },
    { width: 0, height: 800 },
    { width: -540, height: 1080 },
    { width: 852, height: 393 },
    { width: 541, height: 540 },
  ];

  for (const badViewport of invalidViewports) {
    await assert.rejects(
      f.request('join', { displayId: 'virtual', viewport: badViewport }),
      { code: 'invalid-desktop-viewport', status: 400 },
    );
  }

  for (const badDisplayId of ['phone', 'virtual-2', '', '12345678901', 1, null]) {
    await assert.rejects(
      f.request('join', { displayId: badDisplayId }),
      { code: 'invalid-desktop-display', status: 400 },
    );
  }

  // Extra keys on displays / join / non-object JSON plaintext / null quality fail closed with 400 before host IPC.
  await assert.rejects(f.request('displays', { extra: 1 }), { code: 'invalid-desktop-request', status: 400 });
  await assert.rejects(f.request('join', { displayId: 'virtual', unexpected: true }), { code: 'invalid-desktop-request', status: 400 });
  await assert.rejects(f.request('join', { displayId: 'virtual', quality: null }), { code: 'invalid-desktop-quality', status: 400 });
  await assert.rejects(f.desktop.api('displays', 'POST', f.sealRawJson('null'), 'phone', 'https://paired.example'), { code: 'invalid-desktop-request', status: 400 });
  await assert.rejects(f.desktop.api('displays', 'POST', f.sealRawJson('[]'), 'phone', 'https://paired.example'), { code: 'invalid-desktop-request', status: 400 });
  await assert.rejects(f.desktop.api('status', 'POST', {}, 'phone', 'https://paired.example'), { code: 'invalid-desktop-request', status: 400 });
  assert.equal(f.calls.length, 0, 'zero host IPC calls may execute for rejected 400 join/displays payloads');

  // Connect physical, then verify malformed display / quality requests fail closed with 400 WITHOUT tearing down active session!
  const { grant, binding } = await f.connectPhysical();
  const callsBefore = f.calls.length;
  for (const badViewport of invalidViewports) {
    await assert.rejects(
      f.request('display', { ...binding, displayId: 'virtual', viewport: badViewport }),
      { code: 'invalid-desktop-viewport', status: 400 },
    );
  }
  await assert.rejects(f.request('display', { ...binding, displayId: 'bad-id' }), { code: 'invalid-desktop-display', status: 400 });
  await assert.rejects(f.request('display', { ...binding, displayId: 'virtual', extra: 1 }), { code: 'invalid-desktop-request', status: 400 });
  await assert.rejects(f.request('quality', { ...binding, quality: { width: 1920, fps: 30 }, extra: 1 }), { code: 'invalid-desktop-request', status: 400 });
  assert.equal(f.calls.length, callsBefore);
  assert.equal(f.desktop.active?.id, grant.connectionId);
});

test('input scroll accepts valid normalized (x, y) anchor in [0, 1] or omitted coordinates and forwards them to host', async t => {
  const f = await virtualDesktopFixture(t);
  const { binding } = await f.connectVirtual({ width: 393, height: 852 });

  await f.request('input', { ...binding, sequence: 1, input: { action: 'scroll', deltaY: -120 } });
  await f.request('input', { ...binding, sequence: 2, input: { action: 'scroll', deltaY: 1200, x: 0, y: 0 } });
  await f.request('input', { ...binding, sequence: 3, input: { action: 'scroll', deltaY: -1200, x: 1, y: 1 } });
  await f.request('input', { ...binding, sequence: 4, input: { action: 'scroll', deltaY: -48, x: 0.375, y: 0.8125 } });

  const inputCalls = f.calls.filter(c => c.operation === 'input').map(c => c.value);
  assert.equal(inputCalls.length, 4);
  assert.equal('x' in inputCalls[0], false);
  assert.equal('y' in inputCalls[0], false);
  assert.equal(inputCalls[0].deltaY, -120);
  assert.deepEqual({ x: inputCalls[1].x, y: inputCalls[1].y, deltaY: inputCalls[1].deltaY }, { x: 0, y: 0, deltaY: 1200 });
  assert.deepEqual({ x: inputCalls[2].x, y: inputCalls[2].y, deltaY: inputCalls[2].deltaY }, { x: 1, y: 1, deltaY: -1200 });
  assert.deepEqual({ x: inputCalls[3].x, y: inputCalls[3].y, deltaY: inputCalls[3].deltaY }, { x: 0.375, y: 0.8125, deltaY: -48 });
});

test('input scroll fails closed with 400 invalid-desktop-input on partial, out-of-range, non-finite, or extra-key scroll payloads without burning sequence', async t => {
  const f = await virtualDesktopFixture(t);
  const { binding } = await f.connectVirtual({ width: 393, height: 852 });

  // Direct raw JS checks for NaN / Infinity / unknown action.
  assert.throws(() => desktopInput({ action: 'scroll', deltaY: -40, x: Number.NaN, y: 0.5 }), { code: 'invalid-desktop-input', status: 400 });
  assert.throws(() => desktopInput({ action: 'scroll', deltaY: -40, x: 0.5, y: Number.POSITIVE_INFINITY }), { code: 'invalid-desktop-input', status: 400 });
  assert.throws(() => desktopInput({ action: 'unknown' }), { code: 'invalid-desktop-input', status: 400 });

  const invalidScrolls = [
    { action: 'scroll', deltaY: -50, x: 0.5 },
    { action: 'scroll', deltaY: -50, y: 0.5 },
    { action: 'scroll', deltaY: -50, x: -0.001, y: 0.5 },
    { action: 'scroll', deltaY: -50, x: 0.5, y: -1 },
    { action: 'scroll', deltaY: -50, x: 1.001, y: 0.5 },
    { action: 'scroll', deltaY: -50, x: 0.5, y: 2 },
    { action: 'scroll', deltaY: -50, x: null, y: 0.5 },
    { action: 'scroll', deltaY: -50, x: '0.5', y: 0.5 },
    { action: 'scroll', deltaY: 1.5, x: 0.5, y: 0.5 },
    { action: 'scroll', deltaY: 1201, x: 0.5, y: 0.5 },
    { action: 'scroll', deltaY: -1201, x: 0.5, y: 0.5 },
    { action: 'scroll', deltaY: -20, x: 0.5, y: 0.5, button: 'left' },
    { action: 'scroll', deltaY: -20, extra: true },
  ];

  let seq = 0;
  for (const bad of invalidScrolls) {
    await assert.rejects(
      f.request('input', { ...binding, sequence: ++seq, input: bad }),
      { code: 'invalid-desktop-input', status: 400 },
    );
  }
  await assert.rejects(
    f.request('input', { ...binding, sequence: 1, extraField: true, input: { action: 'scroll', deltaY: -10 } }),
    { code: 'invalid-desktop-input', status: 400 },
  );
  assert.equal(f.calls.filter(c => c.operation === 'input').length, 0);
  assert.equal(f.desktop.active?.sequence, 0);
});

test('windows accepts {}, { connectionId }, and { connectionId, generation }, rejects inactive or mismatched viewer with 409 desktop-not-active, and rejects extra keys with 400', async t => {
  const f = await virtualDesktopFixture(t);
  await f.desktop.configure({ enabled: true });

  // Before join -> 409 desktop-not-active.
  await assert.rejects(f.request('windows', {}), { code: 'desktop-not-active', status: 409 });

  const { grant } = await f.connectVirtual({ width: 393, height: 852 });
  const r1 = await f.request('windows', {});
  assert.equal(r1.windows.length, 2);
  assert.equal(r1.activeWindowId, null);

  const r2 = await f.request('windows', { connectionId: grant.connectionId });
  assert.equal(r2.windows.length, 2);

  const r3 = await f.request('windows', { connectionId: grant.connectionId, generation: grant.generation });
  assert.equal(r3.windows.length, 2);

  // Wrong viewer device, wrong connectionId, wrong generation -> 409 desktop-not-active.
  await assert.rejects(f.request('windows', { connectionId: grant.connectionId }, 'other', f.other), { code: 'desktop-not-active', status: 409 });
  await assert.rejects(f.request('windows', { connectionId: 'wrong-conn' }), { code: 'desktop-not-active', status: 409 });
  await assert.rejects(f.request('windows', { connectionId: grant.connectionId, generation: 'wrong-gen' }), { code: 'desktop-not-active', status: 409 });

  // Malformed types or extra keys -> 400 invalid-desktop-request.
  await assert.rejects(f.request('windows', { connectionId: '' }), { code: 'invalid-desktop-request', status: 400 });
  await assert.rejects(f.request('windows', { connectionId: 123 }), { code: 'invalid-desktop-request', status: 400 });
  await assert.rejects(f.request('windows', { connectionId: grant.connectionId, generation: '' }), { code: 'invalid-desktop-request', status: 400 });
  await assert.rejects(f.request('windows', { connectionId: grant.connectionId, geometry: grant.display.geometry }), { code: 'invalid-desktop-request', status: 400 });
  await assert.rejects(f.request('windows', { unexpected: true }), { code: 'invalid-desktop-request', status: 400 });

  // Non-array host fallback normalization.
  f.setWindowsOverride({ windows: null });
  const normalized = await f.request('windows', { connectionId: grant.connectionId });
  assert.deepEqual(normalized, { windows: [], activeWindowId: null });
});

test('window validates strict payload schemas (400 invalid-desktop-window) for fill and restore modes and accepts optional generation', async t => {
  const f = await virtualDesktopFixture(t);
  await f.desktop.configure({ enabled: true });

  // Inactive connection with valid schema -> 409 desktop-disconnected.
  await assert.rejects(
    f.request('window', { connectionId: 'missing', geometry: 'g-1', sequence: 1, mode: 'restore' }),
    { code: 'desktop-disconnected', status: 409 },
  );

  const { grant, binding } = await f.connectVirtual({ width: 393, height: 852 });
  const base = { connectionId: grant.connectionId, geometry: grant.display.geometry, sequence: 1 };

  const invalidPayloads = [
    { ...base, mode: 'maximize', windowId: '1001:5001' },
    { ...base, mode: '' },
    { ...base },
    { ...base, mode: 'fill' },
    { ...base, mode: 'fill', windowId: '1001' },
    { ...base, mode: 'fill', windowId: 'abc:def' },
    { ...base, mode: 'fill', windowId: '12:34:56' },
    { ...base, mode: 'fill', windowId: ':5001' },
    { ...base, mode: 'fill', windowId: '12345678901:5001' },
    { ...base, mode: 'fill', windowId: '-1:5001' },
    { ...base, mode: 'restore', windowId: '1001:5001' },
    { ...base, mode: 'fill', windowId: '1001:5001', extra: 1 },
    { ...base, mode: 'restore', extra: 1 },
    { ...base, connectionId: '', mode: 'restore' },
    { ...base, geometry: '', mode: 'restore' },
    { ...base, generation: '', mode: 'restore' },
    { ...base, sequence: 1.5, mode: 'restore' },
    { ...base, sequence: '1', mode: 'restore' },
  ];

  for (const invalid of invalidPayloads) {
    await assert.rejects(f.request('window', invalid), { code: 'invalid-desktop-window', status: 400 });
  }
  assert.throws(() => desktopWindowRequest({ mode: 'restore', connectionId: 'c', geometry: 'g', sequence: Number.NaN }), {
    code: 'invalid-desktop-window',
    status: 400,
  });
  assert.equal(f.calls.filter(c => c.operation === 'window').length, 0);

  // Wrong device, wrong connectionId, or wrong optional generation -> 409 desktop-disconnected.
  await assert.rejects(f.request('window', { ...base, mode: 'restore' }, 'other', f.other), { code: 'desktop-disconnected', status: 409 });
  await assert.rejects(f.request('window', { ...base, connectionId: 'other-id', mode: 'restore' }), { code: 'desktop-disconnected', status: 409 });
  await assert.rejects(f.request('window', { ...base, generation: 'wrong-gen', mode: 'restore' }), { code: 'desktop-disconnected', status: 409 });

  // Succeeds WITHOUT generation (E2E opaque-box contract).
  const fillNoGen = await f.request('window', { ...base, mode: 'fill', windowId: '1001:5001' });
  assert.equal(fillNoGen.accepted, true);
  assert.equal(fillNoGen.activeWindowId, '1001:5001');
  await f.request('ready', { ...binding, geometry: fillNoGen.geometry, trackSid: fillNoGen.trackSid });

  // Succeeds WITH matching generation (Mobile desktopBinding contract).
  const restoreWithGen = await f.request('window', {
    ...binding,
    geometry: fillNoGen.geometry,
    sequence: 2,
    mode: 'restore',
  });
  assert.equal(restoreWithGen.accepted, true);
  assert.equal(restoreWithGen.activeWindowId, null);
});

test('window enforces virtual display requirement (409 desktop-virtual-display-required) when connected to a physical display', async t => {
  const f = await virtualDesktopFixture(t);
  const { grant, binding } = await f.connectPhysical();

  await assert.rejects(
    f.request('window', { connectionId: grant.connectionId, geometry: binding.geometry, sequence: 1, mode: 'fill', windowId: '1001:5001' }),
    { code: 'desktop-virtual-display-required', status: 409 },
  );
  await assert.rejects(
    f.request('window', { ...binding, sequence: 1, mode: 'restore' }),
    { code: 'desktop-virtual-display-required', status: 409 },
  );
  assert.equal(f.desktop.active?.sequence, 0);
  assert.equal(f.desktop.active?.ready, true);
  assert.equal(f.calls.filter(c => c.operation === 'window').length, 0);
});

test('window enforces sequence (+1..+1024), viewPending (409 desktop-view-changed), geometry (409 desktop-display-changed), and ready (409 desktop-not-ready) safety gates', async t => {
  const f = await virtualDesktopFixture(t);
  await f.desktop.configure({ enabled: true });
  const grant = await f.request('join', { displayId: 'virtual', viewport: { width: 393, height: 852 } });
  const binding = { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry };

  // 1. Before ready (ready === false, viewPending === false) -> 409 desktop-not-ready without consuming sequence.
  await assert.rejects(
    f.request('window', { ...binding, sequence: 1, mode: 'fill', windowId: '1001:5001' }),
    { code: 'desktop-not-ready', status: 409 },
  );
  assert.equal(f.desktop.active?.sequence, 0);

  // Confirm ready.
  await f.request('ready', { ...binding, trackSid: grant.trackSid });

  // 2. Out-of-order sequences (0, -1, 1025) -> 409 desktop-sequence-out-of-order.
  for (const badSeq of [0, -1, 1025]) {
    await assert.rejects(
      f.request('window', { ...binding, sequence: badSeq, mode: 'fill', windowId: '1001:5001' }),
      { code: 'desktop-sequence-out-of-order', status: 409 },
    );
  }
  assert.equal(f.desktop.active?.sequence, 0);

  // 3. Stale geometry -> 409 desktop-display-changed without consuming sequence.
  await assert.rejects(
    f.request('window', { ...binding, geometry: 'stale-geo', sequence: 1, mode: 'fill', windowId: '1001:5001' }),
    { code: 'desktop-display-changed', status: 409 },
  );
  assert.equal(f.desktop.active?.sequence, 0);

  // 4. viewPending === true (after view-invalidated) -> 409 desktop-view-changed without consuming sequence.
  f.host.emit('view-invalidated', grant.connectionId);
  await assert.rejects(
    f.request('window', { ...binding, sequence: 1, mode: 'fill', windowId: '1001:5001' }),
    { code: 'desktop-view-changed', status: 409 },
  );
  assert.equal(f.desktop.active?.sequence, 0);

  // Recover via heartbeat + ready, then verify upper boundary sequence === 1024 succeeds.
  const hb = await f.request('heartbeat', binding);
  await f.request('ready', { ...binding, geometry: hb.geometry, trackSid: hb.trackSid });
  const okAtBound = await f.request('window', {
    ...binding,
    geometry: hb.geometry,
    sequence: 1024,
    mode: 'fill',
    windowId: '1001:5001',
  });
  assert.equal(okAtBound.accepted, true);
  assert.equal(f.desktop.active?.sequence, 1024);
});

test('window reserves active.sequence before IPC so 503 desktop-operation-unknown prevents replay while pre-mutation 409 restores ready when view is clean', async t => {
  const f = await virtualDesktopFixture(t);
  const { grant, binding } = await f.connectVirtual({ width: 393, height: 852 });

  // 1. 503 desktop-operation-unknown reserves sequence 1, preserves room, keeps ready=false, and blocks replay!
  f.failNextWindow(new BridgeError('desktop-operation-unknown', 'Unconfirmed.', 503));
  await assert.rejects(
    f.request('window', { ...binding, sequence: 1, mode: 'fill', windowId: '1001:5001' }),
    { code: 'desktop-operation-unknown', status: 503 },
  );
  assert.equal(f.desktop.active?.id, grant.connectionId);
  assert.equal(f.desktop.active?.sequence, 1);
  assert.equal(f.desktop.active?.ready, false);

  const windowCallsAfterFirst = f.calls.filter(c => c.operation === 'window').length;
  assert.equal(windowCallsAfterFirst, 1);

  // Immediate replay of sequence 1 (even before ready recovery) deterministically rejects with 409 desktop-sequence-out-of-order.
  await assert.rejects(
    f.request('window', { ...binding, sequence: 1, mode: 'fill', windowId: '1001:5001' }),
    { code: 'desktop-sequence-out-of-order', status: 409 },
  );
  assert.equal(f.calls.filter(c => c.operation === 'window').length, 1);

  // Recover view via heartbeat + ready; replay of sequence 1 STILL rejects with 409 desktop-sequence-out-of-order.
  const hb = await f.request('heartbeat', binding);
  const recovered = { ...binding, geometry: hb.geometry };
  await f.request('ready', { ...recovered, trackSid: hb.trackSid });
  await assert.rejects(
    f.request('window', { ...recovered, sequence: 1, mode: 'fill', windowId: '1001:5001' }),
    { code: 'desktop-sequence-out-of-order', status: 409 },
  );
  assert.equal(f.calls.filter(c => c.operation === 'window').length, 1);

  // 2. Pre-mutation plain Error({ code }) from mock host normalizes to 409 BridgeError AND restores ready=true when !viewPending!
  f.failNextWindow(Object.assign(new Error('persist failed'), { code: 'desktop-restore-persist-failed' }), false);
  await assert.rejects(
    f.request('window', { ...recovered, sequence: 2, mode: 'fill', windowId: '1001:5001' }),
    (/** @type {any} */ err) => err instanceof BridgeError && err.code === 'desktop-restore-persist-failed' && err.status === 409,
  );
  assert.equal(f.desktop.active?.sequence, 2);
  assert.equal(f.desktop.active?.ready, true, 'pre-mutation 409 without view invalidation restores ready=true');

  // 3. Post-invalidation 409 (host emitted view-invalidated before failing) keeps ready=false!
  f.failNextWindow(Object.assign(new Error('hung after resize'), { code: 'desktop-window-unresponsive' }), true);
  await assert.rejects(
    f.request('window', { ...recovered, sequence: 3, mode: 'fill', windowId: '1001:5001' }),
    (/** @type {any} */ err) => err instanceof BridgeError && err.code === 'desktop-window-unresponsive' && err.status === 409,
  );
  assert.equal(f.desktop.active?.sequence, 3);
  assert.equal(f.desktop.active?.ready, false, '409 after view-invalidated must keep ready=false');

  // Recover and succeed on fresh sequence 4.
  const hb2 = await f.request('heartbeat', recovered);
  await f.request('ready', { ...recovered, geometry: hb2.geometry, trackSid: hb2.trackSid });
  const ok = await f.request('window', { ...recovered, geometry: hb2.geometry, sequence: 4, mode: 'fill', windowId: '1001:5001' });
  assert.equal(ok.accepted, true);
  assert.equal(ok.sequence, 4);
});

test('window fill auto-upshift and restore update active.display via adoptView across all endpoints, fence input until fresh ready, and reconcile async upshifts over heartbeat', async t => {
  const f = await virtualDesktopFixture(t);
  const { grant, binding } = await f.connectVirtual({ width: 540, height: 1080 });
  assert.equal(grant.display.logicalWidth, 540);
  assert.equal(grant.display.logicalHeight, 1080);
  assert.equal(grant.display.width, 1080);
  assert.equal(grant.display.height, 2160);

  // Fill wide window 1002:5002 -> triggers simulated --set-mode auto-upshift from 540x1080 to 720x1440 logical (1440x2880 backing).
  const upshift = await f.request('window', {
    ...binding,
    sequence: 1,
    mode: 'fill',
    windowId: '1002:5002',
  });
  assert.equal(upshift.accepted, true);
  assert.equal(upshift.connected, true);
  assert.equal(upshift.capturing, true);
  assert.equal(upshift.mode, 'fill');
  assert.equal(upshift.activeWindowId, '1002:5002');
  assert.equal(upshift.upshifted, true);
  assert.equal(upshift.display.logicalWidth, 720);
  assert.equal(upshift.display.logicalHeight, 1440);
  assert.equal(upshift.display.width, 1440);
  assert.equal(upshift.display.height, 2880);
  assert.equal(upshift.display.kind, 'virtual');
  assert.equal(upshift.display.geometry, upshift.geometry);
  assert.notEqual(upshift.geometry, grant.display.geometry);
  assert.notEqual(upshift.trackSid, grant.trackSid);
  assert.deepEqual(upshift.quality, { width: 1920, fps: 30 });

  // Input is fenced until fresh decoded-frame ready confirms the new geometry & trackSid.
  assert.equal(f.desktop.active?.ready, false);
  await assert.rejects(
    f.request('input', { ...binding, sequence: 2, input: { action: 'pointer', phase: 'click', x: 0.5, y: 0.5 } }),
    { code: 'desktop-view-changed', status: 409 },
  );
  await assert.rejects(
    f.request('input', { ...binding, geometry: upshift.geometry, sequence: 2, input: { action: 'pointer', phase: 'click', x: 0.5, y: 0.5 } }),
    { code: 'desktop-not-ready', status: 409 },
  );
  await assert.rejects(
    f.request('ready', { ...binding, geometry: upshift.geometry, trackSid: grant.trackSid }),
    { code: 'desktop-not-ready', status: 409 },
  );

  // Confirm ready on post-upshift trackSid & geometry -> returns updated display and unlocks input!
  const readyRes = await f.request('ready', { ...binding, geometry: upshift.geometry, trackSid: upshift.trackSid });
  assert.equal(readyRes.ready, true);
  assert.equal(readyRes.display.logicalWidth, 720);
  await f.request('input', { ...binding, geometry: upshift.geometry, sequence: 2, input: { action: 'pointer', phase: 'click', x: 0.5, y: 0.5 } });

  // Verify status(), heartbeat, quality, space, and restore all surface the updated display dimensions.
  assert.equal(f.desktop.status().display?.logicalWidth, 720);

  const hb1 = await f.request('heartbeat', { ...binding, geometry: upshift.geometry });
  assert.equal(hb1.display.logicalWidth, 720);

  const qualRes = await f.request('quality', { ...binding, geometry: upshift.geometry, quality: { width: 2560, fps: 60 } });
  assert.equal(qualRes.display.logicalWidth, 720);
  assert.deepEqual(qualRes.quality, { width: 2560, fps: 60 });
  await f.request('ready', { ...binding, geometry: qualRes.geometry, trackSid: qualRes.trackSid });

  const spaceRes = await f.request('space', { ...binding, geometry: qualRes.geometry, sequence: 3, kind: 'next' });
  assert.equal(spaceRes.display.logicalWidth, 720);
  await f.request('ready', { ...binding, geometry: spaceRes.geometry, trackSid: spaceRes.trackSid });

  const restoreRes = await f.request('window', { ...binding, geometry: spaceRes.geometry, sequence: 4, mode: 'restore' });
  assert.equal(restoreRes.accepted, true);
  assert.equal(restoreRes.mode, 'restore');
  assert.equal(restoreRes.activeWindowId, null);
  assert.equal(restoreRes.upshifted, false);
  assert.deepEqual(restoreRes.quality, { width: 2560, fps: 60 });
  await f.request('ready', { ...binding, geometry: restoreRes.geometry, trackSid: restoreRes.trackSid });

  // Simulate async upshift reconciled purely via heartbeat (recoverView() after a 503 timeout).
  f.scheduleAsyncUpshift(840);
  assert.equal(f.desktop.active?.ready, false);
  const recoveredHb = await f.request('heartbeat', { ...binding, geometry: restoreRes.geometry });
  assert.equal(recoveredHb.display.logicalWidth, 840);
  assert.equal(recoveredHb.display.width, 1680);
  assert.equal(f.desktop.status().display?.logicalWidth, 840);
});

test('desktopWindowRequest fails closed with 400 invalid-desktop-window on non-plain objects, primitives, arrays, class instances, and prototype-inherited keys, and canonicalizes -0 across scroll/window validators', () => {
  class CustomWindowReq {}
  const classInstance = Object.assign(new CustomWindowReq(), {
    mode: 'fill',
    connectionId: 'c-1',
    geometry: 'g-1',
    sequence: 1,
    windowId: '1001:5001',
  });
  const protoInherited = Object.create({
    mode: 'restore',
    connectionId: 'c-1',
    geometry: 'g-1',
    sequence: 1,
    windowId: '1001:5001',
    evil: true,
  });
  const arrayWithProps = Object.assign([], {
    mode: 'restore',
    connectionId: 'c-1',
    geometry: 'g-1',
    sequence: 1,
  });

  for (const malformed of [
    null,
    undefined,
    true,
    42,
    'restore',
    arrayWithProps,
    protoInherited,
    classInstance,
    Object.assign(Object.create(null), { mode: 'restore', connectionId: 'c-1', geometry: 'g-1', sequence: 1, extra: 1 }),
  ]) {
    assert.throws(
      () => desktopWindowRequest(malformed),
      (/** @type {unknown} */ err) => err instanceof BridgeError && err.code === 'invalid-desktop-window' && err.status === 400,
    );
  }

  // Null-prototype plain object with valid own properties and -0 sequence succeeds and canonicalizes -0 -> +0.
  const nullProtoValid = Object.assign(Object.create(null), {
    mode: 'restore',
    connectionId: 'c-1',
    geometry: 'g-1',
    sequence: -0,
  });
  const parsedWin = desktopWindowRequest(nullProtoValid);
  assert.deepEqual(parsedWin, {
    mode: 'restore',
    connectionId: 'c-1',
    geometry: 'g-1',
    sequence: 0,
  });
  assert.equal(Object.is(parsedWin.sequence, 0), true);

  // desktopInput canonicalizes -0 -> +0 on both scroll return paths.
  const scrollNoCoords = desktopInput({ action: 'scroll', deltaY: -0 });
  assert.equal(Object.is(scrollNoCoords.deltaY, 0), true);

  const scrollWithCoords = desktopInput({ action: 'scroll', deltaY: -0, x: -0, y: -0 });
  assert.equal(Object.is(scrollWithCoords.deltaY, 0), true);
  assert.equal(Object.is(scrollWithCoords.x, 0), true);
  assert.equal(Object.is(scrollWithCoords.y, 0), true);
});

test('join normalizes malformed host displays inventories to 503 desktop-host-failed, normalizes permissions, and enforces Boolean(virtualDisplaySupported) parity', async t => {
  const f = await virtualDesktopFixture(t);
  await f.desktop.configure({ enabled: true });

  for (const malformedInventory of [
    undefined,
    null,
    42,
    'not-an-object',
    [],
    {},
    { displays: 'not-array', permissions: { screenRecording: true, accessibility: true, locked: false }, virtualDisplaySupported: true },
    { displays: [null, 42], permissions: null },
    { displays: [null], virtualDisplaySupported: true, permissions: { screenRecording: true, accessibility: true, locked: false } },
  ]) {
    f.setDisplaysOverride(malformedInventory);
    for (const targetId of ['virtual', '1']) {
      await assert.rejects(
        f.request('join', { displayId: targetId }),
        (/** @type {unknown} */ err) => err instanceof BridgeError && err.code === 'desktop-host-failed' && err.status === 503,
      );
      assert.equal(f.desktop.active, null);
    }
  }

  // Non-object permissions on valid displays array -> 409 desktop-screen-permission-required.
  const physOnly = [{ id: '1', name: 'Main display', kind: 'physical', width: 3000, height: 2000, geometry: 'phys-geo-1' }];
  for (const badPermissions of [null, 'bad']) {
    f.setDisplaysOverride({ displays: physOnly, permissions: badPermissions, virtualDisplaySupported: true });
    await assert.rejects(
      f.request('join', { displayId: '1' }),
      (/** @type {unknown} */ err) => err instanceof BridgeError && err.code === 'desktop-screen-permission-required' && err.status === 409,
    );
  }

  // Truthy non-boolean permissions.locked -> 409 desktop-locked.
  f.setDisplaysOverride({
    displays: physOnly,
    permissions: { screenRecording: true, accessibility: true, locked: 1 },
    virtualDisplaySupported: true,
  });
  await assert.rejects(
    f.request('join', { displayId: '1' }),
    (/** @type {unknown} */ err) => err instanceof BridgeError && err.code === 'desktop-locked' && err.status === 409,
  );

  // Falsy virtualDisplaySupported: 0 rejects join('virtual') with 409 desktop-virtual-display-unavailable.
  f.setDisplaysOverride({
    displays: physOnly,
    permissions: { screenRecording: true, accessibility: true, locked: false },
    virtualDisplaySupported: 0,
  });
  await assert.rejects(
    f.request('join', { displayId: 'virtual' }),
    (/** @type {unknown} */ err) => err instanceof BridgeError && err.code === 'desktop-virtual-display-unavailable' && err.status === 409,
  );

  // Truthy virtualDisplaySupported: 1 (even with virtual row omitted) matches api('displays') Boolean(...) parity and succeeds!
  f.setDisplaysOverride({
    displays: physOnly,
    permissions: { screenRecording: true, accessibility: true, locked: false },
    virtualDisplaySupported: 1,
  });
  const listed = await f.request('displays');
  assert.equal(listed.virtualDisplaySupported, true);
  const truthyGrant = await f.request('join', { displayId: 'virtual', viewport: { width: 393, height: 852 } });
  assert.equal(truthyGrant.display.id, 'virtual');
  await f.request('leave', { connectionId: truthyGrant.connectionId, generation: truthyGrant.generation });

  // Restoring normal inventory allows subsequent join to succeed cleanly.
  f.clearDisplaysOverride();
  const grant = await f.request('join', { displayId: 'virtual', viewport: { width: 393, height: 852 } });
  assert.equal(grant.display.id, 'virtual');
});

test('RemoteDesktop.watch preserves active session across 16.2s window RPCs (200 & 503), 3.5s display switch at t=12s, and real 20s subprocess timeout while enforcing immediate revocation and >15s idle teardown', async t => {
  const { shPath } = await createFakeHostBinary(t);
  const state = await mkdtemp(join(tmpdir(), 'codelync-watch-timer-'));
  const subState = await mkdtemp(join(tmpdir(), 'codelync-watch-sub-'));
  const mac = nacl.box.keyPair(), phone = nacl.box.keyPair(), other = nacl.box.keyPair();
  const devices = Object.assign(new EventEmitter(), {
    revoked: false,
    publicKey(/** @type {string} */ id) {
      if (id === 'phone' && !this.revoked) return Buffer.from(phone.publicKey).toString('base64url');
      if (id === 'other') return Buffer.from(other.publicKey).toString('base64url');
      return null;
    },
  });

  let nowMs = 1_000_000;
  let interrupts = 0;
  let track = 0;
  let windowMode = /** @type {'ok'|'fail503'|'slow19s'} */ ('ok');
  const permissions = { screenRecording: true, accessibility: true, locked: false };
  const virtualBase = {
    id: 'virtual', name: 'Phone Screen', kind: 'virtual',
    width: 1080, height: 2160, logicalWidth: 540, logicalHeight: 1080, geometry: 'v-watch-1',
  };
  const virtualUpshifted = {
    id: 'virtual', name: 'Phone Screen', kind: 'virtual',
    width: 1440, height: 2880, logicalWidth: 720, logicalHeight: 1440, geometry: 'v-watch-2',
  };
  const physicalMain = {
    id: '1', name: 'Main display', kind: 'physical',
    width: 2560, height: 1440, geometry: 'phys-watch-1',
  };
  let currentDisplay = /** @type {Value} */ (virtualBase);

  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const host = Object.assign(new EventEmitter(), {
    interrupt() { interrupts++; },
    async request(/** @type {string} */ operation) {
      if (operation === 'displays') {
        return { displays: [physicalMain, virtualBase], permissions, virtualDisplaySupported: true };
      }
      if (operation === 'start') {
        track++;
        currentDisplay = virtualBase;
        return {
          capturing: true, connected: true, viewerConnected: true, permissions,
          display: currentDisplay, geometry: currentDisplay.geometry, trackSid: 'track-' + track, viewPending: false,
        };
      }
      if (operation === 'heartbeat') {
        return {
          capturing: true, connected: true, viewerConnected: true, permissions,
          display: currentDisplay, geometry: currentDisplay.geometry, trackSid: 'track-' + track, viewPending: false,
        };
      }
      if (operation === 'window') {
        const delayMs = windowMode === 'slow19s' ? 19_000 : 16_200;
        await new Promise(resolve => { setTimeout(() => resolve(null), delayMs); });
        if (windowMode === 'fail503') {
          throw new BridgeError('desktop-operation-unknown', 'Timed out.', 503);
        }
        track++;
        currentDisplay = virtualUpshifted;
        return {
          capturing: true, connected: true, viewerConnected: true, permissions,
          display: currentDisplay, geometry: currentDisplay.geometry, trackSid: 'track-' + track,
          viewPending: false, activeWindowId: '1002:5002', upshifted: true,
        };
      }
      if (operation === 'display') {
        await new Promise(resolve => { setTimeout(() => resolve(null), 3_500); });
        track++;
        currentDisplay = currentDisplay.id === 'virtual' ? physicalMain : virtualBase;
        return {
          capturing: true, connected: true, viewerConnected: true, permissions,
          display: currentDisplay, geometry: currentDisplay.geometry, trackSid: 'track-' + track, viewPending: false,
        };
      }
      return { stopped: true };
    },
    async close() {},
  });
  const relay = {
    async start() {
      return {
        url: 'ws://127.0.0.1:7999',
        apiKey: 'test-api-key',
        apiSecret: 'a'.repeat(64),
        rooms: { async createRoom() {}, async deleteRoom() {} },
      };
    },
    async close() {},
  };
  const desktop = new RemoteDesktop({
    state,
    devices,
    macSecretKey: mac.secretKey,
    hostBinary: '/unused',
    relayBinary: '/unused',
    hostFactory: () => host,
    relayFactory: () => relay,
    now: () => nowMs,
  });
  const subDesktop = new RemoteDesktop({
    state: subState,
    devices,
    macSecretKey: mac.secretKey,
    hostBinary: shPath,
    relayBinary: '/unused',
    relayFactory: () => relay,
    now: () => nowMs,
  });

  /** @param {RemoteDesktop} target @param {string} action @param {Value} [value] @param {string} [device] @param {{publicKey:Uint8Array,secretKey:Uint8Array}} [pair] */
  const sendTo = (target, action, value = {}, device = 'phone', pair = phone) => {
    const nonce = randomBytes(24);
    const plain = Buffer.from(JSON.stringify({ version: 1, at: nowMs, action, ...value }));
    const packet = {
      version: 1,
      nonce: nonce.toString('base64url'),
      ciphertext: Buffer.from(nacl.box(plain, nonce, mac.publicKey, pair.secretKey)).toString('base64url'),
    };
    return target.api(action, 'POST', packet, device, 'https://paired.example');
  };
  /** @param {string} action @param {Value} [value] @param {string} [device] @param {{publicKey:Uint8Array,secretKey:Uint8Array}} [pair] */
  const send = (action, value = {}, device = 'phone', pair = phone) => sendTo(desktop, action, value, device, pair);

  /** @param {number} totalMs @param {number} [stepMs] */
  const advance = async (totalMs, stepMs = 100) => {
    for (let k = 0; k < 4; k++) await Promise.resolve();
    for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
      const delta = Math.min(stepMs, totalMs - elapsed);
      nowMs += delta;
      t.mock.timers.tick(delta);
      for (let k = 0; k < 4; k++) await Promise.resolve();
    }
  };

  try {
    await desktop.configure({ enabled: true });
    const grant = await send('join', { displayId: 'virtual', viewport: { width: 393, height: 852 } });
    const binding = { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry };
    await send('ready', { ...binding, trackSid: grant.trackSid });

    // 1. 16.2s window RPC (within 20s host timeout) + Mobile 3s heartbeats queued on this.serial must NOT be killed at 15s!
    const windowPromise = send('window', { ...binding, sequence: 1, mode: 'fill', windowId: '1002:5002' });
    const heartbeatPromises = /** @type {Promise<Value>[]} */ ([]);
    for (let beat = 1; beat <= 5; beat++) {
      await advance(3_000, 100);
      heartbeatPromises.push(send('heartbeat', binding));
    }
    await advance(1_100, 100);
    assert.equal(interrupts, 0);
    assert.equal(desktop.active?.id, grant.connectionId);

    await advance(200, 100);
    const winRes = await windowPromise;
    const hbResults = await Promise.all(heartbeatPromises);
    assert.equal(winRes.accepted, true);
    assert.equal(winRes.upshifted, true);
    assert.equal(hbResults.length, 5);
    assert.equal(interrupts, 0);
    assert.equal(desktop.active?.id, grant.connectionId);
    await advance(14_000, 500);
    assert.equal(interrupts, 0);
    assert.equal(desktop.active?.id, grant.connectionId);

    await send('ready', { ...binding, geometry: winRes.geometry, trackSid: winRes.trackSid });

    // 2. 16.2s rejected window (503 desktop-operation-unknown) updates active.lastSeen in finally so +2_000ms does NOT kill active!
    windowMode = 'fail503';
    const failWinPromise = send('window', { ...binding, geometry: winRes.geometry, sequence: 2, mode: 'fill', windowId: '1002:5002' })
      .then(() => null, (/** @type {unknown} */ err) => err);
    await advance(16_200, 200);
    const failErr = await failWinPromise;
    assert.ok(failErr instanceof BridgeError && failErr.code === 'desktop-operation-unknown' && failErr.status === 503);
    await advance(2_000, 200);
    assert.equal(interrupts, 0);
    assert.equal(desktop.active?.id, grant.connectionId);
    windowMode = 'ok';

    const recHb = await send('heartbeat', { ...binding, geometry: winRes.geometry });
    await send('ready', { ...binding, geometry: recHb.geometry, trackSid: recHb.trackSid });

    // 3. Idle for 12s (<= 15s), then run a 3.5s display switch ('virtual' -> '1') crossing 15.5s since prior activity.
    await advance(12_000, 200);
    assert.equal(interrupts, 0);
    const displayPromise = send('display', { ...binding, geometry: recHb.geometry, displayId: '1' });
    await advance(3_600, 100);
    const dispRes = await displayPromise;
    await desktop.serial;
    assert.equal(dispRes.display.id, '1');
    assert.equal(interrupts, 0);
    assert.equal(desktop.active?.id, grant.connectionId);

    // 4. Non-viewer device 'other' calling displays at t = 10s does NOT reset active.lastSeen; session stays alive at exact 15.0s and tears down at >15s!
    await advance(10_000, 200);
    const otherDisplays = await send('displays', {}, 'other', other);
    assert.equal(otherDisplays.virtualDisplaySupported, true);
    await advance(4_900, 100);
    assert.equal(interrupts, 0);
    assert.equal(desktop.active?.id, grant.connectionId);

    await advance(1_000, 200);
    await desktop.serial;
    assert.equal(interrupts, 1);
    assert.equal(desktop.active, null);

    // 5. Device revocation during an in-flight 19s window RPC (via watch tick without 'changed' event) interrupts immediately!
    const grant2 = await send('join', { displayId: 'virtual', viewport: { width: 393, height: 852 } });
    const binding2 = { connectionId: grant2.connectionId, generation: grant2.generation, geometry: grant2.display.geometry };
    await send('ready', { ...binding2, trackSid: grant2.trackSid });
    windowMode = 'slow19s';
    const slowPromise = send('window', { ...binding2, sequence: 1, mode: 'fill', windowId: '1002:5002' })
      .then(() => null, (/** @type {unknown} */ err) => err);
    await advance(500, 100);
    assert.equal((/** @type {Value|null} */ (desktop.active))?.inFlight, 1);
    devices.revoked = true;
    await advance(1_000, 200);
    assert.equal(interrupts, 2, 'revoked device must interrupt immediately even while inFlight === 1');
    await advance(18_000, 500);
    await slowPromise;
    await desktop.serial;
    assert.equal(desktop.active, null);
    devices.revoked = false;

    // 6. Real spawned DesktopHostProcess subprocess hanging on window reaches the full 20_000ms timeout (503 desktop-operation-unknown) instead of 15s watchdog preemption!
    await subDesktop.configure({ enabled: true });
    const subGrant = await sendTo(subDesktop, 'join', { displayId: 'virtual', viewport: { width: 393, height: 852 } });
    const subBinding = { connectionId: subGrant.connectionId, generation: subGrant.generation, geometry: subGrant.display.geometry };
    await sendTo(subDesktop, 'ready', { ...subBinding, trackSid: subGrant.trackSid });

    let subSettled = false;
    /** @type {unknown} */
    let subErr = null;
    const subWin = sendTo(subDesktop, 'window', { ...subBinding, sequence: 1, mode: 'fill', windowId: '9999:9999' }).then(
      () => { subSettled = true; },
      err => { subSettled = true; subErr = err; },
    );
    await advance(16_000, 500);
    assert.equal(subSettled, false, 'real subprocess window RPC must NOT be killed at 16s by watchdog');
    assert.equal(subDesktop.active?.id, subGrant.connectionId);

    await advance(3_999, 500);
    assert.equal(subSettled, false, 'real subprocess window RPC must still be pending at 19_999ms');

    await advance(1, 1);
    await subWin;
    assert.equal(subSettled, true);
    assert.ok(subErr instanceof BridgeError);
    assert.equal(subErr.code, 'desktop-operation-unknown');
    assert.equal(subErr.status, 503);
  } finally {
    t.mock.timers.reset();
    await subDesktop.close();
    await desktop.close();
    await rm(subState, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test('display allows Headless Mac virtual-to-physical fallback display re-ID while preserving R006 503 rejections on physical mismatches and virtual-for-physical', async t => {
  const f = await virtualDesktopFixture(t);
  const { grant, binding } = await f.connectVirtual({ width: 393, height: 852 });

  // 1. Headless Mac fallback: switching from 'virtual' to cached physical '10' when macOS re-synthesizes fallback as '11'.
  f.setNextDisplayResult({
    adoptInMock: true,
    display: { id: '11', name: 'Main display', kind: 'physical', width: 1920, height: 1080, geometry: 'phys-11-geo-1' },
    geometry: 'phys-11-geo-1',
  });
  const fallback = await f.request('display', { ...binding, displayId: '10' });
  assert.equal(fallback.display.id, '11');
  assert.equal(fallback.display.kind, 'physical');
  assert.equal('logicalWidth' in fallback.display, false);
  assert.equal('logicalHeight' in fallback.display, false);
  assert.equal(fallback.geometry, 'phys-11-geo-1');
  assert.equal(f.desktop.active?.id, grant.connectionId);
  assert.equal(f.desktop.active?.display?.id, '11');
  assert.equal(f.desktop.status().display?.id, '11');
  assert.equal(f.desktop.active?.ready, false);

  const physBinding = { connectionId: grant.connectionId, generation: grant.generation, geometry: fallback.geometry };
  await f.request('ready', { ...physBinding, trackSid: fallback.trackSid });
  await assert.rejects(
    f.request('window', { ...physBinding, sequence: 1, mode: 'restore' }),
    { code: 'desktop-virtual-display-required', status: 409 },
  );

  // 2. R006 invariant: physical -> physical mismatch ('11' -> requested '2', host returns '3') MUST reject with 503 and stop!
  f.setNextDisplayResult({
    display: { id: '3', name: 'Unexpected', kind: 'physical', width: 1920, height: 1080, geometry: 'phys-3-geo-1' },
    geometry: 'phys-3-geo-1',
  });
  await assert.rejects(
    f.request('display', { ...physBinding, displayId: '2' }),
    { code: 'desktop-display-unavailable', status: 503 },
  );
  assert.equal(f.desktop.active, null);

  // 3. Physical -> virtual request returning physical '1' MUST reject with 503 and stop!
  const physConn = await f.connectPhysical();
  f.setNextDisplayResult({
    display: { id: '1', name: 'Main display', kind: 'physical', width: 3000, height: 2000, geometry: 'phys-geo-1' },
    geometry: 'phys-geo-1',
  });
  await assert.rejects(
    f.request('display', { ...physConn.binding, displayId: 'virtual', viewport: { width: 393, height: 852 } }),
    { code: 'desktop-display-unavailable', status: 503 },
  );
  assert.equal(f.desktop.active, null);

  // 4. Virtual -> physical request returning 'virtual' or kind='virtual' or non-numeric id or empty geometry MUST reject with 503 and stop!
  for (const badFallbackDisplay of [
    { id: 'virtual', name: 'Phone Screen', kind: 'virtual', width: 1080, height: 2160, geometry: 'v-bad' },
    { id: '11', name: 'Spoofed Virtual', kind: 'virtual', width: 1920, height: 1080, geometry: 'v-bad-2' },
    { id: 'display-11', name: 'NonNumeric', kind: 'physical', width: 1920, height: 1080, geometry: 'g-bad-3' },
    { id: '11', name: 'EmptyGeo', kind: 'physical', width: 1920, height: 1080, geometry: '' },
  ]) {
    const conn = await f.connectVirtual({ width: 393, height: 852 });
    f.setNextDisplayResult({ display: badFallbackDisplay, geometry: badFallbackDisplay.geometry });
    await assert.rejects(
      f.request('display', { ...conn.binding, displayId: '10' }),
      { code: 'desktop-display-unavailable', status: 503 },
    );
    assert.equal(f.desktop.active, null);
  }
});
