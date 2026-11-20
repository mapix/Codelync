import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { isCodelyncNativeSource } from '../../src/codelync/source-scope.mjs';
import { DesktopHostProcess } from '../../src/codelync/desktop-host.mjs';
import {
  REPO_ROOT,
  checkPublicSourceHygiene,
  convertVisibleFrameToAxTopLeft,
  createDesktopGatewayHarness,
  createProgrammableHostBinary,
  createSimulatedMobilePeerClient,
  inspectNativeHostUndefinedSymbols,
  listWorkspaceSourceFiles,
  loadTranspiledMobileModule,
  probeNativeHostCli,
  probeNativeHostDaemon,
  readWorkspaceFile,
  runNativeHostSwiftTest,
  runSwiftDesktopHostTests,
  verifyNativeRuntimeManifest,
} from './harness.mjs';
import {
  createMobileSyncRuntime,
  flattenStyle,
  loadRemoteDesktopLabelsRuntime,
  mountDesktopScreenRuntime,
  mountRemoteDesktopKeyboardRuntime,
  mountRemoteDesktopViewRuntime,
  mountUseRemoteDesktopRuntime,
} from './mobile-runtime-harness.mjs';

/** @typedef {Record<string, any>} Value */
const execFileAsync = promisify(execFile);

/** @param {Value} h @param {string} action @param {Value} [payload] @param {Value} [opts] @returns {Promise<Value>} */
async function requestOk(h, action, payload = {}, opts = {}) {
  const res = await h.requestDesktopHttp(action, payload, opts);
  assert.equal(res.ok, true, `Expected ${action} 200 OK, got ${res.status} (${res.error ?? 'unknown'})`);
  assert.ok(res.data);
  return res.data;
}

/** @param {Value} h @param {string} displayId @param {Value} [opts] @returns {Promise<Value>} */
async function connectAndConfirmReady(h, displayId, opts = {}) {
  const grant = await requestOk(h, 'join', {
    displayId,
    ...(opts.quality ? { quality: opts.quality } : {}),
    ...(opts.viewport ? { viewport: opts.viewport } : {}),
  });
  const ready = await requestOk(h, 'ready', {
    connectionId: grant.connectionId,
    generation: grant.generation,
    geometry: grant.display.geometry,
    trackSid: grant.trackSid,
  });
  assert.equal(ready.ready, true);
  return grant;
}

/** @param {Value} client @param {string} displayId @param {Value} [opts] @returns {Promise<Value>} */
async function mobileConnect(client, displayId, opts = {}) {
  const grant = await client.connect(displayId, opts);
  assert.ok(grant);
  return grant;
}

/** @param {string} relPath */
async function fileExists(relPath) {
  try { await access(join(REPO_ROOT, relPath)); return true; } catch { return false; }
}

/** @type {Promise<Array<[string, string]>> | null} */
let cachedWorkspaceEntries = null;
/** @returns {Promise<Array<[string, string]>>} */
function getWorkspaceSourceEntries() {
  if (!cachedWorkspaceEntries) {
    cachedWorkspaceEntries = (async () => {
      const files = await listWorkspaceSourceFiles(['src', 'native', 'apps/mobile/sources', 'scripts']);
      return Promise.all(files.map(async rel => /** @type {[string, string]} */ ([rel, await readWorkspaceFile(rel)])));
    })();
  }
  return cachedWorkspaceEntries;
}

// ============================================================================
// F01: Spec-First Contracts (spec/codelync-remote-desktop*.md)
// ============================================================================

test('[T1-F01-01] Remote desktop specs declare 2026-11-18 implementation contract status and pass public snapshot hygiene', async () => {
  const [coreSpec, mobileSpec, coreHygiene, mobileHygiene] = await Promise.all([
    readWorkspaceFile('spec/codelync-remote-desktop.md'),
    readWorkspaceFile('spec/codelync-remote-desktop-mobile-experience.md'),
    checkPublicSourceHygiene('spec/codelync-remote-desktop.md'),
    checkPublicSourceHygiene('spec/codelync-remote-desktop-mobile-experience.md'),
  ]);
  assert.match(coreSpec, /Status:\s*implementation contract,\s*2026-11-18\./u);
  assert.match(mobileSpec, /Status:\s*implementation contract,\s*2026-11-18\./u);
  assert.equal(coreHygiene.clean, true);
  assert.equal(mobileHygiene.clean, true);
});

test('[T1-F01-02] Core spec documents Phase 1 adaptive 2x HiDPI CGVirtualDisplay ladder, --set-mode CLI, physical mode protection, and headless fallback', async () => {
  const coreSpec = await readWorkspaceFile('spec/codelync-remote-desktop.md');
  for (const re of [/CGVirtualDisplay/u, /540/u, /1080/u, /800/u, /2160[\s\S]{0,20}5400/u, /--set-mode/u, /--restore-mode/u, /virtualDisplaySupported/u, /CGGetActiveDisplayList/u]) {
    assert.match(coreSpec, re);
  }
});

test('[T1-F01-03] Core spec documents long-edge max(width, height) clarity tiers and normalized (x, y) scroll coordinate anchoring', async () => {
  const coreSpec = await readWorkspaceFile('spec/codelync-remote-desktop.md');
  assert.match(coreSpec, /max\s*\([^)]*width[^)]*height[^)]*\)/iu);
  for (const tier of ['1280', '1920', '2560']) assert.ok(coreSpec.includes(tier));
  assert.match(coreSpec, /scrollWheelEvent2Source|location/u);
});

test('[T1-F01-04] Mobile spec documents dynamic Stack.Screen orientation, portrait safe-area stage insets, soft-keyboard avoidance, and 1-finger scroll', async () => {
  const mobileSpec = await readWorkspaceFile('spec/codelync-remote-desktop-mobile-experience.md');
  for (const re of [/Stack\.Screen/u, /orientation:\s*'landscape'/u, /orientation:\s*'portrait'/u, /statusBarHidden/u, /paddingTop:\s*insets\.top/u, /paddingBottom:\s*keyboardOpen\s*\?\s*0\s*:\s*insets\.bottom/u, /6\s*pt|6pt/u, /panel === 'windows'/u]) {
    assert.match(mobileSpec, re);
  }
});

test('[T1-F01-05] Specs document Phase 2 windows/window wire contracts, RestoreRecord persistence, R4 rules, and clean join wire envelope', async t => {
  const [coreSpec, mobileSpec] = await Promise.all([
    readWorkspaceFile('spec/codelync-remote-desktop.md'),
    readWorkspaceFile('spec/codelync-remote-desktop-mobile-experience.md'),
  ]);
  const combined = `${coreSpec}\n${mobileSpec}`;
  for (const token of ['/api/peer/desktop/windows', '/api/peer/desktop/window', 'window-restore.json', 'RestoreRecord', 'desktop-virtual-display-required', 'desktop-window-unavailable', 'desktop-window-unresponsive', 'desktop-restore-persist-failed', 'phone-models.json', 'CGEventTap', 'UU Remote']) {
    assert.ok(combined.includes(token), `Missing spec contract token: ${token}`);
  }
  assert.match(combined, /⌘\+|⌘-/u);

  const h = await createDesktopGatewayHarness(t);
  const joinData = await requestOk(h, 'join', { displayId: 'virtual', viewport: { width: 393, height: 759 } });
  assert.equal(Object.keys(joinData).some(k => k.startsWith('capture') && k !== 'capturing'), false);
  for (const reqKey of ['connectionId', 'generation', 'display', 'trackSid', 'quality']) {
    assert.equal(reqKey in joinData, true, `Expected spec key ${reqKey} on /join`);
  }
});

// ============================================================================
// F02: Dynamic ObjC Runtime CGVirtualDisplay Bridge & Capability Probe
// ============================================================================

test('[T1-F02-01] Compiled CodelyncDesktopHost binary has zero static CGVirtualDisplay undefined symbols and passes live ObjC runtime probe XCTests', async () => {
  const [sym, daemonProbe, swiftProbe] = await Promise.all([
    inspectNativeHostUndefinedSymbols(),
    probeNativeHostDaemon([{ id: '1', operation: 'status' }, { id: '2', operation: 'displays' }]),
    runNativeHostSwiftTest('RuntimeAndLadderTests/testLiveObjCRuntimeCapabilityProbeAndNegativeFallbacks'),
  ]);
  assert.ok(sym.symbols.length > 20);
  assert.equal(sym.hasStaticVirtualDisplaySymbols, false);
  assert.deepEqual(sym.virtualDisplaySymbols, []);
  assert.equal(daemonProbe.timedOut, false);
  assert.equal(daemonProbe.exitCode, 0);
  assert.equal(daemonProbe.replies[0]?.ok, true);
  assert.equal(daemonProbe.replies[1]?.ok, true);
  assert.equal(swiftProbe.ok, true, swiftProbe.output);
});

test('[T1-F02-02] Native CodelyncDesktopHost displays RPC reports boolean virtualDisplaySupported and valid DesktopDisplay inventory', async () => {
  const probe = await probeNativeHostDaemon([{ id: 'd1', operation: 'displays' }]);
  assert.equal(probe.timedOut, false);
  assert.equal(probe.exitCode, 0);
  assert.equal(probe.replies.length, 1);
  const reply = probe.replies[0];
  assert.equal(reply.ok, true);
  assert.equal(typeof reply.result.virtualDisplaySupported, 'boolean');
  assert.equal(Array.isArray(reply.result.displays), true);
  const hasVirtual = reply.result.displays.some((/** @type {Value} */ d) => d.id === 'virtual' && d.kind === 'virtual');
  assert.equal(hasVirtual, reply.result.virtualDisplaySupported);
});

test('[T1-F02-03] Gateway /api/peer/desktop/displays appends Phone Screen virtual row when virtualDisplaySupported is true', async t => {
  const h = await createDesktopGatewayHarness(t, { hostConfig: { virtualDisplaySupported: true } });
  const data = await requestOk(h, 'displays', {});
  assert.equal(data.virtualDisplaySupported, true);
  const virt = data.displays.find((/** @type {Value} */ d) => d.id === 'virtual');
  assert.ok(virt);
  assert.equal(virt.name, 'Phone Screen');
  assert.equal(virt.kind, 'virtual');
  assert.equal(virt.width, virt.logicalWidth * 2);
  assert.equal(virt.height, virt.logicalHeight * 2);
});

test('[T1-F02-04] Gateway /api/peer/desktop/displays omits virtual row when virtualDisplaySupported is false while physical remote desktop works', async t => {
  const h = await createDesktopGatewayHarness(t, { hostConfig: { virtualDisplaySupported: false } });
  const inv = await requestOk(h, 'displays', {});
  assert.equal(inv.virtualDisplaySupported, false);
  assert.equal(inv.displays.some((/** @type {Value} */ d) => d.id === 'virtual'), false);
  const grant = await connectAndConfirmReady(h, '1');
  assert.equal(grant.display.id, '1');
  assert.equal(grant.display.kind, 'physical');
});

test('[T1-F02-05] Native CGVirtualDisplayRuntime resolves dynamically via ObjC runtime and RemoteDesktopView hides Phone Screen & Windows when unsupported', async t => {
  const entries = await getWorkspaceSourceEntries();
  const contents = entries.filter(([rel]) => rel.startsWith('native/remote-desktop/Sources/')).map(([, text]) => text).join('\n');
  assert.match(contents, /NSClassFromString|objc_lookUpClass/u);
  assert.match(contents, /instancesRespondToSelector/u);
  for (const cls of ['CGVirtualDisplay', 'CGVirtualDisplayDescriptor', 'CGVirtualDisplaySettings', 'CGVirtualDisplayMode']) {
    assert.ok(contents.includes(cls), `Expected dynamic runtime lookup for ${cls}`);
  }

  const h = await createDesktopGatewayHarness(t, {
    hostConfig: {
      virtualDisplaySupported: false,
      physicalDisplays: [
        { id: '1', name: 'Display 1', kind: 'physical', width: 3840, height: 2160, logicalWidth: 1920, logicalHeight: 1080, refreshRate: 60, ioModeID: 1, geometry: 'p1' },
        { id: '2', name: 'Display 2', kind: 'physical', width: 2560, height: 1440, logicalWidth: 1280, logicalHeight: 720, refreshRate: 60, ioModeID: 2, geometry: 'p2' },
      ],
    },
  });
  const rt = await mountRemoteDesktopViewRuntime({ harness: h });
  t.after(() => rt.unmount());
  await rt.pressTestId('desktop-choose-display');
  assert.equal(rt.findByTestId('desktop-display-virtual'), null);
  assert.notEqual(rt.findByTestId('desktop-display-1'), null);
  await rt.pressTestId('desktop-display-1');
  await rt.pressTestId('desktop-connect');
  assert.equal(rt.findByTestId('desktop-windows'), null);
  assert.notEqual(rt.findByTestId('remote-desktop-canvas'), null);
  const st = await requestOk(h, 'status');
  assert.equal(st.connected, true);
  assert.equal(st.display.id, '1');
});

// ============================================================================
// F03: Adaptive 2x HiDPI Portrait Display & 540..1080pt Ladder
// ============================================================================

test('[T1-F03-01] Joining virtual display with iPhone 393x759 portrait safe-area creates 2x HiDPI 540x1043pt (1080x2086px) Phone Screen', async t => {
  const swiftRes = await runNativeHostSwiftTest('RuntimeAndLadderTests/testPortraitModeLadderAcrossEdgeRatiosAndHardwareBounds');
  assert.equal(swiftRes.ok, true, swiftRes.output);

  const h = await createDesktopGatewayHarness(t);
  const grant = await connectAndConfirmReady(h, 'virtual', { viewport: { width: 393, height: 759 } });
  assert.equal(grant.display.id, 'virtual');
  assert.equal(grant.display.kind, 'virtual');
  assert.equal(grant.display.logicalWidth, 540);
  assert.equal(grant.display.logicalHeight, 1043);
  assert.equal(grant.display.width, 1080);
  assert.equal(grant.display.height, 2086);
  const startRpc = ((await h.hostFixture?.getEvents()) ?? []).find(e => e.type === 'rpc' && e.op === 'start');
  assert.deepEqual(startRpc?.msg?.viewport, { width: 393, height: 759 });
});

test('[T1-F03-02] Joining virtual display with 430x839 Pro Max viewport and default omitted viewport yields 2x HiDPI >=540x800pt', async t => {
  const swiftRes = await runNativeHostSwiftTest('RuntimeAndLadderTests/testPortraitModeLadderAcrossEdgeRatiosAndHardwareBounds');
  assert.equal(swiftRes.ok, true, swiftRes.output);

  const h1 = await createDesktopGatewayHarness(t);
  const g1 = await connectAndConfirmReady(h1, 'virtual', { viewport: { width: 430, height: 839 } });
  assert.equal(g1.display.logicalWidth, 540);
  assert.equal(g1.display.logicalHeight, 1054);
  assert.equal(g1.display.width, 1080);
  assert.equal(g1.display.height, 2108);
  assert.ok(g1.display.logicalWidth >= 540 && g1.display.logicalHeight >= 800);

  const h2 = await createDesktopGatewayHarness(t);
  const g2 = await connectAndConfirmReady(h2, 'virtual');
  assert.equal(g2.display.logicalWidth, 540);
  assert.equal(g2.display.logicalHeight, 1080);
  assert.equal(g2.display.width, 1080);
  assert.equal(g2.display.height, 2160);
});

test('[T1-F03-03] Native Swift PortraitModeLadder XCTests pass and Bridge virtual display mounts 1.5 and 2.0 portrait ratios at 2x HiDPI', async t => {
  const swiftRes = await runSwiftDesktopHostTests();
  assert.equal(swiftRes.timedOut, false);
  assert.equal(swiftRes.exitCode, 0, swiftRes.output);
  assert.match(swiftRes.output, /RuntimeAndLadderTests.*passed/su);
  assert.match(swiftRes.output, /testPortraitModeLadderAcrossEdgeRatiosAndHardwareBounds.*passed/u);
  assert.match(swiftRes.output, /testCoordinatorSerialFallbackInPlaceUpdateUpshiftAndMinimumLifetime.*passed/u);

  const h = await createDesktopGatewayHarness(t);
  const g15 = await connectAndConfirmReady(h, 'virtual', { viewport: { width: 600, height: 900 } });
  assert.equal(g15.display.logicalWidth, 540);
  assert.equal(g15.display.logicalHeight, 810);
  assert.ok(g15.display.logicalHeight >= g15.display.logicalWidth);
  assert.equal(g15.display.width, 1080);
  assert.equal(g15.display.height, 1620);
  assert.equal(g15.display.width % 2, 0);
  assert.equal(g15.display.height % 2, 0);

  const g20 = await requestOk(h, 'display', {
    connectionId: g15.connectionId, generation: g15.generation, geometry: g15.display.geometry,
    displayId: 'virtual', viewport: { width: 540, height: 1080 },
  });
  assert.equal(g20.display.logicalWidth, 540);
  assert.equal(g20.display.logicalHeight, 1080);
  assert.equal(g20.display.width, 1080);
  assert.equal(g20.display.height, 2160);
});

test('[T1-F03-04] Switching active virtual display to a new portrait viewport updates settings in-place and rotates geometry and trackSid', async t => {
  const h = await createDesktopGatewayHarness(t);
  const grant = await connectAndConfirmReady(h, 'virtual', { viewport: { width: 540, height: 1080 } });
  const sw = await requestOk(h, 'display', {
    connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry,
    displayId: 'virtual', viewport: { width: 600, height: 900 },
  });
  assert.equal(sw.display.logicalWidth, 540);
  assert.equal(sw.display.logicalHeight, 810);
  assert.equal(sw.display.width, 1080);
  assert.equal(sw.display.height, 1620);
  assert.notEqual(sw.geometry, grant.display.geometry);
  assert.notEqual(sw.trackSid, grant.trackSid);
  const events = (await h.hostFixture?.getEvents()) ?? [];
  assert.equal(events.some(e => e.type === 'apply-settings-in-place' && e.width === 540 && e.height === 810), true);
});

test('[T1-F03-05] Workspace contains zero static phone-models.json files or hardcoded phone model catalog imports', async () => {
  const entries = await getWorkspaceSourceEntries();
  assert.equal(entries.some(([rel]) => rel.endsWith('phone-models.json')), false);
  for (const [rel, text] of entries) {
    assert.equal(text.includes('phone-models.json'), false, `Unexpected phone-models.json reference in ${rel}`);
  }
});

// ============================================================================
// F04: Short-Lived --set-mode & --restore-mode Subprocess CLI
// ============================================================================

test('[T1-F04-01] 0-arg native CodelyncDesktopHost status daemon probe completes in <5s and passes coordinator serial/lifetime XCTests', async () => {
  const [probe, swiftRes] = await Promise.all([
    probeNativeHostDaemon([{ id: 'build-probe', operation: 'status' }]),
    runNativeHostSwiftTest('RuntimeAndLadderTests/testCoordinatorSerialFallbackInPlaceUpdateUpshiftAndMinimumLifetime'),
  ]);
  assert.equal(probe.timedOut, false);
  assert.ok(probe.durationMs < 5000);
  assert.equal(probe.exitCode, 0);
  assert.equal(probe.replies[0]?.ok, true);
  assert.equal(probe.replies[0]?.result?.capturing, false);
  assert.equal(swiftRes.ok, true, swiftRes.output);
});

test('[T1-F04-02] Native CodelyncDesktopHost --set-mode CLI intercepts at entry without hanging on displayID 0 and rotates Bridge ready state', async t => {
  const [res, swiftRes] = await Promise.all([
    probeNativeHostCli(['--set-mode', '0', '540', '1080']),
    runNativeHostSwiftTest('RuntimeAndLadderTests/testCoordinatorSerialFallbackInPlaceUpdateUpshiftAndMinimumLifetime'),
  ]);
  assert.equal(res.timedOut, false);
  assert.ok(res.durationMs < 4500);
  assert.equal(res.exitCode, 1);
  assert.equal(swiftRes.ok, true, swiftRes.output);

  const h = await createDesktopGatewayHarness(t);
  const grant = await connectAndConfirmReady(h, 'virtual', { viewport: { width: 540, height: 1080 } });
  const sw = await requestOk(h, 'display', {
    connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry,
    displayId: 'virtual', viewport: { width: 393, height: 759 },
  });
  assert.notEqual(sw.geometry, grant.display.geometry);
  assert.equal(h.desktop.active?.ready, false);
});

test('[T1-F04-03] Native CodelyncDesktopHost --restore-mode CLI parses UInt32(bitPattern: -1) without flag misparse and exits cleanly on displayID 0', async () => {
  const res = await probeNativeHostCli(['--restore-mode', '0', '4294967295', '1920', '1080', '3840', '2160', '60.0', 'session']);
  assert.equal(res.timedOut, false);
  assert.ok(res.durationMs < 4500);
  assert.equal(res.exitCode, 1);
});

test('[T1-F04-04] Programmable host executes --set-mode subprocess CLI and records set-mode on virtual display mount', async t => {
  const h = await createDesktopGatewayHarness(t);
  assert.ok(h.hostFixture);
  await execFileAsync(h.hostFixture.binaryPath, ['--set-mode', '77', '540', '1080']);
  await connectAndConfirmReady(h, 'virtual', { viewport: { width: 393, height: 759 } });
  const events = await h.hostFixture.getEvents();
  assert.equal(events.some(e => e.type === 'cli-set-mode' && e.ok === true && e.args[1] === '77'), true);
  assert.equal(events.some(e => e.type === 'set-mode' && e.width === 540 && e.height === 1043), true);
});

test('[T1-F04-05] Native CodelyncDesktopHost --restore-mode CLI handles session, permanent, and invalid scopes without hanging and passes Swift CLI XCTests', async () => {
  const sessionProbe = await probeNativeHostCli(['--restore-mode', '0', '4294967295', '1920', '1080', '3840', '2160', '60.0', 'session'], 5000);
  assert.equal(sessionProbe.timedOut, false);
  assert.equal(sessionProbe.signal, null);
  assert.equal(sessionProbe.exitCode, 1);
  assert.equal(sessionProbe.stdout, '');
  assert.ok(sessionProbe.durationMs < 4500);

  const permProbe = await probeNativeHostCli(['--restore-mode', '0', '2147483648', '2560', '1440', '5120', '2880', '120.0', 'permanent'], 5000);
  assert.equal(permProbe.timedOut, false);
  assert.equal(permProbe.signal, null);
  assert.equal(permProbe.exitCode, 1);
  assert.equal(permProbe.stdout, '');

  const badScope = await probeNativeHostCli(['--restore-mode', '999999999', '4294967295', '1920', '1080', '3840', '2160', '60.0', 'invalid-scope'], 5000);
  assert.equal(badScope.timedOut, false);
  assert.equal(badScope.exitCode, 1);

  const [swiftCli, swiftMode] = await Promise.all([
    runNativeHostSwiftTest('SubprocessAndSnapshotTests/testCLIArgumentParsingAndSignedIOModeIDRoundTrip'),
    runNativeHostSwiftTest('SubprocessAndSnapshotTests/testVirtualHiDPIAndPhysicalRestoreModeSelectionPriority'),
  ]);
  assert.equal(swiftCli.ok, true, swiftCli.output);
  assert.equal(swiftMode.ok, true, swiftMode.output);
});

// ============================================================================
// F05: Physical Display Mode & Refresh Rate Snapshot/Restore
// ============================================================================

test('[T1-F05-01] Mounting Virtual Phone Screen creates 0o600 display-modes-snapshot.json and native --state-dir reconciles cleanly', async t => {
  const swiftStore = await runNativeHostSwiftTest('SubprocessAndSnapshotTests/testDurableJSONStorePermissionsQuarantineAndSymlinkDefense');
  assert.equal(swiftStore.ok, true, swiftStore.output);

  const tmpStateRoot = await mkdtemp(join(tmpdir(), 'codelync-f05-state-'));
  t.after(() => rm(tmpStateRoot, { recursive: true, force: true }));
  const tmpStateDir = join(tmpStateRoot, 'desktop-state');
  const nativeProbe = await probeNativeHostDaemon([{ id: '1', operation: 'status' }], ['--state-dir=' + tmpStateDir]);
  assert.equal(nativeProbe.timedOut, false);
  assert.equal(nativeProbe.exitCode, 0);
  assert.equal(nativeProbe.replies[0]?.ok, true);

  const physicalDisplays = [
    { id: '1', name: 'Built-in Retina', kind: 'physical', width: 3024, height: 1964, logicalWidth: 1512, logicalHeight: 982, refreshRate: 120, ioModeID: 11, geometry: 'phys-1' },
    { id: '2', name: 'Studio Display', kind: 'physical', width: 5120, height: 2880, logicalWidth: 2560, logicalHeight: 1440, refreshRate: 60, ioModeID: 22, geometry: 'phys-2' },
  ];
  const h = await createDesktopGatewayHarness(t, { hostConfig: { physicalDisplays } });
  await connectAndConfirmReady(h, 'virtual');
  const snapFile = join(h.desktopState, 'display-modes-snapshot.json');
  assert.equal((await stat(snapFile)).mode & 0o777, 0o600);
  const snap = JSON.parse(await readFile(snapFile, 'utf8'));
  assert.equal(snap.version, 1);
  assert.equal(snap.phase, 'mount');
  assert.equal(snap.displays.length, 2);
});

test('[T1-F05-02] Mounting Virtual Phone Screen snapshots physical displays and restores drifted display with session scope', async t => {
  const swiftProtector = await runNativeHostSwiftTest('SubprocessAndSnapshotTests/testPhysicalDisplayModeProtectorDriftSleepDeferralAndStartupRecovery');
  assert.equal(swiftProtector.ok, true, swiftProtector.output);

  const physicalDisplays = [{ id: '1', name: 'Display 1', kind: 'physical', width: 3840, height: 2160, logicalWidth: 1920, logicalHeight: 1080, refreshRate: 120, ioModeID: 7, geometry: 'p1', drifted: true }];
  const h = await createDesktopGatewayHarness(t, { hostConfig: { physicalDisplays } });
  await connectAndConfirmReady(h, 'virtual');
  const events = (await h.hostFixture?.getEvents()) ?? [];
  const snapIdx = events.findIndex(e => e.type === 'snapshot-physical-modes' && e.phase === 'mount');
  const restoreIdx = events.findIndex(e => e.type === 'restore-mode' && e.id === '1' && e.scope === 'session');
  assert.ok(snapIdx >= 0 && restoreIdx > snapIdx);
});

test('[T1-F05-03] Tearing down Virtual Phone Screen restores drifted physical displays with permanent scope and removes snapshot file', async t => {
  const swiftPerm = await runNativeHostSwiftTest('SubprocessAndSnapshotTests/testRestoreDriftedAfterMountNonConvergencePreservesBaselineForPermanentRestore');
  assert.equal(swiftPerm.ok, true, swiftPerm.output);

  const physicalDisplays = [{ id: '1', name: 'Display 1', kind: 'physical', width: 3840, height: 2160, logicalWidth: 1920, logicalHeight: 1080, refreshRate: 60, ioModeID: 7, geometry: 'p1', drifted: true }];
  const h = await createDesktopGatewayHarness(t, { hostConfig: { physicalDisplays } });
  const grant = await connectAndConfirmReady(h, 'virtual');
  await requestOk(h, 'leave', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry });
  const events = (await h.hostFixture?.getEvents()) ?? [];
  assert.equal(events.some(e => e.type === 'restore-mode' && e.id === '1' && e.scope === 'permanent'), true);
  await assert.rejects(access(join(h.desktopState, 'display-modes-snapshot.json')));
});

test('[T1-F05-04] Non-drifted physical displays in multi-monitor topology are preserved without redundant restore-mode calls', async t => {
  const swiftProtector = await runNativeHostSwiftTest('SubprocessAndSnapshotTests/testPhysicalDisplayModeProtectorDriftSleepDeferralAndStartupRecovery');
  assert.equal(swiftProtector.ok, true, swiftProtector.output);

  const physicalDisplays = [
    { id: '1', name: 'Stable Display', kind: 'physical', width: 3840, height: 2160, logicalWidth: 1920, logicalHeight: 1080, refreshRate: 60, ioModeID: 1, geometry: 'p1', drifted: false },
    { id: '2', name: 'Drifted Display', kind: 'physical', width: 5120, height: 2880, logicalWidth: 2560, logicalHeight: 1440, refreshRate: 120, ioModeID: 2, geometry: 'p2', drifted: true },
  ];
  const h = await createDesktopGatewayHarness(t, { hostConfig: { physicalDisplays } });
  const grant = await connectAndConfirmReady(h, 'virtual');
  await requestOk(h, 'leave', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry });
  const restoredIds = ((await h.hostFixture?.getEvents()) ?? []).filter(e => e.type === 'restore-mode').map(e => e.id);
  assert.deepEqual(restoredIds, ['2', '2']);
});

test('[T1-F05-05] Asleep physical displays defer session restore on mount while unplugged displays are skipped cleanly', async t => {
  const swiftProtector = await runNativeHostSwiftTest('SubprocessAndSnapshotTests/testPhysicalDisplayModeProtectorDriftSleepDeferralAndStartupRecovery');
  assert.equal(swiftProtector.ok, true, swiftProtector.output);

  const tmpRoot = await mkdtemp(join(tmpdir(), 'codelync-f05-startup-'));
  t.after(() => rm(tmpRoot, { recursive: true, force: true }));
  const tmpStateDir = join(tmpRoot, 'state');
  const nativeProbe = await probeNativeHostDaemon([{ id: '1', operation: 'status' }], ['--state-dir=' + tmpStateDir]);
  assert.equal(nativeProbe.exitCode, 0);
  assert.equal(nativeProbe.replies[0]?.ok, true);

  const physicalDisplays = [
    { id: '1', name: 'Clamshell Asleep', kind: 'physical', width: 3024, height: 1964, logicalWidth: 1512, logicalHeight: 982, refreshRate: 120, ioModeID: 1, geometry: 'p1', isAsleep: true, drifted: true },
    { id: '2', name: 'Unplugged HDMI', kind: 'physical', width: 3840, height: 2160, logicalWidth: 1920, logicalHeight: 1080, refreshRate: 60, ioModeID: 2, geometry: 'p2', unplugged: true, drifted: true },
  ];
  const h = await createDesktopGatewayHarness(t, { hostConfig: { physicalDisplays } });
  await connectAndConfirmReady(h, 'virtual');
  const events = (await h.hostFixture?.getEvents()) ?? [];
  assert.equal(events.some(e => e.type === 'defer-asleep-display' && e.id === '1'), true);
  assert.equal(events.some(e => e.type === 'restore-mode' && e.id === '2'), false);
  const snap = JSON.parse(await readFile(join(h.desktopState, 'display-modes-snapshot.json'), 'utf8'));
  assert.equal(snap.displays.length, 1);
});

// ============================================================================
// F06: Virtual Display Teardown & Headless Mac Stream Safety
// ============================================================================

test('[T1-F06-01] Headless Mac with zero physical monitors returns [virtualRow] on displays and connects cleanly to Phone Screen', async t => {
  const h = await createDesktopGatewayHarness(t, { hostConfig: { headless: true } });
  const inv = await requestOk(h, 'displays', {});
  assert.equal(inv.virtualDisplaySupported, true);
  assert.equal(inv.displays.length, 1);
  assert.equal(inv.displays[0].id, 'virtual');
  const grant = await connectAndConfirmReady(h, 'virtual', { viewport: { width: 393, height: 759 } });
  assert.equal(grant.display.id, 'virtual');
});

test('[T1-F06-02] Switching from Virtual Phone Screen to physical display tears down virtual display with display-switch reason', async t => {
  const h = await createDesktopGatewayHarness(t);
  const grant = await connectAndConfirmReady(h, 'virtual');
  const sw = await requestOk(h, 'display', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry, displayId: '1' });
  assert.equal(sw.display.id, '1');
  assert.equal(sw.display.kind, 'physical');
  const events = (await h.hostFixture?.getEvents()) ?? [];
  assert.equal(events.some(e => e.type === 'release-virtual-display' && e.reason === 'display-switch'), true);
});

test('[T1-F06-03] Leaving Virtual Phone Screen session tears down virtual display and resets desktop status to disconnected', async t => {
  const h = await createDesktopGatewayHarness(t);
  const grant = await connectAndConfirmReady(h, 'virtual');
  const lv = await requestOk(h, 'leave', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry });
  assert.equal(lv.stopped, true);
  const status = await requestOk(h, 'status');
  assert.equal(status.connected, false);
  const events = (await h.hostFixture?.getEvents()) ?? [];
  assert.equal(events.some(e => e.type === 'release-virtual-display' && e.reason === 'stop'), true);
});

test('[T1-F06-04] Closing RemoteDesktop during active Virtual Phone Screen session tears down virtual display cleanly', async t => {
  const h = await createDesktopGatewayHarness(t);
  await connectAndConfirmReady(h, 'virtual');
  await h.desktop.close();
  const events = (await h.hostFixture?.getEvents()) ?? [];
  assert.equal(events.some(e => e.type === 'release-virtual-display'), true);
});

test('[T1-F06-05] Headless virtual display teardown stops SCStream capture strictly before releasing CGVirtualDisplay and passes Swift teardown XCTests', async t => {
  const swiftTeardown = await runNativeHostSwiftTest('DesktopHostStateMachineTests/testM1Advisory1StatusDisplayParityAndTeardownOrderBeforeVirtualDisplayMutation');
  assert.equal(swiftTeardown.ok, true, swiftTeardown.output);

  const h = await createDesktopGatewayHarness(t, { hostConfig: { headless: true } });
  const grant = await connectAndConfirmReady(h, 'virtual');
  await requestOk(h, 'leave', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry });
  const events = (await h.hostFixture?.getEvents()) ?? [];
  const stopIdx = events.findIndex(e => e.type === 'stop-capture-before-virtual-release');
  const releaseIdx = events.findIndex(e => e.type === 'release-virtual-display');
  const scStreamStoppedBeforeVirtualDestroy = stopIdx >= 0 && releaseIdx > stopIdx;
  assert.equal(scStreamStoppedBeforeVirtualDestroy, true);
  assert.equal(events[releaseIdx].minimumLifetimeMs, 2500);
});

// ============================================================================
// F07: Long-Edge Capture Clarity Scaling max(width, height)
// ============================================================================

test('[T1-F07-01] Native Swift DesktopCaptureMath XCTests pass and portrait 1080x2160 Virtual Phone Screen rotates trackSid across 1280/1920/2560 quality tiers', async t => {
  const [swiftCap, swiftScroll] = await Promise.all([
    runNativeHostSwiftTest('CaptureAndInputTests/testLongEdgeCaptureDimensionsAcrossLandscapePortraitSquareSmallAndOddSizes'),
    runNativeHostSwiftTest('CaptureAndInputTests/testScrollCoordinateAnchorAndEndToEndPortraitClarityAndInputValidation'),
  ]);
  assert.equal(swiftCap.ok, true, swiftCap.output);
  assert.equal(swiftScroll.ok, true, swiftScroll.output);

  const h = await createDesktopGatewayHarness(t);
  const grant = await connectAndConfirmReady(h, 'virtual', { viewport: { width: 540, height: 1080 } });
  let prevTrackSid = grant.trackSid;
  for (const [tier, fps] of /** @type {Array<[number, number]>} */ ([[1280, 15], [1920, 30], [2560, 60]])) {
    const q = await requestOk(h, 'quality', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry, quality: { width: tier, fps } });
    assert.equal(Object.keys(q).some(k => k.startsWith('capture') && k !== 'capturing'), false);
    assert.deepEqual(q.quality, { width: tier, fps });
    assert.notEqual(q.trackSid, prevTrackSid);
    assert.equal(h.desktop.active?.ready, false);
    assert.equal(q.display.logicalWidth, 540);
    assert.equal(q.display.logicalHeight, 1080);
    assert.equal(q.display.width, 1080);
    assert.equal(q.display.height, 2160);
    assert.deepEqual(h.desktop.status().quality, { width: tier, fps });
    prevTrackSid = q.trackSid;
  }
  const qualityRpcs = ((await h.hostFixture?.getEvents()) ?? []).filter(e => e.type === 'rpc' && e.op === 'quality');
  assert.deepEqual(qualityRpcs.map(e => e.msg.quality), [
    { width: 1280, fps: 15 },
    { width: 1920, fps: 30 },
    { width: 2560, fps: 60 },
  ]);
});

test('[T1-F07-02] Odd-aspect iPhone portrait 1080x2086 preserves 2x backing display geometry across transpiled desktopRequest quality tiers', async t => {
  const h = await createDesktopGatewayHarness(t);
  const sync = await createMobileSyncRuntime(h);
  t.after(() => sync.dispose());

  const grant = await sync.desktopRequest('join', { displayId: 'virtual', viewport: { width: 393, height: 759 } });
  assert.equal(grant.display.logicalWidth, 540);
  assert.equal(grant.display.logicalHeight, 1043);
  assert.equal(grant.display.width, 1080);
  assert.equal(grant.display.height, 2086);

  let prevTrackSid = grant.trackSid;
  for (const tier of [1280, 1920, 2560]) {
    const q = await sync.desktopRequest('quality', {
      connectionId: grant.connectionId,
      generation: grant.generation,
      geometry: grant.display.geometry,
      quality: { width: tier, fps: 30 },
    });
    assert.equal(Object.keys(q).some(k => k.startsWith('capture') && k !== 'capturing'), false);
    assert.deepEqual(q.quality, { width: tier, fps: 30 });
    assert.notEqual(q.trackSid, prevTrackSid);
    assert.equal(q.display.logicalWidth, 540);
    assert.equal(q.display.logicalHeight, 1043);
    assert.equal(q.display.width, 1080);
    assert.equal(q.display.height, 2086);
    prevTrackSid = q.trackSid;
  }
});

test('[T1-F07-03] Tall portrait 540x1350pt (1080x2700px) and max upshifted 2160x5400px update Bridge quality state cleanly across 1280/1920/2560 tiers', async t => {
  const h = await createDesktopGatewayHarness(t, { hostConfig: { windowMinSizes: { '1001:5001': { width: 1080, height: 2600 } } } });
  const grant = await connectAndConfirmReady(h, 'virtual', { viewport: { width: 300, height: 900 } });
  assert.equal(grant.display.logicalWidth, 540);
  assert.equal(grant.display.logicalHeight, 1350);
  assert.equal(grant.display.width, 1080);
  assert.equal(grant.display.height, 2700);

  const qPre = await requestOk(h, 'quality', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry, quality: { width: 1280, fps: 30 } });
  assert.equal(Object.keys(qPre).some(k => k.startsWith('capture') && k !== 'capturing'), false);
  assert.equal(qPre.display.width, 1080);
  assert.equal(qPre.display.height, 2700);
  await requestOk(h, 'ready', { connectionId: grant.connectionId, generation: grant.generation, geometry: qPre.geometry, trackSid: qPre.trackSid });

  const fill = await requestOk(h, 'window', { connectionId: grant.connectionId, generation: grant.generation, geometry: qPre.geometry, sequence: 1, mode: 'fill', windowId: '1001:5001' });
  assert.equal(fill.display.width, 2160);
  assert.equal(fill.display.height, 5400);
  for (const tier of [1280, 1920, 2560]) {
    const q = await requestOk(h, 'quality', { connectionId: grant.connectionId, generation: grant.generation, geometry: fill.geometry, quality: { width: tier, fps: 30 } });
    assert.equal(Object.keys(q).some(k => k.startsWith('capture') && k !== 'capturing'), false);
    assert.deepEqual(q.quality, { width: tier, fps: 30 });
    assert.equal(q.display.width, 2160);
    assert.equal(q.display.height, 5400);
  }
});

test('[T1-F07-04] Landscape 4K physical display 3840x2160 updates Bridge quality, resets ready, and rotates trackSid across 1280/1920/2560 tiers', async t => {
  const h = await createDesktopGatewayHarness(t);
  const grant = await connectAndConfirmReady(h, '1');
  let prevTrack = grant.trackSid;
  for (const tier of [1280, 1920, 2560]) {
    const q = await requestOk(h, 'quality', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry, quality: { width: tier, fps: 60 } });
    assert.equal(Object.keys(q).some(k => k.startsWith('capture') && k !== 'capturing'), false);
    assert.deepEqual(q.quality, { width: tier, fps: 60 });
    assert.notEqual(q.trackSid, prevTrack);
    assert.equal(h.desktop.active?.ready, false);
    assert.equal(q.display.logicalWidth, 1920);
    assert.equal(q.display.logicalHeight, 1080);
    assert.equal(q.display.width, 3840);
    assert.equal(q.display.height, 2160);
    prevTrack = q.trackSid;
  }
});

test('[T1-F07-05] Changing capture quality tier rotates trackSid and blocks input until ready confirms new trackSid', async t => {
  const h = await createDesktopGatewayHarness(t);
  const grant = await connectAndConfirmReady(h, 'virtual');
  const q = await requestOk(h, 'quality', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry, quality: { width: 1280, fps: 15 } });
  assert.notEqual(q.trackSid, grant.trackSid);
  const blocked = await h.requestDesktopHttp('input', { connectionId: grant.connectionId, generation: grant.generation, geometry: q.geometry, sequence: 1, input: { action: 'scroll', deltaY: 60, x: 0.5, y: 0.5 } });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.error, 'desktop-not-ready');
  await requestOk(h, 'ready', { connectionId: grant.connectionId, generation: grant.generation, geometry: q.geometry, trackSid: q.trackSid });
  const accepted = await requestOk(h, 'input', { connectionId: grant.connectionId, generation: grant.generation, geometry: q.geometry, sequence: 2, input: { action: 'scroll', deltaY: 60, x: 0.5, y: 0.5 } });
  assert.equal(accepted.accepted, true);
});

// ============================================================================
// F08: Host Scroll Coordinate Anchor (x, y)
// ============================================================================

test('[T1-F08-01] Scroll input with normalized center anchor (0.5, 0.5) updates host cursor anchor and acknowledges sequence', async t => {
  const h = await createDesktopGatewayHarness(t);
  const grant = await connectAndConfirmReady(h, 'virtual');
  const data = await requestOk(h, 'input', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry, sequence: 1, input: { action: 'scroll', deltaY: 180, x: 0.5, y: 0.5 } });
  assert.deepEqual(data, { accepted: true, sequence: 1 });
  const evt = ((await h.hostFixture?.getEvents()) ?? []).find(e => e.type === 'input' && e.sequence === 1);
  assert.deepEqual(evt?.cursor, { x: 0.5, y: 0.5 });
  assert.equal(evt?.deltaY, 180);
});

test('[T1-F08-02] Scroll inputs at normalized boundary corners (0, 0) and (1, 1) anchor host location accurately', async t => {
  const h = await createDesktopGatewayHarness(t);
  const grant = await connectAndConfirmReady(h, 'virtual');
  await requestOk(h, 'input', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry, sequence: 1, input: { action: 'scroll', deltaY: 120, x: 0, y: 0 } });
  await requestOk(h, 'input', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry, sequence: 2, input: { action: 'scroll', deltaY: -120, x: 1, y: 1 } });
  const inputs = ((await h.hostFixture?.getEvents()) ?? []).filter(e => e.type === 'input');
  assert.deepEqual(inputs[0].cursor, { x: 0, y: 0 });
  assert.deepEqual(inputs[1].cursor, { x: 1, y: 1 });
});

test('[T1-F08-03] Scroll input at interior point (0.25, 0.75) with negative deltaY updates host cursor and dispatches scroll', async t => {
  const h = await createDesktopGatewayHarness(t);
  const grant = await connectAndConfirmReady(h, 'virtual');
  const data = await requestOk(h, 'input', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry, sequence: 1, input: { action: 'scroll', deltaY: -360, x: 0.25, y: 0.75 } });
  assert.equal(data.sequence, 1);
  const evt = ((await h.hostFixture?.getEvents()) ?? []).find(e => e.type === 'input' && e.sequence === 1);
  assert.deepEqual(evt?.cursor, { x: 0.25, y: 0.75 });
  assert.equal(evt?.deltaY, -360);
});

test('[T1-F08-04] Scroll input omitting (x, y) is accepted and preserves prior cursor anchor on selected display', async t => {
  const h = await createDesktopGatewayHarness(t);
  const grant = await connectAndConfirmReady(h, 'virtual');
  await requestOk(h, 'input', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry, sequence: 1, input: { action: 'pointer', phase: 'move', x: 0.35, y: 0.65 } });
  const data = await requestOk(h, 'input', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry, sequence: 2, input: { action: 'scroll', deltaY: 90 } });
  assert.deepEqual(data, { accepted: true, sequence: 2 });
  const evt = ((await h.hostFixture?.getEvents()) ?? []).find(e => e.type === 'input' && e.sequence === 2);
  assert.deepEqual(evt?.cursor, { x: 0.35, y: 0.65 });
});

test('[T1-F08-05] Multi-step anchored scroll stream maintains monotonic sequence across display switch with zero Space arrow-key synthesis', async t => {
  const h = await createDesktopGatewayHarness(t);
  const grant = await connectAndConfirmReady(h, '1');
  await requestOk(h, 'input', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry, sequence: 1, input: { action: 'scroll', deltaY: 100, x: 0.2, y: 0.8 } });
  const sw = await requestOk(h, 'display', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry, displayId: 'virtual' });
  await requestOk(h, 'ready', { connectionId: grant.connectionId, generation: grant.generation, geometry: sw.geometry, trackSid: sw.trackSid });
  const s2 = await requestOk(h, 'input', { connectionId: grant.connectionId, generation: grant.generation, geometry: sw.geometry, sequence: 2, input: { action: 'scroll', deltaY: -200, x: 0.75, y: 0.25 } });
  assert.equal(s2.sequence, 2);
  const inputs = ((await h.hostFixture?.getEvents()) ?? []).filter(e => e.type === 'input');
  assert.deepEqual(inputs.map(e => e.sequence), [1, 2]);
  assert.deepEqual(inputs[1].cursor, { x: 0.75, y: 0.25 });

  for (const [rel, src] of (await getWorkspaceSourceEntries()).filter(([p]) => p.startsWith('native/remote-desktop/Sources/'))) {
    const hasControlMask = /\bmaskControl\b/u.test(src);
    const hasArrowKeyCode = /(?:virtualKey|keyCode)\s*:\s*(?:CGKeyCode\s*\(\s*)?(123|124)\b/u.test(src)
      || /CGEvent\s*\(\s*keyboardEventSource:[^)]*,\s*virtualKey:\s*(123|124)\b/u.test(src);
    assert.equal(hasControlMask && hasArrowKeyCode, false, `Space keystroke synth forbidden in ${rel}`);
  }
});

// ============================================================================
// F09: AX Standard Window Enumeration & visibleFrame Fill
// ============================================================================

test('[T1-F09-01] POST /api/peer/desktop/windows returns DesktopWindowItem schema with <pid>:<cgWindowId> and excludes Codelync', async t => {
  const h = await createDesktopGatewayHarness(t);
  const grant = await connectAndConfirmReady(h, 'virtual');
  const data = await requestOk(h, 'windows', { connectionId: grant.connectionId });
  assert.equal(data.activeWindowId, null);
  assert.equal(data.windows.length, 2);
  for (const w of data.windows) {
    assert.match(w.id, /^\d{1,10}:\d{1,10}$/u);
    assert.equal(w.id, `${w.pid}:${w.windowId}`);
    assert.equal(w.appName.toLowerCase().includes('codelync'), false);
    assert.equal(typeof w.bounds.width, 'number');
    assert.equal(typeof w.minimized, 'boolean');
    assert.equal(typeof w.onVirtualDisplay, 'boolean');
  }
});

test('[T1-F09-02] POST /api/peer/desktop/window mode fill moves window onto Phone Screen and updates activeWindowId and onVirtualDisplay', async t => {
  const h = await createDesktopGatewayHarness(t);
  const grant = await connectAndConfirmReady(h, 'virtual');
  const fill = await requestOk(h, 'window', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry, sequence: 1, mode: 'fill', windowId: '1001:5001' });
  assert.equal(fill.accepted, true);
  assert.equal(fill.activeWindowId, '1001:5001');
  assert.notEqual(fill.geometry, grant.display.geometry);
  assert.notEqual(fill.trackSid, grant.trackSid);

  const list = await requestOk(h, 'windows', { connectionId: grant.connectionId, generation: grant.generation });
  assert.equal(list.activeWindowId, '1001:5001');
  const filledItem = list.windows.find((/** @type {Value} */ w) => w.id === '1001:5001');
  assert.equal(filledItem?.onVirtualDisplay, true);
});

test('[T1-F09-03] Bridge windows/window preserve negative secondary-screen visibleFrame bounds verbatim and Swift sources have zero 28pt subtraction', async t => {
  const axLeftDock = convertVisibleFrameToAxTopLeft({ minX: -540, minY: 0, maxY: 1415, width: 540, height: 1415 }, 1440);
  assert.deepEqual(axLeftDock, { x: -540, y: 25, width: 540, height: 1415 });

  const windowsList = [
    { id: '1001:5001', pid: 1001, windowId: 5001, appName: 'Safari', bundleId: 'com.apple.Safari', title: 'Left Display', bounds: { x: -540, y: 25, width: 540, height: 1018 }, minimized: false, onVirtualDisplay: false },
  ];
  const h = await createDesktopGatewayHarness(t, {
    hostConfig: { windowsList, fillArea: { x: -540, y: 25, width: 540, height: 1018 } },
  });
  const grant = await connectAndConfirmReady(h, 'virtual');
  const initialList = await requestOk(h, 'windows', { connectionId: grant.connectionId });
  assert.deepEqual(initialList.windows[0].bounds, { x: -540, y: 25, width: 540, height: 1018 });

  const fill = await requestOk(h, 'window', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry, sequence: 1, mode: 'fill', windowId: '1001:5001' });
  assert.equal(fill.accepted, true);
  assert.equal(h.desktop.active?.ready, false);
  const afterList = await requestOk(h, 'windows', { connectionId: grant.connectionId });
  assert.deepEqual(afterList.windows[0].bounds, { x: -540, y: 25, width: 540, height: 1018 });

  const swiftFiles = await listWorkspaceSourceFiles(['native/remote-desktop/Sources']);
  for (const rel of swiftFiles) {
    const src = await readWorkspaceFile(rel);
    assert.equal(/\bvisibleFrame\b[^;\n]*-\s*28\b/u.test(src), false, `Forbidden 28pt subtraction on visibleFrame in ${rel}`);
  }
});

test('[T1-F09-04] Minimized and native fullscreen windows can be filled onto Virtual Phone Screen while preserving prior flags', async t => {
  const windowsList = [
    { id: '2001:6001', pid: 2001, windowId: 6001, appName: 'Terminal', bundleId: 'com.apple.Terminal', title: 'zsh', bounds: { x: 40, y: 60, width: 500, height: 700 }, minimized: true, fullScreen: false, onVirtualDisplay: false },
    { id: '2002:6002', pid: 2002, windowId: 6002, appName: 'Safari', bundleId: 'com.apple.Safari', title: 'Docs', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, minimized: false, fullScreen: true, onVirtualDisplay: false },
  ];
  const h = await createDesktopGatewayHarness(t, { hostConfig: { windowsList } });
  const grant = await connectAndConfirmReady(h, 'virtual');
  const f1 = await requestOk(h, 'window', { connectionId: grant.connectionId, geometry: grant.display.geometry, sequence: 1, mode: 'fill', windowId: '2001:6001' });
  const rec1 = JSON.parse(await readFile(join(h.desktopState, 'window-restore.json'), 'utf8'));
  assert.equal(rec1.records[0].wasMinimized, true);
  assert.equal(rec1.records[0].wasFullScreen, false);

  await requestOk(h, 'ready', { connectionId: grant.connectionId, generation: grant.generation, geometry: f1.geometry, trackSid: f1.trackSid });
  await requestOk(h, 'window', { connectionId: grant.connectionId, geometry: f1.geometry, sequence: 2, mode: 'fill', windowId: '2002:6002' });
  const rec2 = JSON.parse(await readFile(join(h.desktopState, 'window-restore.json'), 'utf8'));
  assert.equal(rec2.records[0].wasFullScreen, true);
});

test('[T1-F09-05] Windows RPC accepts omitted or explicit generation and pre-on-virtual window uses centered primary fallback originalFrame', async t => {
  const windowsList = [
    { id: '3001:7001', pid: 3001, windowId: 7001, appName: 'Xcode', bundleId: 'com.apple.dt.Xcode', title: 'App.swift', bounds: { x: 2000, y: 24, width: 540, height: 1000 }, minimized: false, onVirtualDisplay: true },
  ];
  const h = await createDesktopGatewayHarness(t, { hostConfig: { windowsList } });
  const grant = await connectAndConfirmReady(h, 'virtual');
  const wNoGen = await requestOk(h, 'windows', {});
  const wWithGen = await requestOk(h, 'windows', { connectionId: grant.connectionId, generation: grant.generation });
  assert.deepEqual(wNoGen, wWithGen);

  await requestOk(h, 'window', { connectionId: grant.connectionId, geometry: grant.display.geometry, sequence: 1, mode: 'fill', windowId: '3001:7001' });
  const rec = JSON.parse(await readFile(join(h.desktopState, 'window-restore.json'), 'utf8'));
  assert.deepEqual(rec.records[0].originalFrame, { x: 320, y: 130, width: 540, height: 1000 });
});

// ============================================================================
// F10: Post-Move Clamped Min-Width Auto-Upshift & geometry Gate
// ============================================================================

test('[T1-F10-01] Filling a 720pt min-width window on 540pt Phone Screen auto-upshifts virtual display to 720pt (1440px backing)', async t => {
  const h = await createDesktopGatewayHarness(t, { hostConfig: { windowMinSizes: { '1002:5002': { width: 720, height: 900 } } } });
  const grant = await connectAndConfirmReady(h, 'virtual', { viewport: { width: 540, height: 1080 } });
  const fill = await requestOk(h, 'window', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry, sequence: 1, mode: 'fill', windowId: '1002:5002' });
  assert.equal(fill.upshifted, true);
  assert.equal(fill.display.logicalWidth, 720);
  assert.equal(fill.display.logicalHeight, 1440);
  assert.equal(fill.display.width, 1440);
  assert.equal(fill.display.height, 2880);
  const events = (await h.hostFixture?.getEvents()) ?? [];
  assert.equal(events.some(e => e.type === 'upshift-set-mode' && e.nextWidth === 720), true);
});

test('[T1-F10-02] Filling a 755pt min-width window rounds auto-upshift up to smallest fitting 10pt step (760pt / 1520px)', async t => {
  const h = await createDesktopGatewayHarness(t, { hostConfig: { windowMinSizes: { '1002:5002': { width: 755, height: 900 } } } });
  const grant = await connectAndConfirmReady(h, 'virtual', { viewport: { width: 393, height: 759 } });
  const fill = await requestOk(h, 'window', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry, sequence: 1, mode: 'fill', windowId: '1002:5002' });
  assert.equal(fill.upshifted, true);
  assert.equal(fill.display.logicalWidth, 760);
  assert.equal(fill.display.width, 1520);
  assert.equal(fill.display.height, fill.display.logicalHeight * 2);
});

test('[T1-F10-03] Filling a compact 480pt window that fits within 540pt Phone Screen keeps logicalWidth 540pt with upshifted false', async t => {
  const h = await createDesktopGatewayHarness(t, { hostConfig: { windowMinSizes: { '1001:5001': { width: 480, height: 700 } } } });
  const grant = await connectAndConfirmReady(h, 'virtual', { viewport: { width: 540, height: 1080 } });
  const fill = await requestOk(h, 'window', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry, sequence: 1, mode: 'fill', windowId: '1001:5001' });
  assert.equal(fill.upshifted, false);
  assert.equal(fill.display.logicalWidth, 540);
});

test('[T1-F10-04] Native Swift upshift XCTests, Bridge IEEE-754 (580*630)/522=700pt & +2pt/+3pt boundaries, and useRemoteDesktop upshift ready-gate pass', async t => {
  const [swiftCoord, swiftSeam] = await Promise.all([
    runNativeHostSwiftTest('RuntimeAndLadderTests/testCoordinatorSerialFallbackInPlaceUpdateUpshiftAndMinimumLifetime'),
    runNativeHostSwiftTest('DesktopHostStateMachineTests/testSCStreamStopDuringWindowRestoreAndCaptureSafeUpshiftSeam'),
  ]);
  assert.equal(swiftCoord.ok, true, swiftCoord.output);
  assert.equal(swiftSeam.ok, true, swiftSeam.output);

  const h1 = await createDesktopGatewayHarness(t, {
    hostConfig: { fillArea: { width: 522, height: 1000 }, windowMinSizes: { '1001:5001': { width: 630, height: 900 } } },
  });
  const g1 = await connectAndConfirmReady(h1, 'virtual', { viewport: { width: 580, height: 805 } });
  const f700 = await requestOk(h1, 'window', { connectionId: g1.connectionId, generation: g1.generation, geometry: g1.display.geometry, sequence: 1, mode: 'fill', windowId: '1001:5001' });
  assert.equal(f700.upshifted, true);
  assert.equal(f700.display.logicalWidth, 700);
  assert.equal(f700.display.width, 1400);

  const h2 = await createDesktopGatewayHarness(t, {
    hostConfig: {
      fillArea: { width: 540, height: 1056 },
      windowMinSizes: { '1001:5001': { width: 542, height: 900 }, '1002:5002': { width: 543, height: 900 } },
    },
  });
  const g2 = await connectAndConfirmReady(h2, 'virtual', { viewport: { width: 540, height: 1080 } });
  const f542 = await requestOk(h2, 'window', { connectionId: g2.connectionId, generation: g2.generation, geometry: g2.display.geometry, sequence: 1, mode: 'fill', windowId: '1001:5001' });
  assert.equal(f542.upshifted, false);
  assert.equal(f542.display.logicalWidth, 540);
  await requestOk(h2, 'ready', { connectionId: g2.connectionId, generation: g2.generation, geometry: f542.geometry, trackSid: f542.trackSid });
  const f543 = await requestOk(h2, 'window', { connectionId: g2.connectionId, generation: g2.generation, geometry: f542.geometry, sequence: 2, mode: 'fill', windowId: '1002:5002' });
  assert.equal(f543.upshifted, true);
  assert.equal(f543.display.logicalWidth, 550);

  const h3 = await createDesktopGatewayHarness(t, {
    hostConfig: { windowMinSizes: { '1002:5002': { width: 780, height: 900 } } },
  });
  const hook = await mountUseRemoteDesktopRuntime({
    harness: h3,
    autoDecodeFrames: false,
    initialDecodedFrames: 2,
    window: { width: 393, height: 852 },
    insets: { top: 59, bottom: 34, left: 0, right: 0 },
  });
  t.after(() => hook.unmount());
  await hook.call(() => hook.current.selectDisplay('virtual'));
  await hook.call(() => hook.current.connect('virtual', { width: 393, height: 759 }));
  await hook.setDecodedFrames(4, 1080, 2086);
  assert.equal(hook.current.ready, true);
  await hook.call(() => hook.current.fillWindow('1002:5002'));
  assert.equal(hook.current.grant?.display.logicalWidth, 780);
  assert.equal(hook.current.grant?.display.logicalHeight, 1506);
  assert.equal(hook.current.grant?.display.width, 1560);
  assert.equal(hook.current.grant?.display.height, 3012);
  assert.equal(hook.current.ready, false);
  await hook.setDecodedFrames(6, 1560, 3012);
  assert.equal(hook.current.ready, true);
});

test('[T1-F10-05] Auto-upshift invalidates view and blocks input until /api/peer/desktop/ready confirms new geometry and trackSid', async t => {
  const h = await createDesktopGatewayHarness(t, { hostConfig: { windowMinSizes: { '1002:5002': { width: 720, height: 900 } } } });
  const grant = await connectAndConfirmReady(h, 'virtual');
  const fill = await requestOk(h, 'window', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry, sequence: 1, mode: 'fill', windowId: '1002:5002' });
  assert.equal(fill.upshifted, true);

  const staleGeo = await h.requestDesktopHttp('input', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry, sequence: 2, input: { action: 'pointer', phase: 'click', x: 0.5, y: 0.5, button: 'left' } });
  assert.equal(staleGeo.status, 409);
  assert.equal(staleGeo.error, 'desktop-view-changed');

  const preReady = await h.requestDesktopHttp('input', { connectionId: grant.connectionId, generation: grant.generation, geometry: fill.geometry, sequence: 2, input: { action: 'pointer', phase: 'click', x: 0.5, y: 0.5, button: 'left' } });
  assert.equal(preReady.status, 409);
  assert.equal(preReady.error, 'desktop-not-ready');

  await requestOk(h, 'ready', { connectionId: grant.connectionId, generation: grant.generation, geometry: fill.geometry, trackSid: fill.trackSid });
  const postReady = await requestOk(h, 'input', { connectionId: grant.connectionId, generation: grant.generation, geometry: fill.geometry, sequence: 2, input: { action: 'pointer', phase: 'click', x: 0.5, y: 0.5, button: 'left' } });
  assert.equal(postReady.accepted, true);
});

// ============================================================================
// F11: Write-Ahead RestoreRecord Persistence & 4-Trigger Auto-Restore
// ============================================================================

test('[T1-F11-01] Filling a window atomically writes 0o600 window-restore.json inside 0o700 state dir with v1 RestoreRecord schema', async t => {
  const h = await createDesktopGatewayHarness(t);
  const grant = await connectAndConfirmReady(h, 'virtual');
  await requestOk(h, 'window', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry, sequence: 1, mode: 'fill', windowId: '1001:5001' });

  assert.equal((await stat(h.desktopState)).mode & 0o777, 0o700);
  const restorePath = join(h.desktopState, 'window-restore.json');
  assert.equal((await stat(restorePath)).mode & 0o777, 0o600);

  const payload = JSON.parse(await readFile(restorePath, 'utf8'));
  assert.equal(payload.version, 1);
  assert.equal(payload.records.length, 1);
  assert.equal(payload.records[0].pid, 1001);
  assert.equal(payload.records[0].windowId, 5001);
  assert.deepEqual(payload.records[0].originalFrame, { x: 80, y: 80, width: 640, height: 900 });
  assert.equal(typeof payload.records[0].savedAt, 'string');
});

test('[T1-F11-02] Auto-restore Trigger 1: switching to another window restores previous filled window before filling new window', async t => {
  const h = await createDesktopGatewayHarness(t);
  const grant = await connectAndConfirmReady(h, 'virtual');
  const f1 = await requestOk(h, 'window', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry, sequence: 1, mode: 'fill', windowId: '1001:5001' });
  await requestOk(h, 'ready', { connectionId: grant.connectionId, generation: grant.generation, geometry: f1.geometry, trackSid: f1.trackSid });
  const f2 = await requestOk(h, 'window', { connectionId: grant.connectionId, generation: grant.generation, geometry: f1.geometry, sequence: 2, mode: 'fill', windowId: '1002:5002' });
  assert.equal(f2.activeWindowId, '1002:5002');
  const restoreEvt = ((await h.hostFixture?.getEvents()) ?? []).find(e => e.type === 'restore-windows' && e.trigger === 'window-switch');
  assert.equal(restoreEvt?.records[0].windowId, 5001);
});

test('[T1-F11-03] Auto-restore Trigger 2: switching back to physical display restores filled window and clears window-restore.json', async t => {
  const h = await createDesktopGatewayHarness(t);
  const grant = await connectAndConfirmReady(h, 'virtual');
  const f1 = await requestOk(h, 'window', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry, sequence: 1, mode: 'fill', windowId: '1001:5001' });
  await requestOk(h, 'display', { connectionId: grant.connectionId, generation: grant.generation, geometry: f1.geometry, displayId: '1' });
  const events = (await h.hostFixture?.getEvents()) ?? [];
  assert.equal(events.some(e => e.type === 'restore-windows' && e.trigger === 'display-switch'), true);
  await assert.rejects(access(join(h.desktopState, 'window-restore.json')));
});

test('[T1-F11-04] Auto-restore Trigger 3: explicit mode restore and session leave restore filled windows and delete RestoreRecord', async t => {
  const h = await createDesktopGatewayHarness(t);
  const grant = await connectAndConfirmReady(h, 'virtual');
  const f1 = await requestOk(h, 'window', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry, sequence: 1, mode: 'fill', windowId: '1001:5001' });
  await requestOk(h, 'ready', { connectionId: grant.connectionId, generation: grant.generation, geometry: f1.geometry, trackSid: f1.trackSid });

  const manual = await requestOk(h, 'window', { connectionId: grant.connectionId, generation: grant.generation, geometry: f1.geometry, sequence: 2, mode: 'restore' });
  assert.equal(manual.activeWindowId, null);
  await assert.rejects(access(join(h.desktopState, 'window-restore.json')));

  await requestOk(h, 'ready', { connectionId: grant.connectionId, generation: grant.generation, geometry: manual.geometry, trackSid: manual.trackSid });
  const f2 = await requestOk(h, 'window', { connectionId: grant.connectionId, generation: grant.generation, geometry: manual.geometry, sequence: 3, mode: 'fill', windowId: '1002:5002' });
  await requestOk(h, 'leave', { connectionId: grant.connectionId, generation: grant.generation, geometry: f2.geometry });

  const events = (await h.hostFixture?.getEvents()) ?? [];
  assert.equal(events.some(e => e.type === 'restore-windows' && e.trigger === 'manual-restore'), true);
  assert.equal(events.some(e => e.type === 'restore-windows' && e.trigger === 'stop'), true);
  await assert.rejects(access(join(h.desktopState, 'window-restore.json')));
});

test('[T1-F11-05] Auto-restore Trigger 4: startup crash recovery, Swift DurableJSONStore XCTests, and fail-closed persist error pass', async t => {
  const swiftStore = await runNativeHostSwiftTest('SubprocessAndSnapshotTests/testDurableJSONStorePermissionsQuarantineAndSymlinkDefense');
  assert.equal(swiftStore.ok, true, swiftStore.output);

  const crashRoot = await mkdtemp(join(tmpdir(), 'codelync-f11-crash-'));
  t.after(() => rm(crashRoot, { recursive: true, force: true }));
  const stateDir = join(crashRoot, 'desktop-state');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const restoreFile = join(stateDir, 'window-restore.json');
  const crashRecord = {
    version: 1,
    records: [{ pid: 999999, windowId: 888888, bundleId: 'com.apple.dt.Xcode', appName: 'Xcode', title: 'Workspace.xcodeproj', originalFrame: { x: 120, y: 90, width: 1280, height: 820 }, wasFullScreen: false, wasMinimized: false, savedAt: '2026-11-18T12:00:00Z' }],
  };
  await writeFile(restoreFile, JSON.stringify(crashRecord, null, 2), { mode: 0o600 });

  const fixture = await createProgrammableHostBinary(join(crashRoot, 'host'));
  const proc = new DesktopHostProcess({ binary: fixture.binaryPath, state: stateDir });
  t.after(() => proc.close());
  const status = await proc.request('status');
  assert.equal(status.capturing, false);
  const events = await fixture.getEvents();
  assert.equal(events.some(e => e.type === 'restore-windows' && e.trigger === 'startup' && e.records[0].windowId === 888888), true);
  await assert.rejects(access(restoreFile));

  const nativeStateDir = join(crashRoot, 'native-state');
  await mkdir(nativeStateDir, { recursive: true, mode: 0o700 });
  const nativeRestoreFile = join(nativeStateDir, 'window-restore.json');
  await writeFile(nativeRestoreFile, JSON.stringify(crashRecord, null, 2), { mode: 0o600 });
  const nativeProbe = await probeNativeHostDaemon(
    [{ id: 's1', operation: 'status' }, { id: 'w1', operation: 'windows' }],
    ['--state-dir=' + nativeStateDir],
  );
  assert.equal(nativeProbe.timedOut, false);
  assert.equal(nativeProbe.exitCode, 0);
  assert.equal(nativeProbe.replies[0]?.ok, true);
  assert.notEqual(nativeProbe.replies[1]?.error, 'invalid-desktop-operation');
  if (nativeProbe.replies[0]?.result?.permissions?.accessibility === true) {
    assert.equal(nativeProbe.replies[1]?.ok, true);
    await assert.rejects(access(nativeRestoreFile));
  } else {
    assert.equal(nativeProbe.replies[1]?.ok, false);
    assert.equal(nativeProbe.replies[1]?.error, 'desktop-accessibility-required');
    await access(nativeRestoreFile);
  }

  const hPersistFail = await createDesktopGatewayHarness(t, { hostConfig: { persistFailure: true } });
  const grant = await connectAndConfirmReady(hPersistFail, 'virtual');
  const failRes = await hPersistFail.requestDesktopHttp('window', {
    connectionId: grant.connectionId,
    generation: grant.generation,
    geometry: grant.display.geometry,
    sequence: 1,
    mode: 'fill',
    windowId: '1001:5001',
  });
  assert.equal(failRes.ok, false);
  assert.equal(failRes.status, 409);
  assert.equal(failRes.error, 'desktop-restore-persist-failed');
  const winAfter = await requestOk(hPersistFail, 'windows', { connectionId: grant.connectionId });
  assert.equal(winAfter.activeWindowId, null);
});

// ============================================================================
// F12: Bridge Virtual Display, --state-dir Plumbing & Window RPC State Machine
// ============================================================================

test('[T1-F12-01] Bridge DesktopHostProcess spawns CodelyncDesktopHost with --state-dir=<desktopState>', async t => {
  const h = await createDesktopGatewayHarness(t);
  await requestOk(h, 'displays', {});
  const argv = (await h.hostFixture?.getArgv()) ?? [];
  assert.equal(argv.includes(`--state-dir=${h.desktopState}`), true);
});

test('[T1-F12-02] Sealed /api/peer/desktop/windows and /window round-trip under both v3 compact and v2 JSON peer codecs', async t => {
  const h = await createDesktopGatewayHarness(t);
  const grant = await connectAndConfirmReady(h, 'virtual');
  const winV2 = await requestOk(h, 'windows', { connectionId: grant.connectionId }, { codecV3: false });
  const winV3 = await requestOk(h, 'windows', { connectionId: grant.connectionId }, { codecV3: true });
  assert.deepEqual(winV2, winV3);
  const fillV2 = await requestOk(h, 'window', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry, sequence: 1, mode: 'fill', windowId: '1001:5001' }, { codecV3: false });
  assert.equal(fillV2.activeWindowId, '1001:5001');
});

test('[T1-F12-03] Bridge adoptView propagates upshifted virtual display dimensions across window, heartbeat, and status', async t => {
  const h = await createDesktopGatewayHarness(t, { hostConfig: { windowMinSizes: { '1002:5002': { width: 780, height: 900 } } } });
  const grant = await connectAndConfirmReady(h, 'virtual', { viewport: { width: 393, height: 759 } });
  const fill = await requestOk(h, 'window', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry, sequence: 1, mode: 'fill', windowId: '1002:5002' });
  assert.equal(fill.display.logicalWidth, 780);
  assert.equal(fill.display.width, 1560);

  const hb = await requestOk(h, 'heartbeat', { connectionId: grant.connectionId, generation: grant.generation, geometry: fill.geometry });
  assert.equal(hb.display.logicalWidth, 780);
  assert.equal(hb.display.width, 1560);

  const st = await requestOk(h, 'status');
  assert.equal(st.display.logicalWidth, 780);
  assert.equal(st.display.width, 1560);
});

test('[T1-F12-04] Bridge reserves window sequence before IPC dispatch with 20s host / 25s mobile timeouts and never replays unknown outcomes', async t => {
  const h = await createDesktopGatewayHarness(t, { hostConfig: { failOperation: { window: { error: 'desktop-operation-unknown', invalidateFirst: true } } } });
  const grant = await connectAndConfirmReady(h, 'virtual');
  const first = await h.requestDesktopHttp('window', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry, sequence: 1, mode: 'fill', windowId: '1001:5001' });
  assert.equal(first.status, 503);
  assert.equal(first.error, 'desktop-operation-unknown');

  await h.hostFixture?.updateConfig({ failOperation: {} });
  const replay = await h.requestDesktopHttp('window', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry, sequence: 1, mode: 'fill', windowId: '1001:5001' });
  assert.equal(replay.status, 409);
  assert.equal(replay.error, 'desktop-sequence-out-of-order');

  const hb = await requestOk(h, 'heartbeat', { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry });
  await requestOk(h, 'ready', { connectionId: grant.connectionId, generation: grant.generation, geometry: hb.geometry, trackSid: hb.trackSid });

  const sync = await createMobileSyncRuntime(h);
  t.after(() => sync.dispose());
  /** @type {number[]} */
  const mobileTimeouts = [];
  /** @type {number[]} */
  const hostTimeouts = [];
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = /** @type {typeof setTimeout} */ (((/** @type {any} */ fn, /** @type {any} */ ms, /** @type {any[]} */ ...rest) => {
    if (ms === 25_000 || ms === 10_000) mobileTimeouts.push(ms);
    if (ms === 20_000 || ms === 5_000) hostTimeouts.push(ms);
    return origSetTimeout(fn, ms, ...rest);
  }));
  try {
    await sync.desktopRequest('windows', { connectionId: grant.connectionId });
    const next = await sync.desktopRequest('window', {
      connectionId: grant.connectionId,
      generation: grant.generation,
      geometry: hb.geometry,
      sequence: 2,
      mode: 'fill',
      windowId: '1001:5001',
    });
    assert.equal(next.activeWindowId, '1001:5001');
    await sync.desktopRequest('ready', {
      connectionId: grant.connectionId,
      generation: grant.generation,
      geometry: next.geometry,
      trackSid: next.trackSid,
    });
    const inp = await sync.desktopRequest('input', {
      connectionId: grant.connectionId,
      generation: grant.generation,
      geometry: next.geometry,
      sequence: 3,
      input: { action: 'scroll', deltaY: 60, x: 0.5, y: 0.5 },
    });
    assert.equal(inp.accepted, true);
  } finally {
    globalThis.setTimeout = origSetTimeout;
  }
  assert.deepEqual(mobileTimeouts.slice(0, 2), [25_000, 25_000]);
  assert.equal(mobileTimeouts.includes(10_000), true);
  assert.equal(hostTimeouts.includes(20_000), true);
  assert.equal(hostTimeouts.includes(5_000), true);
});

test('[T1-F12-05] DesktopHostProcess parses >32KiB NDJSON window payloads and useRemoteDesktop recovers via heartbeat on desktop-operation-unknown', async t => {
  const h = await createDesktopGatewayHarness(t, { hostConfig: { windowsCount: 120 } });
  const grant = await connectAndConfirmReady(h, 'virtual');
  const data = await requestOk(h, 'windows', { connectionId: grant.connectionId });
  assert.equal(data.windows.length, 120);
  assert.ok(JSON.stringify(data).length > 32_768);

  const hUnknown = await createDesktopGatewayHarness(t, {
    hostConfig: { failOperation: { window: { error: 'desktop-operation-unknown', invalidateFirst: true } } },
  });
  const hook = await mountUseRemoteDesktopRuntime({
    harness: hUnknown,
    autoDecodeFrames: false,
    initialDecodedFrames: 2,
    window: { width: 393, height: 852 },
    insets: { top: 59, bottom: 34, left: 0, right: 0 },
  });
  t.after(() => hook.unmount());
  await hook.call(() => hook.current.selectDisplay('virtual'));
  await hook.call(() => hook.current.connect('virtual', { width: 393, height: 759 }));
  await hook.setDecodedFrames(4, 1080, 2086);
  assert.equal(hook.current.ready, true);
  await hook.setDecodedFrames(0, 1080, 2086);

  const ok = await hook.call(() => hook.current.fillWindow('1002:5002'));
  assert.equal(ok, false);
  assert.equal(hook.current.notice, 'desktop-operation-unknown');
  assert.equal(hook.current.error, null);
  assert.equal(hook.current.ready, false);
  assert.equal(hUnknown.desktop.active?.viewPending, false);
  assert.equal(await hook.call(() => hook.current.input({ action: 'pointer', phase: 'click', x: 0.5, y: 0.5, button: 'left' })), false);
  const rpcs = ((await hUnknown.hostFixture?.getEvents()) ?? []).filter(e => e.type === 'rpc');
  assert.equal(rpcs.filter(e => e.op === 'window').length, 1);
  assert.equal(rpcs.some(e => e.op === 'heartbeat'), true);
});

// ============================================================================
// F13: Mobile Phone Screen Option & 3-Tier Portrait Safe-Area viewport
// ============================================================================

test('[T1-F13-01] DesktopScreen auto-selects Phone Screen in portrait on headless Mac and switches to Phone Screen via display picker on multi-display Mac', async t => {
  const hHeadless = await createDesktopGatewayHarness(t, { hostConfig: { headless: true } });
  const rtHeadless = await mountDesktopScreenRuntime({ harness: hHeadless });
  t.after(() => rtHeadless.unmount());
  assert.equal(rtHeadless.getStackScreenOptions()?.orientation, 'portrait');
  const singleLabel = rtHeadless.findByTestId('desktop-single-display-label');
  assert.notEqual(singleLabel, null);
  assert.equal(singleLabel?.children?.join(''), 'Phone Screen');

  const hMulti = await createDesktopGatewayHarness(t, { hostConfig: { virtualDisplaySupported: true } });
  const rtMulti = await mountDesktopScreenRuntime({ harness: hMulti });
  t.after(() => rtMulti.unmount());
  assert.equal(rtMulti.getStackScreenOptions()?.orientation, 'landscape');
  assert.notEqual(rtMulti.findByTestId('desktop-choose-display'), null);
  await rtMulti.pressTestId('desktop-choose-display');
  assert.notEqual(rtMulti.findByTestId('desktop-display-virtual'), null);
  await rtMulti.pressTestId('desktop-display-virtual');
  assert.equal(rtMulti.getStackScreenOptions()?.orientation, 'portrait');
});

test('[T1-F13-02] Tier 1 live and cached portrait safe-area sends 393x759 on /join and preserves 393x759 across keyboardDidShow and rotation', async t => {
  const h = await createDesktopGatewayHarness(t);
  const rt = await mountRemoteDesktopViewRuntime({
    harness: h,
    window: { width: 393, height: 852 },
    insets: { top: 59, bottom: 34, left: 0, right: 0 },
  });
  t.after(() => rt.unmount());

  await rt.pressTestId('desktop-choose-display');
  await rt.pressTestId('desktop-display-virtual');
  await rt.pressTestId('desktop-connect');

  await rt.emitKeyboard('keyboardDidShow', { endCoordinates: { height: 336, screenY: 516 } });
  await rt.emitKeyboard('keyboardDidHide', { endCoordinates: { height: 0, screenY: 852 } });
  await rt.pressTestId('desktop-more');
  await rt.pressTestId('desktop-display-menu');
  await rt.pressTestId('desktop-display-1');

  await rt.setWindow(852, 393);
  await rt.setInsets({ top: 0, bottom: 21, left: 59, right: 59 });
  await rt.emitKeyboard('keyboardDidShow', { endCoordinates: { height: 220, screenY: 173 } });
  await rt.emitKeyboard('keyboardDidHide', { endCoordinates: { height: 0, screenY: 393 } });
  await rt.pressTestId('desktop-more');
  await rt.pressTestId('desktop-display-menu');
  await rt.pressTestId('desktop-display-virtual');

  const rpcs = ((await h.hostFixture?.getEvents()) ?? []).filter(
    e => e.type === 'rpc' && (e.op === 'start' || e.op === 'display') && e.msg.displayId === 'virtual',
  );
  assert.equal(rpcs.length, 2);
  assert.deepEqual(rpcs[0].msg.viewport, { width: 393, height: 759 });
  assert.deepEqual(rpcs[1].msg.viewport, { width: 393, height: 759 });
});

test('[T1-F13-03] Tier 2 initialWindowMetrics sends 393x759 portrait safe-area on cold landscape mount when switching to Phone Screen', async t => {
  const h = await createDesktopGatewayHarness(t);
  const rt = await mountRemoteDesktopViewRuntime({
    harness: h,
    window: { width: 852, height: 393 },
    insets: { top: 0, bottom: 21, left: 59, right: 59 },
    initialMetrics: {
      frame: { x: 0, y: 0, width: 393, height: 852 },
      insets: { top: 59, bottom: 34, left: 0, right: 0 },
    },
  });
  t.after(() => rt.unmount());

  await rt.pressTestId('desktop-connect');
  await rt.pressTestId('desktop-more');
  await rt.pressTestId('desktop-display-menu');
  await rt.pressTestId('desktop-display-virtual');

  const displayRpc = ((await h.hostFixture?.getEvents()) ?? []).find(
    e => e.type === 'rpc' && e.op === 'display' && e.msg.displayId === 'virtual',
  );
  assert.deepEqual(displayRpc?.msg?.viewport, { width: 393, height: 759 });
});

test('[T1-F13-04] Tier 3 cold landscape fallback without initialMetrics submits iPhone (393x759), iPad (834x1150), and Android (412x843) viewports', async t => {
  const cases = [
    {
      platform: 'ios',
      isPad: false,
      window: { width: 852, height: 393 },
      insets: { top: 0, bottom: 21, left: 59, right: 59 },
      expected: { width: 393, height: 759 },
    },
    {
      platform: 'ios',
      isPad: true,
      window: { width: 1194, height: 834 },
      insets: { top: 24, bottom: 20, left: 0, right: 0 },
      expected: { width: 834, height: 1150 },
    },
    {
      platform: 'android',
      isPad: false,
      window: { width: 915, height: 412 },
      insets: { top: 0, bottom: 24, left: 48, right: 0 },
      expected: { width: 412, height: 843 },
    },
  ];

  for (const c of cases) {
    const h = await createDesktopGatewayHarness(t);
    const rt = await mountRemoteDesktopViewRuntime({
      harness: h,
      platform: c.platform,
      isPad: c.isPad,
      window: c.window,
      insets: c.insets,
      initialMetrics: null,
    });
    t.after(() => rt.unmount());
    await rt.pressTestId('desktop-choose-display');
    await rt.pressTestId('desktop-display-virtual');
    await rt.pressTestId('desktop-connect');
    const startRpc = ((await h.hostFixture?.getEvents()) ?? []).find(
      e => e.type === 'rpc' && e.op === 'start' && e.msg.displayId === 'virtual',
    );
    assert.deepEqual(startRpc?.msg?.viewport, c.expected);
  }
});

test('[T1-F13-05] Mobile connect("virtual") and switchDisplay("virtual") submit exact portrait safe-area viewport to host', async t => {
  const h = await createDesktopGatewayHarness(t);
  const client = createSimulatedMobilePeerClient(h, { window: { width: 393, height: 852 }, insets: { top: 59, bottom: 34, left: 0, right: 0 } });
  await client.refreshDisplays();
  const grant = await mobileConnect(client, 'virtual');
  assert.equal(grant.display.id, 'virtual');
  assert.equal(grant.display.logicalWidth, 540);
  assert.equal(grant.display.logicalHeight, 1043);

  await client.switchDisplay('1');
  client.setViewportMetrics({ window: { width: 852, height: 393 }, insets: { top: 0, bottom: 21, left: 59, right: 59 } });
  const backToVirtual = await client.switchDisplay('virtual');
  assert.equal(backToVirtual.display.id, 'virtual');

  const rpcs = ((await h.hostFixture?.getEvents()) ?? []).filter(e => e.type === 'rpc' && (e.op === 'start' || e.op === 'display') && e.msg.displayId === 'virtual');
  assert.equal(rpcs.length, 2);
  assert.deepEqual(rpcs[0].msg.viewport, { width: 393, height: 759 });
  assert.deepEqual(rpcs[1].msg.viewport, { width: 393, height: 759 });
});

// ============================================================================
// F14: Mobile Dynamic Orientation Lock & Safe-Area / Keyboard Layout
// ============================================================================

test('[T1-F14-01] app.config.js preserves orientation default while mounted DesktopScreen locks landscape on physical and portrait on virtual/disabled/unpaired', async t => {
  const appCfg = await readWorkspaceFile('apps/mobile/app.config.js');
  assert.match(appCfg, /orientation:\s*["']default["']/u);

  const h = await createDesktopGatewayHarness(t);
  const rtDisabled = await mountDesktopScreenRuntime({ harness: h, enabled: false });
  t.after(() => rtDisabled.unmount());
  assert.equal(rtDisabled.getStackScreenOptions()?.orientation, 'portrait');
  const redirects = rtDisabled.findAllByType('Redirect');
  assert.ok(redirects.length >= 1);
  assert.equal(redirects.some(node => node.props?.href === '/settings'), true);

  const rtUnpaired = await mountDesktopScreenRuntime({ harness: h, paired: false });
  t.after(() => rtUnpaired.unmount());
  assert.equal(rtUnpaired.getStackScreenOptions()?.orientation, 'portrait');
  assert.ok(rtUnpaired.findAllByType('CodelyncScanScreen').length >= 1);

  const rtPaired = await mountDesktopScreenRuntime({ harness: h, enabled: true, paired: true, focused: true });
  t.after(() => rtPaired.unmount());
  assert.deepEqual(rtPaired.getStackScreenOptions(), {
    headerShown: false,
    statusBarHidden: true,
    orientation: 'landscape',
    gestureEnabled: false,
    fullScreenGestureEnabled: false,
  });

  await rtPaired.pressTestId('desktop-choose-display');
  await rtPaired.pressTestId('desktop-display-virtual');
  assert.deepEqual(rtPaired.getStackScreenOptions(), {
    headerShown: false,
    statusBarHidden: false,
    orientation: 'portrait',
    gestureEnabled: false,
    fullScreenGestureEnabled: false,
  });
});

test('[T1-F14-02] Mounted DesktopScreen switches display orientation with zero DesktopCanvas remount and restores portrait on exit, unfocus, unpair, and disable', async t => {
  const h = await createDesktopGatewayHarness(t);
  const rt = await mountDesktopScreenRuntime({ harness: h });
  t.after(() => rt.unmount());

  await rt.pressTestId('desktop-connect');
  assert.equal(rt.getStackScreenOptions()?.orientation, 'landscape');
  const canvasRef = rt.findByTestId('remote-desktop-canvas');
  assert.notEqual(canvasRef, null);

  await rt.pressTestId('desktop-more');
  await rt.pressTestId('desktop-display-menu');
  await rt.pressTestId('desktop-display-virtual');
  assert.equal(rt.getStackScreenOptions()?.orientation, 'portrait');
  assert.equal(rt.findByTestId('remote-desktop-canvas'), canvasRef);

  await rt.pressTestId('desktop-more');
  await rt.pressTestId('desktop-display-menu');
  await rt.pressTestId('desktop-display-1');
  assert.equal(rt.getStackScreenOptions()?.orientation, 'landscape');
  assert.equal(rt.findByTestId('remote-desktop-canvas'), canvasRef);

  await rt.setFocused(false);
  assert.equal(rt.getStackScreenOptions()?.orientation, 'portrait');
  assert.equal(rt.getStackScreenOptions()?.statusBarHidden, false);
  await rt.setFocused(true);

  await rt.pressTestId('desktop-connect');
  assert.equal(rt.getStackScreenOptions()?.orientation, 'landscape');
  await rt.pressTestId('desktop-exit');
  await rt.setPaired(false);
  assert.equal(rt.getStackScreenOptions()?.orientation, 'portrait');
  await rt.setPaired(true);
  await rt.setEnabled(false);
  assert.equal(rt.getStackScreenOptions()?.orientation, 'portrait');
});

test('[T1-F14-03] Mounted RemoteDesktopView applies portrait top/bottom safe-area stage insets, >=44pt dock buttons, maxWidth 369, and keyboardInset', async t => {
  const h = await createDesktopGatewayHarness(t);
  const rt = await mountRemoteDesktopViewRuntime({
    harness: h,
    window: { width: 393, height: 852 },
    insets: { top: 59, bottom: 34, left: 0, right: 0 },
  });
  t.after(() => rt.unmount());

  await rt.pressTestId('desktop-choose-display');
  await rt.pressTestId('desktop-display-virtual');
  await rt.pressTestId('desktop-connect');

  const stageClosed = flattenStyle(rt.findByTestId('desktop-video-stage')?.props?.style);
  assert.equal(stageClosed.paddingTop, 59);
  assert.equal(stageClosed.paddingBottom, 34);

  for (const id of ['desktop-exit', 'desktop-windows', 'desktop-keyboard', 'desktop-more']) {
    const btnStyle = flattenStyle(rt.findByTestId(id)?.props?.style);
    assert.ok(btnStyle.width >= 44 && btnStyle.height >= 44, `Expected >=44pt hit target on ${id}`);
  }
  const dockStyle = flattenStyle(rt.findByTestId('desktop-control-dock')?.props?.style);
  assert.equal(dockStyle.maxWidth, 369);

  await rt.pressTestId('desktop-keyboard');
  await rt.emitKeyboard('keyboardDidShow', { endCoordinates: { height: 320, screenY: 532 } });
  const stageOpen = flattenStyle(rt.findByTestId('desktop-video-stage')?.props?.style);
  assert.equal(stageOpen.paddingTop, 59);
  assert.equal(stageOpen.paddingBottom, 0);
  const pageOpen = flattenStyle(rt.findByTestId('remote-desktop-page')?.props?.style);
  assert.equal(pageOpen.paddingBottom, 320);
});

test('[T1-F14-04] Mounted RemoteDesktopView enforces mutually exclusive windows/more/keyboard/immersive overlays with zero Modal usage and viewport focus', async t => {
  const h = await createDesktopGatewayHarness(t);
  const rt = await mountRemoteDesktopViewRuntime({ harness: h });
  t.after(() => rt.unmount());

  await rt.pressTestId('desktop-choose-display');
  await rt.pressTestId('desktop-display-virtual');
  await rt.pressTestId('desktop-connect');

  await rt.pressTestId('desktop-windows');
  assert.notEqual(rt.findByTestId('desktop-windows-panel'), null);
  assert.equal(rt.findByTestId('desktop-more-panel'), null);

  await rt.pressTestId('desktop-more');
  assert.equal(rt.findByTestId('desktop-windows-panel'), null);
  assert.notEqual(rt.findByTestId('desktop-more-panel'), null);

  await rt.pressTestId('desktop-keyboard');
  assert.equal(rt.findByTestId('desktop-more-panel'), null);
  assert.notEqual(rt.findByTestId('desktop-keyboard-panel'), null);

  await rt.pressTestId('desktop-keyboard-close');
  await rt.pressTestId('desktop-more');
  await rt.pressTestId('desktop-hide-controls');
  assert.equal(rt.findByTestId('desktop-control-dock'), null);
  assert.equal(rt.findByTestId('desktop-more-panel'), null);
  assert.notEqual(rt.findByTestId('desktop-restore-controls'), null);
  assert.equal(rt.findAllByType('Modal').length, 0);

  const sync = await createMobileSyncRuntime(h);
  t.after(() => sync.dispose());
  const display = { width: 1080, height: 2086 };
  const prevStage = { width: 393, height: 759 };
  const shrunkStage = { width: 393, height: 459 };
  const target = { x: 0.25, y: 0.85 };
  const focused = sync.desktopViewportFocus(display, prevStage, shrunkStage, { zoom: 1, offset: { x: 0, y: 0 } }, target);
  assert.ok(focused && focused.zoom >= 1 && focused.zoom <= 4);
  const centerMapped = sync.desktopPoint(shrunkStage.width / 2, shrunkStage.height / 2, shrunkStage, display, focused.zoom, focused.offset);
  assert.ok(centerMapped && Math.abs(centerMapped.x - target.x) < 0.001 && Math.abs(centerMapped.y - target.y) < 0.001);
});

test('[T1-F14-05] Mounted RemoteDesktopKeyboard preserves CJK/English drafts across hide/reopen and failed send while clearing on acknowledged send', async t => {
  const [draftMod, focusMod, queueMod] = await Promise.all([
    loadTranspiledMobileModule('apps/mobile/sources/sync/desktopKeyboardDraft.ts'),
    loadTranspiledMobileModule('apps/mobile/sources/sync/desktopViewportFocus.ts'),
    loadTranspiledMobileModule('apps/mobile/sources/sync/desktopInputQueue.ts'),
  ]);
  assert.equal(typeof focusMod.desktopViewportFocus, 'function');
  assert.equal(typeof queueMod.DesktopInputQueue, 'function');
  const submitted = draftMod.desktopTextSubmission({ text: '草稿 draft', revision: 1 });
  assert.equal(draftMod.acknowledgeDesktopText({ text: '草稿 draft 续写', revision: 2 }, submitted, true), ' 续写');

  let shouldAck = false;
  const kb = await mountRemoteDesktopKeyboardRuntime({
    visible: true,
    enabled: true,
    onInput: async () => shouldAck,
  });
  t.after(() => kb.unmount());

  await kb.changeText('草稿 draft');
  assert.equal(kb.findByTestId('desktop-text-input')?.props?.value, '草稿 draft');

  await kb.rerender({ visible: false });
  assert.equal(kb.findByTestId('desktop-keyboard-panel'), null);
  await kb.rerender({ visible: true });
  assert.equal(kb.findByTestId('desktop-text-input')?.props?.value, '草稿 draft');

  await kb.pressType();
  assert.equal(kb.findByTestId('desktop-text-input')?.props?.value, '草稿 draft');

  shouldAck = true;
  await kb.pressType();
  assert.equal(kb.findByTestId('desktop-text-input')?.props?.value, '');
});

// ============================================================================
// F15: Mobile Native 1-Finger Touch Scroll, DesktopInputQueue & Window Picker UI
// ============================================================================

test('[T1-F15-01] Transpiled DesktopInputQueue coalesces adjacent same-sign scrolls within -1200..1200 while preserving initial (x, y) anchor', async () => {
  const { DesktopInputQueue, desktopInputAcknowledged } = await loadTranspiledMobileModule('apps/mobile/sources/sync/desktopInputQueue.ts');
  assert.equal(desktopInputAcknowledged({ accepted: true, sequence: 4 }, 4), true);
  assert.equal(desktopInputAcknowledged({ accepted: true, sequence: 3 }, 4), false);

  /** @type {Value[]} */ const dispatched = [];
  /** @type {(() => void) | null} */ let releaseFirst = null;
  const queue = new DesktopInputQueue(async (/** @type {Value} */ item) => {
    dispatched.push(item);
    if (dispatched.length === 1) await new Promise(resolve => { releaseFirst = /** @type {() => void} */ (resolve); });
  }, () => {});

  const p1 = queue.send({ action: 'pointer', phase: 'click', x: 0.5, y: 0.5, button: 'left' });
  const s1 = queue.send({ action: 'scroll', deltaY: 120, x: 0.2, y: 0.7 });
  const s2 = queue.send({ action: 'scroll', deltaY: 180, x: 0.2, y: 0.85 });
  const s3 = queue.send({ action: 'scroll', deltaY: -90, x: 0.6, y: 0.3 });
  const s4 = queue.send({ action: 'scroll', deltaY: -60, x: 0.6, y: 0.2 });
  if (releaseFirst) /** @type {() => void} */ (releaseFirst)();
  assert.deepEqual(await Promise.all([p1, s1, s2, s3, s4]), [true, false, true, false, true]);
  assert.deepEqual(dispatched.slice(1), [
    { action: 'scroll', deltaY: 300, x: 0.2, y: 0.7 },
    { action: 'scroll', deltaY: -150, x: 0.6, y: 0.3 },
  ]);
});

test('[T1-F15-02] Transpiled remoteDesktopLabels maintains 4-locale parity (en, zh-Hans, zh-Hant, ja) with distinct Traditional Chinese copy and errors', async t => {
  const i18n = await loadRemoteDesktopLabelsRuntime();
  t.after(() => i18n.dispose());

  const locales = ['en', 'zh-Hans', 'zh-Hant', 'ja'];
  const byLocale = Object.fromEntries(locales.map(lang => {
    i18n.setLanguage(lang);
    return [lang, i18n.remoteDesktopLabels()];
  }));
  const enKeys = Object.keys(byLocale.en).sort();
  const phase1And2Keys = [
    'phoneScreen', 'windows', 'restoreWindows', 'windowsLoading', 'windowsEmpty',
    'untitledWindow', 'windowOnPhone', 'windowMinimized', 'virtualDisplayUnavailable',
    'virtualDisplayRequired', 'windowUnavailable', 'windowUnresponsive',
    'restorePersistFailed', 'displayChanged',
  ];
  for (const lang of locales) {
    assert.deepEqual(Object.keys(byLocale[lang]).sort(), enKeys);
    for (const [k, v] of Object.entries(byLocale[lang])) {
      assert.ok(typeof v === 'string' && v.trim().length > 0, `Empty ${lang}.${k}`);
    }
    if (lang !== 'en') {
      for (const k of phase1And2Keys) {
        assert.notEqual(byLocale[lang][k], byLocale.en[k], `English fallback in ${lang}.${k}`);
      }
    }
  }
  const zhDistinctKeys = [...phase1And2Keys, 'inputPermission'];
  for (const k of zhDistinctKeys) {
    assert.notEqual(byLocale['zh-Hant'][k], byLocale['zh-Hans'][k], `zh-Hant must differ from zh-Hans on ${k}`);
    assert.notEqual(byLocale.ja[k], byLocale['zh-Hans'][k]);
    assert.notEqual(byLocale.ja[k], byLocale['zh-Hant'][k]);
  }
  assert.equal(byLocale['zh-Hans'].phoneScreen, '手机竖屏');
  assert.equal(byLocale['zh-Hant'].phoneScreen, '手機直向螢幕');
  assert.equal(byLocale.ja.phoneScreen, 'スマホ縦画面');

  const errorCodes = [
    'desktop-virtual-display-unavailable', 'desktop-virtual-display-required',
    'desktop-accessibility-required', 'desktop-window-unavailable',
    'desktop-window-unresponsive', 'desktop-restore-persist-failed',
    'desktop-view-changed', 'desktop-display-changed', 'desktop-operation-unknown',
  ];
  for (const lang of locales) {
    i18n.setLanguage(lang);
    const unavailable = i18n.remoteDesktopLabels().unavailable;
    const messages = errorCodes.map(code => i18n.remoteDesktopError(code));
    for (const msg of messages) {
      assert.ok(msg.trim().length > 0 && msg !== unavailable);
    }
    assert.equal(new Set(messages).size, errorCodes.length);
  }
  i18n.setLanguage('zh-Hans');
  const zhHansAcc = i18n.remoteDesktopError('desktop-accessibility-required');
  i18n.setLanguage('zh-Hant');
  const zhHantAcc = i18n.remoteDesktopError('desktop-accessibility-required');
  assert.notEqual(zhHantAcc, zhHansAcc);
});

test('[T1-F15-03] Mounted RemoteDesktopView gates canvas taps on decoded video frames and peerNetwork write-fence allows /windows while blocking /window', async t => {
  const peerNet = await loadTranspiledMobileModule('apps/mobile/sources/sync/peerNetwork.ts', {
    tweetnacl: nacl,
    'expo-crypto': { getRandomBytes: (/** @type {number} */ n) => randomBytes(n) },
    '@/encryption/base64': {
      decodeBase64: (/** @type {string} */ s) => Buffer.from(s, 'base64url'),
      encodeBase64: (/** @type {Uint8Array} */ b) => Buffer.from(b).toString('base64url'),
    },
    '@/encryption/openPeerBox': { openPeerBox: (/** @type {Uint8Array} */ c, /** @type {Uint8Array} */ n, /** @type {Uint8Array} */ pk, /** @type {Uint8Array} */ sk) => nacl.box.open(c, n, pk, sk) },
    '@/encryption/decodePeerText': { decodePeerText: (/** @type {Uint8Array} */ b) => new TextDecoder().decode(b) },
    '@/utils/serverOrigin': { isSameServerEndpoint: (/** @type {string} */ a, /** @type {string} */ b) => new URL(a).origin === new URL(b).origin },
    '@/encryption/nativePeerPayload': { decodeNativePeerPayload: () => null, nativePeerPayloadAvailable: () => false },
  });
  const macPair = nacl.box.keyPair(), devPair = nacl.box.keyPair(), origin = 'http://127.0.0.1:19999';
  const peer = {
    id: 'peer-f15', key: Buffer.from(macPair.publicKey).toString('base64url'), channels: [{ kind: 'local', url: origin }],
    device: { publicKey: Buffer.from(devPair.publicKey).toString('base64url'), secretKey: Buffer.from(devPair.secretKey).toString('base64url') },
  };
  peerNet.setPeerRouteWriteFence(peer, null);
  try {
    assert.match(peerNet.peerAuthorization('tok', peer, origin, 'POST', `${origin}/api/peer/desktop/windows`), /^Codelync /u);
    assert.throws(() => peerNet.peerAuthorization('tok', peer, origin, 'POST', `${origin}/api/peer/desktop/window`), (/** @type {Value} */ err) => err?.code === 'preferred-route-unavailable' && err?.effectMayHaveOccurred === false);
  } finally {
    peerNet.setPeerRouteWriteFence(null);
  }

  const h = await createDesktopGatewayHarness(t);
  const rt = await mountRemoteDesktopViewRuntime({
    harness: h,
    initialDecodedFrames: 0,
    autoDecodeFrames: false,
    window: { width: 393, height: 852 },
    insets: { top: 59, bottom: 34, left: 0, right: 0 },
  });
  t.after(() => rt.unmount());

  await rt.pressTestId('desktop-choose-display');
  await rt.pressTestId('desktop-display-virtual');
  await rt.pressTestId('desktop-connect');
  await rt.layoutCanvas(393, 759);

  const responder = rt.findCanvasResponder();
  assert.notEqual(responder, null);
  assert.equal(h.desktop.active?.ready, false);
  await responder?.grant(196.5, 379.5);
  await responder?.release(196.5, 379.5);
  await rt.flush(4);
  const preReadyInputs = ((await h.hostFixture?.getEvents()) ?? []).filter(e => e.type === 'input');
  assert.equal(preReadyInputs.length, 0);

  await rt.setDecodedFrames(2, 1080, 2086);
  const deadline = Date.now() + 2000;
  while (!h.desktop.active?.ready && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 60));
    await rt.flush(2);
  }
  assert.equal(h.desktop.active?.ready, true);

  const readyResponder = rt.findCanvasResponder();
  await readyResponder?.grant(196.5, 379.5);
  await readyResponder?.release(196.5, 379.5);
  await rt.flush(6);
  const postReadyInputs = ((await h.hostFixture?.getEvents()) ?? []).filter(e => e.type === 'rpc' && e.op === 'input');
  assert.equal(postReadyInputs.length, 1);
  assert.equal(postReadyInputs[0].msg.phase, 'click');
});

test('[T1-F15-04] Mounted RemoteDesktopView PanResponder dispatches <=6pt tap click, >6pt anchored scroll, drag/right/zoom modes, and physical pointer move', async t => {
  const sleep = (/** @type {number} */ ms) => new Promise(resolve => setTimeout(resolve, ms));
  const h = await createDesktopGatewayHarness(t);
  const rt = await mountRemoteDesktopViewRuntime({
    harness: h,
    window: { width: 393, height: 852 },
    insets: { top: 59, bottom: 34, left: 0, right: 0 },
  });
  t.after(() => rt.unmount());

  await rt.pressTestId('desktop-choose-display');
  await rt.pressTestId('desktop-display-virtual');
  await rt.pressTestId('desktop-connect');
  await rt.layoutCanvas(393, 759);

  // 1) Tap <= 6pt (hypot(3, 4) === 5 <= 6) -> left click at (0.5, 0.5)
  let responder = rt.findCanvasResponder();
  await responder?.grant(196.5, 379.5);
  await responder?.move(199.5, 383.5, 3, 4);
  await responder?.release(199.5, 383.5, 3, 4);
  await rt.flush(6);

  // 2) 1-finger drag > 6pt (48pt) in pointer mode at 1x on virtual -> scroll deltaY: 48 anchored at initial touch
  await sleep(70);
  responder = rt.findCanvasResponder();
  await responder?.grant(196.5, 200);
  await responder?.move(196.5, 248, 0, 48);
  await responder?.release(196.5, 248, 0, 48);
  await rt.flush(6);

  let inputs = ((await h.hostFixture?.getEvents()) ?? []).filter(e => e.type === 'rpc' && e.op === 'input').map(e => e.msg);
  assert.equal(inputs[0]?.action, 'pointer');
  assert.equal(inputs[0]?.phase, 'click');
  assert.equal(inputs[0]?.button, 'left');
  assert.ok(Math.abs(inputs[0].x - 0.5) < 0.01 && Math.abs(inputs[0].y - 0.5) < 0.01);
  assert.equal(inputs[1]?.action, 'scroll');
  assert.equal(inputs[1]?.deltaY, 48);
  assert.ok(Math.abs(inputs[1].x - 0.5) < 0.01);

  // 3) Drag mode -> pointer down, move, up
  await rt.pressTestId('desktop-more');
  await rt.pressTestId('desktop-drag');
  await rt.pressTestId('desktop-panel-close');
  await sleep(70);
  responder = rt.findCanvasResponder();
  await responder?.grant(196.5, 200);
  await responder?.move(220, 240, 23.5, 40);
  await responder?.release(220, 240, 23.5, 40);
  await rt.flush(6);

  inputs = ((await h.hostFixture?.getEvents()) ?? []).filter(e => e.type === 'rpc' && e.op === 'input').map(e => e.msg);
  assert.deepEqual(inputs.slice(2).map(e => e.phase), ['down', 'move', 'up']);

  // 4) Right-click mode -> button: 'right'
  await rt.pressTestId('desktop-more');
  await rt.pressTestId('desktop-right-click');
  await rt.pressTestId('desktop-panel-close');
  responder = rt.findCanvasResponder();
  await responder?.grant(196.5, 379.5);
  await responder?.release(196.5, 379.5);
  await rt.flush(6);
  inputs = ((await h.hostFixture?.getEvents()) ?? []).filter(e => e.type === 'rpc' && e.op === 'input').map(e => e.msg);
  const rightEvt = inputs[inputs.length - 1];
  assert.equal(rightEvt?.phase, 'click');
  assert.equal(rightEvt?.button, 'right');

  // 5) Zoomed > 1x in pointer mode -> local pan (0 new HTTP /input calls)
  await rt.pressTestId('desktop-more');
  await rt.pressTestId('desktop-pointer');
  await rt.pressTestId('desktop-zoom-in');
  await rt.pressTestId('desktop-panel-close');
  const countBeforeZoomPan = inputs.length;
  await sleep(70);
  responder = rt.findCanvasResponder();
  await responder?.grant(150, 200);
  await responder?.move(190, 250, 40, 50);
  await responder?.release(190, 250, 40, 50);
  await rt.flush(6);
  inputs = ((await h.hostFixture?.getEvents()) ?? []).filter(e => e.type === 'rpc' && e.op === 'input').map(e => e.msg);
  assert.equal(inputs.length, countBeforeZoomPan);

  // 6) Switch to physical '1' at 1x pointer mode -> drag dispatches phase: 'move' (not scroll)
  await rt.pressTestId('desktop-more');
  await rt.pressTestId('desktop-fit');
  await rt.pressTestId('desktop-display-menu');
  await rt.pressTestId('desktop-display-1');
  await rt.layoutCanvas(800, 450);
  await sleep(70);
  responder = rt.findCanvasResponder();
  await responder?.grant(200, 150);
  await responder?.move(260, 190, 60, 40);
  await responder?.release(260, 190, 60, 40);
  await rt.flush(6);
  inputs = ((await h.hostFixture?.getEvents()) ?? []).filter(e => e.type === 'rpc' && e.op === 'input').map(e => e.msg);
  const physEvt = inputs[inputs.length - 1];
  assert.equal(physEvt?.action, 'pointer');
  assert.equal(physEvt?.phase, 'move');
});

test('[T1-F15-05] Mounted RemoteDesktopView window picker fill -> upshift ready fence -> frame decode -> restore lifecycle succeeds end-to-end', async t => {
  const h = await createDesktopGatewayHarness(t, { hostConfig: { windowMinSizes: { '1002:5002': { width: 780, height: 900 } } } });
  const rt = await mountRemoteDesktopViewRuntime({
    harness: h,
    initialDecodedFrames: 2,
    autoDecodeFrames: false,
    window: { width: 393, height: 852 },
    insets: { top: 59, bottom: 34, left: 0, right: 0 },
  });
  t.after(() => rt.unmount());

  await rt.pressTestId('desktop-choose-display');
  await rt.pressTestId('desktop-display-virtual');
  await rt.pressTestId('desktop-connect');
  await rt.layoutCanvas(393, 759);
  assert.equal(h.desktop.active?.ready, true);

  await rt.pressTestId('desktop-windows');
  assert.notEqual(rt.findByTestId('desktop-window-1002:5002'), null);
  await rt.pressTestId('desktop-window-1002:5002');
  assert.equal(h.desktop.status().display.logicalWidth, 780);
  assert.equal(h.desktop.status().display.logicalHeight, 1506);
  assert.equal(h.desktop.active?.ready, false);

  await rt.pressTestId('desktop-panel-close');
  const gatedResponder = rt.findCanvasResponder();
  await gatedResponder?.grant(196.5, 379.5);
  await gatedResponder?.release(196.5, 379.5);
  await rt.flush(4);
  assert.equal(((await h.hostFixture?.getEvents()) ?? []).filter(e => e.type === 'rpc' && e.op === 'input').length, 0);

  await rt.setDecodedFrames(6, 1560, 3012);
  const deadline = Date.now() + 2000;
  while (!h.desktop.active?.ready && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 60));
    await rt.flush(2);
  }
  assert.equal(h.desktop.active?.ready, true);

  await rt.pressTestId('desktop-windows');
  await rt.pressTestId('desktop-windows-restore');
  await rt.setDecodedFrames(8, 1560, 3012);
  const winAfter = await requestOk(h, 'windows', {});
  assert.equal(winAfter.activeWindowId, null);
});

test('[T1-F15-06] Mounted RemoteDesktopView renders Glass desktop-windows-panel from dock icon and Controls menu row and hides Windows on physical display', async t => {
  const h = await createDesktopGatewayHarness(t);
  const rt = await mountRemoteDesktopViewRuntime({ harness: h });
  t.after(() => rt.unmount());

  await rt.pressTestId('desktop-choose-display');
  await rt.pressTestId('desktop-display-virtual');
  await rt.pressTestId('desktop-connect');

  await rt.pressTestId('desktop-windows');
  assert.notEqual(rt.findByTestId('desktop-windows-panel'), null);
  assert.notEqual(rt.findByTestId('desktop-windows-refresh'), null);
  assert.notEqual(rt.findByTestId('desktop-windows-restore'), null);
  assert.notEqual(rt.findByTestId('desktop-window-1001:5001'), null);
  assert.equal(rt.findAllByType('Modal').length, 0);

  await rt.pressTestId('desktop-panel-close');
  assert.equal(rt.findByTestId('desktop-windows-panel'), null);

  await rt.pressTestId('desktop-more');
  assert.notEqual(rt.findByTestId('desktop-windows-menu'), null);
  await rt.pressTestId('desktop-windows-menu');
  assert.notEqual(rt.findByTestId('desktop-windows-panel'), null);

  await rt.pressTestId('desktop-more');
  await rt.pressTestId('desktop-display-menu');
  await rt.pressTestId('desktop-display-1');
  assert.equal(rt.findByTestId('desktop-windows'), null);
  await rt.pressTestId('desktop-more');
  assert.equal(rt.findByTestId('desktop-windows-menu'), null);
});

// ============================================================================
// F16: R4 Non-Intrusion, Session Scope Fence & Release Hygiene
// ============================================================================

test('[T1-F16-01] Full Phone Screen upshift and window fill/restore lifecycle emits zero Cmd+/Cmd-/Cmd= zoom keys and zero session mutations', async t => {
  const kbSrc = await readWorkspaceFile('apps/mobile/sources/components/RemoteDesktopKeyboard.tsx');
  const entries = await getWorkspaceSourceEntries();
  const h = await createDesktopGatewayHarness(t, { hostConfig: { windowMinSizes: { '1002:5002': { width: 740, height: 900 } } } });
  const client = createSimulatedMobilePeerClient(h);
  const grant = await mobileConnect(client, 'virtual');
  await client.videoReady(grant.trackSid);
  const filled = await client.fillWindow('1002:5002');
  await client.videoReady(filled.trackSid);
  await client.sendInput({ action: 'scroll', deltaY: 160, x: 0.5, y: 0.5 });
  await client.sendInput({ action: 'text', text: 'hello' });
  const restored = await client.restoreWindow();
  await client.videoReady(restored.trackSid);
  await client.leave();

  const rpcs = ((await h.hostFixture?.getEvents()) ?? []).filter(e => e.type === 'rpc');
  assert.equal(rpcs.some(e => 'sessionId' in (e.msg ?? {})), false);
  assert.equal(rpcs.some(e => e.op === 'input' && e.msg.action === 'key' && ['+', '-', '='].includes(e.msg.key)), false);
  assert.equal(/⌘\+|⌘-|⌘=/u.test(kbSrc), false);

  const dictZoomRe = /["'](?:\+|-|=|plus|minus|equal|equals)["']\s*:\s*(?:24|27|69|78)\b/iu;
  const directZoomRe = /\b(?:keyCode|virtualKey|code)\s*:\s*(?:24|27|69|78)\b/u;
  for (const [rel, text] of entries.filter(([p]) => p.startsWith('native/remote-desktop/Sources/'))) {
    assert.equal(dictZoomRe.test(text), false, `Forbidden zoom key mapping in ${rel}`);
    assert.equal(directZoomRe.test(text) && text.includes('.maskCommand'), false, `Forbidden Cmd+zoom keycode dispatch in ${rel}`);
  }
});

test('[T1-F16-02] Active runtime contains zero global CGEventTap mouse hijacking and zero UU Remote log/AX sniffing while allowing .cghidEventTap', async () => {
  const entries = await getWorkspaceSourceEntries();
  let sawHidEventTap = false;
  for (const [rel, text] of entries) {
    if (!rel.startsWith('native/remote-desktop/Sources/') && !rel.startsWith('src/') && !rel.startsWith('apps/mobile/sources/') && !rel.startsWith('scripts/')) continue;
    if (text.includes('.cghidEventTap')) sawHidEventTap = true;
    assert.equal(/CGEvent\.tapCreate|CGEventTapCreate|CGEventTapEnable/u.test(text), false, `Forbidden global CGEventTap in ${rel}`);
    assert.equal(/uuremote|netease\.uu/iu.test(text), false, `Forbidden UU Remote sniffing in ${rel}`);
  }
  assert.equal(sawHidEventTap, true);
});

test('[T1-F16-03] Deferred research sources remain excluded from runtime while transpiled desktopRequest + peerNetwork NaCl E2EE round-trips end-to-end', async t => {
  assert.equal(await fileExists('native/MacOSAXControl.swift'), true);
  assert.equal(await fileExists('native/MacOSAXReadOnly.swift'), true);
  assert.equal(await fileExists('src/window-frames.mjs'), true);
  assert.equal(/MacOSAX/u.test(await readWorkspaceFile('native/remote-desktop/Package.swift')), false);

  const entries = await getWorkspaceSourceEntries();
  for (const [rel, text] of entries) {
    if (!rel.startsWith('src/codelync/') && !rel.startsWith('native/remote-desktop/Sources/') && !rel.startsWith('apps/mobile/sources/')) continue;
    assert.equal(/MacOSAXControl|MacOSAXReadOnly|window-frames\.mjs/u.test(text), false, `Unexpected deferred window adapter import in ${rel}`);
  }

  const hostHash = 'a'.repeat(64);
  assert.equal(isCodelyncNativeSource({ app: 'codex', kind: 'window', id: '1001:5001' }), false);
  assert.equal(isCodelyncNativeSource({ app: 'codex', kind: 'session', id: 's1' }, { controlMode: 'window' }), false);
  assert.equal(isCodelyncNativeSource({ app: 'antigravity', kind: 'window', protocol: 'antigravity-connect', runtimeGeneration: 'g1', hostId: `local:antigravity:${hostHash}` }), false);
  assert.equal(isCodelyncNativeSource({ app: 'claude-desktop', kind: 'window', protocol: 'claude-desktop-native', id: '1001:5001', appMode: 'code', nativeCollection: 'claude-code-sessions', runtimeGeneration: 'g1', hostId: `local:claude-desktop:${hostHash}` }), false);

  const h = await createDesktopGatewayHarness(t);
  const sync = await createMobileSyncRuntime(h);
  t.after(() => sync.dispose());

  const grant = await sync.desktopRequest('join', { displayId: 'virtual', viewport: { width: 393, height: 759 } });
  assert.equal(grant.display.id, 'virtual');
  await sync.desktopRequest('ready', { ...sync.desktopBinding(grant), trackSid: grant.trackSid });

  const winList = await sync.desktopRequest('windows', { connectionId: grant.connectionId });
  assert.equal(winList.windows.length, 2);

  const filled = await sync.desktopRequest('window', {
    ...sync.desktopBinding(grant),
    sequence: 1,
    mode: 'fill',
    windowId: '1001:5001',
  });
  assert.equal(filled.activeWindowId, '1001:5001');
  await sync.desktopRequest('ready', {
    connectionId: grant.connectionId,
    generation: grant.generation,
    geometry: filled.geometry,
    trackSid: filled.trackSid,
  });

  const inp = await sync.desktopRequest('input', {
    connectionId: grant.connectionId,
    generation: grant.generation,
    geometry: filled.geometry,
    sequence: 2,
    input: { action: 'scroll', deltaY: 90, x: 0.5, y: 0.5 },
  });
  assert.equal(inp.accepted, true);

  const left = await sync.desktopRequest('leave', {
    connectionId: grant.connectionId,
    generation: grant.generation,
    geometry: filled.geometry,
  });
  assert.equal(left.stopped, true);
});

test('[T1-F16-04] Native host and bridge never force-terminate user desktop apps and preserve CODELYNC DESKTOP STDIN FRAMER markers', async () => {
  const mainSwift = await readWorkspaceFile('native/remote-desktop/Sources/CodelyncDesktopHost/main.swift');
  assert.ok(mainSwift.includes('// BEGIN CODELYNC DESKTOP STDIN FRAMER'));
  assert.ok(mainSwift.includes('// END CODELYNC DESKTOP STDIN FRAMER'));

  const entries = await getWorkspaceSourceEntries();
  for (const [rel, text] of entries) {
    if (!rel.startsWith('native/remote-desktop/Sources/')) continue;
    assert.equal(/\.forceTerminate\s*\(|killall\b/u.test(text), false, `Forbidden user app termination call in ${rel}`);
  }
});

test('[T1-F16-05] verifyNativeRuntimeManifest confirms synchronized SHA-256 hashes for CodelyncDesktopHost and livekit-server', async () => {
  const manifest = await verifyNativeRuntimeManifest();
  assert.equal(manifest.version, 1);
  assert.match(manifest.hashes.CodelyncDesktopHost, /^[a-f0-9]{64}$/u);
  assert.match(manifest.hashes['livekit-server'], /^[a-f0-9]{64}$/u);
});

test('[T1-F16-06] Public source snapshot hygiene passes on specs, harness.mjs, and tier1-feature-coverage.test.mjs with zero path or key leaks', async () => {
  for (const rel of ['spec/codelync-remote-desktop.md', 'spec/codelync-remote-desktop-mobile-experience.md', 'test/e2e-remote-desktop-virtual/harness.mjs', 'test/e2e-remote-desktop-virtual/tier1-feature-coverage.test.mjs']) {
    const report = await checkPublicSourceHygiene(rel);
    assert.equal(report.allowedInPublicSnapshot, true);
    assert.deepEqual(report.leaks, []);
    assert.equal(report.clean, true);
  }
});
