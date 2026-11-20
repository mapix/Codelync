import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import { build as esbuildBuild, stop as esbuildStop } from 'esbuild';
import { channelPath, peerMaterial } from '@codelync/wire/codelync';
import { decodeCompactPeerPlaintext, PEER_RESPONSE_CODEC_HEADER, PEER_RESPONSE_CODEC_VALUE } from '@codelync/wire/peer-codec';
import { MacConnectionService } from '../../src/codelync/mac-connection-service.mjs';
import { RemoteDesktop } from '../../src/codelync/remote-desktop.mjs';
import { PairingInvitations, createPairingGateway } from '../../src/codelync/pairing-gateway.mjs';
import { DeviceRegistry } from '../../src/codelync/device-registry.mjs';
import { ConnectionChannelsManager } from '../../src/network/connection-channels.mjs';
import { verifyDesktopRuntimeManifest } from '../../scripts/build-desktop-runtime.mjs';
import { publicSourcePath } from '../../src/release/source-snapshot.mjs';

/** @typedef {Record<string, any>} Value */
const execFileAsync = promisify(execFile);
export const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const READ_ALLOWED_ACTIONS = new Set(['status', 'displays', 'heartbeat', 'ready', 'leave', 'windows']);
const DETERMINISTIC_WINDOW_ERRORS = new Set([
  'desktop-virtual-display-unavailable', 'desktop-virtual-display-required', 'desktop-accessibility-required', 'desktop-input-permission-required',
  'desktop-window-unavailable', 'desktop-window-unresponsive', 'desktop-restore-persist-failed', 'desktop-view-changed', 'desktop-display-changed', 'desktop-locked',
]);

/** @param {{ width?: number, height?: number }} [viewport] */
export function computeSpecPortraitLadder(viewport = { width: 540, height: 1080 }) {
  const w = Number.isFinite(viewport?.width) && (viewport?.width ?? 0) > 0 ? Number(viewport.width) : 540;
  const h = Number.isFinite(viewport?.height) && (viewport?.height ?? 0) > 0 ? Number(viewport.height) : 1080;
  const ratio = Math.min(2.5, Math.max(1.0, h / w));
  let baseWidth = 1080;
  for (let step = 540; step <= 1080; step += 10) if (Math.round(step * ratio) >= 800) { baseWidth = step; break; }
  /** @type {Array<{ logicalWidth: number, logicalHeight: number, pixelWidth: number, pixelHeight: number, refreshRate: number }>} */ const modes = [];
  for (let step = baseWidth; step <= 1080; step += 10) { const lh = Math.round(step * ratio); modes.push({ logicalWidth: step, logicalHeight: lh, pixelWidth: step * 2, pixelHeight: lh * 2, refreshRate: 60 }); }
  const baseHeight = modes[0].logicalHeight;
  return { ratio, baseWidth, baseHeight, backingWidth: baseWidth * 2, backingHeight: baseHeight * 2, modes, maxPixels: { width: 2160, height: 5400 }, sizeInMillimeters: { width: (2160 / 220) * 25.4, height: (5400 / 220) * 25.4 }, minimumLifetimeMs: 2500, serialPoolSize: 3 };
}

/** @param {number} nativeW @param {number} nativeH @param {number} tierWidth */
export function computeSpecCaptureDimensions(nativeW, nativeH, tierWidth) {
  const safeW = Math.max(2, Math.trunc(nativeW)), safeH = Math.max(2, Math.trunc(nativeH)), evenW = Math.max(2, Math.floor(safeW / 2) * 2), evenH = Math.max(2, Math.floor(safeH / 2) * 2);
  if (Math.max(safeW, safeH) <= tierWidth) return { width: evenW, height: evenH };
  if (safeW >= safeH) { const tw = Math.max(2, Math.floor(Math.min(safeW, tierWidth) / 2) * 2); return { width: tw, height: Math.max(2, Math.min(evenH, Math.floor(Math.trunc((safeH * tw) / safeW) / 2) * 2)) }; }
  const th = Math.max(2, Math.floor(Math.min(safeH, tierWidth) / 2) * 2);
  return { width: Math.max(2, Math.min(evenW, Math.floor(Math.trunc((safeW * th) / safeH) / 2) * 2)), height: th };
}

/** @param {number} currentWidth @param {number} fillW @param {number} fillH @param {number} gotW @param {number} gotH */
export function computeSpecAutoUpshift(currentWidth, fillW, fillH, gotW, gotH) {
  if (gotW <= fillW + 2 && gotH <= fillH + 2) return { upshifted: false, nextWidth: currentWidth, needed: currentWidth };
  const needed = Math.max((currentWidth * gotW) / fillW, (currentWidth * gotH) / fillH), nextWidth = Math.min(1080, Math.max(540, Math.ceil(Math.ceil(needed) / 10) * 10));
  return { upshifted: nextWidth > currentWidth, nextWidth, needed };
}

/** @param {{ x?: number, y?: number, minX?: number, minY?: number, maxY?: number, width: number, height: number }} visibleFrame @param {number} primaryH */
export function convertVisibleFrameToAxTopLeft(visibleFrame, primaryH) {
  const minX = visibleFrame.minX ?? visibleFrame.x ?? 0, minY = visibleFrame.minY ?? visibleFrame.y ?? 0;
  return { x: minX, y: primaryH - (visibleFrame.maxY ?? (minY + visibleFrame.height)), width: visibleFrame.width, height: visibleFrame.height };
}

/** @param {string[]} [relDirs] @returns {Promise<string[]>} */
export async function listWorkspaceSourceFiles(relDirs = ['src', 'native', 'apps/mobile/sources', 'scripts', 'spec']) {
  const skip = new Set(['node_modules', 'Pods', '.build', 'build', 'dist', 'bin', 'DerivedData', '.git', '.expo']);
  /** @type {string[]} */ const out = [];
  /** @param {string} absDir @param {string} prefix */
  async function walk(absDir, prefix) {
    let entries; try { entries = await readdir(absDir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (skip.has(e.name) || e.name.startsWith('._') || e.name === '.DS_Store') continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(absDir, e.name), rel); else if (e.isFile()) out.push(rel);
    }
  }
  for (const dir of relDirs) await walk(join(REPO_ROOT, dir), dir.replace(/\/+$/u, ''));
  return out.sort();
}

/** @param {string} relPath */
export async function readWorkspaceFile(relPath) { return readFile(join(REPO_ROOT, relPath), 'utf8'); }

/**
 * @param {string} relPath
 * @param {string} [rootDir]
 */
export async function checkPublicSourceHygiene(relPath, rootDir = REPO_ROOT) {
  const allowed = publicSourcePath(relPath);
  /** @type {string[]} */
  const leaks = [];
  const macHomeRe = new RegExp('/' + 'Users/[A-Za-z0-9._-]+', 'u');
  const winHomeRe = new RegExp('C:\\\\' + 'Users\\\\[A-Za-z0-9._-]+', 'u');
  const agentsDirRe = new RegExp('(?:^|[\\\\/\\s\'"`(=:\\[{,;])\\.' + 'agents[\\\\/]', 'u');
  const privKeyRe = new RegExp('BEGIN [A-Z ]*' + 'PRIVATE KEY', 'u');
  try {
    const text = await readFile(join(rootDir, relPath), 'utf8');
    if (macHomeRe.test(text)) leaks.push('macos-home-path');
    if (winHomeRe.test(text)) leaks.push('win-home-path');
    if (agentsDirRe.test(text)) leaks.push('agents-dir-leak');
    if (privKeyRe.test(text)) leaks.push('private-key-leak');
  } catch {
    leaks.push('missing-file');
  }
  return { relPath, allowedInPublicSnapshot: allowed, leaks, clean: allowed && leaks.length === 0 };
}

const MOCK_HOST_SCRIPT = [
  "import { createInterface } from 'node:readline'; import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'; import { dirname, join } from 'node:path';",
  "const dir = dirname(new URL(import.meta.url).pathname), argvPath = join(dir, 'host-argv.json'), cfgPath = join(dir, 'host-config.json'), evtPath = join(dir, 'host-events.json');",
  'const readJson = (p, fb) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fb; } };',
  'const appendEvt = e => { const list = readJson(evtPath, []); list.push({ at: Date.now(), ...e }); writeFileSync(evtPath, JSON.stringify(list)); };',
  'const atomicWrite = (p, data) => { mkdirSync(dirname(p), { recursive: true, mode: 0o700 }); const tmp = p + ".tmp-" + process.pid + "-" + Date.now(); writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 }); renameSync(tmp, p); };',
  'writeFileSync(argvPath, JSON.stringify(process.argv)); const cli = process.argv.slice(2);',
  "if (cli[0] === '--set-mode') { const ok = cli.length === 4 && /^\\d+$/.test(cli[1]) && cli[1] !== '0' && /^\\d+$/.test(cli[2]) && /^\\d+$/.test(cli[3]); appendEvt({ type: 'cli-set-mode', args: cli, ok }); process.exit(ok ? 0 : 1); }",
  "if (cli[0] === '--restore-mode') { const ok = cli.length === 9 && /^\\d+$/.test(cli[1]) && cli[1] !== '0' && ['session', 'permanent'].includes(cli[8]); appendEvt({ type: 'cli-restore-mode', args: cli, ok }); process.exit(ok ? 0 : 1); }",
  "const stateArg = cli.find(a => a.startsWith('--state-dir=')), stateDir = stateArg ? stateArg.slice('--state-dir='.length) : null; if (cli.some(a => !a.startsWith('--state-dir='))) process.exit(1);",
  'const ladder = vp => { const ratio = Math.min(2.5, Math.max(1.0, (vp?.height ?? 1080) / (vp?.width ?? 540))); let bw = 1080; for (let w = 540; w <= 1080; w += 10) if (Math.round(w * ratio) >= 800) { bw = w; break; } return { ratio, bw, bh: Math.round(bw * ratio) }; };',
  'let epoch = 1, capturing = false, connected = false, quality = { width: 1920, fps: 30 }, lastVp = { width: 540, height: 1080 }, curDisp = null, trackSid = "", activeWinId = null, viewPending = false, cursor = { x: 0, y: 0 };',
  'const restorePath = stateDir ? join(stateDir, "window-restore.json") : null, snapPath = stateDir ? join(stateDir, "display-modes-snapshot.json") : null;',
  'const restoreSaved = trigger => { if (!restorePath || !existsSync(restorePath)) return; try { const data = JSON.parse(readFileSync(restorePath, "utf8")); if (!data || !Array.isArray(data.records)) throw Error("bad"); appendEvt({ type: "restore-windows", trigger, records: data.records }); rmSync(restorePath, { force: true }); } catch { const q = restorePath + ".corrupt-" + Date.now(); try { renameSync(restorePath, q); } catch {} appendEvt({ type: "quarantine-restore-record", trigger, quarantined: q }); } activeWinId = null; };',
  'const initCfg = readJson(cfgPath, {}); if (stateDir && initCfg.accessibilityTrusted !== false) { restoreSaved("startup"); if (snapPath && existsSync(snapPath)) { appendEvt({ type: "startup-display-snapshot-reconcile" }); rmSync(snapPath, { force: true }); } }',
  'const getPhys = cfg => cfg.headless ? [] : (cfg.physicalDisplays ?? [{ id: "1", name: "Display 1", kind: "physical", width: 3840, height: 2160, logicalWidth: 1920, logicalHeight: 1080, refreshRate: 60, ioModeID: 1, geometry: "phys-1" }]);',
  'const getPerms = cfg => ({ screenRecording: cfg.screenRecording !== false, accessibility: cfg.accessibilityTrusted !== false, locked: Boolean(cfg.locked) });',
  'const makeVirt = (vp, minW) => { const { ratio, bw } = ladder(vp), lw = Math.min(1080, Math.max(bw, Math.ceil((minW ?? bw) / 10) * 10)), lh = Math.round(lw * ratio); return { id: "virtual", name: "Phone Screen", kind: "virtual", width: lw * 2, height: lh * 2, logicalWidth: lw, logicalHeight: lh, geometry: "virt-" + lw + "x" + lh + "-g" + (++epoch) }; };',
  'const snapModes = (cfg, phase) => { const phys = getPhys(cfg).filter(d => !d.unplugged); if (snapPath && phys.length) atomicWrite(snapPath, { version: 1, phase, displays: phys }); appendEvt({ type: "snapshot-physical-modes", phase, count: phys.length }); };',
  'const restoreModes = (cfg, scope) => { for (const d of getPhys(cfg)) { if (d.unplugged) continue; if (d.isAsleep && scope === "session") { appendEvt({ type: "defer-asleep-display", id: d.id }); continue; } if (d.drifted) appendEvt({ type: "restore-mode", id: d.id, scope }); } if (scope === "permanent" && snapPath && existsSync(snapPath)) rmSync(snapPath, { force: true }); };',
  'const teardownVirt = (cfg, reason) => { if (curDisp?.id === "virtual") { restoreSaved(reason); appendEvt({ type: "stop-capture-before-virtual-release", reason }); appendEvt({ type: "release-virtual-display", reason, minimumLifetimeMs: 2500 }); restoreModes(cfg, "permanent"); } };',
  'const makeWins = cfg => { if (Array.isArray(cfg.windowsList)) return cfg.windowsList; const n = Number(cfg.windowsCount ?? 2), rows = []; for (let i = 1; i <= n; i++) rows.push({ id: (1000 + i) + ":" + (5000 + i), pid: 1000 + i, windowId: 5000 + i, appName: i === 1 ? "Notes" : "Xcode_" + i, bundleId: i === 1 ? "com.apple.Notes" : "com.apple.dt.Xcode", title: "Doc_" + i + (n > 50 ? "_" + "w".repeat(360) : ""), bounds: { x: 80, y: 80, width: 640, height: 900 }, minimized: false, onVirtualDisplay: activeWinId === (1000 + i) + ":" + (5000 + i) }); return rows; };',
  'const reply = obj => process.stdout.write(JSON.stringify(obj) + "\\n");',
  'createInterface({ input: process.stdin }).on("line", async line => {',
  '  let msg; try { msg = JSON.parse(line); } catch { return; } const cfg = readJson(cfgPath, {}), op = msg.operation; appendEvt({ type: "rpc", op, msg });',
  '  const fail = cfg.failOperation?.[op]; if (fail?.hangMs) await new Promise(r => setTimeout(r, fail.hangMs));',
  '  if (fail?.error) { if (fail.invalidateFirst && msg.connectionId) reply({ type: "desktop-view-invalidated", connectionId: msg.connectionId }); reply({ id: msg.id, ok: false, error: fail.error }); return; }',
  '  const perms = getPerms(cfg), virtOk = cfg.virtualDisplaySupported !== false, phys = getPhys(cfg);',
  '  if (op === "status") return reply({ id: msg.id, ok: true, result: { connected, capturing, viewerConnected: connected, permissions: perms, virtualDisplaySupported: virtOk, display: curDisp, activeWindowId: activeWinId } });',
  '  if (op === "displays") { const rows = [...phys]; if (virtOk) rows.push(curDisp?.id === "virtual" ? curDisp : { id: "virtual", name: "Phone Screen", kind: "virtual", width: 1080, height: 2160, logicalWidth: 540, logicalHeight: 1080, geometry: "virt-preview" }); return reply({ id: msg.id, ok: true, result: { displays: rows, permissions: perms, virtualDisplaySupported: virtOk } }); }',
  '  if (op === "start" || op === "display") {',
  '    if (op === "start" && msg.quality) quality = msg.quality;',
  '    if (msg.displayId === "virtual") { if (!virtOk) return reply({ id: msg.id, ok: false, error: "desktop-virtual-display-unavailable" }); const wasVirt = op === "display" && curDisp?.id === "virtual"; if (!wasVirt) snapModes(cfg, "mount"); lastVp = msg.viewport ?? { width: 540, height: 1080 }; curDisp = makeVirt(lastVp); appendEvt({ type: wasVirt ? "apply-settings-in-place" : "set-mode", width: curDisp.logicalWidth, height: curDisp.logicalHeight }); restoreModes(cfg, "session"); }',
  '    else { if (op === "display") teardownVirt(cfg, "display-switch"); const found = phys.find(d => d.id === msg.displayId); if (!found) return reply({ id: msg.id, ok: false, error: "desktop-display-unavailable" }); curDisp = { ...found, geometry: found.id + "-g" + (++epoch) }; }',
  '    connected = true; capturing = true; viewPending = Boolean(op === "start" ? cfg.startViewPending : cfg.displayViewPending); trackSid = "TR_" + (++epoch);',
  '    return reply({ id: msg.id, ok: true, result: { connected: true, capturing: true, viewerConnected: true, permissions: perms, display: curDisp, geometry: curDisp.geometry, trackSid, viewPending } });',
  '  }',
  '  if (op === "quality") { quality = msg.quality; trackSid = "TR_" + (++epoch); return reply({ id: msg.id, ok: true, result: { connected: true, capturing: true, viewerConnected: true, permissions: perms, display: curDisp, geometry: curDisp.geometry, trackSid, viewPending: false } }); }',
  '  if (op === "heartbeat") { if (viewPending) { viewPending = false; trackSid = "TR_" + (++epoch); } return reply({ id: msg.id, ok: true, result: { connected, capturing, viewerConnected: cfg.viewerConnected !== false && connected, permissions: perms, display: curDisp, geometry: curDisp?.geometry ?? "", trackSid, viewPending: false, activeWindowId: activeWinId } }); }',
  '  if (op === "space") { if (!perms.accessibility) return reply({ id: msg.id, ok: false, error: "desktop-input-permission-required" }); reply({ type: "desktop-view-invalidated", connectionId: msg.connectionId }); curDisp = { ...curDisp, geometry: curDisp.id + "-space-" + (++epoch) }; trackSid = "TR_" + (++epoch); return reply({ id: msg.id, ok: true, result: { connected: true, capturing: true, viewerConnected: true, permissions: perms, display: curDisp, geometry: curDisp.geometry, trackSid, viewPending: false, accepted: true, spaceChanged: true } }); }',
  '  if (op === "windows") return perms.accessibility ? reply({ id: msg.id, ok: true, result: { windows: makeWins(cfg), activeWindowId: activeWinId } }) : reply({ id: msg.id, ok: false, error: "desktop-accessibility-required" });',
  '  if (op === "window") {',
  '    if (!perms.accessibility) return reply({ id: msg.id, ok: false, error: "desktop-accessibility-required" });',
  '    if (curDisp?.id !== "virtual") return reply({ id: msg.id, ok: false, error: "desktop-virtual-display-required" });',
  '    let upshifted = false;',
  '    if (msg.mode === "fill") {',
  '      if ((cfg.unresponsiveWindowIds ?? []).includes(msg.windowId)) return reply({ id: msg.id, ok: false, error: "desktop-window-unresponsive" });',
  '      const win = makeWins(cfg).find(w => w.id === msg.windowId); if (!win) return reply({ id: msg.id, ok: false, error: "desktop-window-unavailable" });',
  '      if (cfg.persistFailure || !restorePath) return reply({ id: msg.id, ok: false, error: "desktop-restore-persist-failed" });',
  '      if (activeWinId && activeWinId !== win.id) restoreSaved("window-switch");',
  '      try { atomicWrite(restorePath, { version: 1, records: [{ pid: win.pid, windowId: win.windowId, bundleId: win.bundleId, appName: win.appName, title: win.title, originalFrame: win.onVirtualDisplay ? { x: 320, y: 130, width: win.bounds.width, height: win.bounds.height } : win.bounds, wasFullScreen: Boolean(win.fullScreen), wasMinimized: Boolean(win.minimized), savedAt: new Date().toISOString() }] }); } catch { return reply({ id: msg.id, ok: false, error: "desktop-restore-persist-failed" }); }',
  '      const minSz = cfg.windowMinSizes?.[win.id], curW = curDisp.logicalWidth ?? 540, curH = curDisp.logicalHeight ?? 1080, fillW = cfg.fillArea?.width ?? curW, fillH = cfg.fillArea?.height ?? Math.max(1, curH - 24);',
  '      const gotW = Math.max(fillW, minSz?.width ?? 0), gotH = Math.max(fillH, minSz?.height ?? 0);',
  '      if (gotW > fillW + 2 || gotH > fillH + 2) { const needed = Math.max((curW * gotW) / fillW, (curW * gotH) / fillH), nextW = Math.min(1080, Math.max(540, Math.ceil(Math.ceil(needed) / 10) * 10)); if (nextW > curW) { upshifted = true; curDisp = makeVirt(lastVp, nextW); appendEvt({ type: "upshift-set-mode", nextWidth: nextW, windowId: win.id }); } }',
  '      if (!upshifted) curDisp = { ...curDisp, geometry: "virt-" + curW + "x" + curH + "-g" + (++epoch) };',
  '      activeWinId = win.id; appendEvt({ type: "window-filled", windowId: win.id, upshifted, logicalWidth: curDisp.logicalWidth });',
  '    } else { restoreSaved("manual-restore"); curDisp = { ...curDisp, geometry: "virt-restore-g" + (++epoch) }; }',
  '    reply({ type: "desktop-view-invalidated", connectionId: msg.connectionId }); trackSid = "TR_" + (++epoch); viewPending = Boolean(cfg.windowViewPending);',
  '    return reply({ id: msg.id, ok: true, result: { connected: true, capturing: true, viewerConnected: true, permissions: perms, display: curDisp, geometry: curDisp.geometry, trackSid, viewPending, activeWindowId: activeWinId, upshifted } });',
  '  }',
  '  if (op === "input") { if (!perms.accessibility) return reply({ id: msg.id, ok: false, error: "desktop-input-permission-required" }); if ((msg.action === "pointer" || msg.action === "scroll") && typeof msg.x === "number" && typeof msg.y === "number") cursor = { x: msg.x, y: msg.y }; appendEvt({ type: "input", action: msg.action, deltaY: msg.deltaY, cursor: { ...cursor }, sequence: msg.sequence }); return reply({ id: msg.id, ok: true, result: { accepted: true, sequence: msg.sequence } }); }',
  '  if (op === "stop") { teardownVirt(cfg, "stop"); connected = false; capturing = false; curDisp = null; return reply({ id: msg.id, ok: true, result: { stopped: true } }); }',
  '  reply({ id: msg.id, ok: false, error: "invalid-desktop-operation" });',
  '});',
  'const shutdown = sig => { teardownVirt(readJson(cfgPath, {}), sig); process.exit(0); }; process.on("SIGTERM", () => shutdown("SIGTERM")); process.stdin.on("end", () => shutdown("stdin-eof"));',
].join('\n');

/** @param {string} tempDir @param {Value} [initialConfig] */
export async function createProgrammableHostBinary(tempDir, initialConfig = {}) {
  await mkdir(tempDir, { recursive: true, mode: 0o700 });
  const scriptPath = join(tempDir, 'mock-host.mjs'), binaryPath = join(tempDir, 'CodelyncDesktopHost-mock.sh');
  const configPath = join(tempDir, 'host-config.json'), argvPath = join(tempDir, 'host-argv.json'), eventsPath = join(tempDir, 'host-events.json');
  await Promise.all([
    writeFile(configPath, JSON.stringify(initialConfig, null, 2), 'utf8'), writeFile(eventsPath, '[]', 'utf8'),
    writeFile(scriptPath, MOCK_HOST_SCRIPT, 'utf8'), writeFile(binaryPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, { mode: 0o755 }),
  ]);
  return {
    binaryPath, scriptPath, configPath, argvPath, eventsPath,
    /** @returns {Promise<string[]>} */ async getArgv() { try { return JSON.parse(await readFile(argvPath, 'utf8')); } catch { return []; } },
    /** @returns {Promise<Value[]>} */ async getEvents() { try { return JSON.parse(await readFile(eventsPath, 'utf8')); } catch { return []; } },
    async clearEvents() { await writeFile(eventsPath, '[]', 'utf8'); },
    /** @param {Value} next */ async setConfig(next) { await writeFile(configPath, JSON.stringify(next, null, 2), 'utf8'); },
    /** @param {Value} patch */ async updateConfig(patch) {
      let cur = {}; try { cur = JSON.parse(await readFile(configPath, 'utf8')); } catch { /* empty */ }
      await writeFile(configPath, JSON.stringify({ ...cur, ...patch }, null, 2), 'utf8');
    },
  };
}

class LoopbackTunnel extends EventEmitter {
  /** @param {string} origin */ constructor(origin) { super(); this.origin = origin; }
  async start() { return this.origin; }
  activate() {} close() {}
}

/** @param {import('node:test').TestContext} t @param {Value} [opts] */
export async function createDesktopGatewayHarness(t, opts = {}) {
  const state = await mkdtemp(join(tmpdir(), 'codelync-e2e-desktop-')), desktopState = join(state, 'desktop');
  await mkdir(desktopState, { recursive: true, mode: 0o700 });
  const hostFixture = !opts.hostFactory && !opts.hostBinary ? await createProgrammableHostBinary(join(state, 'mock-host'), opts.hostConfig ?? {}) : null;
  const mac = nacl.box.keyPair(), phone = nacl.box.keyPair(), intruder = nacl.box.keyPair();
  const token = 'synthetic-e2e-device-token', account = { secret: randomBytes(32).toString('base64url') };
  const devices = new DeviceRegistry(join(state, 'devices.json'));
  const deviceId = await devices.approve(Buffer.from(phone.publicKey).toString('base64url'), 'E2E Phone', token);
  const invitations = new PairingInvitations({ key: mac.secretKey, credentials: { ...account, token, deviceId } });
  const peerId = createHash('sha256').update(peerMaterial(Buffer.from(invitations.pair.publicKey).toString('base64url'), account.secret)).digest('hex');

  /** @type {Value[]} */ const relayCalls = [];
  const rooms = { async createRoom(/** @type {Value} */ v) { relayCalls.push({ create: v }); }, async deleteRoom(/** @type {string} */ v) { relayCalls.push({ delete: v }); } };
  const relay = { async start() { relayCalls.push({ start: true }); return { url: opts.mediaUrl ?? 'ws://127.0.0.1:7999', apiKey: 'test-api-key', apiSecret: 'a'.repeat(64), rooms }; }, async close() { relayCalls.push({ close: true }); } };
  const desktop = new RemoteDesktop(/** @type {any} */ ({
    state: desktopState, devices, macSecretKey: invitations.pair.secretKey, hostBinary: opts.hostBinary ?? hostFixture?.binaryPath ?? '/unused-host-binary', relayBinary: '/unused-relay-binary',
    ...(opts.hostFactory ? { hostFactory: opts.hostFactory } : {}), relayFactory: opts.relayFactory ?? (() => relay), ...(opts.now ? { now: opts.now } : {}),
  }));
  await desktop.load();
  if (opts.enabled !== false) await desktop.configure({ enabled: true });

  const daemon = { sources: new Map(), actors: new Map(), closed: false, ownsLease: true, inventoryAvailable: true, registrationAvailable: true, machine: { id: 'machine-e2e' }, useSource: async (/** @type {string} */ _k, /** @type {() => Promise<Value>} */ fn) => fn(), prepareSource: async () => ({}), startSource: async () => {} };
  const service = new MacConnectionService({
    state, cloudflared: 'unused', upstream: 'http://127.0.0.1:9', account, devices, invitations,
    daemon: /** @type {import('../../src/codelync/mac-daemon.mjs').CodelyncMacDaemon} */ (/** @type {unknown} */ (daemon)),
    remoteDesktop: desktop, networkWatchMs: 0, interfaces: () => ({ en0: [{ address: '192.168.50.2', family: 'IPv4', internal: false }] }),
    gatewayFactory: gwOpts => {
      const server = createPairingGateway(gwOpts), listen = server.listen.bind(server);
      server.listen = /** @type {typeof server.listen} */ ((/** @type {number} */ port, /** @type {string} */ _host) => listen(port, '127.0.0.1'));
      return server;
    },
    managerFactory: mgrOpts => new ConnectionChannelsManager({ ...mgrOpts, transportFactory: cfg => new LoopbackTunnel(cfg.kind === 'relay' ? cfg.serverUrl + '/r/' + 'a'.repeat(24) : 'https://fixture-public.example'), probesFor: () => ({ verify: async () => {} }) }),
  });
  t.after(async () => { await desktop.close(); await service.close(); invitations.close(); await rm(state, { recursive: true, force: true }); });
  await service.start();
  for (let i = 0; i < 100 && !service.candidates().some(r => r.kind === 'local'); i++) await new Promise(r => setTimeout(r, 5));
  const channel = service.candidates().find(r => r.kind === 'local');
  assert.ok(channel, 'Expected local LAN gateway candidate');
  const loopbackBase = 'http://127.0.0.1:' + new URL(channel.url).port;

  /** @param {string} path @param {string} [method] @param {{ publicKey: Uint8Array, secretKey: Uint8Array }} [pair] @param {string} [tok] */
  const authHeader = (path, method = 'POST', pair = phone, tok = token) => {
    const nonce = randomBytes(24), frame = { version: 2, token: tok, origin: channel.url, method, path: channelPath(channel.url, channel.url + path), at: Date.now() };
    const cipher = nacl.box(Buffer.from(JSON.stringify(frame)), nonce, invitations.pair.publicKey, pair.secretKey);
    return 'Codelync ' + Buffer.from(JSON.stringify({ publicKey: Buffer.from(pair.publicKey).toString('base64url'), nonce: nonce.toString('base64url'), ciphertext: Buffer.from(cipher).toString('base64url') })).toString('base64url');
  };
  /** @param {string} action @param {Value} [payload] @param {{ publicKey: Uint8Array, secretKey: Uint8Array }} [pair] */
  const sealDesktopBody = (action, payload = {}, pair = phone) => {
    const nonce = randomBytes(24), plain = Buffer.from(JSON.stringify({ version: 1, at: Date.now(), action, ...payload }));
    return { version: 1, nonce: nonce.toString('base64url'), ciphertext: Buffer.from(nacl.box(plain, nonce, invitations.pair.publicKey, pair.secretKey)).toString('base64url') };
  };
  /** @param {any} packet @param {{ secretKey: Uint8Array }} [pair] */
  const unsealGatewayResponse = (packet, pair = phone) => {
    const compact = Array.isArray(packet) && packet[0] === 3;
    const plain = nacl.box.open(Buffer.from(compact ? packet[2] : packet.ciphertext, 'base64url'), Buffer.from(compact ? packet[1] : packet.nonce, 'base64url'), invitations.pair.publicKey, pair.secretKey);
    assert.ok(plain, 'Failed to open sealed peer response');
    return compact ? decodeCompactPeerPlaintext(plain, peerId) : JSON.parse(Buffer.from(plain).toString('utf8')).payload;
  };
  /** @param {string} action @param {Value} [payload] @param {{ method?: string, codecV3?: boolean, pair?: { publicKey: Uint8Array, secretKey: Uint8Array }, signer?: { publicKey: Uint8Array, secretKey: Uint8Array }, rawBody?: string, headers?: Record<string, string> }} [reqOpts] */
  const requestDesktopHttp = async (action, payload = {}, reqOpts = {}) => {
    const method = reqOpts.method ?? (action === 'status' ? 'GET' : 'POST'), path = '/api/peer/desktop/' + action, pair = reqOpts.signer ?? reqOpts.pair ?? phone;
    /** @type {Record<string, string>} */
    const headers = { Authorization: authHeader(path, method, pair), ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...(reqOpts.codecV3 !== false ? { [PEER_RESPONSE_CODEC_HEADER]: PEER_RESPONSE_CODEC_VALUE } : {}), ...(reqOpts.headers ?? {}) };
    const res = await fetch(loopbackBase + path, { method, headers, body: method === 'GET' ? undefined : (reqOpts.rawBody ?? JSON.stringify(sealDesktopBody(action, payload, pair))) });
    const rawText = await res.text();
    /** @type {Value} */
    let json = {};
    if (rawText.trim().length > 0) {
      try {
        json = JSON.parse(rawText);
      } catch (parseErr) {
        if (res.ok) throw parseErr;
        json = { rawText };
      }
    }
    if (!res.ok) {
      return { ok: false, status: res.status, error: typeof json?.error === 'string' ? json.error : null, raw: json };
    }
    return { ok: true, status: res.status, data: /** @type {Value} */ (unsealGatewayResponse(json, pair)), raw: json };
  };
  return { state, desktopState, hostFixture, service, desktop, devices, deviceId, invitations, mac: invitations.pair, phone, intruder, token, account, peerId, channel, loopbackBase, relayCalls, authHeader, sealDesktopBody, unsealGatewayResponse, requestDesktopHttp };
}

/** @param {Value} harness @param {Value} [opts] */
export function createSimulatedMobilePeerClient(harness, opts = {}) {
  let win = opts.window ?? { width: 393, height: 852 }, insets = opts.insets ?? { top: 59, bottom: 34, left: 0, right: 0 };
  let keyboardHeight = Number(opts.keyboardHeight ?? 0), initialMetrics = opts.initialWindowMetrics !== undefined ? opts.initialWindowMetrics : null;
  let platform = opts.platform ?? { OS: 'ios', isPad: false }, writeFenced = Boolean(opts.writeFenced);
  let remoteDesktopEnabled = opts.remoteDesktopEnabled !== false, focused = opts.focused !== false, paired = opts.paired !== false, exiting = false;
  /** @type {{ width: number, height: number } | null} */ let cachedPortrait = opts.cachedPortrait ?? null;
  let grant = /** @type {Value | null} */ (null), displays = /** @type {Value[]} */ ([]);
  const sentInputs = /** @type {Value[]} */ ([]);
  let virtualDisplaySupported = false, permissions = { screenRecording: true, accessibility: true, locked: false };
  let selectedDisplayId = String(opts.selectedDisplayId ?? ''), sequence = 0, ready = false, busy = false, viewPending = false;
  let notice = /** @type {string | null} */ (null), activeWindowId = /** @type {string | null} */ (null), target = /** @type {{ x: number, y: number } | null} */ (null);
  let camera = { mode: /** @type {string} */ ('pointer'), zoom: 1, offset: { x: 0, y: 0 } };

  /** @param {unknown} w @param {unknown} h */
  const hasPositiveDims = (w, h) => typeof w === 'number' && typeof h === 'number' && Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0;
  const safe = (/** @type {number} */ v) => (Number.isFinite(v) && v > 0 ? v : 0);
  const clampVp = (/** @type {number} */ w, /** @type {number} */ h) => {
    if (!Number.isFinite(w) || !Number.isFinite(h)) return { width: 540, height: 1080 };
    const cw = Math.min(10_000, Math.max(100, Math.round(w)));
    return { width: cw, height: Math.min(10_000, Math.max(cw, Math.round(h))) };
  };
  const maybeCachePortrait = () => {
    if (win && hasPositiveDims(win.width, win.height) && win.height > win.width && keyboardHeight <= 0) {
      cachedPortrait = clampVp(Math.max(1, win.width - safe(insets.left) - safe(insets.right)), Math.max(1, win.height - safe(insets.top) - safe(insets.bottom)));
    }
  };
  maybeCachePortrait();
  /** @param {Value} [overrideOpts] */
  const resolvePortraitViewport = (overrideOpts = {}) => {
    const curWin = overrideOpts.window ?? win;
    const curInsets = overrideOpts.insets ?? insets;
    const curKb = overrideOpts.keyboardHeight !== undefined ? Number(overrideOpts.keyboardHeight) : keyboardHeight;
    const curCached = overrideOpts.cachedPortrait !== undefined ? overrideOpts.cachedPortrait : cachedPortrait;
    const curInit = overrideOpts.initialWindowMetrics !== undefined ? overrideOpts.initialWindowMetrics : initialMetrics;
    const curPlat = overrideOpts.platform ?? platform;
    if (curWin && hasPositiveDims(curWin.width, curWin.height) && curWin.height > curWin.width && curKb <= 0) {
      const next = clampVp(Math.max(1, curWin.width - safe(curInsets.left) - safe(curInsets.right)), Math.max(1, curWin.height - safe(curInsets.top) - safe(curInsets.bottom)));
      if (overrideOpts.window === undefined) cachedPortrait = next;
      return next;
    }
    if (curCached && hasPositiveDims(curCached.width, curCached.height)) {
      return clampVp(Math.min(curCached.width, curCached.height), Math.max(curCached.width, curCached.height));
    }
    if (curInit && curInit.frame && hasPositiveDims(curInit.frame.width, curInit.frame.height) && curInit.frame.height > curInit.frame.width) {
      return clampVp(Math.max(1, curInit.frame.width - safe(curInit.insets.left) - safe(curInit.insets.right)), Math.max(1, curInit.frame.height - safe(curInit.insets.top) - safe(curInit.insets.bottom)));
    }
    if (!curWin || !hasPositiveDims(curWin.width, curWin.height)) {
      return { width: 540, height: 1080 };
    }
    const pw = Math.min(curWin.width, curWin.height), ph = Math.max(curWin.width, curWin.height), pTop = Math.max(safe(curInsets.top), safe(curInsets.left), safe(curInsets.right));
    return clampVp(pw, Math.max(1, ph - pTop - (curPlat.OS === 'ios' && !curPlat.isPad && safe(curInsets.bottom) > 0 ? 34 : safe(curInsets.bottom))));
  };

  /** @param {string} action @param {Value} [payload] */
  const call = async (action, payload = {}) => {
    if (writeFenced && !READ_ALLOWED_ACTIONS.has(action)) throw Object.assign(new Error('preferred-route-unavailable'), { code: 'preferred-route-unavailable', effectMayHaveOccurred: false });
    const res = await harness.requestDesktopHttp(action, payload);
    if (!res.ok) {
      let code = typeof res.error === 'string' ? res.error : 'desktop-relay-unavailable';
      if (res.status >= 500 && ((action === 'input' && !['desktop-input-permission-required', 'desktop-locked'].includes(code)) || (action === 'window' && !DETERMINISTIC_WINDOW_ERRORS.has(code)))) code = 'desktop-operation-unknown';
      throw Object.assign(new Error(code), { code, status: res.status });
    }
    return res.data;
  };

  let qClosed = true, qRunning = false;
  /** @type {Array<{ input: Value, resolve: (ok: boolean) => void, reject: (err: Error) => void }>} */ let qWaiting = [];
  const closeQueue = () => { qClosed = true; for (const w of qWaiting) w.resolve(false); qWaiting = []; };
  const openQueue = () => { qClosed = false; qRunning = false; qWaiting = []; };
  const drainQueue = async () => {
    if (qRunning || qClosed) return;
    qRunning = true;
    try {
      for (let guard = 0; guard < 2048 && !qClosed && qWaiting.length > 0; guard++) {
        const next = /** @type {{ input: Value, resolve: (ok: boolean) => void, reject: (err: Error) => void }} */ (qWaiting.shift());
        if (!grant) { next.resolve(false); continue; }
        const seq = ++sequence;
        try {
          const ack = await call('input', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry, sequence: seq, input: next.input });
          sentInputs.push({ sequence: seq, input: next.input, ack }); next.resolve(!qClosed && ack?.accepted === true && ack?.sequence === seq);
        } catch (err) { notice = /** @type {Value} */ (err)?.code ?? 'desktop-operation-unknown'; closeQueue(); next.reject(/** @type {Error} */ (err)); }
      }
    } finally { qRunning = false; }
  };

  /** @param {Value} input */
  const sendInput = input => {
    if (qClosed || !grant || !ready) return Promise.resolve(false);
    return new Promise((resolveDone, rejectDone) => {
      const last = qWaiting[qWaiting.length - 1];
      if (input.action === 'pointer' && input.phase === 'move' && last?.input.action === 'pointer' && last.input.phase === 'move') { last.resolve(false); qWaiting[qWaiting.length - 1] = { input, resolve: resolveDone, reject: rejectDone }; }
      else if (input.action === 'scroll' && last?.input.action === 'scroll' && Math.sign(input.deltaY) === Math.sign(last.input.deltaY) && Math.abs(input.deltaY + last.input.deltaY) <= 1200) {
        const ax = last.input.x, ay = last.input.y; last.resolve(false);
        qWaiting[qWaiting.length - 1] = { input: typeof ax === 'number' && typeof ay === 'number' ? { action: 'scroll', deltaY: input.deltaY + last.input.deltaY, x: ax, y: ay } : { action: 'scroll', deltaY: input.deltaY + last.input.deltaY }, resolve: resolveDone, reject: rejectDone };
      } else if (qWaiting.length < 16) qWaiting.push({ input, resolve: resolveDone, reject: rejectDone });
      else { notice = 'desktop-input-busy'; closeQueue(); rejectDone(Object.assign(new Error('desktop-input-busy'), { code: 'desktop-input-busy' })); return; }
      void drainQueue();
    });
  };

  /** @param {Value} res */
  const adoptView = res => {
    if (!grant) return;
    const nextGeo = res.geometry ?? res.display?.geometry ?? grant.display.geometry, nextTrack = res.trackSid ?? grant.trackSid;
    if (nextGeo !== grant.display.geometry || (res.display?.id && res.display.id !== grant.display.id)) camera = { mode: 'pointer', zoom: 1, offset: { x: 0, y: 0 } };
    if (nextGeo !== grant.display.geometry || nextTrack !== grant.trackSid || res.viewPending === true) { ready = false; closeQueue(); }
    viewPending = res.viewPending === true;
    grant = { ...grant, display: res.display ? { ...grant.display, ...res.display, geometry: nextGeo } : { ...grant.display, geometry: nextGeo }, trackSid: nextTrack };
    if (res.permissions) permissions = res.permissions; if (res.activeWindowId !== undefined) activeWindowId = res.activeWindowId;
  };
  const recoverView = async () => { if (!grant) return null; const hb = await call('heartbeat', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry }); adoptView(hb); return hb; };
  /** @param {'fill' | 'restore'} mode @param {string} [windowId] */
  const mutateWindow = async (mode, windowId) => {
    if (!grant) throw Object.assign(new Error('desktop-disconnected'), { code: 'desktop-disconnected' });
    closeQueue(); ready = false; busy = true; const seq = ++sequence;
    try { const res = await call('window', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry, sequence: seq, mode, ...(mode === 'fill' ? { windowId } : {}) }); adoptView(res); return res; }
    catch (err) { const code = /** @type {Value} */ (err)?.code ?? 'desktop-operation-unknown'; notice = code; if (code === 'desktop-operation-unknown') await recoverView().catch(() => null); throw err; }
    finally { busy = false; }
  };

  return {
    get state() { return { grant, displays, virtualDisplaySupported, permissions, selectedDisplayId, sequence, ready, busy, viewPending, notice, activeWindowId, target, camera, sentInputs }; },
    /** @param {boolean} fenced */ setWriteFence(fenced) { writeFenced = Boolean(fenced); },
    /** @param {Value} next */
    setViewportMetrics(next) {
      if (next.window) win = next.window; if (next.insets) insets = next.insets; if (next.platform) platform = next.platform;
      if (next.keyboardHeight !== undefined) keyboardHeight = Number(next.keyboardHeight); if (next.initialWindowMetrics !== undefined) initialMetrics = next.initialWindowMetrics;
      if (next.remoteDesktopEnabled !== undefined) remoteDesktopEnabled = Boolean(next.remoteDesktopEnabled); if (next.focused !== undefined) focused = Boolean(next.focused);
      if (next.paired !== undefined) paired = Boolean(next.paired); if (next.selectedDisplayId !== undefined) selectedDisplayId = String(next.selectedDisplayId);
      if (next.mode !== undefined) camera = { ...camera, mode: String(next.mode) }; if (next.zoom !== undefined) camera = { ...camera, zoom: Number(next.zoom) };
      maybeCachePortrait();
    },
    resolvePortraitViewport,
    screenOptions() {
      const disp = grant?.display ?? displays.find(d => d.id === selectedDisplayId);
      const portrait = !remoteDesktopEnabled || !focused || !paired || exiting || selectedDisplayId === 'virtual' || disp?.id === 'virtual' || disp?.kind === 'virtual';
      return { orientation: portrait ? 'portrait' : 'landscape', statusBarHidden: !portrait, gestureEnabled: false, fullScreenGestureEnabled: false };
    },
    async refreshDisplays() { const inv = await call('displays', {}); displays = inv.displays ?? []; virtualDisplaySupported = Boolean(inv.virtualDisplaySupported); if (inv.permissions) permissions = inv.permissions; return inv; },
    /** @param {string} displayId @param {Value} [cOpts] */
    async connect(displayId, cOpts = {}) {
      exiting = false; selectedDisplayId = displayId; busy = true; ready = false; notice = null;
      try { grant = await call('join', { displayId, ...(cOpts.quality ? { quality: cOpts.quality } : {}), ...(displayId === 'virtual' ? { viewport: cOpts.viewport ?? resolvePortraitViewport() } : {}) }); sequence = 0; viewPending = false; activeWindowId = null; camera = { mode: 'pointer', zoom: 1, offset: { x: 0, y: 0 } }; openQueue(); return grant; }
      finally { busy = false; }
    },
    /** @param {string} displayId @param {Value} [sOpts] */
    async switchDisplay(displayId, sOpts = {}) {
      if (!grant) throw Object.assign(new Error('desktop-disconnected'), { code: 'desktop-disconnected' });
      closeQueue(); ready = false; selectedDisplayId = displayId;
      const res = await call('display', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry, displayId, ...(displayId === 'virtual' ? { viewport: sOpts.viewport ?? resolvePortraitViewport() } : {}) });
      adoptView(res); return res;
    },
    /** @param {{ width: number, fps: number }} quality */
    async setQuality(quality) {
      if (!grant) throw Object.assign(new Error('desktop-disconnected'), { code: 'desktop-disconnected' });
      closeQueue(); ready = false; const res = await call('quality', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry, quality });
      grant = { ...grant, quality }; adoptView(res); return res;
    },
    async listWindows() { return call('windows', grant ? { connectionId: grant.connectionId } : {}); },
    /** @param {string} windowId */ fillWindow: windowId => mutateWindow('fill', windowId),
    restoreWindow: () => mutateWindow('restore'),
    /** @param {string} trackSid */
    async videoReady(trackSid) {
      if (!grant || busy || viewPending || grant.trackSid !== trackSid) return false;
      const snapGeo = grant.display.geometry; await call('ready', { connectionId: grant.connectionId, generation: grant.generation, geometry: snapGeo, trackSid });
      if (!grant || grant.trackSid !== trackSid || grant.display.geometry !== snapGeo) return false;
      ready = true; openQueue(); return true;
    },
    recoverView, sendInput,
    /** @param {{ startX: number, startY: number, moves?: Array<{ x: number, y: number }>, stageViewport?: { width: number, height: number }, mode?: string, zoom?: number }} g */
    async touchGesture(g) {
      if (!grant || !ready || busy || viewPending || permissions.accessibility === false) return { kind: 'blocked', packets: [] };
      const stage = g.stageViewport ?? resolvePortraitViewport(), mode = g.mode ?? camera.mode, zoom = g.zoom ?? camera.zoom, disp = grant.display;
      const toNorm = (/** @type {number} */ px, /** @type {number} */ py) => {
        const scale = Math.min(stage.width / disp.width, stage.height / disp.height) * zoom, w = disp.width * scale, h = disp.height * scale;
        const nx = (px - (stage.width - w) / 2 - camera.offset.x) / w, ny = (py - (stage.height - h) / 2 - camera.offset.y) / h;
        return nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1 ? { x: nx, y: ny } : null;
      };
      const initPt = toNorm(g.startX, g.startY); if (!initPt) return { kind: 'outside', packets: [] };
      const pts = g.moves ?? [];
      if (mode === 'pointer' && zoom > 1) { const last = pts[pts.length - 1] ?? { x: g.startX, y: g.startY }; camera = { ...camera, zoom, offset: { x: camera.offset.x + (last.x - g.startX), y: camera.offset.y + (last.y - g.startY) } }; return { kind: 'pan', offset: camera.offset, packets: [] }; }
      if (mode === 'drag') {
        /** @type {Promise<boolean>[]} */ const jobs = [sendInput({ action: 'pointer', phase: 'down', x: initPt.x, y: initPt.y, button: 'left' })]; let endPt = initPt;
        for (const m of pts) { const np = toNorm(m.x, m.y); if (np) { endPt = np; jobs.push(sendInput({ action: 'pointer', phase: 'move', x: np.x, y: np.y, button: 'left' })); } }
        jobs.push(sendInput({ action: 'pointer', phase: 'up', x: endPt.x, y: endPt.y, button: 'left' })); await Promise.all(jobs); return { kind: 'drag', count: jobs.length };
      }
      const maxDist = pts.reduce((mx, m) => Math.max(mx, Math.hypot(m.x - g.startX, m.y - g.startY)), 0);
      if (maxDist <= 6.0 && mode !== 'scroll') { target = initPt; await sendInput({ action: 'pointer', phase: 'click', x: initPt.x, y: initPt.y, button: mode === 'right' ? 'right' : 'left' }); return { kind: 'click', point: initPt }; }
      if (mode === 'scroll' || ((disp.id === 'virtual' || disp.kind === 'virtual') && mode === 'pointer' && zoom === 1)) {
        let lastY = g.startY; /** @type {Promise<boolean>[]} */ const jobs = [];
        for (const m of pts) { const deltaY = Math.max(-1200, Math.min(1200, Math.round(m.y - lastY))); lastY = m.y; if (deltaY !== 0) jobs.push(sendInput({ action: 'scroll', deltaY, x: initPt.x, y: initPt.y })); }
        await Promise.all(jobs); return { kind: 'scroll', anchor: initPt, count: jobs.length };
      }
      /** @type {Promise<boolean>[]} */ const movesOut = [];
      for (const m of pts) { const np = toNorm(m.x, m.y); if (np) movesOut.push(sendInput({ action: 'pointer', phase: 'move', x: np.x, y: np.y })); }
      await Promise.all(movesOut); return { kind: 'move', count: movesOut.length };
    },
    leave() {
      const prev = grant; exiting = true; closeQueue(); ready = false; grant = null; activeWindowId = null;
      return prev ? call('leave', { connectionId: prev.connectionId, generation: prev.generation, geometry: prev.display.geometry }).catch(() => ({ stopped: false })) : Promise.resolve({ stopped: true });
    },
  };
}

let esbuildQueue = Promise.resolve();
let esbuildPending = 0;

/**
 * Serialize `esbuild` builds on a shared queue and stop the `esbuild` child service
 * only when all in-flight builds have settled.
 * @param {import('esbuild').BuildOptions} buildOptions
 * @returns {Promise<import('esbuild').BuildResult>}
 */
export async function runSerializedEsbuild(buildOptions) {
  esbuildPending += 1;
  const execute = () => esbuildBuild(buildOptions);
  const next = esbuildQueue.then(execute, execute);
  esbuildQueue = next.then(() => {}, () => {});
  try {
    return await next;
  } finally {
    esbuildPending -= 1;
    if (esbuildPending === 0) {
      await esbuildStop();
    }
  }
}

/** @param {string} relPathFromRepoRoot @param {Record<string, string | Value>} [stubModules] @returns {Promise<Value>} */
export async function loadTranspiledMobileModule(relPathFromRepoRoot, stubModules = {}) {
  const mobileDir = join(REPO_ROOT, 'apps/mobile'), stubId = randomBytes(8).toString('hex'), keys = Object.keys(stubModules);
  const registry = /** @type {Map<string, Value>} */ ((/** @type {Value} */ (globalThis).__codelyncMobileStubs ??= new Map()));
  const stubPlugin = {
    name: 'codelync-mobile-stubs',
    /** @param {import('esbuild').PluginBuild} b */
    setup(b) {
      if (!keys.length) return;
      b.onResolve({ filter: /.*/ }, args => (keys.includes(args.path) ? { path: args.path, namespace: 'codelync-stub' } : null));
      b.onLoad({ filter: /.*/, namespace: 'codelync-stub' }, args => {
        const val = stubModules[args.path];
        if (typeof val === 'string') return { contents: val, loader: 'ts', resolveDir: mobileDir };
        const regKey = `${stubId}:${args.path}`; registry.set(regKey, val);
        const exportsCode = Object.keys(val).map(k => `export const ${k} = __mod[${JSON.stringify(k)}];`).join('\n');
        return { contents: `const __mod = globalThis.__codelyncMobileStubs.get(${JSON.stringify(regKey)});\n${exportsCode}\nexport default __mod;`, loader: 'ts', resolveDir: mobileDir };
      });
    },
  };
  const built = await runSerializedEsbuild({
    entryPoints: [join(REPO_ROOT, relPathFromRepoRoot)], write: false, bundle: true, format: 'esm', platform: 'node', target: 'node24',
    tsconfig: join(mobileDir, 'tsconfig.json'), nodePaths: [join(mobileDir, 'node_modules'), join(REPO_ROOT, 'node_modules')], plugins: [stubPlugin],
    logLevel: 'silent',
  });
  const files = built.outputFiles ?? [];
  assert.ok(files.length > 0, 'Expected esbuild in-memory output');
  return /** @type {Value} */ (await import('data:text/javascript;base64,' + Buffer.from(files[0].text).toString('base64')));
}

/**
 * @typedef {{
 *   ok: boolean,
 *   exitCode: number,
 *   stdout: string,
 *   stderr: string,
 *   output: string,
 *   passedTests: string[],
 *   executedCount: number,
 *   timedOut: boolean,
 *   durationMs: number,
 *   cached: boolean,
 * }} SwiftTestRunResult
 */

/** @type {Map<string, Promise<SwiftTestRunResult>>} */
const swiftTestMemo = new Map();

async function computeNativeSwiftDigest() {
  const hash = createHash('sha256');
  const files = ['native/remote-desktop/Package.swift', ...(await listWorkspaceSourceFiles(['native/remote-desktop/Sources', 'native/remote-desktop/Tests']))];
  for (const rel of files) {
    hash.update(rel + '\0');
    hash.update(await readFile(join(REPO_ROOT, rel)));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 24);
}

/** @param {string} combinedOutput @returns {string[]} */
function parsePassedSwiftTests(combinedOutput) {
  /** @type {Set<string>} */
  const passed = new Set();
  for (const m of combinedOutput.matchAll(/Test Case '-\[(?:[A-Za-z0-9_]+\.)?([A-Za-z0-9_]+)\s+([A-Za-z0-9_]+)\]' passed/gu)) {
    passed.add(`${m[1]}/${m[2]}`);
  }
  for (const m of combinedOutput.matchAll(/Test Case '([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)' passed/gu)) {
    passed.add(`${m[1]}/${m[2]}`);
  }
  return [...passed].sort();
}

/** @param {number} pid */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err)?.code === 'EPERM';
  }
}

/**
 * Execute `swift test` in an isolated `--scratch-path` with cross-process locking
 * and SHA-256 source-digest caching so parallel test workers and concurrent host builds
 * never contend on `native/remote-desktop/.build/.lock`.
 * @param {{ filter?: string, timeoutMs?: number }} [options]
 * @returns {Promise<SwiftTestRunResult>}
 */
export function runSwiftDesktopHostTests(options = {}) {
  const rawFilter = typeof options.filter === 'string' && options.filter.trim().length > 0 ? options.filter.trim() : '';
  const timeoutMs = options.timeoutMs ?? 180_000;
  const cacheTtlMs = 30_000;

  return (async () => {
    const digest = await computeNativeSwiftDigest();
    const memoKey = `${digest}::${rawFilter || '__all__'}`;
    const inFlight = swiftTestMemo.get(memoKey);
    if (inFlight) {
      const prev = await inFlight;
      if (prev.ok) return { ...prev, cached: true };
      swiftTestMemo.delete(memoKey);
    }

    const job = (async () => {
      const scratchDir = join(tmpdir(), 'codelync-e2e-swiftpm-scratch');
      const lockDir = join(tmpdir(), 'codelync-e2e-swiftpm-runner.lock');
      const safeTag = (rawFilter || 'all').replace(/[^A-Za-z0-9_.-]/gu, '_');
      const cacheFile = join(tmpdir(), `codelync-e2e-swiftpm-cache-${safeTag}-${digest}.json`);

      try {
        const cachedRaw = JSON.parse(await readFile(cacheFile, 'utf8'));
        if (cachedRaw && cachedRaw.digest === digest && cachedRaw.exitCode === 0 && cachedRaw.ok === true && Date.now() - Number(cachedRaw.at) < cacheTtlMs) {
          return /** @type {SwiftTestRunResult} */ ({ ...cachedRaw.value, cached: true });
        }
      } catch { /* cache miss */ }

      const deadline = Date.now() + timeoutMs;
      let acquired = false;
      while (!acquired && Date.now() < deadline) {
        try {
          await mkdir(lockDir);
          await writeFile(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
          acquired = true;
        } catch {
          try {
            const ownerRaw = JSON.parse(await readFile(join(lockDir, 'owner.json'), 'utf8'));
            const age = Date.now() - Number(ownerRaw?.at ?? 0);
            if (!isProcessAlive(Number(ownerRaw?.pid)) || age > 180_000) {
              await rm(lockDir, { recursive: true, force: true });
            }
          } catch {
            try {
              const st = await stat(lockDir);
              if (Date.now() - st.mtimeMs > 180_000) await rm(lockDir, { recursive: true, force: true });
            } catch { /* lock released concurrently */ }
          }
          await new Promise(r => setTimeout(r, 75));
        }
      }

      try {
        try {
          const cachedRaw = JSON.parse(await readFile(cacheFile, 'utf8'));
          if (cachedRaw && cachedRaw.digest === digest && cachedRaw.exitCode === 0 && cachedRaw.ok === true && Date.now() - Number(cachedRaw.at) < cacheTtlMs) {
            return /** @type {SwiftTestRunResult} */ ({ ...cachedRaw.value, cached: true });
          }
        } catch { /* cache miss */ }

        await mkdir(scratchDir, { recursive: true });
        const runOnce = () => new Promise(/** @param {(res: SwiftTestRunResult) => void} resolveRun */ resolveRun => {
          const args = ['test', '--package-path', join(REPO_ROOT, 'native/remote-desktop'), '--scratch-path', scratchDir];
          if (rawFilter) {
            args.push('--filter', rawFilter.replace(/\//gu, '.'));
          }
          const startedAt = Date.now();
          const child = spawn('swift', args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
          let stdout = '', stderr = '', timedOut = false;
          child.stdout?.setEncoding('utf8');
          child.stderr?.setEncoding('utf8');
          child.stdout?.on('data', chunk => { stdout += chunk; });
          child.stderr?.on('data', chunk => { stderr += chunk; });
          const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
          child.once('error', err => {
            clearTimeout(timer);
            const errText = stderr + '\n' + String(err);
            resolveRun({ ok: false, exitCode: 1, stdout, stderr: errText, output: stdout + '\n' + errText, passedTests: [], executedCount: 0, timedOut, durationMs: Date.now() - startedAt, cached: false });
          });
          child.once('close', code => {
            clearTimeout(timer);
            const exitCode = typeof code === 'number' ? code : 1;
            const output = stdout + '\n' + stderr;
            const passedTests = parsePassedSwiftTests(output);
            let executedCount = passedTests.length;
            for (const m of output.matchAll(/Executed (\d+) tests?, with 0 failures/gu)) {
              executedCount = Math.max(executedCount, Number(m[1]));
            }
            const ok = exitCode === 0 && !timedOut;
            resolveRun({ ok, exitCode, stdout, stderr, output, passedTests, executedCount, timedOut, durationMs: Date.now() - startedAt, cached: false });
          });
        });

        let result = await runOnce();
        if (!result.ok && !result.timedOut) {
          await new Promise(r => setTimeout(r, 600));
          result = await runOnce();
        }
        if (result.ok && result.exitCode === 0 && !result.timedOut) {
          await writeFile(cacheFile, JSON.stringify({ at: Date.now(), digest, exitCode: 0, ok: true, value: result }), 'utf8').catch(() => {});
        }
        return result;
      } finally {
        if (acquired) {
          await rm(lockDir, { recursive: true, force: true }).catch(() => {});
        }
      }
    })();

    swiftTestMemo.set(memoKey, job);
    try {
      const res = await job;
      if (!res.ok) swiftTestMemo.delete(memoKey);
      return res;
    } catch (err) {
      swiftTestMemo.delete(memoKey);
      throw err;
    }
  })();
}

/**
 * Match `filter` (`'Suite/test'`, `'Suite.test'`, `'Suite'`, or `'test'`) against `passedTests`.
 * @param {string[]} passedTests
 * @param {string} filter
 * @returns {string[]}
 */
function matchPassedSwiftTests(passedTests, filter) {
  const normalized = filter.trim().replace(/^CodelyncDesktopHostTests[./]/u, '').replace(/\./gu, '/');
  if (!normalized) return [];
  if (normalized.includes('/')) {
    return passedTests.filter(item => item === normalized);
  }
  return passedTests.filter(item => {
    const [suiteName, methodName] = item.split('/');
    return suiteName === normalized || methodName === normalized;
  });
}

/**
 * Check whether `res` confirms `filter` passed.
 * @param {SwiftTestRunResult} res
 * @param {string} filter
 */
function evaluateSwiftFilterMatch(res, filter) {
  const matched = matchPassedSwiftTests(res.passedTests, filter);
  const tokens = filter.trim().replace(/^CodelyncDesktopHostTests[./]/u, '').split(/[./]+/u).filter(Boolean);
  const tokenRegexes = tokens.map(tok => new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`, 'u'));
  const hasPassedLine = tokenRegexes.length > 0 && res.output.split('\n').some(line => /\bpassed\b/iu.test(line) && tokenRegexes.every(re => re.test(line)));
  return { matched, isMatched: matched.length > 0 || hasPassedLine };
}

/**
 * Verify that `filter` passes in `native/remote-desktop` SwiftPM XCTests.
 * @param {string} filter
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, filter: string, matched: string[], exitCode: number, timedOut: boolean, output: string }>}
 */
export async function runNativeHostSwiftTest(filter, options = {}) {
  const cleanFilter = filter.trim();
  if (cleanFilter) {
    const digest = await computeNativeSwiftDigest();
    const filterMemo = swiftTestMemo.get(`${digest}::${cleanFilter}`);
    if (filterMemo) {
      const prev = await filterMemo;
      if (prev.ok) {
        const { matched, isMatched } = evaluateSwiftFilterMatch(prev, cleanFilter);
        return { ok: prev.ok && isMatched, filter, matched, exitCode: prev.exitCode, timedOut: prev.timedOut, output: prev.output };
      }
    }
    const safeTag = cleanFilter.replace(/[^A-Za-z0-9_.-]/gu, '_');
    try {
      const cachedRaw = JSON.parse(await readFile(join(tmpdir(), `codelync-e2e-swiftpm-cache-${safeTag}-${digest}.json`), 'utf8'));
      if (cachedRaw && cachedRaw.digest === digest && cachedRaw.exitCode === 0 && cachedRaw.ok === true && Date.now() - Number(cachedRaw.at) < 30_000) {
        const val = /** @type {SwiftTestRunResult} */ (cachedRaw.value);
        const { matched, isMatched } = evaluateSwiftFilterMatch(val, cleanFilter);
        return { ok: val.ok && isMatched, filter, matched, exitCode: val.exitCode, timedOut: val.timedOut, output: val.output };
      }
    } catch { /* no per-filter cache hit */ }
  }

  const res = await runSwiftDesktopHostTests(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {});
  const { matched, isMatched } = evaluateSwiftFilterMatch(res, filter);
  if (res.ok || res.timedOut || !isMatched || !cleanFilter) {
    return { ok: res.ok && isMatched, filter, matched, exitCode: res.exitCode, timedOut: res.timedOut, output: res.output };
  }

  const filteredRes = await runSwiftDesktopHostTests({
    filter: cleanFilter,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  const filteredEval = evaluateSwiftFilterMatch(filteredRes, filter);
  return {
    ok: filteredRes.ok && filteredEval.isMatched,
    filter,
    matched: filteredEval.matched,
    exitCode: filteredRes.exitCode,
    timedOut: filteredRes.timedOut,
    output: filteredRes.output,
  };
}

/** @param {string[]} args @param {string | null} stdinText @param {number} timeoutMs */
async function spawnBoundedHost(args, stdinText, timeoutMs) {
  const capMs = Math.min(5000, Math.max(100, timeoutMs)), started = Date.now();
  const child = spawn(join(REPO_ROOT, 'native/bin/CodelyncDesktopHost'), args, { stdio: [stdinText === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', timedOut = false;
  child.stdout?.on('data', chunk => { stdout += String(chunk); }); child.stderr?.on('data', chunk => { stderr += String(chunk); });
  if (stdinText !== null && child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(stdinText); }
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, capMs);
  const [exitCode, signal] = /** @type {[number | null, NodeJS.Signals | null]} */ (await new Promise((done, reject) => { child.once('error', reject); child.once('exit', (c, s) => done([c, s])); }));
  clearTimeout(timer);
  return { exitCode, signal, stdout, stderr, timedOut, durationMs: Date.now() - started };
}
/** @param {string[]} [args] @param {number} [timeoutMs] */
export async function probeNativeHostCli(args = [], timeoutMs = 4500) { return spawnBoundedHost(args, null, timeoutMs); }
/** @param {Array<Value | string>} [requests] @param {string[]} [args] @param {number} [timeoutMs] */
export async function probeNativeHostDaemon(requests = [{ id: 'e2e-probe', operation: 'status' }], args = [], timeoutMs = 4500) {
  const res = await spawnBoundedHost(args, requests.length ? requests.map(r => (typeof r === 'string' ? r : JSON.stringify(r)) + '\n').join('') : null, timeoutMs);
  /** @type {Value[]} */ const replies = [];
  for (const line of res.stdout.split('\n')) if (line.trim()) { try { replies.push(JSON.parse(line)); } catch { /* ignore */ } }
  return { ...res, replies };
}
export async function inspectNativeHostUndefinedSymbols() {
  const { stdout } = await execFileAsync('/usr/bin/nm', ['-u', join(REPO_ROOT, 'native/bin/CodelyncDesktopHost')]);
  const symbols = stdout.split('\n').map(s => s.trim()).filter(Boolean), virtualDisplaySymbols = symbols.filter(s => s.includes('CGVirtualDisplay'));
  return { stdout, symbols, virtualDisplaySymbols, hasStaticVirtualDisplaySymbols: virtualDisplaySymbols.length > 0 };
}
/** @param {string} [targetDir] */
export async function verifyNativeRuntimeManifest(targetDir = join(REPO_ROOT, 'native/bin')) { return verifyDesktopRuntimeManifest(targetDir); }
