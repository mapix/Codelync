import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import { DesktopHostProcess } from '../../src/codelync/desktop-host.mjs';
import { desktopInput } from '../../src/codelync/remote-desktop.mjs';
import { BridgeError } from '../../src/errors.mjs';
import { publicSourcePath } from '../../src/release/source-snapshot.mjs';
import {
  validatePublicTestflightManifest,
  validateMacLocalizationParity,
} from '../../scripts/audit-public-release.mjs';
import {
  checkPublicSourceHygiene,
  createDesktopGatewayHarness,
  inspectNativeHostUndefinedSymbols,
  listWorkspaceSourceFiles,
  probeNativeHostDaemon,
  readWorkspaceFile,
  runNativeHostSwiftTest,
  verifyNativeRuntimeManifest,
} from './harness.mjs';
import {
  createMobileSyncRuntime,
  flattenStyle,
  loadRemoteDesktopLabelsRuntime,
  mountDesktopScreenRuntime,
  mountRemoteDesktopViewRuntime,
  mountUseRemoteDesktopRuntime,
} from './mobile-runtime-harness.mjs';

/** @typedef {Record<string, any>} Value */

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/**
 * @returns {{ promise: Promise<void>, resolve: () => void, reject: (err: Error) => void }}
 */
function createDeferred() {
  /** @type {() => void} */
  let resolveFn = () => {};
  /** @type {(err: Error) => void} */
  let rejectFn = () => {};
  /** @type {Promise<void>} */
  const promise = new Promise((res, rej) => {
    resolveFn = () => res();
    rejectFn = rej;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

test('[T5-01] Window RPC 3-branch sequence reservation and view-invalidation fence', async t => {
  const harness = await createDesktopGatewayHarness(t);
  assert.ok(harness.hostFixture);

  const joinRes = await harness.requestDesktopHttp('join', {
    displayId: 'virtual',
    viewport: { width: 393, height: 759 },
  });
  assert.equal(joinRes.status, 200);
  assert.ok(joinRes.data);
  const { connectionId, generation, trackSid } = joinRes.data;
  const initialGeometry = joinRes.data.display.geometry;

  const readyRes = await harness.requestDesktopHttp('ready', {
    connectionId,
    generation,
    geometry: initialGeometry,
    trackSid,
  });
  assert.equal(readyRes.status, 200);

  // Branch (a): Pre-mutation domain failure (!viewPending) reserves seq=1 while preserving ready=true.
  await harness.hostFixture.updateConfig({
    failOperation: {
      window: { error: 'desktop-window-unresponsive', invalidateFirst: false },
    },
  });
  const branchAFail = await harness.requestDesktopHttp('window', {
    connectionId,
    generation,
    geometry: initialGeometry,
    sequence: 1,
    mode: 'fill',
    windowId: '1001:5001',
  });
  assert.equal(branchAFail.status, 409);
  assert.equal(branchAFail.error, 'desktop-window-unresponsive');

  await harness.hostFixture.updateConfig({ failOperation: {} });

  const replayWindowSeq1 = await harness.requestDesktopHttp('window', {
    connectionId,
    generation,
    geometry: initialGeometry,
    sequence: 1,
    mode: 'fill',
    windowId: '1001:5001',
  });
  assert.equal(replayWindowSeq1.status, 409);
  assert.equal(replayWindowSeq1.error, 'desktop-sequence-out-of-order');

  const replayInputSeq1 = await harness.requestDesktopHttp('input', {
    connectionId,
    generation,
    geometry: initialGeometry,
    sequence: 1,
    input: { action: 'pointer', phase: 'click', x: 0.5, y: 0.5, button: 'left' },
  });
  assert.equal(replayInputSeq1.status, 409);
  assert.equal(replayInputSeq1.error, 'desktop-input-replayed');

  const validInputSeq2 = await harness.requestDesktopHttp('input', {
    connectionId,
    generation,
    geometry: initialGeometry,
    sequence: 2,
    input: { action: 'pointer', phase: 'click', x: 0.5, y: 0.5, button: 'left' },
  });
  assert.equal(validInputSeq2.status, 200);
  assert.ok(validInputSeq2.data);
  assert.equal(validInputSeq2.data.accepted, true);
  assert.equal(validInputSeq2.data.sequence, 2);

  // Branch (b): Post-invalidation failure (invalidateFirst: true) forces viewPending=true & ready=false.
  await harness.hostFixture.updateConfig({
    failOperation: {
      window: { error: 'desktop-window-unresponsive', invalidateFirst: true },
    },
  });
  const branchBFail = await harness.requestDesktopHttp('window', {
    connectionId,
    generation,
    geometry: initialGeometry,
    sequence: 3,
    mode: 'fill',
    windowId: '1001:5001',
  });
  assert.equal(branchBFail.status, 409);
  assert.equal(branchBFail.error, 'desktop-window-unresponsive');

  await harness.hostFixture.updateConfig({ failOperation: {} });

  const fencedInputSeq4 = await harness.requestDesktopHttp('input', {
    connectionId,
    generation,
    geometry: initialGeometry,
    sequence: 4,
    input: { action: 'pointer', phase: 'click', x: 0.4, y: 0.4, button: 'left' },
  });
  assert.equal(fencedInputSeq4.status, 409);
  assert.equal(fencedInputSeq4.error, 'desktop-view-changed');

  const fencedWindowSeq4 = await harness.requestDesktopHttp('window', {
    connectionId,
    generation,
    geometry: initialGeometry,
    sequence: 4,
    mode: 'fill',
    windowId: '1001:5001',
  });
  assert.equal(fencedWindowSeq4.status, 409);
  assert.equal(fencedWindowSeq4.error, 'desktop-view-changed');

  const hbAfterB = await harness.requestDesktopHttp('heartbeat', {
    connectionId,
    generation,
    geometry: initialGeometry,
  });
  assert.equal(hbAfterB.status, 200);
  assert.ok(hbAfterB.data);
  assert.equal(hbAfterB.data.viewPending, false);
  const settledGeoB = hbAfterB.data.geometry;
  const settledTrackB = hbAfterB.data.trackSid;

  const readyAfterB = await harness.requestDesktopHttp('ready', {
    connectionId,
    generation,
    geometry: settledGeoB,
    trackSid: settledTrackB,
  });
  assert.equal(readyAfterB.status, 200);

  // Verify sequence 4 was NOT burned while fenced by viewPending.
  const unblockedInputSeq4 = await harness.requestDesktopHttp('input', {
    connectionId,
    generation,
    geometry: settledGeoB,
    sequence: 4,
    input: { action: 'pointer', phase: 'click', x: 0.4, y: 0.4, button: 'left' },
  });
  assert.equal(unblockedInputSeq4.status, 200);
  assert.ok(unblockedInputSeq4.data);
  assert.equal(unblockedInputSeq4.data.sequence, 4);

  // Branch (c): Ambiguous 503 desktop-operation-unknown reserves seq=5 and forces ready=false.
  await harness.hostFixture.updateConfig({
    failOperation: {
      window: { error: 'desktop-operation-unknown', invalidateFirst: false },
    },
  });
  const branchCFail = await harness.requestDesktopHttp('window', {
    connectionId,
    generation,
    geometry: settledGeoB,
    sequence: 5,
    mode: 'fill',
    windowId: '1001:5001',
  });
  assert.equal(branchCFail.status, 503);
  assert.equal(branchCFail.error, 'desktop-operation-unknown');

  await harness.hostFixture.updateConfig({ failOperation: {} });

  const replayWindowSeq5 = await harness.requestDesktopHttp('window', {
    connectionId,
    generation,
    geometry: settledGeoB,
    sequence: 5,
    mode: 'fill',
    windowId: '1001:5001',
  });
  assert.equal(replayWindowSeq5.status, 409);
  assert.equal(replayWindowSeq5.error, 'desktop-sequence-out-of-order');

  const notReadyInputSeq6 = await harness.requestDesktopHttp('input', {
    connectionId,
    generation,
    geometry: settledGeoB,
    sequence: 6,
    input: { action: 'pointer', phase: 'click', x: 0.6, y: 0.6, button: 'left' },
  });
  assert.equal(notReadyInputSeq6.status, 409);
  assert.equal(notReadyInputSeq6.error, 'desktop-not-ready');

  const readyAfterC = await harness.requestDesktopHttp('ready', {
    connectionId,
    generation,
    geometry: settledGeoB,
    trackSid: settledTrackB,
  });
  assert.equal(readyAfterC.status, 200);

  const windowSeq6 = await harness.requestDesktopHttp('window', {
    connectionId,
    generation,
    geometry: settledGeoB,
    sequence: 6,
    mode: 'fill',
    windowId: '1001:5001',
  });
  assert.equal(windowSeq6.status, 200);
  assert.ok(windowSeq6.data);
  assert.equal(windowSeq6.data.accepted, true);
  assert.equal(windowSeq6.data.sequence, 6);
  assert.equal(windowSeq6.data.activeWindowId, '1001:5001');
});

test('[T5-02] adoptView mid-flight ready rotation race and DesktopHostProcess saturation/framing', async t => {
  // Part A: Mid-flight geometry/track rotation during ready()'s internal heartbeat.
  let heartbeatCallCount = 0;
  let currentDisplay = {
    id: 'virtual',
    name: 'Phone Screen',
    kind: 'virtual',
    width: 1080,
    height: 2086,
    logicalWidth: 540,
    logicalHeight: 1043,
    geometry: 'virt-g1',
  };
  let currentTrack = 'TR_1';
  let currentPending = false;
  const perms = { screenRecording: true, accessibility: true, locked: false };

  class RotatingMockHost extends EventEmitter {
    /** @param {string} op @param {Value} [_payload] */
    async request(op, _payload = {}) {
      if (op === 'displays') {
        return {
          displays: [currentDisplay],
          permissions: perms,
          virtualDisplaySupported: true,
        };
      }
      if (op === 'start') {
        return {
          connected: true,
          capturing: true,
          viewerConnected: true,
          permissions: perms,
          display: currentDisplay,
          geometry: currentDisplay.geometry,
          trackSid: currentTrack,
          viewPending: false,
        };
      }
      if (op === 'window') {
        currentDisplay = {
          id: 'virtual',
          name: 'Phone Screen',
          kind: 'virtual',
          width: 1560,
          height: 3012,
          logicalWidth: 780,
          logicalHeight: 1506,
          geometry: 'virt-g2',
        };
        currentTrack = 'TR_2';
        currentPending = true;
        return {
          connected: true,
          capturing: true,
          viewerConnected: true,
          permissions: perms,
          display: currentDisplay,
          geometry: 'virt-g2',
          trackSid: 'TR_2',
          viewPending: true,
          activeWindowId: '1001:5001',
          upshifted: true,
        };
      }
      if (op === 'heartbeat') {
        heartbeatCallCount += 1;
        if (heartbeatCallCount === 1) {
          // Initial ready('virt-g1', 'TR_1')
          return {
            connected: true,
            capturing: true,
            viewerConnected: true,
            permissions: perms,
            display: currentDisplay,
            geometry: currentDisplay.geometry,
            trackSid: currentTrack,
            viewPending: false,
          };
        }
        if (heartbeatCallCount === 2) {
          // Explicit heartbeat clearing viewPending -> TR_3
          currentPending = false;
          currentTrack = 'TR_3';
          return {
            connected: true,
            capturing: true,
            viewerConnected: true,
            permissions: perms,
            display: currentDisplay,
            geometry: 'virt-g2',
            trackSid: 'TR_3',
            viewPending: false,
          };
        }
        if (heartbeatCallCount === 3) {
          // Mid-flight rotation inside ready('virt-g2', 'TR_3') -> ('virt-g3', 'TR_4', 800x1545 / 1600x3090px)
          currentDisplay = {
            id: 'virtual',
            name: 'Phone Screen',
            kind: 'virtual',
            width: 1600,
            height: 3090,
            logicalWidth: 800,
            logicalHeight: 1545,
            geometry: 'virt-g3',
          };
          currentTrack = 'TR_4';
          return {
            connected: true,
            capturing: true,
            viewerConnected: true,
            permissions: perms,
            display: currentDisplay,
            geometry: 'virt-g3',
            trackSid: 'TR_4',
            viewPending: false,
          };
        }
        return {
          connected: true,
          capturing: true,
          viewerConnected: true,
          permissions: perms,
          display: currentDisplay,
          geometry: currentDisplay.geometry,
          trackSid: currentTrack,
          viewPending: currentPending,
        };
      }
      if (op === 'stop') return { stopped: true };
      throw new BridgeError('invalid-desktop-operation', 'Unsupported mock op', 400);
    }
    interrupt() {}
    async close() {}
  }

  const harness = await createDesktopGatewayHarness(t, {
    hostFactory: () => new RotatingMockHost(),
  });
  const joined = await harness.requestDesktopHttp('join', {
    displayId: 'virtual',
    viewport: { width: 393, height: 759 },
  });
  assert.equal(joined.status, 200);
  assert.ok(joined.data);
  const { connectionId, generation } = joined.data;

  const ready1 = await harness.requestDesktopHttp('ready', {
    connectionId,
    generation,
    geometry: 'virt-g1',
    trackSid: 'TR_1',
  });
  assert.equal(ready1.status, 200);

  const fillRes = await harness.requestDesktopHttp('window', {
    connectionId,
    generation,
    geometry: 'virt-g1',
    sequence: 1,
    mode: 'fill',
    windowId: '1001:5001',
  });
  assert.equal(fillRes.status, 200);
  assert.ok(fillRes.data);
  assert.equal(fillRes.data.viewPending, true);
  assert.equal(harness.desktop.status().display?.width, 1560);
  assert.equal(harness.desktop.status().display?.height, 3012);
  assert.equal(harness.desktop.status().display?.logicalWidth, 780);
  assert.equal(harness.desktop.status().display?.logicalHeight, 1506);

  const readyWhilePending = await harness.requestDesktopHttp('ready', {
    connectionId,
    generation,
    geometry: 'virt-g2',
    trackSid: 'TR_2',
  });
  assert.equal(readyWhilePending.status, 409);
  assert.equal(readyWhilePending.error, 'desktop-not-ready');

  const hbSettled = await harness.requestDesktopHttp('heartbeat', {
    connectionId,
    generation,
    geometry: 'virt-g2',
  });
  assert.equal(hbSettled.status, 200);
  assert.ok(hbSettled.data);
  assert.equal(hbSettled.data.trackSid, 'TR_3');
  assert.equal(hbSettled.data.viewPending, false);

  const midFlightReady = await harness.requestDesktopHttp('ready', {
    connectionId,
    generation,
    geometry: 'virt-g2',
    trackSid: 'TR_3',
  });
  assert.equal(midFlightReady.status, 409);
  assert.equal(midFlightReady.error, 'desktop-not-ready');
  assert.equal(harness.desktop.status().display?.width, 1600);
  assert.equal(harness.desktop.status().display?.height, 3090);
  assert.equal(harness.desktop.status().display?.logicalWidth, 800);
  assert.equal(harness.desktop.status().display?.logicalHeight, 1545);
  assert.equal(harness.desktop.status().display?.geometry, 'virt-g3');

  const freshReady = await harness.requestDesktopHttp('ready', {
    connectionId,
    generation,
    geometry: 'virt-g3',
    trackSid: 'TR_4',
  });
  assert.equal(freshReady.status, 200);
  assert.ok(freshReady.data);
  assert.equal(freshReady.data.ready, true);

  // Part B: DesktopHostProcess saturation (pending.size >= 8), >262,144-byte stdout drop, and error sanitization.
  const tempDir = await mkdtemp(join(tmpdir(), 'codelync-t5-hostproc-'));
  const scriptPath = join(tempDir, 'adversarial-host.mjs');
  const wrapperPath = join(tempDir, 'run-adversarial-host.sh');
  const releaseFlagPath = join(tempDir, 'release-held.flag');
  await writeFile(
    scriptPath,
    [
      "import { createInterface } from 'node:readline';",
      "import { existsSync } from 'node:fs';",
      `const releaseFlag = ${JSON.stringify(releaseFlagPath)};`,
      'const held = [];',
      'const timer = setInterval(() => {',
      '  if (held.length > 0 && existsSync(releaseFlag)) {',
      '    while (held.length > 0) {',
      '      const id = held.shift();',
      '      process.stdout.write(JSON.stringify({ id, ok: true, result: { released: true } }) + "\\n");',
      '    }',
      '  }',
      '}, 10);',
      'timer.unref();',
      'createInterface({ input: process.stdin }).on("line", line => {',
      '  let msg; try { msg = JSON.parse(line); } catch { return; }',
      '  if (msg.hold) { held.push(msg.id); return; }',
      '  if (msg.oversize) {',
      '    process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { pad: "x".repeat(270_000) } }) + "\\n");',
      '    process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { oversizeSurvived: true } }) + "\\n");',
      '    return;',
      '  }',
      '  if (msg.badError) {',
      '    process.stdout.write(JSON.stringify({ id: msg.id, ok: false, error: "UPPER_BAD!" }) + "\\n");',
      '    return;',
      '  }',
      '  process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { ok: true } }) + "\\n");',
      '});',
    ].join('\n'),
    'utf8',
  );
  await writeFile(wrapperPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, { mode: 0o755 });

  const hostProc = new DesktopHostProcess({ binary: wrapperPath });
  t.after(async () => {
    await hostProc.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const heldPromises = Array.from({ length: 8 }, (_, idx) => hostProc.request('status', { hold: true, idx }));
  assert.equal(hostProc.pending.size, 8);

  await assert.rejects(
    () => hostProc.request('status', { ninth: true }),
    /** @param {any} err */ err => err?.code === 'desktop-input-busy' && err?.status === 429,
  );

  await writeFile(releaseFlagPath, '1', 'utf8');
  const heldResults = await Promise.all(heldPromises);
  assert.equal(heldResults.length, 8);
  assert.ok(heldResults.every(item => item?.released === true));

  const oversizeResult = await hostProc.request('status', { oversize: true });
  assert.deepEqual(oversizeResult, { oversizeSurvived: true });

  await assert.rejects(
    () => hostProc.request('status', { badError: true }),
    /** @param {any} err */ err => err?.code === 'desktop-host-failed' && err?.status === 503,
  );
});

test('[T5-03] --state-dir corrupt JSON quarantine, write-ahead obstruction, and multi-switch idempotency', async t => {
  // (a) Real native binary quarantines unsupported version:99 display-modes-snapshot.json with 0o600 permissions.
  const nativeStateDir = await mkdtemp(join(tmpdir(), 'codelync-t5-nativestate-'));
  t.after(() => rm(nativeStateDir, { recursive: true, force: true }));

  const snapFile = join(nativeStateDir, 'display-modes-snapshot.json');
  await writeFile(
    snapFile,
    JSON.stringify({ version: 99, savedAt: '2026-11-18T00:00:00Z', displays: [] }),
    { mode: 0o644 },
  );

  const daemonProbe = await probeNativeHostDaemon(
    [{ id: 's1', operation: 'status' }],
    ['--state-dir=' + nativeStateDir],
  );
  assert.equal(daemonProbe.exitCode, 0);
  const s1Reply = daemonProbe.replies.find(r => r.id === 's1');
  assert.equal(s1Reply?.ok, true);

  const stateEntries = await readdir(nativeStateDir);
  const quarantinedSnap = stateEntries.find(name => name.startsWith('display-modes-snapshot.json.corrupt-'));
  assert.ok(quarantinedSnap, `Expected quarantined display snapshot, found: ${stateEntries.join(', ')}`);
  const qStat = await stat(join(nativeStateDir, quarantinedSnap));
  assert.equal(qStat.mode & 0o777, 0o600);

  // (b) Pre-seed corrupt window-restore.json -> startup quarantine; obstruct with directory -> 409; multi-switch A -> B -> restore.
  const harness = await createDesktopGatewayHarness(t);
  assert.ok(harness.hostFixture);

  const restorePath = join(harness.desktopState, 'window-restore.json');
  await writeFile(restorePath, '{bad', { mode: 0o600 });

  const joinRes = await harness.requestDesktopHttp('join', {
    displayId: 'virtual',
    viewport: { width: 393, height: 759 },
  });
  assert.equal(joinRes.status, 200);
  assert.ok(joinRes.data);
  const { connectionId, generation, trackSid } = joinRes.data;
  const g1 = joinRes.data.display.geometry;

  const desktopEntriesAfterStart = await readdir(harness.desktopState);
  assert.ok(
    desktopEntriesAfterStart.some(name => name.startsWith('window-restore.json.corrupt-')),
    'Expected startup quarantine of corrupt window-restore.json',
  );

  const ready1 = await harness.requestDesktopHttp('ready', {
    connectionId,
    generation,
    geometry: g1,
    trackSid,
  });
  assert.equal(ready1.status, 200);

  // Obstruct write-ahead path with a directory
  await mkdir(restorePath, { recursive: true, mode: 0o700 });
  await harness.hostFixture.clearEvents();

  const obstructedFill = await harness.requestDesktopHttp('window', {
    connectionId,
    generation,
    geometry: g1,
    sequence: 1,
    mode: 'fill',
    windowId: '1001:5001',
  });
  assert.equal(obstructedFill.status, 409);
  assert.equal(obstructedFill.error, 'desktop-restore-persist-failed');

  const eventsAfterObstruct = await harness.hostFixture.getEvents();
  assert.equal(eventsAfterObstruct.filter(e => e.type === 'window-filled').length, 0);

  // Pre-mutation persist failure preserves ready=true
  const probeInputAfterPersistFail = await harness.requestDesktopHttp('input', {
    connectionId,
    generation,
    geometry: g1,
    sequence: 2,
    input: { action: 'pointer', phase: 'click', x: 0.5, y: 0.5, button: 'left' },
  });
  assert.equal(probeInputAfterPersistFail.status, 200);

  // Remove directory obstruction and run 1001:5001 -> 1002:5002 -> restore
  await rm(restorePath, { recursive: true, force: true });
  await harness.hostFixture.clearEvents();

  const fillA = await harness.requestDesktopHttp('window', {
    connectionId,
    generation,
    geometry: g1,
    sequence: 3,
    mode: 'fill',
    windowId: '1001:5001',
  });
  assert.equal(fillA.status, 200);
  assert.ok(fillA.data);
  const restoreStatA = await stat(restorePath);
  assert.equal(restoreStatA.mode & 0o777, 0o600);

  const readyA = await harness.requestDesktopHttp('ready', {
    connectionId,
    generation,
    geometry: fillA.data.geometry,
    trackSid: fillA.data.trackSid,
  });
  assert.equal(readyA.status, 200);

  await harness.hostFixture.clearEvents();
  const fillB = await harness.requestDesktopHttp('window', {
    connectionId,
    generation,
    geometry: fillA.data.geometry,
    sequence: 4,
    mode: 'fill',
    windowId: '1002:5002',
  });
  assert.equal(fillB.status, 200);
  assert.ok(fillB.data);

  const switchEvents = await harness.hostFixture.getEvents();
  const restoreSwitchIdx = switchEvents.findIndex(e => e.type === 'restore-windows' && e.trigger === 'window-switch');
  const fillBIdx = switchEvents.findIndex(e => e.type === 'window-filled' && e.windowId === '1002:5002');
  assert.ok(restoreSwitchIdx >= 0 && fillBIdx > restoreSwitchIdx, 'Expected window-switch restore before write-ahead fill of B');

  const restoreStatB = await stat(restorePath);
  assert.equal(restoreStatB.mode & 0o777, 0o600);
  const savedB = JSON.parse(await readFile(restorePath, 'utf8'));
  assert.equal(savedB.records[0]?.windowId, 5002);

  const readyB = await harness.requestDesktopHttp('ready', {
    connectionId,
    generation,
    geometry: fillB.data.geometry,
    trackSid: fillB.data.trackSid,
  });
  assert.equal(readyB.status, 200);

  const manualRestore = await harness.requestDesktopHttp('window', {
    connectionId,
    generation,
    geometry: fillB.data.geometry,
    sequence: 5,
    mode: 'restore',
  });
  assert.equal(manualRestore.status, 200);
  await assert.rejects(stat(restorePath), { code: 'ENOENT' });

  // (c) Verify SwiftPM XCTests for durable store permissions/symlink defense and same-window refill frame idempotency.
  const [durableTest, refillTest] = await Promise.all([
    runNativeHostSwiftTest('testDurableJSONStorePermissionsQuarantineAndSymlinkDefense'),
    runNativeHostSwiftTest('testRefillAlreadyTrackedWindowPreservesOriginalPreVirtualFrame'),
  ]);
  assert.equal(durableTest.ok, true, durableTest.output);
  assert.equal(refillTest.ok, true, refillTest.output);
});

test('[T5-04] Dual Mach-O dynamic symbol cleanliness and DesktopStdinFramer adversarial stream', async () => {
  const symInfo = await inspectNativeHostUndefinedSymbols();
  assert.equal(symInfo.virtualDisplaySymbols.length, 0);
  assert.equal(symInfo.symbols.filter(s => s.includes('AXUIElement')).length, 0);
  assert.equal(symInfo.symbols.filter(s => s.includes('CGEventTapCreate')).length, 0);

  const mainSwift = await readWorkspaceFile('native/remote-desktop/Sources/CodelyncDesktopHost/main.swift');
  assert.ok(mainSwift.includes('// BEGIN CODELYNC DESKTOP STDIN FRAMER'));
  assert.ok(mainSwift.includes('// END CODELYNC DESKTOP STDIN FRAMER'));
  assert.ok(mainSwift.includes('16_384'));

  const probe = await probeNativeHostDaemon([
    JSON.stringify({ id: 'oversize', operation: 'status', pad: 'x'.repeat(20_000) }),
    '{not-valid-json',
    '["array"]',
    '{"id":"crlf-ok","operation":"status"}\r',
    { id: 'unknown-op', operation: 'bogus-op' },
    { id: 'after-adversarial', operation: 'displays' },
  ]);
  assert.equal(probe.exitCode, 0);
  assert.deepEqual(
    probe.replies.map(r => [r.id, r.ok]),
    [
      ['crlf-ok', true],
      ['unknown-op', false],
      ['after-adversarial', true],
    ],
  );
  assert.equal(probe.replies[1]?.error, 'invalid-desktop-operation');

  const selfHygiene = await checkPublicSourceHygiene('test/e2e-remote-desktop-virtual/tier5-adversarial-hardening.test.mjs');
  assert.equal(selfHygiene.clean, true, `Tier 5 source hygiene failed: ${selfHygiene.leaks.join(', ')}`);
});

test('[T5-05] Scroll (x, y) partial/out-of-range rejection without sequence burn and -0 anchor persistence', async t => {
  const harness = await createDesktopGatewayHarness(t);
  assert.ok(harness.hostFixture);

  const joinRes = await harness.requestDesktopHttp('join', {
    displayId: 'virtual',
    viewport: { width: 393, height: 759 },
  });
  assert.equal(joinRes.status, 200);
  assert.ok(joinRes.data);
  const { connectionId, generation, trackSid } = joinRes.data;
  const geometry = joinRes.data.display.geometry;

  const readyRes = await harness.requestDesktopHttp('ready', {
    connectionId,
    generation,
    geometry,
    trackSid,
  });
  assert.equal(readyRes.status, 200);

  const invalidScrollPayloads = [
    { action: 'scroll', deltaY: 120, x: 0.5 },
    { action: 'scroll', deltaY: 120, y: 0.5 },
    { action: 'scroll', deltaY: 120, x: null, y: 0.5 },
    { action: 'scroll', deltaY: 120, x: -0.001, y: 0.5 },
    { action: 'scroll', deltaY: 120, x: 0.5, y: 1.001 },
    { action: 'scroll', deltaY: 1201, x: 0.5, y: 0.5 },
    { action: 'scroll', deltaY: 120, x: 0.5, y: 0.5, button: 'left' },
  ];

  for (const invalidInput of invalidScrollPayloads) {
    const res = await harness.requestDesktopHttp('input', {
      connectionId,
      generation,
      geometry,
      sequence: 1,
      input: invalidInput,
    });
    assert.equal(res.status, 400);
    assert.equal(res.error, 'invalid-desktop-input');
  }

  // Direct unit check and raw sealed JSON wire check with literal `-0` so JSON.parse yields `-0` on server.
  const directNormalized = desktopInput({ action: 'scroll', deltaY: -1200, x: -0, y: 1 });
  assert.equal(Object.is(directNormalized.x, 0), true);

  await harness.hostFixture.clearEvents();
  const nonce = randomBytes(24);
  const rawPlain = Buffer.from(
    `{"version":1,"at":${Date.now()},"action":"input","connectionId":${JSON.stringify(connectionId)},"generation":${JSON.stringify(generation)},"geometry":${JSON.stringify(geometry)},"sequence":1,"input":{"action":"scroll","deltaY":-1200,"x":-0,"y":1}}`,
    'utf8',
  );
  const cipher = nacl.box(rawPlain, nonce, harness.mac.publicKey, harness.phone.secretKey);
  const rawEnvelope = JSON.stringify({
    version: 1,
    nonce: nonce.toString('base64url'),
    ciphertext: Buffer.from(cipher).toString('base64url'),
  });

  const validSeq1 = await harness.requestDesktopHttp('input', {}, { rawBody: rawEnvelope });
  assert.equal(validSeq1.status, 200);
  assert.ok(validSeq1.data);
  assert.equal(validSeq1.data.sequence, 1);

  const validSeq2 = await harness.requestDesktopHttp('input', {
    connectionId,
    generation,
    geometry,
    sequence: 2,
    input: { action: 'scroll', deltaY: 1200 },
  });
  assert.equal(validSeq2.status, 200);
  assert.ok(validSeq2.data);
  assert.equal(validSeq2.data.sequence, 2);

  const inputEvents = (await harness.hostFixture.getEvents()).filter(e => e.type === 'input');
  assert.equal(inputEvents.length, 2);
  assert.equal(Object.is(inputEvents[0]?.cursor?.x, 0), true);
  assert.equal(inputEvents[0]?.cursor?.y, 1);
  assert.equal(Object.is(inputEvents[1]?.cursor?.x, 0), true);
  assert.equal(inputEvents[1]?.cursor?.y, 1);

  const swiftScroll = await runNativeHostSwiftTest(
    'CaptureAndInputTests/testScrollCoordinateAnchorAndEndToEndPortraitClarityAndInputValidation',
  );
  assert.equal(swiftScroll.ok, true, swiftScroll.output);
});

test('[T5-06] Headless virtual-to-physical fallback ID substitution vs physical spoofing rejection', async t => {
  const perms = { screenRecording: true, accessibility: true, locked: false };
  /** @type {Value} */
  let currentDisp = {
    id: 'virtual',
    name: 'Phone Screen',
    kind: 'virtual',
    width: 1080,
    height: 2086,
    logicalWidth: 540,
    logicalHeight: 1043,
    geometry: 'virt-g1',
  };
  let currentTrack = 'TR_1';

  class HeadlessFallbackMockHost extends EventEmitter {
    /** @param {string} op @param {Value} [msg] */
    async request(op, msg = {}) {
      if (op === 'displays') {
        return {
          displays: [
            {
              id: 'virtual',
              name: 'Phone Screen',
              kind: 'virtual',
              width: 1080,
              height: 2160,
              logicalWidth: 540,
              logicalHeight: 1080,
              geometry: 'virt-preview',
            },
          ],
          permissions: perms,
          virtualDisplaySupported: true,
        };
      }
      if (op === 'start') {
        return {
          connected: true,
          capturing: true,
          viewerConnected: true,
          permissions: perms,
          display: currentDisp,
          geometry: currentDisp.geometry,
          trackSid: currentTrack,
          viewPending: false,
        };
      }
      if (op === 'display') {
        if (msg.displayId === '99') {
          currentDisp = {
            id: '1',
            name: 'Main display',
            kind: 'physical',
            width: 3840,
            height: 2160,
            geometry: 'phys-1-g2',
          };
          currentTrack = 'TR_2';
          return {
            connected: true,
            capturing: true,
            viewerConnected: true,
            permissions: perms,
            display: currentDisp,
            geometry: 'phys-1-g2',
            trackSid: 'TR_2',
            viewPending: false,
          };
        }
        // Spoofed physical-to-physical mismatch: caller asked for '2', host returned '1'
        return {
          connected: true,
          capturing: true,
          viewerConnected: true,
          permissions: perms,
          display: {
            id: '1',
            name: 'Main display',
            kind: 'physical',
            width: 3840,
            height: 2160,
            geometry: 'phys-1-g3',
          },
          geometry: 'phys-1-g3',
          trackSid: 'TR_3',
          viewPending: false,
        };
      }
      if (op === 'heartbeat') {
        return {
          connected: true,
          capturing: true,
          viewerConnected: true,
          permissions: perms,
          display: currentDisp,
          geometry: currentDisp.geometry,
          trackSid: currentTrack,
          viewPending: false,
        };
      }
      if (op === 'stop') return { stopped: true };
      throw new BridgeError('invalid-desktop-operation', 'Unsupported op', 400);
    }
    interrupt() {}
    async close() {}
  }

  const harness = await createDesktopGatewayHarness(t, {
    hostFactory: () => new HeadlessFallbackMockHost(),
  });

  const joined = await harness.requestDesktopHttp('join', {
    displayId: 'virtual',
    viewport: { width: 393, height: 759 },
  });
  assert.equal(joined.status, 200);
  assert.ok(joined.data);
  const { connectionId, generation } = joined.data;

  const readyVirt = await harness.requestDesktopHttp('ready', {
    connectionId,
    generation,
    geometry: 'virt-g1',
    trackSid: 'TR_1',
  });
  assert.equal(readyVirt.status, 200);

  // Headless virtual-to-physical fallback '99' -> '1' succeeds and strips stale virtual fields
  const fallbackSwitch = await harness.requestDesktopHttp('display', {
    connectionId,
    generation,
    geometry: 'virt-g1',
    displayId: '99',
  });
  assert.equal(fallbackSwitch.status, 200);
  const statusAfterFallback = harness.desktop.status();
  assert.equal(statusAfterFallback.display?.id, '1');
  assert.equal(statusAfterFallback.display?.kind, 'physical');
  assert.equal(statusAfterFallback.display?.width, 3840);
  assert.equal(statusAfterFallback.display?.height, 2160);
  assert.equal(statusAfterFallback.display?.logicalWidth, undefined);
  assert.equal(statusAfterFallback.display?.logicalHeight, undefined);

  const gatedInput = await harness.requestDesktopHttp('input', {
    connectionId,
    generation,
    geometry: 'phys-1-g2',
    sequence: 1,
    input: { action: 'pointer', phase: 'click', x: 0.5, y: 0.5, button: 'left' },
  });
  assert.equal(gatedInput.status, 409);
  assert.equal(gatedInput.error, 'desktop-not-ready');

  const readyPhys = await harness.requestDesktopHttp('ready', {
    connectionId,
    generation,
    geometry: 'phys-1-g2',
    trackSid: 'TR_2',
  });
  assert.equal(readyPhys.status, 200);

  // Physical-to-physical ID spoofing '2' -> '1' must fail closed 503 and stop session
  const spoofSwitch = await harness.requestDesktopHttp('display', {
    connectionId,
    generation,
    geometry: 'phys-1-g2',
    displayId: '2',
  });
  assert.equal(spoofSwitch.status, 503);
  assert.equal(spoofSwitch.error, 'desktop-display-unavailable');
  assert.equal(harness.desktop.status().connected, false);

  const swiftHeadless = await runNativeHostSwiftTest(
    'DesktopHostStateMachineTests/testHeadlessMacSwitchFromVirtualToDefaultDisplayReEmergenceAndZeroDisplaySafety',
  );
  assert.equal(swiftHeadless.ok, true, swiftHeadless.output);
});

test('[T5-07] Cross-orientation portrait safe-area, dynamic Stack.Screen orientation, and DesktopCanvas mount stability', async t => {
  const harness = await createDesktopGatewayHarness(t);
  assert.ok(harness.hostFixture);

  const screen = await mountDesktopScreenRuntime({
    harness,
    window: { width: 852, height: 393 },
    insets: { top: 0, bottom: 21, left: 59, right: 59 },
    initialMetrics: {
      frame: { x: 0, y: 0, width: 393, height: 852 },
      insets: { top: 59, bottom: 34, left: 0, right: 0 },
    },
  });
  t.after(() => screen.unmount());

  await screen.pressTestId('desktop-connect');
  assert.equal(screen.getStackScreenOptions()?.orientation, 'landscape');
  assert.equal(screen.getStackScreenOptions()?.statusBarHidden, true);

  const initialRoom = screen.env.activeRoom;
  const initialCanvasNode = screen.findByTestId('remote-desktop-canvas');
  assert.ok(initialRoom, 'Expected connected LiveKit room on physical display');
  assert.ok(initialCanvasNode, 'Expected mounted remote-desktop-canvas');

  // Simulate non-zero IME height and IME-shrunk window while keyboardOpen is true so cachedPortrait must NOT record IME-shrunk height
  await screen.pressTestId('desktop-keyboard');
  await screen.emitKeyboard('keyboardDidShow', 264);
  await screen.setWindow(393, 588);
  await screen.setWindow(852, 393);
  await screen.pressTestId('desktop-keyboard-close');

  await screen.pressTestId('desktop-more');
  await screen.pressTestId('desktop-display-menu');
  await harness.hostFixture.clearEvents();
  await screen.pressTestId('desktop-display-virtual');

  const displayEvents = await harness.hostFixture.getEvents();
  const displaySwitchRpc = displayEvents.find(e => e.type === 'rpc' && e.op === 'display');
  assert.ok(displaySwitchRpc, 'Expected display switch RPC');
  assert.deepEqual(displaySwitchRpc.msg.viewport, { width: 393, height: 759 });

  assert.equal(screen.getStackScreenOptions()?.orientation, 'portrait');
  assert.equal(screen.getStackScreenOptions()?.statusBarHidden, false);
  assert.equal(screen.env.activeRoom, initialRoom, 'Expected zero LiveKit room reconnect on orientation switch');
  assert.equal(
    screen.findByTestId('remote-desktop-canvas'),
    initialCanvasNode,
    'Expected DesktopCanvas instance to stay mounted across orientation switch',
  );

  // Rotate window metrics to portrait and verify desktop-video-stage top/bottom safe-area vs IME padding
  await screen.setWindow(393, 852);
  await screen.setInsets({ top: 59, bottom: 34, left: 0, right: 0 });

  const stageClosedStyle = flattenStyle(screen.findByTestId('desktop-video-stage')?.props?.style);
  assert.equal(stageClosedStyle.paddingTop, 59);
  assert.equal(stageClosedStyle.paddingBottom, 34);

  await screen.pressTestId('desktop-keyboard');
  await screen.emitKeyboard('keyboardDidShow', 280);
  const stageOpenStyle = flattenStyle(screen.findByTestId('desktop-video-stage')?.props?.style);
  assert.equal(stageOpenStyle.paddingTop, 59);
  assert.equal(stageOpenStyle.paddingBottom, 0);
});

test('[T5-08] DesktopInputQueue scroll anchor preservation, 1200/sign split, partial-anchor sanitization, and >16 overflow', async t => {
  const syncRt = await createMobileSyncRuntime(null);
  t.after(() => syncRt.dispose());

  /** @type {Value[]} */
  const dispatched = [];
  const gate1 = createDeferred();
  /** @type {{ promise: Promise<void>, resolve: () => void } | null} */
  let holdGate = gate1;

  const queue = new syncRt.DesktopInputQueue(
    async (/** @type {Value} */ payload) => {
      if (holdGate) {
        const gate = holdGate;
        holdGate = null;
        await gate.promise;
      }
      dispatched.push(payload);
    },
    () => {},
  );

  const firstClick = queue.send({ action: 'pointer', phase: 'click', x: 0.1, y: 0.1, button: 'left' });
  const s1 = queue.send({ action: 'scroll', deltaY: 400, x: 0.22, y: 0.78 });
  const s2 = queue.send({ action: 'scroll', deltaY: 500, x: 0.91, y: 0.11 });
  const s3 = queue.send({ action: 'scroll', deltaY: 300, x: 0.5, y: 0.5 });
  const s4 = queue.send({ action: 'scroll', deltaY: 100, x: 0.33, y: 0.66 });
  const s5 = queue.send({ action: 'scroll', deltaY: -150, x: 0.44, y: 0.55 });

  // Wait a microtask so all 5 scrolls enqueue while firstClick awaits gate1, then release gate1.
  await Promise.resolve();
  gate1.resolve();

  const outcomes = await Promise.all([firstClick, s1, s2, s3, s4, s5]);
  assert.deepEqual(outcomes, [true, false, false, true, true, true]);
  assert.deepEqual(dispatched.slice(1), [
    { action: 'scroll', deltaY: 1200, x: 0.22, y: 0.78 },
    { action: 'scroll', deltaY: 100, x: 0.33, y: 0.66 },
    { action: 'scroll', deltaY: -150, x: 0.44, y: 0.55 },
  ]);

  // Malformed half-anchor strips invalid coordinates when coalescing
  dispatched.length = 0;
  const gate2 = createDeferred();
  holdGate = gate2;
  const holdClick2 = queue.send({ action: 'pointer', phase: 'click', x: 0.2, y: 0.2, button: 'left' });
  const halfAnchor1 = queue.send({ action: 'scroll', deltaY: 40, x: 0.3 });
  const halfAnchor2 = queue.send({ action: 'scroll', deltaY: 30, x: 0.8, y: 0.2 });
  await Promise.resolve();
  gate2.resolve();
  await Promise.all([holdClick2, halfAnchor1, halfAnchor2]);
  assert.deepEqual(dispatched[1], { action: 'scroll', deltaY: 70 });
  assert.equal('x' in dispatched[1], false);
  assert.equal('y' in dispatched[1], false);

  // >16 queued non-coalescing clicks emit DesktopInputQueueError('desktop-input-busy') and close queue
  /** @type {any} */
  let reportedOverflow = null;
  const overflowGate = createDeferred();
  const busyQueue = new syncRt.DesktopInputQueue(
    async () => {
      await overflowGate.promise;
    },
    (/** @type {Error} */ err) => {
      reportedOverflow = err;
    },
  );

  const inFlight = busyQueue.send({ action: 'pointer', phase: 'click', x: 0.5, y: 0.5, button: 'left' });
  const sixteenQueued = Array.from({ length: 16 }, (_, idx) =>
    busyQueue.send({ action: 'pointer', phase: 'click', x: (idx + 1) / 20, y: 0.5, button: 'left' }),
  );
  const seventeenth = busyQueue.send({ action: 'pointer', phase: 'click', x: 0.9, y: 0.9, button: 'left' });
  assert.equal(await seventeenth, false);
  assert.ok(reportedOverflow instanceof syncRt.DesktopInputQueueError);
  assert.equal(/** @type {Value} */ (reportedOverflow).code, 'desktop-input-busy');

  // Queue is now closed: any subsequent send resolves false immediately
  assert.equal(await busyQueue.send({ action: 'pointer', phase: 'click', x: 0.3, y: 0.3, button: 'left' }), false);
  overflowGate.resolve();
  await Promise.all([inFlight, ...sixteenQueued]);
});

test('[T5-09] Window-picker geometry/videoReady input fence, windowsEpoch stale-drop, and route-write fence asymmetry', async t => {
  const harness = await createDesktopGatewayHarness(t, {
    hostConfig: {
      windowMinSizes: { '1002:5002': { width: 715, height: 900 } },
      windowViewPending: true,
    },
  });
  assert.ok(harness.hostFixture);

  // Part 1: Upshift fill (logicalWidth: 720, viewPending: true) fences window rows, restore button, and canvas inputs until frame confirmation; 503 unknown never replays.
  const view = await mountRemoteDesktopViewRuntime({
    harness,
    autoDecodeFrames: false,
    initialDecodedFrames: 2,
  });
  t.after(() => view.unmount());

  await view.pressTestId('desktop-choose-display');
  await view.pressTestId('desktop-display-virtual');
  await view.pressTestId('desktop-connect');
  await view.layoutCanvas(393, 759);

  await view.pressTestId('desktop-windows');
  assert.ok(view.findByTestId('desktop-window-1002:5002'));
  assert.equal(view.findByTestId('desktop-window-1002:5002')?.props?.disabled, false);

  await harness.hostFixture.clearEvents();
  await view.pressTestId('desktop-window-1002:5002');

  assert.equal(harness.desktop.status().display?.logicalWidth, 720);
  assert.equal(view.findByTestId('desktop-window-1001:5001')?.props?.disabled, true);
  assert.equal(view.findByTestId('desktop-window-1002:5002')?.props?.disabled, true);
  assert.equal(view.findByTestId('desktop-windows-restore')?.props?.disabled, true);

  const responder = view.findCanvasResponder();
  assert.ok(responder);
  await responder.grant(120, 200);
  await responder.release(120, 200);
  const eventsWhileFenced = await harness.hostFixture.getEvents();
  assert.equal(eventsWhileFenced.filter(e => e.type === 'input').length, 0);

  // Clear host viewPending via heartbeat, then confirm new track frame via setDecodedFrames(1)
  const activeSnap = harness.desktop.active;
  assert.ok(activeSnap);
  const hbClear = await harness.requestDesktopHttp('heartbeat', {
    connectionId: activeSnap.id,
    generation: activeSnap.generation,
    geometry: activeSnap.geometry,
  });
  assert.equal(hbClear.status, 200);
  await view.setDecodedFrames(1);
  // Trigger hook heartbeat/adoptView or canvas check so mobile adopts settled trackSid & confirms /ready
  await new Promise(r => setTimeout(r, 550));
  await view.setDecodedFrames(2);
  if (view.findByTestId('desktop-windows-restore')?.props?.disabled) {
    // Allow periodic heartbeat/videoReady poll to settle if trackSid rotated on viewPending clear
    await new Promise(r => setTimeout(r, 2600));
    await view.setDecodedFrames(2);
    await new Promise(r => setTimeout(r, 550));
    await view.flush();
  }
  assert.equal(view.findByTestId('desktop-windows-restore')?.props?.disabled, false);
  assert.equal(view.findByTestId('desktop-window-1002:5002')?.props?.disabled, false);

  // Inject 503 desktop-operation-unknown on window -> sequence increments without auto-replay and triggers heartbeat recovery
  await harness.hostFixture.updateConfig({
    windowViewPending: false,
    failOperation: { window: { error: 'desktop-operation-unknown' } },
  });
  await harness.hostFixture.clearEvents();
  await view.pressTestId('desktop-windows-restore');

  const unknownEvents = await harness.hostFixture.getEvents();
  const windowRpcs = unknownEvents.filter(e => e.type === 'rpc' && e.op === 'window');
  const recoveryHeartbeats = unknownEvents.filter(e => e.type === 'rpc' && e.op === 'heartbeat');
  assert.equal(windowRpcs.length, 1, 'Expected zero auto-replay on 503 desktop-operation-unknown');
  assert.equal(windowRpcs[0]?.msg?.sequence, 2);
  assert.ok(recoveryHeartbeats.length >= 1, 'Expected recoverView() heartbeat after desktop-operation-unknown');

  await harness.hostFixture.updateConfig({ failOperation: {} });
  await view.unmount();

  // Part 2: Stale /windows response resolving AFTER switching to a physical display is discarded by windowsEpoch.
  const delayedWindowsGate = createDeferred();
  let interceptNextWindows = false;
  const hookRt = await mountUseRemoteDesktopRuntime({
    harness,
    fetchImpl: async (/** @type {string | URL | Request} */ url, /** @type {RequestInit | undefined} */ init) => {
      const urlStr = String(url);
      if (interceptNextWindows && urlStr.endsWith('/api/peer/desktop/windows')) {
        interceptNextWindows = false;
        const res = await fetch(url, init);
        await delayedWindowsGate.promise;
        return res;
      }
      return fetch(url, init);
    },
  });
  t.after(() => hookRt.unmount());

  await hookRt.call(h => h.connect('virtual', { width: 393, height: 759 }));
  assert.equal(hookRt.current.grant?.display?.id, 'virtual');

  interceptNextWindows = true;
  /** @type {Promise<unknown> | null} */
  let staleRefreshPromise = null;
  await hookRt.act(async () => {
    staleRefreshPromise = hookRt.current.refreshWindows();
    await Promise.resolve();
  });
  await hookRt.call(h => h.switchDisplay('1'));
  assert.equal(hookRt.current.grant?.display?.id, '1');

  delayedWindowsGate.resolve();
  await staleRefreshPromise;
  await hookRt.flush();
  assert.equal(hookRt.current.windows.length, 0, 'Expected windowsEpoch to discard stale /windows payload');

  // Part 3: Under setPeerRouteWriteFence(peer, null), POST /windows succeeds while POST /window fails closed locally.
  const syncRt = await createMobileSyncRuntime(harness);
  t.after(() => syncRt.dispose());

  // Switch back to virtual so /windows has an active connection, then activate route write fence
  await hookRt.call(h => h.switchDisplay('virtual', { width: 393, height: 759 }));
  const activeConnId = hookRt.current.grant?.connectionId;
  const activeGen = hookRt.current.grant?.generation;
  const activeGeo = hookRt.current.grant?.display?.geometry;
  assert.ok(activeConnId && activeGen && activeGeo);

  syncRt.setWritable(false);

  const readAllowedWindows = await syncRt.desktopRequest('windows', { connectionId: activeConnId });
  assert.equal(Array.isArray(readAllowedWindows.windows), true);
  assert.ok(readAllowedWindows.windows.length >= 2);

  await assert.rejects(
    () =>
      syncRt.desktopRequest('window', {
        connectionId: activeConnId,
        generation: activeGen,
        geometry: activeGeo,
        sequence: 99,
        mode: 'restore',
      }),
    /** @param {any} err */ err =>
      err?.code === 'preferred-route-unavailable' && err?.effectMayHaveOccurred === false,
  );
});

test('[T5-10] 4-locale (en, zh, zh-Hant, ja) label and domain error mapping parity', async t => {
  const labelsRt = await loadRemoteDesktopLabelsRuntime('en');
  t.after(() => labelsRt.dispose());

  const locales = ['en', 'zh', 'zh-Hant', 'ja'];
  const phaseKeys = [
    'phoneScreen',
    'windows',
    'restoreWindows',
    'windowsLoading',
    'windowsEmpty',
    'untitledWindow',
    'windowOnPhone',
    'windowMinimized',
    'virtualDisplayUnavailable',
    'virtualDisplayRequired',
    'windowUnavailable',
    'windowUnresponsive',
    'restorePersistFailed',
    'displayChanged',
  ];
  const domainErrorCodes = [
    'desktop-virtual-display-unavailable',
    'desktop-virtual-display-required',
    'desktop-accessibility-required',
    'desktop-window-unavailable',
    'desktop-window-unresponsive',
    'desktop-restore-persist-failed',
    'desktop-view-changed',
    'desktop-display-changed',
    'preferred-route-unavailable',
    'desktop-input-busy',
    'desktop-operation-unknown',
  ];

  /** @type {Record<string, Value>} */
  const tables = {};
  for (const locale of locales) {
    labelsRt.setLanguage(locale);
    tables[locale] = { ...labelsRt.remoteDesktopLabels() };
  }

  const enKeys = Object.keys(tables.en).sort();
  for (const locale of locales) {
    assert.deepEqual(Object.keys(tables[locale]).sort(), enKeys, `Key mismatch in ${locale}`);
    for (const [k, v] of Object.entries(tables[locale])) {
      assert.equal(typeof v, 'string', `${locale}.${k} must be string`);
      assert.ok(v.trim().length > 0, `${locale}.${k} must be non-empty`);
    }
  }

  for (const key of phaseKeys) {
    for (const nonEn of ['zh', 'zh-Hant', 'ja']) {
      assert.notEqual(
        tables[nonEn][key],
        tables.en[key],
        `Expected localized non-English translation for ${nonEn}.${key}`,
      );
    }
  }

  for (const locale of locales) {
    labelsRt.setLanguage(locale);
    const fallbackMsg = labelsRt.remoteDesktopError('unmapped-sentinel-error-code');
    /** @type {Set<string>} */
    const seenMessages = new Set();
    for (const code of domainErrorCodes) {
      const localized = labelsRt.remoteDesktopError(code);
      assert.equal(typeof localized, 'string');
      assert.ok(localized.trim().length > 0);
      assert.notEqual(localized, fallbackMsg, `Error code ${code} fell back to generic unavailable in ${locale}`);
      seenMessages.add(localized);
    }
    assert.equal(
      seenMessages.size,
      domainErrorCodes.length,
      `Expected distinct localized messages across all ${domainErrorCodes.length} domain error codes in ${locale}`,
    );
  }
});

test('[T5-11] Packaging desktop-runtime.json SHA-256 sync, zero-arg verifyDesktopHelper() probe, and snapshot/release validators', async t => {
  const nativeBinDir = join(REPO_ROOT, 'native/bin');
  const manifest = await verifyNativeRuntimeManifest(nativeBinDir);
  assert.equal(manifest.version, 1);
  assert.match(manifest.hashes.CodelyncDesktopHost, /^[a-f0-9]{64}$/u);

  const tamperedDir = await mkdtemp(join(tmpdir(), 'codelync-t5-tampered-bin-'));
  t.after(() => rm(tamperedDir, { recursive: true, force: true }));

  const tamperedManifest = {
    ...manifest,
    hashes: {
      ...manifest.hashes,
      CodelyncDesktopHost: (manifest.hashes.CodelyncDesktopHost.startsWith('0') ? 'f' : '0')
        + manifest.hashes.CodelyncDesktopHost.slice(1),
    },
  };
  await writeFile(join(tamperedDir, 'desktop-runtime.json'), JSON.stringify(tamperedManifest), 'utf8');
  await symlink(join(nativeBinDir, 'CodelyncDesktopHost'), join(tamperedDir, 'CodelyncDesktopHost'));
  await assert.rejects(() => verifyNativeRuntimeManifest(tamperedDir), /SHA-256 mismatch/u);

  const buildProbe = await probeNativeHostDaemon([{ id: 'build-probe', operation: 'status' }], []);
  assert.equal(buildProbe.exitCode, 0);
  const probeReply = buildProbe.replies.find(r => r.id === 'build-probe');
  assert.equal(probeReply?.ok, true);
  assert.equal(probeReply?.result?.capturing, false);

  const admittedPaths = [
    'spec/codelync-remote-desktop.md',
    'spec/codelync-remote-desktop-mobile-experience.md',
    'native/remote-desktop/Package.swift',
    'native/remote-desktop/Sources/CGVirtualDisplayRuntime/CGVirtualDisplayRuntime.m',
    'native/remote-desktop/Sources/CodelyncDesktopHost/main.swift',
    'native/remote-desktop/Sources/CodelyncDesktopHost/Core/WindowCoordinator.swift',
    'src/codelync/desktop-host.mjs',
    'src/codelync/mac-connection-service.mjs',
    'src/codelync/remote-desktop.mjs',
    'apps/mobile/sources/app/(app)/desktop.tsx',
    'apps/mobile/sources/components/RemoteDesktopView.tsx',
    'apps/mobile/sources/hooks/useRemoteDesktop.ts',
    'test/remote-desktop-virtual.test.mjs',
    'test/e2e-remote-desktop-virtual/tier5-adversarial-hardening.test.mjs',
  ];
  for (const rel of admittedPaths) {
    assert.equal(publicSourcePath(rel), true, `Expected publicSourcePath to admit ${rel}`);
  }

  const hiddenScratchPrefix = ['.', 'agents', '/'].join('');
  const rejectedPaths = [
    'native/bin/CodelyncDesktopHost',
    'native/bin/desktop-runtime.json',
    `${hiddenScratchPrefix}teamwork/PROJECT.md`,
    '.scratch-local/notes.md',
  ];
  for (const rel of rejectedPaths) {
    assert.equal(publicSourcePath(rel), false, `Expected publicSourcePath to reject ${rel}`);
  }

  const [betaManifest, macLoc] = await Promise.all([
    validatePublicTestflightManifest(REPO_ROOT),
    validateMacLocalizationParity(REPO_ROOT),
  ]);
  assert.equal(typeof betaManifest.version, 'string');
  assert.ok(macLoc.keyCount > 0);
});

test('[T5-12] R4 non-intrusion source/Mach-O hygiene and Android 8efbd25 coexistence (BackHandler + edge-to-edge IME)', async t => {
  const symInfo = await inspectNativeHostUndefinedSymbols();
  assert.equal(symInfo.virtualDisplaySymbols.length, 0);
  assert.equal(symInfo.symbols.filter(s => s.includes('_AXUIElement') || s.includes('AXUIElement')).length, 0);

  const userHomePrefix = ['', 'Users', ''].join('/');
  const { stdout: binaryStrings } = await execFileAsync(
    '/usr/bin/strings',
    [join(REPO_ROOT, 'native/bin/CodelyncDesktopHost')],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  assert.equal(binaryStrings.includes(userHomePrefix), false, 'Expected zero build-machine home paths in binary strings');

  const sourceFiles = await listWorkspaceSourceFiles([
    'native/remote-desktop/Sources',
    'src/codelync',
    'apps/mobile/sources',
  ]);
  assert.equal(sourceFiles.some(p => p.endsWith('phone-models.json')), false);

  const zoomShortcutRe = /keyCode\s*:\s*(?:24|27|0x18|0x1b)\b/u;
  for (const rel of sourceFiles) {
    if (!/\.(?:swift|m|h|mjs|ts|tsx)$/u.test(rel)) continue;
    const content = await readWorkspaceFile(rel);
    assert.equal(content.includes('phone-models.json'), false, `Forbidden phone-models.json ref in ${rel}`);
    assert.equal(content.includes('CGEventTapCreate'), false, `Forbidden CGEventTapCreate ref in ${rel}`);
    assert.equal(/uuremote/iu.test(content), false, `Forbidden UU Remote sniffing ref in ${rel}`);
    assert.equal(zoomShortcutRe.test(content), false, `Forbidden zoom keycode injection in ${rel}`);
    if (rel.startsWith('src/codelync/')) {
      assert.equal(content.includes('window-frames.mjs'), false, `Forbidden window-frames.mjs import in ${rel}`);
      assert.equal(content.includes('MacOSAX'), false, `Forbidden MacOSAX reference in ${rel}`);
    }
  }

  const { stdout: deferredGitDiff } = await execFileAsync(
    'git',
    ['diff', 'HEAD', '--', 'native/MacOSAXInspect.swift', 'native/MacOSAXControl.swift', 'src/window-frames.mjs'],
    { cwd: REPO_ROOT },
  );
  assert.equal(deferredGitDiff.trim(), '', 'Expected deferred AX/window-frames files to remain untouched vs HEAD');

  // Android 8efbd25 coexistence: edge-to-edge IME paddingBottom + multi-step BackHandler dismissal
  const harness = await createDesktopGatewayHarness(t);
  assert.ok(harness.hostFixture);

  /** @type {string[]} */
  const orientationHistory = [];
  const androidView = await mountRemoteDesktopViewRuntime({
    harness,
    platform: 'android',
    window: { width: 412, height: 915 },
    insets: { top: 28, bottom: 24, left: 0, right: 0 },
    onOrientationModeChange: (/** @type {string} */ mode) => {
      orientationHistory.push(mode);
    },
  });
  t.after(() => androidView.unmount());

  await androidView.pressTestId('desktop-choose-display');
  await androidView.pressTestId('desktop-display-virtual');
  await androidView.pressTestId('desktop-connect');

  // Step 1: Open keyboard + emit IME height 312 -> remote-desktop-page paddingBottom === 312; hardware back closes keyboard
  await androidView.pressTestId('desktop-keyboard');
  await androidView.emitKeyboard('keyboardDidShow', 312);
  const pageWithIme = flattenStyle(androidView.findByTestId('remote-desktop-page')?.props?.style);
  assert.equal(pageWithIme.paddingBottom, 312);

  assert.equal(await androidView.triggerHardwareBack(), true);
  await androidView.flush();
  const pageAfterBack1 = flattenStyle(androidView.findByTestId('remote-desktop-page')?.props?.style);
  assert.equal(pageAfterBack1.paddingBottom, 0);

  // Step 2: Open desktop-windows-panel -> hardware back dismisses panel
  await androidView.pressTestId('desktop-windows');
  assert.ok(androidView.findByTestId('desktop-windows-panel'));
  assert.equal(await androidView.triggerHardwareBack(), true);
  await androidView.flush();
  assert.equal(androidView.findByTestId('desktop-windows-panel'), null);

  // Step 3: Enter immersive fullscreen -> hardware back exits immersive and restores control dock
  await androidView.pressTestId('desktop-more');
  await androidView.pressTestId('desktop-fullscreen');
  assert.ok(androidView.findByTestId('desktop-restore-controls'));
  assert.equal(await androidView.triggerHardwareBack(), true);
  await androidView.flush();
  assert.equal(androidView.findByTestId('desktop-restore-controls'), null);
  assert.ok(androidView.findByTestId('desktop-control-dock'));

  // Step 4: Final hardware back calls non-blocking exit(), restores 'portrait', navigates back, and fires /leave
  assert.equal(await androidView.triggerHardwareBack(), true);
  assert.equal(androidView.routerCalls.back, 1);
  assert.equal(orientationHistory[orientationHistory.length - 1], 'portrait');
  for (let attempt = 0; attempt < 100 && harness.desktop.status().connected; attempt += 1) {
    await new Promise(r => setTimeout(r, 20));
  }
  await androidView.flush();
  assert.equal(harness.desktop.status().connected, false);
});
