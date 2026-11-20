import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { PEER_RESPONSE_CODEC_HEADER, PEER_RESPONSE_CODEC_VALUE } from '@codelync/wire/peer-codec';
import { isCodelyncNativeSource } from '../../src/codelync/source-scope.mjs';
import {
  REPO_ROOT,
  createDesktopGatewayHarness,
  createSimulatedMobilePeerClient,
  loadTranspiledMobileModule,
  probeNativeHostCli,
  probeNativeHostDaemon,
  inspectNativeHostUndefinedSymbols,
  verifyNativeRuntimeManifest,
  computeSpecPortraitLadder,
  listWorkspaceSourceFiles,
  readWorkspaceFile,
  checkPublicSourceHygiene,
  runNativeHostSwiftTest,
} from './harness.mjs';
import {
  flattenStyle,
  loadRemoteDesktopLabelsRuntime,
  mountDesktopScreenRuntime,
  mountRemoteDesktopViewRuntime,
  mountRemoteDesktopKeyboardRuntime,
} from './mobile-runtime-harness.mjs';

/** @typedef {Record<string, any>} Value */
const execFileAsync = promisify(execFile);

const REMOTE_DESKTOP_SYNC_STUBS = {
  'tweetnacl': nacl,
  'expo-crypto': { getRandomBytes: (/** @type {number} */ size) => new Uint8Array(size) },
  '@/auth/tokenStorage': { TokenStorage: { getCredentials: async () => null } },
  '@/encryption/base64': {
    decodeBase64: (/** @type {string} */ s) => new Uint8Array(Buffer.from(s, 'base64url')),
    encodeBase64: (/** @type {Uint8Array} */ b) => Buffer.from(b).toString('base64url'),
  },
  './peerNetwork': { peerAuthorization: () => '', decodePeerResponse: (/** @type {unknown} */ _p, /** @type {unknown} */ v) => v },
  './serverConfig': { getServerUrl: () => 'http://127.0.0.1' },
};

/** @param {Value} obj */
function hasExtraCaptureDimensionField(obj) {
  return Object.keys(obj).some(k => k.startsWith('capture') && k !== 'capturing');
}

/** @param {Value | null} node @returns {string} */
function collectRenderedText(node) {
  if (!node) return '';
  /** @type {string[]} */
  const parts = [];
  /** @param {unknown} cur */
  const visit = cur => {
    if (typeof cur === 'string' || typeof cur === 'number') {
      parts.push(String(cur));
      return;
    }
    if (!cur || typeof cur !== 'object') return;
    const children = /** @type {Value} */ (cur).children;
    if (Array.isArray(children)) {
      for (const child of children) visit(child);
    }
  };
  visit(node);
  return parts.join(' ');
}

test('[T3-01][F03xF13] Mobile 3-tier portrait viewport shapes -> Bridge -> Host 2x HiDPI mode ladder selection', async t => {
  const harness = await createDesktopGatewayHarness(t);
  assert.ok(harness.hostFixture);

  const swiftLadder = await runNativeHostSwiftTest('RuntimeAndLadderTests/testPortraitModeLadderAcrossEdgeRatiosAndHardwareBounds');
  assert.equal(swiftLadder.ok, true);

  /**
   * @type {Array<{
   *   label: string,
   *   mountOpts: Value,
   *   expectedViewport: { width: number, height: number },
   *   expectedDisplay?: { logicalWidth: number, logicalHeight: number, width: number, height: number },
   * }>}
   */
  const cases = [
    {
      label: 'iPhone portrait safe-area (Tier 1 live portrait)',
      mountOpts: {
        window: { width: 393, height: 852 },
        insets: { top: 59, bottom: 34, left: 0, right: 0 },
        platform: 'ios',
        isPad: false,
      },
      expectedViewport: { width: 393, height: 759 },
      expectedDisplay: { logicalWidth: 540, logicalHeight: 1043, width: 1080, height: 2086 },
    },
    {
      label: 'Standard 2:1 portrait via initialWindowMetrics while rotated landscape (Tier 2)',
      mountOpts: {
        window: { width: 1080, height: 540 },
        insets: { top: 0, bottom: 21, left: 44, right: 44 },
        initialMetrics: {
          frame: { x: 0, y: 0, width: 540, height: 1160 },
          insets: { top: 46, bottom: 34, left: 0, right: 0 },
        },
        platform: 'ios',
        isPad: false,
      },
      expectedViewport: { width: 540, height: 1080 },
      expectedDisplay: { logicalWidth: 540, logicalHeight: 1080, width: 1080, height: 2160 },
    },
    {
      label: 'Square foldable 1:1 boundary stepping baseWidth to 800pt (Tier 3)',
      mountOpts: {
        window: { width: 700, height: 700 },
        insets: { top: 0, bottom: 0, left: 0, right: 0 },
        initialMetrics: null,
        platform: 'android',
        isPad: false,
      },
      expectedViewport: { width: 700, height: 700 },
      expectedDisplay: { logicalWidth: 800, logicalHeight: 800, width: 1600, height: 1600 },
    },
    {
      label: 'Ultra-tall 2.5x ratio ceiling (360x900)',
      mountOpts: {
        window: { width: 360, height: 960 },
        insets: { top: 36, bottom: 24, left: 0, right: 0 },
        initialMetrics: null,
        platform: 'android',
        isPad: false,
      },
      expectedViewport: { width: 360, height: 900 },
      expectedDisplay: { logicalWidth: 540, logicalHeight: 1350, width: 1080, height: 2700 },
    },
  ];

  for (const entry of cases) {
    await harness.hostFixture.clearEvents();
    const rt = await mountDesktopScreenRuntime({ harness, ...entry.mountOpts });
    try {
      await rt.pressTestId('desktop-choose-display');
      await rt.pressTestId('desktop-display-virtual');
      assert.equal(rt.getStackScreenOptions().orientation, 'portrait', `${entry.label}: portrait orientation selected`);

      await rt.pressTestId('desktop-connect');
      assert.ok(rt.findByTestId('remote-desktop-canvas'), `${entry.label}: connected remote-desktop-canvas rendered`);
      assert.equal(rt.getStackScreenOptions().orientation, 'portrait', `${entry.label}: connected portrait orientation`);

      const events = await harness.hostFixture.getEvents();
      const startRpc = events.find((/** @type {Value} */ e) => e.type === 'rpc' && e.op === 'start');
      assert.ok(startRpc, `${entry.label}: host start RPC recorded`);
      assert.deepEqual(startRpc.msg.viewport, entry.expectedViewport, `${entry.label}: Gateway /api/peer/desktop/join viewport`);

      const specLadder = computeSpecPortraitLadder(entry.expectedViewport);
      const liveDisplay = harness.desktop.status().display;
      assert.ok(liveDisplay, `${entry.label}: active display present`);
      assert.equal(liveDisplay.id, 'virtual');
      assert.equal(liveDisplay.kind, 'virtual');
      assert.equal(liveDisplay.logicalWidth, specLadder.baseWidth, entry.label);
      assert.equal(liveDisplay.logicalHeight, specLadder.baseHeight, entry.label);
      assert.equal(liveDisplay.width, specLadder.backingWidth, entry.label);
      assert.equal(liveDisplay.height, specLadder.backingHeight, entry.label);
      assert.equal(liveDisplay.width, (liveDisplay.logicalWidth ?? 0) * 2);
      assert.equal(liveDisplay.height, (liveDisplay.logicalHeight ?? 0) * 2);
      if (entry.expectedDisplay) {
        assert.equal(liveDisplay.logicalWidth, entry.expectedDisplay.logicalWidth, entry.label);
        assert.equal(liveDisplay.logicalHeight, entry.expectedDisplay.logicalHeight, entry.label);
        assert.equal(liveDisplay.width, entry.expectedDisplay.width, entry.label);
        assert.equal(liveDisplay.height, entry.expectedDisplay.height, entry.label);
      }

      await rt.pressTestId('desktop-exit');
    } finally {
      await rt.unmount();
    }
    for (let w = 0; w < 40 && harness.desktop.status().connected; w++) {
      await new Promise(r => setTimeout(r, 15));
    }
    await harness.desktop.run(() => Promise.resolve());
    assert.equal(harness.desktop.status().connected, false);
  }
});

test('[T3-02][F02xF13] Dynamic virtualDisplaySupported toggle (true <-> false) <-> Mobile Phone Screen visibility & fallback', async t => {
  const harness = await createDesktopGatewayHarness(t, { hostConfig: { virtualDisplaySupported: true } });
  assert.ok(harness.hostFixture);
  const client = createSimulatedMobilePeerClient(harness, { selectedDisplayId: 'virtual' });

  const firstInv = await client.refreshDisplays();
  assert.equal(firstInv.virtualDisplaySupported, true);
  assert.equal(client.state.virtualDisplaySupported, true);
  assert.ok(firstInv.displays.some((/** @type {Value} */ d) => d.id === 'virtual' && d.kind === 'virtual'));
  assert.equal(client.screenOptions().orientation, 'portrait');
  assert.equal(client.screenOptions().statusBarHidden, false);

  await harness.hostFixture.updateConfig({ virtualDisplaySupported: false });
  const degradedInv = await client.refreshDisplays();
  assert.equal(degradedInv.virtualDisplaySupported, false);
  assert.equal(client.state.virtualDisplaySupported, false);
  assert.equal(degradedInv.displays.some((/** @type {Value} */ d) => d.id === 'virtual'), false);

  await assert.rejects(() => client.connect('virtual'), (/** @type {Value} */ err) => {
    assert.equal(err.code, 'desktop-virtual-display-unavailable');
    assert.equal(err.status, 409);
    return true;
  });

  const fallbackDisplay = degradedInv.displays[0];
  assert.ok(fallbackDisplay && fallbackDisplay.id === '1');
  client.setViewportMetrics({ selectedDisplayId: fallbackDisplay.id });
  assert.equal(client.screenOptions().orientation, 'landscape');
  assert.equal(client.screenOptions().statusBarHidden, true);

  const physGrant = await client.connect(fallbackDisplay.id);
  assert.ok(physGrant);
  assert.equal(physGrant.display.id, '1');
  assert.equal(client.screenOptions().orientation, 'landscape');
  await client.leave();

  await harness.hostFixture.updateConfig({ virtualDisplaySupported: true });
  const restoredInv = await client.refreshDisplays();
  assert.equal(restoredInv.virtualDisplaySupported, true);
  assert.ok(restoredInv.displays.some((/** @type {Value} */ d) => d.id === 'virtual'));
});

test('[T3-03][F07xF14] Portrait Phone Screen (1080x2200 & upshifted 1560x3178) x Clarity tiers (1280/1920/2560) x portrait orientation & ready re-fencing', async t => {
  const swiftCapture = await runNativeHostSwiftTest('CaptureAndInputTests/testLongEdgeCaptureDimensionsAcrossLandscapePortraitSquareSmallAndOddSizes');
  assert.equal(swiftCapture.ok, true);

  const harness = await createDesktopGatewayHarness(t, {
    hostConfig: { windowMinSizes: { '1002:5002': { width: 775, height: 900 } } },
  });
  assert.ok(harness.hostFixture);
  const client = createSimulatedMobilePeerClient(harness);

  const grant = await client.connect('virtual', { viewport: { width: 540, height: 1100 } });
  assert.ok(grant);
  assert.equal(hasExtraCaptureDimensionField(grant), false);
  assert.equal(grant.display.width, 1080);
  assert.equal(grant.display.height, 2200);
  assert.equal(client.screenOptions().orientation, 'portrait');
  assert.equal(await client.videoReady(grant.trackSid), true);

  let prevTrackSid = grant.trackSid;
  for (const tierWidth of [1280, 1920, 2560]) {
    await harness.hostFixture.clearEvents();
    const view = await client.setQuality({ width: tierWidth, fps: 30 });
    assert.equal(hasExtraCaptureDimensionField(view), false);
    assert.equal(client.screenOptions().orientation, 'portrait');
    assert.equal(client.screenOptions().statusBarHidden, false);
    assert.equal(client.state.ready, false, `Quality ${tierWidth} must re-fence ready`);
    assert.notEqual(view.trackSid, prevTrackSid, `Quality ${tierWidth} must rotate trackSid`);
    prevTrackSid = view.trackSid;

    const blockedRaw = await harness.requestDesktopHttp('input', {
      connectionId: grant.connectionId,
      generation: grant.generation,
      geometry: view.geometry,
      sequence: client.state.sequence + 1,
      input: { action: 'pointer', phase: 'click', x: 0.5, y: 0.5, button: 'left' },
    });
    assert.equal(blockedRaw.ok, false);
    assert.equal(blockedRaw.status, 409);
    assert.equal(blockedRaw.error, 'desktop-not-ready');

    assert.deepEqual(view.quality, { width: tierWidth, fps: 30 });
    assert.deepEqual(harness.desktop.status().quality, { width: tierWidth, fps: 30 });
    assert.equal(view.display.width, 1080);
    assert.equal(view.display.height, 2200);

    const qEvents = await harness.hostFixture.getEvents();
    const qRpc = qEvents.find((/** @type {Value} */ e) => e.type === 'rpc' && e.op === 'quality');
    assert.ok(qRpc);
    assert.deepEqual(qRpc.msg.quality, { width: tierWidth, fps: 30 });
    assert.equal(await client.videoReady(view.trackSid), true);
  }

  const fillRes = await client.fillWindow('1002:5002');
  assert.equal(fillRes.upshifted, true);
  assert.equal(fillRes.display.logicalWidth, 780);
  assert.equal(fillRes.display.logicalHeight, 1589);
  assert.equal(fillRes.display.width, 1560);
  assert.equal(fillRes.display.height, 3178);
  assert.equal(await client.videoReady(fillRes.trackSid), true);

  prevTrackSid = fillRes.trackSid;
  for (const tierWidth of [1280, 1920, 2560]) {
    await harness.hostFixture.clearEvents();
    const view = await client.setQuality({ width: tierWidth, fps: 60 });
    assert.equal(hasExtraCaptureDimensionField(view), false);
    assert.equal(client.screenOptions().orientation, 'portrait');
    assert.equal(client.state.ready, false);
    assert.notEqual(view.trackSid, prevTrackSid);
    prevTrackSid = view.trackSid;
    assert.deepEqual(view.quality, { width: tierWidth, fps: 60 });
    assert.deepEqual(harness.desktop.status().quality, { width: tierWidth, fps: 60 });
    assert.equal(view.display.width, 1560);
    assert.equal(view.display.height, 3178);

    const qEvents = await harness.hostFixture.getEvents();
    const qRpc = qEvents.find((/** @type {Value} */ e) => e.type === 'rpc' && e.op === 'quality');
    assert.ok(qRpc);
    assert.deepEqual(qRpc.msg.quality, { width: tierWidth, fps: 60 });
    assert.equal(await client.videoReady(view.trackSid), true);
  }
  await client.leave();
});

test('[T3-04][F08xF15] Mobile 1-finger touch scroll + real DesktopInputQueue coalescing -> Bridge (x, y) validation -> Host location anchor', async t => {
  const harness = await createDesktopGatewayHarness(t);
  assert.ok(harness.hostFixture);
  const queueMod = await loadTranspiledMobileModule('apps/mobile/sources/sync/desktopInputQueue.ts');
  const client = createSimulatedMobilePeerClient(harness);

  const grant = await client.connect('virtual', { viewport: { width: 540, height: 1080 } });
  assert.ok(grant);
  assert.equal(await client.videoReady(grant.trackSid), true);
  await harness.hostFixture.clearEvents();

  /** @type {Value[]} */
  const dispatched = [];
  let releaseFirst = /** @type {(() => void) | null} */ (null);
  const firstGate = new Promise(resolve => { releaseFirst = /** @type {() => void} */ (resolve); });

  let seq = 0;
  const realQueue = new queueMod.DesktopInputQueue(
    async (/** @type {Value} */ input) => {
      const currentSeq = ++seq;
      if (currentSeq === 1) await firstGate;
      const res = await harness.requestDesktopHttp('input', {
        connectionId: grant.connectionId,
        generation: grant.generation,
        geometry: grant.display.geometry,
        sequence: currentSeq,
        input,
      });
      assert.equal(res.ok, true);
      assert.equal(queueMod.desktopInputAcknowledged(res.data, currentSeq), true);
      dispatched.push(input);
    },
    (/** @type {unknown} */ err) => { throw err; },
  );

  const p1 = realQueue.send({ action: 'scroll', deltaY: -40, x: 0.3, y: 0.75 });
  const p2 = realQueue.send({ action: 'scroll', deltaY: -60, x: 0.3, y: 0.75 });
  const p3 = realQueue.send({ action: 'scroll', deltaY: -90, x: 0.85, y: 0.2 });
  releaseFirst?.();
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.equal(r1, true);
  assert.equal(r2, false, 'Intermediate scroll packet coalesced into trailing packet');
  assert.equal(r3, true);
  assert.equal(dispatched.length, 2);
  assert.deepEqual(dispatched[1], { action: 'scroll', deltaY: -150, x: 0.3, y: 0.75 });

  client.setViewportMetrics({ selectedDisplayId: 'virtual' });
  const badPartial = await harness.requestDesktopHttp('input', {
    connectionId: grant.connectionId,
    generation: grant.generation,
    geometry: grant.display.geometry,
    sequence: seq + 1,
    input: { action: 'scroll', deltaY: -25, x: 0.3 },
  });
  assert.equal(badPartial.ok, false);
  assert.equal(badPartial.status, 400);
  assert.equal(badPartial.error, 'invalid-desktop-input');

  const events = await harness.hostFixture.getEvents();
  const scrollEvents = events.filter((/** @type {Value} */ e) => e.type === 'input' && e.action === 'scroll');
  assert.equal(scrollEvents.length, 2);
  assert.deepEqual(scrollEvents[1].cursor, { x: 0.3, y: 0.75 });
  assert.equal(scrollEvents[1].deltaY, -150);

  await client.leave();
});

test('[T3-05][F10xF14xF15] Window fill min-width auto-upshift (540pt -> 780pt) x adoptView display update x desktopViewportFocus & desktopPoint accuracy', async t => {
  const harness = await createDesktopGatewayHarness(t, {
    hostConfig: { windowMinSizes: { '1002:5002': { width: 772, height: 920 } } },
  });
  const focusMod = await loadTranspiledMobileModule('apps/mobile/sources/sync/desktopViewportFocus.ts');
  const syncMod = await loadTranspiledMobileModule('apps/mobile/sources/sync/remoteDesktop.ts', REMOTE_DESKTOP_SYNC_STUBS);
  const client = createSimulatedMobilePeerClient(harness);

  const grant = await client.connect('virtual', { viewport: { width: 540, height: 1100 } });
  assert.ok(grant);
  assert.equal(grant.display.width, 1080);
  assert.equal(grant.display.height, 2200);
  assert.equal(await client.videoReady(grant.trackSid), true);

  const fillRes = await client.fillWindow('1002:5002');
  assert.equal(fillRes.upshifted, true);
  assert.equal(fillRes.display.logicalWidth, 780);
  assert.equal(fillRes.display.logicalHeight, 1589);
  assert.equal(fillRes.display.width, 1560);
  assert.equal(fillRes.display.height, 3178);

  const bridgeDisplay = harness.desktop.status().display;
  assert.ok(bridgeDisplay);
  assert.equal(bridgeDisplay.width, 1560);
  assert.equal(bridgeDisplay.height, 3178);
  assert.equal(client.state.grant?.display.width, 1560);
  assert.equal(client.state.grant?.display.height, 3178);
  assert.equal(await client.videoReady(fillRes.trackSid), true);

  const fullStage = { width: 393, height: 759 };
  const scaleBeforeKb = Math.min(fullStage.width / 1560, fullStage.height / 3178);
  const fittedW = 1560 * scaleBeforeKb;
  const fittedH = 3178 * scaleBeforeKb;
  const tapX = (fullStage.width - fittedW) / 2 + 0.8 * fittedW;
  const tapY = (fullStage.height - fittedH) / 2 + 0.9 * fittedH;

  const tapGesture = await client.touchGesture({ startX: tapX, startY: tapY, moves: [], stageViewport: fullStage });
  assert.equal(tapGesture.kind, 'click');
  assert.ok(tapGesture.point);
  assert.ok(Math.abs(tapGesture.point.x - 0.8) < 1e-6);
  assert.ok(Math.abs(tapGesture.point.y - 0.9) < 1e-6);

  const shrunkStage = { width: 393, height: 759 - 290 };
  const focusedCamera = focusMod.desktopViewportFocus(
    { width: 1560, height: 3178 },
    fullStage,
    shrunkStage,
    { zoom: 1, offset: { x: 0, y: 0 } },
    tapGesture.point,
  );
  assert.ok(focusedCamera);
  assert.ok(focusedCamera.zoom > 1, 'Shrunk portrait stage zooms in to preserve readable glyph scale');

  const centerMapped = syncMod.desktopPoint(
    shrunkStage.width / 2,
    shrunkStage.height / 2,
    shrunkStage,
    { width: 1560, height: 3178 },
    focusedCamera.zoom,
    focusedCamera.offset,
  );
  assert.ok(centerMapped);
  assert.ok(Math.abs(centerMapped.x - 0.8) < 1e-6);
  assert.ok(Math.abs(centerMapped.y - 0.9) < 1e-6);
  await client.leave();
});

test('[T3-06][F05xF06xF11xF14] Switching virtual -> physical 1 -> virtual coordinates orientation, RestoreRecord restore, SCStream stop-before-destroy, and physical mode restore', async t => {
  const harness = await createDesktopGatewayHarness(t, {
    hostConfig: {
      physicalDisplays: [
        { id: '1', name: 'Studio Display', kind: 'physical', width: 5120, height: 2880, logicalWidth: 2560, logicalHeight: 1440, refreshRate: 60, ioModeID: 12, geometry: 'phys-1', drifted: true },
      ],
    },
  });
  assert.ok(harness.hostFixture);
  const client = createSimulatedMobilePeerClient(harness);

  const vGrant = await client.connect('virtual', { viewport: { width: 393, height: 759 } });
  assert.ok(vGrant);
  assert.equal(client.screenOptions().orientation, 'portrait');
  assert.equal(client.screenOptions().statusBarHidden, false);
  assert.equal(await client.videoReady(vGrant.trackSid), true);

  const fillRes = await client.fillWindow('1001:5001');
  assert.equal(fillRes.activeWindowId, '1001:5001');
  const restorePath = join(harness.desktopState, 'window-restore.json');
  const snapPath = join(harness.desktopState, 'display-modes-snapshot.json');
  const savedRestore = JSON.parse(await readFile(restorePath, 'utf8'));
  assert.equal(savedRestore.version, 1);
  assert.equal(savedRestore.records[0].windowId, 5001);
  assert.equal(await client.videoReady(fillRes.trackSid), true);

  await harness.hostFixture.clearEvents();
  const physView = await client.switchDisplay('1');
  assert.equal(physView.display.id, '1');
  assert.equal(client.screenOptions().orientation, 'landscape');
  assert.equal(client.screenOptions().statusBarHidden, true);

  const switchEvents = await harness.hostFixture.getEvents();
  const idxRestoreWin = switchEvents.findIndex((/** @type {Value} */ e) => e.type === 'restore-windows' && e.trigger === 'display-switch');
  const idxStopStream = switchEvents.findIndex((/** @type {Value} */ e) => e.type === 'stop-capture-before-virtual-release');
  const idxReleaseVirt = switchEvents.findIndex((/** @type {Value} */ e) => e.type === 'release-virtual-display');
  const idxRestoreMode = switchEvents.findIndex((/** @type {Value} */ e) => e.type === 'restore-mode' && e.scope === 'permanent');
  assert.ok(idxRestoreWin >= 0, 'Window restored on display switch');
  assert.ok(idxStopStream > idxRestoreWin, 'SCStream stopped after window restore');
  assert.ok(idxReleaseVirt > idxStopStream, 'Virtual display released strictly after SCStream stop');
  assert.ok(idxRestoreMode > idxReleaseVirt, 'Physical display mode restored permanently after virtual release');
  await assert.rejects(stat(restorePath), { code: 'ENOENT' });
  await assert.rejects(stat(snapPath), { code: 'ENOENT' });

  assert.equal(await client.videoReady(physView.trackSid), true);
  const backToVirt = await client.switchDisplay('virtual');
  assert.equal(backToVirt.display.id, 'virtual');
  assert.equal(client.screenOptions().orientation, 'portrait');
  assert.equal(client.screenOptions().statusBarHidden, false);
  await client.leave();
});

test('[T3-07][F12xF15] Concurrent retired DesktopInputQueue failure during in-flight window fill does not drop active session and advances monotonic sequence', async t => {
  const harness = await createDesktopGatewayHarness(t, {
    hostConfig: { failOperation: { input: { hangMs: 70 } } },
  });
  assert.ok(harness.hostFixture);
  const client = createSimulatedMobilePeerClient(harness);

  const grant = await client.connect('virtual');
  assert.ok(grant);
  assert.equal(await client.videoReady(grant.trackSid), true);
  const oldGeometry = grant.display.geometry;

  const inFlightInput = client.sendInput({ action: 'pointer', phase: 'click', x: 0.4, y: 0.4, button: 'left' });
  await new Promise(r => setTimeout(r, 15));
  await harness.hostFixture.updateConfig({ failOperation: {} });

  const fillPromise = client.fillWindow('1001:5001');
  const [firstInputAccepted, fillRes] = await Promise.all([inFlightInput, fillPromise]);
  assert.equal(firstInputAccepted, false, 'Retired queue resolves in-flight input false instead of disconnecting');
  assert.equal(fillRes.activeWindowId, '1001:5001');
  assert.equal(harness.desktop.status().connected, true);

  const staleInput = await harness.requestDesktopHttp('input', {
    connectionId: grant.connectionId,
    generation: grant.generation,
    geometry: oldGeometry,
    sequence: 1,
    input: { action: 'pointer', phase: 'click', x: 0.2, y: 0.2, button: 'left' },
  });
  assert.equal(staleInput.ok, false);
  assert.equal(staleInput.status, 409);
  assert.equal(staleInput.error, 'desktop-view-changed');
  assert.equal(harness.desktop.status().connected, true);

  assert.equal(await client.videoReady(fillRes.trackSid), true);
  const freshAccepted = await client.sendInput({ action: 'pointer', phase: 'click', x: 0.6, y: 0.6, button: 'left' });
  assert.equal(freshAccepted, true);
  assert.equal(client.state.sequence, 3);
  await client.leave();
});

test('[T3-08][F10xF12] Asynchronous host desktop-view-invalidated while viewing filled window fences input & window until heartbeat recoverView + ready', async t => {
  const harness = await createDesktopGatewayHarness(t, {
    hostConfig: { windowMinSizes: { '1002:5002': { width: 755, height: 900 } } },
  });
  assert.ok(harness.hostFixture);
  const client = createSimulatedMobilePeerClient(harness);

  const grant = await client.connect('virtual', { viewport: { width: 540, height: 1080 } });
  assert.ok(grant);
  assert.equal(await client.videoReady(grant.trackSid), true);

  const fillRes = await client.fillWindow('1002:5002');
  assert.equal(fillRes.upshifted, true);
  assert.equal(fillRes.display.logicalWidth, 760);
  assert.equal(fillRes.display.width, 1520);
  assert.equal(await client.videoReady(fillRes.trackSid), true);

  await harness.hostFixture.updateConfig({
    failOperation: { input: { error: 'desktop-view-changed', invalidateFirst: true } },
  });
  await assert.rejects(
    () => client.sendInput({ action: 'pointer', phase: 'click', x: 0.5, y: 0.5, button: 'left' }),
    (/** @type {Value} */ err) => err.code === 'desktop-view-changed',
  );
  await harness.hostFixture.updateConfig({ failOperation: {} });

  const fencedInput = await harness.requestDesktopHttp('input', {
    connectionId: grant.connectionId,
    generation: grant.generation,
    geometry: fillRes.geometry,
    sequence: client.state.sequence + 1,
    input: { action: 'pointer', phase: 'click', x: 0.5, y: 0.5, button: 'left' },
  });
  assert.equal(fencedInput.ok, false);
  assert.equal(fencedInput.status, 409);
  assert.equal(fencedInput.error, 'desktop-view-changed');

  const fencedWin = await harness.requestDesktopHttp('window', {
    connectionId: grant.connectionId,
    generation: grant.generation,
    geometry: fillRes.geometry,
    sequence: client.state.sequence + 1,
    mode: 'restore',
  });
  assert.equal(fencedWin.ok, false);
  assert.equal(fencedWin.status, 409);
  assert.equal(fencedWin.error, 'desktop-view-changed');

  const hb = await client.recoverView();
  assert.ok(hb);
  assert.equal(hb.viewPending, false);
  assert.equal(client.state.grant?.display.width, 1520);
  assert.equal(client.state.grant?.display.logicalWidth, 760);
  assert.equal(await client.videoReady(hb.trackSid), true);

  const recoveredOk = await client.sendInput({ action: 'pointer', phase: 'click', x: 0.5, y: 0.5, button: 'left' });
  assert.equal(recoveredOk, true);
  await client.leave();
});

test('[T3-09][F06xF09xF13] Headless Mac (0 physical monitors) + Phone Screen connect + Window fill + Disconnect safe SCStream retirement & RestoreRecord cleanup', async t => {
  const harness = await createDesktopGatewayHarness(t, { hostConfig: { headless: true } });
  assert.ok(harness.hostFixture);
  const client = createSimulatedMobilePeerClient(harness);

  const inv = await client.refreshDisplays();
  assert.equal(inv.virtualDisplaySupported, true);
  assert.equal(inv.displays.length, 1);
  assert.equal(inv.displays[0].id, 'virtual');
  assert.equal(inv.displays[0].kind, 'virtual');

  const grant = await client.connect('virtual', { viewport: { width: 393, height: 759 } });
  assert.ok(grant);
  assert.equal(client.screenOptions().orientation, 'portrait');
  assert.equal(await client.videoReady(grant.trackSid), true);

  const winList = await client.listWindows();
  assert.ok(winList.windows.length >= 2);

  const fillRes = await client.fillWindow(winList.windows[0].id);
  assert.equal(fillRes.activeWindowId, winList.windows[0].id);
  const restorePath = join(harness.desktopState, 'window-restore.json');
  const st = await stat(restorePath);
  assert.equal(st.mode & 0o777, 0o600);
  assert.equal(await client.videoReady(fillRes.trackSid), true);

  await harness.hostFixture.clearEvents();
  const leaveRes = await client.leave();
  assert.equal(leaveRes.stopped, true);

  const events = await harness.hostFixture.getEvents();
  const idxRestore = events.findIndex((/** @type {Value} */ e) => e.type === 'restore-windows' && e.trigger === 'stop');
  const idxStopStream = events.findIndex((/** @type {Value} */ e) => e.type === 'stop-capture-before-virtual-release');
  const idxReleaseVirt = events.findIndex((/** @type {Value} */ e) => e.type === 'release-virtual-display');
  assert.ok(idxRestore >= 0);
  assert.ok(idxStopStream > idxRestore);
  assert.ok(idxReleaseVirt > idxStopStream);
  await assert.rejects(stat(restorePath), { code: 'ENOENT' });
});

test('[T3-10][F15xF16] 4-locale parity (en, zh-Hans, zh-Hant, ja) x touch target & zero Cmd+/Cmd- non-intrusion across Window Picker & Keyboard', async t => {
  const i18n = await loadRemoteDesktopLabelsRuntime('en');
  try {
    const locales = ['en', 'zh-Hans', 'zh-Hant', 'ja'];
    /** @type {Record<string, Value>} */
    const byLocale = {};
    for (const lang of locales) {
      i18n.setLanguage(lang);
      byLocale[lang] = i18n.remoteDesktopLabels();
    }

    const requiredKeys = [
      'phoneScreen', 'windows', 'restoreWindows', 'windowsLoading', 'windowsEmpty',
      'untitledWindow', 'windowOnPhone', 'windowMinimized', 'virtualDisplayUnavailable',
      'virtualDisplayRequired', 'windowUnavailable', 'windowUnresponsive',
      'restorePersistFailed', 'displayChanged',
    ];
    const distinctChineseErrorCodes = [
      'desktop-virtual-display-unavailable',
      'desktop-virtual-display-required',
      'desktop-accessibility-required',
      'desktop-window-unavailable',
      'desktop-window-unresponsive',
      'desktop-restore-persist-failed',
      'desktop-display-changed',
    ];
    const allErrorCodes = [...distinctChineseErrorCodes, 'desktop-operation-unknown'];

    for (const lang of locales) {
      const dict = byLocale[lang];
      for (const key of requiredKeys) {
        assert.equal(typeof dict[key], 'string', `${lang}.${key} must be string`);
        assert.ok(dict[key].trim().length > 0, `${lang}.${key} must be non-empty`);
        if (lang !== 'en') {
          assert.notEqual(dict[key], byLocale.en[key], `${lang}.${key} must be localized (no English fallback)`);
        }
      }
      for (const code of allErrorCodes) {
        i18n.setLanguage(lang);
        const msg = i18n.remoteDesktopError(code);
        assert.ok(typeof msg === 'string' && msg.trim().length > 0, `${lang} error(${code})`);
        if (lang !== 'en') {
          i18n.setLanguage('en');
          const enMsg = i18n.remoteDesktopError(code);
          assert.notEqual(msg, enMsg, `${lang} error(${code}) must not fall back to English`);
        }
      }
    }

    for (const key of requiredKeys) {
      assert.notEqual(byLocale['zh-Hant'][key], byLocale['zh-Hans'][key], `zh-Hant.${key} must differ from zh-Hans.${key}`);
    }
    for (const code of distinctChineseErrorCodes) {
      i18n.setLanguage('zh-Hans');
      const hansErr = i18n.remoteDesktopError(code);
      i18n.setLanguage('zh-Hant');
      const hantErr = i18n.remoteDesktopError(code);
      assert.notEqual(hantErr, hansErr, `zh-Hant error(${code}) must differ from zh-Hans`);
    }

    i18n.setLanguage('zh-Hant');
    const expectedHantPhone = byLocale['zh-Hant'].phoneScreen;
    const expectedHantUnresponsive = i18n.remoteDesktopError('desktop-window-unresponsive');
    i18n.setLanguage('ja');
    const expectedJaPhone = byLocale.ja.phoneScreen;
    const expectedJaUnresponsive = i18n.remoteDesktopError('desktop-window-unresponsive');

    const harness = await createDesktopGatewayHarness(t, {
      hostConfig: { unresponsiveWindowIds: ['1001:5001'] },
    });
    const rt = await mountRemoteDesktopViewRuntime({ harness, language: 'zh-Hant' });
    try {
      await rt.pressTestId('desktop-choose-display');
      const hantDispBtn = rt.findByTestId('desktop-display-virtual');
      assert.ok(hantDispBtn);
      assert.ok(collectRenderedText(hantDispBtn).includes(expectedHantPhone));
      await rt.pressTestId('desktop-display-virtual');
      await rt.pressTestId('desktop-connect');

      const winDockBtn = rt.findByTestId('desktop-windows');
      assert.ok(winDockBtn);
      const winDockStyle = flattenStyle(winDockBtn.props.style);
      assert.ok(winDockStyle.width >= 44 && winDockStyle.height >= 44, 'Dock icon touch target >= 44x44pt');

      await rt.pressTestId('desktop-windows');
      const winRow = rt.findByTestId('desktop-window-1001:5001');
      assert.ok(winRow);
      assert.equal(winRow.props.accessibilityRole, 'button');
      const winRowStyle = flattenStyle(winRow.props.style);
      assert.ok(winRowStyle.minHeight >= 48, 'Window picker row minHeight >= 48pt');

      await rt.pressTestId('desktop-window-1001:5001');
      await rt.pressTestId('desktop-connection-indicator');
      const hantStatusPanel = rt.findByTestId('desktop-status-panel');
      assert.ok(hantStatusPanel);
      const hantStatusText = collectRenderedText(hantStatusPanel);
      assert.ok(hantStatusText.includes(expectedHantUnresponsive), 'zh-Hant notice rendered in status panel');
      assert.ok(hantStatusText.includes(expectedHantPhone), 'zh-Hant Phone Screen label rendered in status panel');

      await rt.setLanguage('ja');
      const jaStatusPanel = rt.findByTestId('desktop-status-panel');
      assert.ok(jaStatusPanel);
      const jaStatusText = collectRenderedText(jaStatusPanel);
      assert.ok(jaStatusText.includes(expectedJaUnresponsive), 'ja notice rendered in status panel');
      assert.ok(jaStatusText.includes(expectedJaPhone), 'ja Phone Screen label rendered in status panel');

      await rt.pressTestId('desktop-exit');
    } finally {
      await rt.unmount();
    }

    const kb = await mountRemoteDesktopKeyboardRuntime({ visible: true, language: 'ja' });
    try {
      await kb.pressTestId('desktop-keyboard-shortcuts');
      const keyNodes = kb.renderer.root.findAll(
        (/** @type {Value} */ n) => typeof n.type === 'string' && typeof n.props?.testID === 'string' && n.props.testID.startsWith('desktop-key-'),
      );
      assert.ok(keyNodes.length >= 10);
      for (const kNode of keyNodes) {
        assert.equal(/desktop-key-(?:\+|plus|=|equal|-|minus)/iu.test(kNode.props.testID), false, 'Zero zoom shortcut keys in keyboard strip');
      }
    } finally {
      await kb.unmount();
    }

    const keyboardSource = await readWorkspaceFile('apps/mobile/sources/components/RemoteDesktopKeyboard.tsx');
    const viewSource = await readWorkspaceFile('apps/mobile/sources/components/RemoteDesktopView.tsx');
    assert.equal(/⌘[+=]|⌘-|key:\s*['"][+=-]['"]/u.test(keyboardSource), false, 'Zero Cmd+/Cmd- zoom shortcuts in RemoteDesktopKeyboard');
    assert.equal(/⌘[+=]|⌘-/u.test(viewSource), false, 'Zero Cmd+/Cmd- zoom shortcuts in RemoteDesktopView');
  } finally {
    i18n.dispose();
  }
});

test('[T3-11][F03xF04] Dynamic viewport aspect ratio change (16:9 -> 19.5:9 via switchDisplay) x --set-mode subprocess re-selection without zombie virtual display', async t => {
  const harness = await createDesktopGatewayHarness(t);
  assert.ok(harness.hostFixture);
  const client = createSimulatedMobilePeerClient(harness);

  const grant16x9 = await client.connect('virtual', { viewport: { width: 540, height: 960 } });
  assert.ok(grant16x9);
  assert.equal(grant16x9.display.logicalWidth, 540);
  assert.equal(grant16x9.display.logicalHeight, 960);
  assert.equal(grant16x9.display.width, 1080);
  assert.equal(grant16x9.display.height, 1920);
  assert.equal(await client.videoReady(grant16x9.trackSid), true);

  await harness.hostFixture.clearEvents();
  const switched195x9 = await client.switchDisplay('virtual', { viewport: { width: 400, height: 866 } });
  const expectedLadder = computeSpecPortraitLadder({ width: 400, height: 866 });
  assert.equal(switched195x9.display.logicalWidth, expectedLadder.baseWidth);
  assert.equal(switched195x9.display.logicalHeight, expectedLadder.baseHeight);
  assert.equal(switched195x9.display.width, expectedLadder.backingWidth);
  assert.equal(switched195x9.display.height, expectedLadder.backingHeight);

  const events = await harness.hostFixture.getEvents();
  assert.ok(events.some((/** @type {Value} */ e) => e.type === 'apply-settings-in-place' && e.width === expectedLadder.baseWidth && e.height === expectedLadder.baseHeight));
  assert.equal(events.some((/** @type {Value} */ e) => e.type === 'release-virtual-display'), false, 'Ratio change applies settings in-place without releasing/zombifying display');

  await execFileAsync(harness.hostFixture.binaryPath, ['--set-mode', '77', String(expectedLadder.baseWidth), String(expectedLadder.baseHeight)]);
  await assert.rejects(execFileAsync(harness.hostFixture.binaryPath, ['--set-mode', '0', '540', '1080']));
  await client.leave();
});

test('[T3-12][F04xF05] Physical display negative ioModeID (UInt32 bitPattern) snapshot x --restore-mode subprocess execution across mount & teardown', async t => {
  const negativeIoModeId = -2147483640;
  const unsignedBits = String(negativeIoModeId >>> 0);
  assert.equal(unsignedBits, '2147483656');

  const harness = await createDesktopGatewayHarness(t, {
    hostConfig: {
      physicalDisplays: [
        { id: '1', name: 'Primary ProMotion', kind: 'physical', width: 3840, height: 2160, logicalWidth: 1920, logicalHeight: 1080, refreshRate: 120, ioModeID: negativeIoModeId, geometry: 'phys-1', drifted: true },
        { id: '2', name: 'Asleep Side Monitor', kind: 'physical', width: 2560, height: 1440, logicalWidth: 2560, logicalHeight: 1440, refreshRate: 60, ioModeID: -1, geometry: 'phys-2', isAsleep: true, drifted: true },
        { id: '3', name: 'Unplugged HDMI', kind: 'physical', width: 1920, height: 1080, logicalWidth: 1920, logicalHeight: 1080, refreshRate: 60, ioModeID: 4, geometry: 'phys-3', unplugged: true, drifted: true },
      ],
    },
  });
  assert.ok(harness.hostFixture);
  const client = createSimulatedMobilePeerClient(harness);

  const grant = await client.connect('virtual');
  assert.ok(grant);
  assert.equal(await client.videoReady(grant.trackSid), true);

  const snapPath = join(harness.desktopState, 'display-modes-snapshot.json');
  const snapData = JSON.parse(await readFile(snapPath, 'utf8'));
  assert.equal(snapData.displays.length, 2, 'Online displays snapshotted while unplugged display skipped');
  assert.equal(snapData.displays[0].ioModeID, negativeIoModeId);

  const mountEvents = await harness.hostFixture.getEvents();
  assert.ok(mountEvents.some((/** @type {Value} */ e) => e.type === 'restore-mode' && e.id === '1' && e.scope === 'session'));
  assert.ok(mountEvents.some((/** @type {Value} */ e) => e.type === 'defer-asleep-display' && e.id === '2'));
  assert.equal(mountEvents.some((/** @type {Value} */ e) => e.type === 'restore-mode' && e.id === '3'), false);

  await execFileAsync(harness.hostFixture.binaryPath, ['--restore-mode', '1', unsignedBits, '1920', '1080', '3840', '2160', '120.0', 'session']);
  const nativeRestoreProbe = await probeNativeHostCli(['--restore-mode', '0', unsignedBits, '1920', '1080', '3840', '2160', '120.0', 'permanent']);
  assert.equal(nativeRestoreProbe.timedOut, false);
  assert.equal(nativeRestoreProbe.exitCode, 1, 'Real native binary parses UInt32 bitPattern cleanly and exits 1 for displayID=0');

  await client.leave();
  await assert.rejects(stat(snapPath), { code: 'ENOENT' });
});

test('[T3-13][F09xF11] Filling Window A (Terminal) then switching directly to Window B (Xcode) atomically restores Window A before persisting & filling Window B', async t => {
  const harness = await createDesktopGatewayHarness(t, {
    hostConfig: {
      windowsList: [
        { id: '1101:6101', pid: 1101, windowId: 6101, appName: 'Terminal', bundleId: 'com.apple.Terminal', title: 'zsh — codelight', bounds: { x: 48, y: 72, width: 620, height: 480 }, minimized: false, onVirtualDisplay: false },
        { id: '1102:6102', pid: 1102, windowId: 6102, appName: 'Xcode', bundleId: 'com.apple.dt.Xcode', title: 'Codelync.xcodeproj', bounds: { x: 220, y: 96, width: 1280, height: 840 }, minimized: false, onVirtualDisplay: false },
      ],
      windowMinSizes: { '1102:6102': { width: 810, height: 700 } },
    },
  });
  assert.ok(harness.hostFixture);
  const client = createSimulatedMobilePeerClient(harness);

  const grant = await client.connect('virtual');
  assert.ok(grant);
  assert.equal(await client.videoReady(grant.trackSid), true);

  const fillA = await client.fillWindow('1101:6101');
  assert.equal(fillA.activeWindowId, '1101:6101');
  assert.equal(fillA.upshifted, false);
  const restorePath = join(harness.desktopState, 'window-restore.json');
  const savedA = JSON.parse(await readFile(restorePath, 'utf8'));
  assert.equal(savedA.records.length, 1);
  assert.equal(savedA.records[0].windowId, 6101);
  assert.deepEqual(savedA.records[0].originalFrame, { x: 48, y: 72, width: 620, height: 480 });
  assert.equal(await client.videoReady(fillA.trackSid), true);

  await harness.hostFixture.clearEvents();
  const fillB = await client.fillWindow('1102:6102');
  assert.equal(fillB.activeWindowId, '1102:6102');
  assert.equal(fillB.upshifted, true);
  assert.equal(fillB.display.logicalWidth, 810);

  const events = await harness.hostFixture.getEvents();
  const idxRestoreA = events.findIndex((/** @type {Value} */ e) => e.type === 'restore-windows' && e.trigger === 'window-switch');
  const idxFilledB = events.findIndex((/** @type {Value} */ e) => e.type === 'window-filled' && e.windowId === '1102:6102');
  assert.ok(idxRestoreA >= 0, 'Window A restored on direct window switch');
  assert.equal(events[idxRestoreA].records[0].windowId, 6101);
  assert.ok(idxFilledB > idxRestoreA, 'Window A restored strictly before Window B filled');

  const savedB = JSON.parse(await readFile(restorePath, 'utf8'));
  assert.equal(savedB.records.length, 1);
  assert.equal(savedB.records[0].windowId, 6102);
  assert.deepEqual(savedB.records[0].originalFrame, { x: 220, y: 96, width: 1280, height: 840 });
  await client.leave();
});

test('[T3-14][F09xF10xF14] DesktopScreen orientation x session continuity (1 landscape -> virtual portrait -> fill wide minimized/fullscreen window -> 1 landscape -> exit portrait) without canvas remount', async t => {
  const swiftCoord = await runNativeHostSwiftTest('RuntimeAndLadderTests/testCoordinatorSerialFallbackInPlaceUpdateUpshiftAndMinimumLifetime');
  assert.equal(swiftCoord.ok, true);

  const harness = await createDesktopGatewayHarness(t, {
    hostConfig: {
      windowsList: [
        { id: '1001:5001', pid: 1001, windowId: 5001, appName: 'Notes', bundleId: 'com.apple.Notes', title: 'Notes', bounds: { x: 60, y: 60, width: 500, height: 700 }, minimized: false, fullScreen: false, onVirtualDisplay: false },
        { id: '1002:5002', pid: 1002, windowId: 5002, appName: 'Cursor', bundleId: 'com.todesktop.230313mzl4w4u92', title: 'workspace', bounds: { x: 0, y: 0, width: 1440, height: 900 }, minimized: true, fullScreen: true, onVirtualDisplay: false },
      ],
      fillArea: { width: 522, height: 1000 },
      windowMinSizes: { '1002:5002': { width: 630, height: 700 } },
    },
  });

  const rt = await mountDesktopScreenRuntime({
    harness,
    window: { width: 580, height: 800 },
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
  });
  try {
    assert.equal(rt.getStackScreenOptions().orientation, 'landscape');
    await rt.pressTestId('desktop-connect');
    assert.equal(harness.desktop.status().display?.id, '1');
    assert.equal(rt.getStackScreenOptions().orientation, 'landscape');
    assert.equal(rt.getStackScreenOptions().statusBarHidden, true);

    const canvasRef = rt.findByTestId('remote-desktop-canvas');
    assert.ok(canvasRef, 'Initial remote-desktop-canvas mounted');

    await rt.pressTestId('desktop-more');
    await rt.pressTestId('desktop-display-menu');
    await rt.pressTestId('desktop-display-virtual');

    assert.equal(harness.desktop.status().display?.id, 'virtual');
    assert.equal(harness.desktop.status().display?.logicalWidth, 580);
    assert.equal(rt.getStackScreenOptions().orientation, 'portrait');
    assert.equal(rt.getStackScreenOptions().statusBarHidden, false);
    assert.equal(rt.findByTestId('remote-desktop-canvas'), canvasRef, 'Canvas instance preserved across 1 -> virtual switch');

    await rt.pressTestId('desktop-windows');
    await rt.pressTestId('desktop-window-1002:5002');

    assert.equal(rt.findByTestId('desktop-window-1002:5002')?.props?.accessibilityState?.selected, true);
    const hbAfterFill = await harness.requestDesktopHttp('heartbeat', {
      connectionId: harness.desktop.active?.id,
      generation: harness.desktop.active?.generation,
      geometry: harness.desktop.active?.geometry,
    });
    assert.equal(hbAfterFill.ok, true);
    assert.equal(hbAfterFill.data?.activeWindowId, '1002:5002');
    assert.equal(harness.desktop.status().display?.logicalWidth, 700, 'Multiply-before-divide (580 * 630) / 522 === 700 exact');
    assert.equal(harness.desktop.status().display?.width, 1400);

    const restoreData = JSON.parse(await readFile(join(harness.desktopState, 'window-restore.json'), 'utf8'));
    assert.equal(restoreData.records[0].wasMinimized, true);
    assert.equal(restoreData.records[0].wasFullScreen, true);
    assert.equal(rt.findByTestId('remote-desktop-canvas'), canvasRef, 'Canvas instance preserved across window fill upshift');

    await rt.pressTestId('desktop-more');
    await rt.pressTestId('desktop-display-menu');
    await rt.pressTestId('desktop-display-1');

    assert.equal(harness.desktop.status().display?.id, '1');
    const hbAfterSwitch = await harness.requestDesktopHttp('heartbeat', {
      connectionId: harness.desktop.active?.id,
      generation: harness.desktop.active?.generation,
      geometry: harness.desktop.active?.geometry,
    });
    assert.equal(hbAfterSwitch.ok, true);
    assert.equal(hbAfterSwitch.data?.activeWindowId, null);
    assert.equal(rt.findByTestId('desktop-windows'), null);
    assert.equal(rt.getStackScreenOptions().orientation, 'landscape');
    assert.equal(rt.getStackScreenOptions().statusBarHidden, true);
    assert.equal(rt.findByTestId('remote-desktop-canvas'), canvasRef, 'Canvas never remounted during session display switches');

    await rt.pressTestId('desktop-exit');
    assert.equal(rt.getStackScreenOptions().orientation, 'portrait');
    assert.equal(rt.getStackScreenOptions().statusBarHidden, false);
  } finally {
    await rt.unmount();
  }
});

test('[T3-15][F11xF12] --state-dir plumbing from RemoteDesktop -> DesktopHostProcess -> child host x persistFailure (409 desktop-restore-persist-failed) preserving active.ready', async t => {
  const harness = await createDesktopGatewayHarness(t, { hostConfig: { persistFailure: true } });
  assert.ok(harness.hostFixture);
  const client = createSimulatedMobilePeerClient(harness);

  const grant = await client.connect('virtual');
  assert.ok(grant);
  assert.equal(await client.videoReady(grant.trackSid), true);

  const argv = await harness.hostFixture.getArgv();
  assert.ok(argv.includes(`--state-dir=${harness.desktopState}`), 'DesktopHostProcess passes --state-dir=<desktopState>');

  await assert.rejects(() => client.fillWindow('1001:5001'), (/** @type {Value} */ err) => {
    assert.equal(err.code, 'desktop-restore-persist-failed');
    assert.equal(err.status, 409);
    return true;
  });
  await assert.rejects(stat(join(harness.desktopState, 'window-restore.json')), { code: 'ENOENT' });

  const immediateInput = await harness.requestDesktopHttp('input', {
    connectionId: grant.connectionId,
    generation: grant.generation,
    geometry: grant.display.geometry,
    sequence: 2,
    input: { action: 'pointer', phase: 'click', x: 0.5, y: 0.5, button: 'left' },
  });
  assert.ok(immediateInput.ok && immediateInput.data, 'Pre-mutation persist failure restores active.ready === true on Bridge without extra ready round-trip');
  assert.equal(immediateInput.data.accepted, true);
  assert.equal(immediateInput.data.sequence, 2);
  await client.leave();
});

test('[T3-16][F12xF15] Peer route write fence (setWriteFence(true)) allows windows listing while blocking window fill, then unblocking when verified', async t => {
  const harness = await createDesktopGatewayHarness(t);
  assert.ok(harness.hostFixture);
  const peerNetworkSource = await readWorkspaceFile('apps/mobile/sources/sync/peerNetwork.ts');
  assert.match(peerNetworkSource, /windows/u, 'peerNetwork.ts explicitly classifies windows as read-allowed on fenced routes');

  const client = createSimulatedMobilePeerClient(harness);
  const grant = await client.connect('virtual');
  assert.ok(grant);
  assert.equal(await client.videoReady(grant.trackSid), true);

  await harness.hostFixture.clearEvents();
  client.setWriteFence(true);

  const listed = await client.listWindows();
  assert.ok(listed.windows.length >= 2, 'windows enumeration succeeds while write-fenced');
  const hb = await client.recoverView();
  assert.ok(hb, 'heartbeat succeeds while write-fenced');

  await assert.rejects(() => client.fillWindow(listed.windows[0].id), (/** @type {Value} */ err) => {
    assert.equal(err.code, 'preferred-route-unavailable');
    assert.equal(err.effectMayHaveOccurred, false);
    return true;
  });
  const fencedEvents = await harness.hostFixture.getEvents();
  assert.equal(fencedEvents.some((/** @type {Value} */ e) => e.type === 'rpc' && e.op === 'window'), false, 'Zero window RPCs sent while write-fenced');

  client.setWriteFence(false);
  assert.equal(await client.videoReady(client.state.grant?.trackSid ?? grant.trackSid), true);
  const fillRes = await client.fillWindow(listed.windows[0].id);
  assert.equal(fillRes.activeWindowId, listed.windows[0].id);
  await client.leave();
});

test('[T3-17][F07xF10] Clarity tier 1280 active before window fill auto-upshift (540x1080 -> 800x1600 logical / 1600x3200 backing) keeps capture long-edge capped at 1280', async t => {
  const swiftCapture = await runNativeHostSwiftTest('CaptureAndInputTests/testLongEdgeCaptureDimensionsAcrossLandscapePortraitSquareSmallAndOddSizes');
  assert.equal(swiftCapture.ok, true);

  const harness = await createDesktopGatewayHarness(t, {
    hostConfig: { windowMinSizes: { '1002:5002': { width: 795, height: 900 } } },
  });
  assert.ok(harness.hostFixture);
  const client = createSimulatedMobilePeerClient(harness);

  const grant = await client.connect('virtual', {
    quality: { width: 1280, fps: 30 },
    viewport: { width: 540, height: 1080 },
  });
  assert.ok(grant);
  assert.equal(hasExtraCaptureDimensionField(grant), false);
  assert.deepEqual(grant.quality, { width: 1280, fps: 30 });
  assert.deepEqual(harness.desktop.status().quality, { width: 1280, fps: 30 });
  assert.equal(await client.videoReady(grant.trackSid), true);

  const fillRes = await client.fillWindow('1002:5002');
  assert.equal(fillRes.upshifted, true);
  assert.equal(fillRes.display.logicalWidth, 800);
  assert.equal(fillRes.display.logicalHeight, 1600);
  assert.equal(fillRes.display.width, 1600);
  assert.equal(fillRes.display.height, 3200);
  assert.deepEqual(fillRes.quality, { width: 1280, fps: 30 });
  assert.deepEqual(harness.desktop.status().quality, { width: 1280, fps: 30 });
  assert.equal(await client.videoReady(fillRes.trackSid), true);

  await harness.hostFixture.clearEvents();
  const reconfirmedQuality = await client.setQuality({ width: 1280, fps: 30 });
  assert.equal(hasExtraCaptureDimensionField(reconfirmedQuality), false);
  assert.equal(client.state.ready, false);
  assert.deepEqual(reconfirmedQuality.quality, { width: 1280, fps: 30 });
  assert.deepEqual(harness.desktop.status().quality, { width: 1280, fps: 30 });
  assert.equal(reconfirmedQuality.display.width, 1600);
  assert.equal(reconfirmedQuality.display.height, 3200);
  assert.notEqual(reconfirmedQuality.trackSid, fillRes.trackSid);

  const qEvents = await harness.hostFixture.getEvents();
  const qRpc = qEvents.find((/** @type {Value} */ e) => e.type === 'rpc' && e.op === 'quality');
  assert.ok(qRpc);
  assert.deepEqual(qRpc.msg.quality, { width: 1280, fps: 30 });
  assert.equal(await client.videoReady(reconfirmedQuality.trackSid), true);
  await client.leave();
});

test('[T3-18][F01xF12xF16] Spec-locked HTTP error codes & v2/v3 @codelync/wire/peer-codec envelopes match real Gateway/Bridge & R4 session admission fence', async t => {
  const desktopSpec = await readWorkspaceFile('spec/codelync-remote-desktop.md');
  const mobileSpec = await readWorkspaceFile('spec/codelync-remote-desktop-mobile-experience.md');
  for (const token of [
    'invalid-desktop-viewport', 'desktop-virtual-display-unavailable', 'desktop-virtual-display-required',
    'desktop-window-unavailable', 'desktop-window-unresponsive', 'desktop-restore-persist-failed',
    '--set-mode', '--restore-mode', '--state-dir', 'window-restore.json',
  ]) {
    assert.ok(desktopSpec.includes(token), `spec/codelync-remote-desktop.md documents ${token}`);
  }
  assert.ok(mobileSpec.includes('Phone Screen') && mobileSpec.includes('portrait'), 'mobile experience spec documents Phone Screen portrait UX');

  const harness = await createDesktopGatewayHarness(t);

  const rawV3 = await fetch(harness.loopbackBase + '/api/peer/desktop/status', {
    method: 'GET',
    headers: {
      Authorization: harness.authHeader('/api/peer/desktop/status', 'GET'),
      [PEER_RESPONSE_CODEC_HEADER]: PEER_RESPONSE_CODEC_VALUE,
    },
  });
  const jsonV3 = await rawV3.json();
  assert.equal(rawV3.status, 200);
  assert.ok(Array.isArray(jsonV3) && jsonV3[0] === 3, 'v3 compact response envelope');
  assert.equal(harness.unsealGatewayResponse(jsonV3).enabled, true);

  const rawV2 = await fetch(harness.loopbackBase + '/api/peer/desktop/status', {
    method: 'GET',
    headers: { Authorization: harness.authHeader('/api/peer/desktop/status', 'GET') },
  });
  const jsonV2 = /** @type {Value} */ (await rawV2.json());
  assert.equal(rawV2.status, 200);
  assert.equal(Array.isArray(jsonV2), false, 'v2 object response envelope');
  assert.equal(harness.unsealGatewayResponse(jsonV2).enabled, true);

  const badVp = await harness.requestDesktopHttp('join', { displayId: 'virtual', viewport: { width: 800, height: 600 } });
  assert.equal(badVp.status, 400);
  assert.equal(badVp.error, 'invalid-desktop-viewport');

  const unknownRoute = await harness.requestDesktopHttp('nonexistent-route', {});
  assert.equal(unknownRoute.status, 404);
  assert.equal(unknownRoute.error, 'unsupported-peer-route');

  const physJoin = await harness.requestDesktopHttp('join', { displayId: '1' });
  assert.equal(physJoin.ok, true);
  const readyPhys = await harness.requestDesktopHttp('ready', {
    connectionId: physJoin.data?.connectionId,
    generation: physJoin.data?.generation,
    geometry: physJoin.data?.display.geometry,
    trackSid: physJoin.data?.trackSid,
  });
  assert.equal(readyPhys.ok, true);

  const winOnPhys = await harness.requestDesktopHttp('window', {
    connectionId: physJoin.data?.connectionId,
    generation: physJoin.data?.generation,
    geometry: physJoin.data?.display.geometry,
    sequence: 1,
    mode: 'fill',
    windowId: '1001:5001',
  });
  assert.equal(winOnPhys.status, 409);
  assert.equal(winOnPhys.error, 'desktop-virtual-display-required');

  const sealedReplayBody = JSON.stringify(harness.sealDesktopBody('displays', {}));
  const firstDisp = await harness.requestDesktopHttp('displays', {}, { rawBody: sealedReplayBody });
  assert.equal(firstDisp.ok, true);
  const replayedDisp = await harness.requestDesktopHttp('displays', {}, { rawBody: sealedReplayBody });
  assert.equal(replayedDisp.status, 409);
  assert.equal(replayedDisp.error, 'desktop-request-replayed');

  assert.equal(isCodelyncNativeSource({ app: 'codex', kind: 'window', id: '1001:5001' }), false);
  assert.equal(isCodelyncNativeSource({ app: 'antigravity', kind: 'window', id: '1001:5001', protocol: 'antigravity-connect', runtimeGeneration: 'g1', hostId: 'local:antigravity:' + 'a'.repeat(64) }), false);
  assert.equal(isCodelyncNativeSource({ app: 'claude-desktop', kind: 'window', id: '1001:5001', protocol: 'claude-desktop-native', runtimeGeneration: 'g1', hostId: 'local:claude-desktop:' + 'b'.repeat(64), appMode: 'code', nativeCollection: 'claude-code-sessions' }), false);
});

test('[T3-19][F02xF04xF16] Real compiled native/bin/CodelyncDesktopHost 0-arg daemon probe + nm -u dynamic ObjC check + verifyNativeRuntimeManifest + R4 & suite hygiene scan', async () => {
  const e2eFiles = (await readdir(join(REPO_ROOT, 'test/e2e-remote-desktop-virtual')))
    .filter(name => name.endsWith('.mjs'))
    .sort();
  assert.ok(e2eFiles.length >= 6, `Expected >= 6 .mjs files in e2e suite, got ${e2eFiles.length}`);

  const [daemonProbe, setModeProbe, symReport, manifest, allSourceFiles, hygieneReports] = await Promise.all([
    probeNativeHostDaemon([
      { id: 'probe-status', operation: 'status' },
      { id: 'probe-displays', operation: 'displays' },
    ]),
    probeNativeHostCli(['--set-mode', '0', '540', '1080']),
    inspectNativeHostUndefinedSymbols(),
    verifyNativeRuntimeManifest(),
    listWorkspaceSourceFiles(['src', 'native', 'apps/mobile/sources', 'scripts', 'spec']),
    Promise.all(e2eFiles.map(name => checkPublicSourceHygiene(`test/e2e-remote-desktop-virtual/${name}`))),
  ]);

  assert.equal(daemonProbe.timedOut, false);
  assert.equal(daemonProbe.exitCode, 0);
  const statusReply = daemonProbe.replies.find((/** @type {Value} */ r) => r.id === 'probe-status');
  const displaysReply = daemonProbe.replies.find((/** @type {Value} */ r) => r.id === 'probe-displays');
  assert.ok(statusReply?.ok === true);
  assert.equal(statusReply.result.capturing, false);
  assert.ok(displaysReply?.ok === true);
  assert.equal(typeof displaysReply.result.virtualDisplaySupported, 'boolean');

  assert.equal(setModeProbe.timedOut, false);
  assert.equal(setModeProbe.exitCode, 1);

  assert.equal(symReport.hasStaticVirtualDisplaySymbols, false, `Expected zero static CGVirtualDisplay symbols, found: ${symReport.virtualDisplaySymbols.join(', ')}`);
  assert.equal(typeof manifest.hashes.CodelyncDesktopHost, 'string');
  assert.equal(manifest.hashes.CodelyncDesktopHost.length, 64);

  assert.equal(allSourceFiles.some(f => f.endsWith('phone-models.json')), false, 'Zero static phone-models.json files');
  assert.ok(allSourceFiles.includes('native/MacOSAXControl.swift'), 'Historical deferred research file preserved');

  const activeHostAndBridgeFiles = allSourceFiles.filter(f => f.startsWith('native/remote-desktop/') || f.startsWith('src/codelync/'));
  for (const rel of activeHostAndBridgeFiles) {
    const content = await readWorkspaceFile(rel);
    assert.equal(/CGEvent\.tapCreate|CGEventTapCreate|CGEventTapEnable/u.test(content), false, `Zero global CGEventTap in ${rel}`);
  }

  for (const report of hygieneReports) {
    assert.equal(report.allowedInPublicSnapshot, true, `${report.relPath} must be snapshot-eligible`);
    assert.equal(report.leaks.length, 0, `${report.relPath} leaked: ${report.leaks.join(',')}`);
    assert.equal(report.clean, true, `${report.relPath} must have clean === true`);
  }
});

test('[T3-20][F08xF12] High-volume 125-window >32KB windows enumeration followed immediately by window fill + (x, y)-anchored scroll sequence continuity', async t => {
  const harness = await createDesktopGatewayHarness(t, { hostConfig: { windowsCount: 125 } });
  assert.ok(harness.hostFixture);
  const client = createSimulatedMobilePeerClient(harness);

  const grant = await client.connect('virtual');
  assert.ok(grant);
  assert.equal(await client.videoReady(grant.trackSid), true);

  const winRes = await client.listWindows();
  assert.equal(winRes.windows.length, 125);
  assert.ok(Buffer.byteLength(JSON.stringify(winRes), 'utf8') > 32_768, 'NDJSON windows response exceeds 32 KiB');

  const targetWin = winRes.windows[119];
  const fillRes = await client.fillWindow(targetWin.id);
  assert.equal(fillRes.activeWindowId, targetWin.id);
  assert.equal(client.state.sequence, 1);
  assert.equal(await client.videoReady(fillRes.trackSid), true);

  await harness.hostFixture.clearEvents();
  const scrollOk = await client.sendInput({ action: 'scroll', deltaY: -240, x: 0.42, y: 0.68 });
  assert.equal(scrollOk, true);
  assert.equal(client.state.sequence, 2);

  const events = await harness.hostFixture.getEvents();
  const scrollEvt = events.find((/** @type {Value} */ e) => e.type === 'input' && e.action === 'scroll');
  assert.ok(scrollEvt);
  assert.equal(scrollEvt.sequence, 2);
  assert.deepEqual(scrollEvt.cursor, { x: 0.42, y: 0.68 });
  await client.leave();
});

test('[T3-21][F01xF09xF11] Spec RestoreRecord v1 schema x pre-on-virtual window fallback originalFrame x manual restoreWindow() round-trip', async t => {
  const harness = await createDesktopGatewayHarness(t, {
    hostConfig: {
      windowsList: [
        { id: '1501:6501', pid: 1501, windowId: 6501, appName: 'Preview', bundleId: 'com.apple.Preview', title: 'Architecture.pdf', bounds: { x: 2560, y: 24, width: 540, height: 1056 }, minimized: false, onVirtualDisplay: true },
      ],
    },
  });
  assert.ok(harness.hostFixture);
  const client = createSimulatedMobilePeerClient(harness);

  const grant = await client.connect('virtual');
  assert.ok(grant);
  assert.equal(await client.videoReady(grant.trackSid), true);

  const fillRes = await client.fillWindow('1501:6501');
  assert.equal(fillRes.activeWindowId, '1501:6501');
  const restorePath = join(harness.desktopState, 'window-restore.json');
  const onDisk = JSON.parse(await readFile(restorePath, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.records.length, 1);
  assert.deepEqual(onDisk.records[0].originalFrame, { x: 320, y: 130, width: 540, height: 1056 }, 'Window already on virtual display records centered primary-display fallback frame');
  assert.equal(typeof onDisk.records[0].savedAt, 'string');
  assert.equal(await client.videoReady(fillRes.trackSid), true);

  const restored = await client.restoreWindow();
  assert.equal(restored.activeWindowId, null);
  assert.equal(client.state.activeWindowId, null);
  assert.equal(client.state.ready, false, 'Manual restore re-fences ready until fresh frame confirmed');
  await assert.rejects(stat(restorePath), { code: 'ENOENT' });
  assert.equal(await client.videoReady(restored.trackSid), true);
  await client.leave();
});

test('[T3-22][F05xF12xF14] Idle session 15,000ms expiry while window filled on Phone Screen tears down virtual display, restores RestoreRecord, and reconciles physical modes', async t => {
  let clock = Date.now();
  const harness = await createDesktopGatewayHarness(t, {
    now: () => clock,
    hostConfig: {
      physicalDisplays: [
        { id: '1', name: 'Main Display', kind: 'physical', width: 3840, height: 2160, logicalWidth: 1920, logicalHeight: 1080, refreshRate: 60, ioModeID: 7, geometry: 'phys-1', drifted: true },
      ],
    },
  });
  assert.ok(harness.hostFixture);
  const client = createSimulatedMobilePeerClient(harness);

  const grant = await client.connect('virtual');
  assert.ok(grant);
  assert.equal(client.screenOptions().orientation, 'portrait');
  assert.equal(await client.videoReady(grant.trackSid), true);

  const fillRes = await client.fillWindow('1001:5001');
  assert.equal(await client.videoReady(fillRes.trackSid), true);
  const restorePath = join(harness.desktopState, 'window-restore.json');
  await stat(restorePath);

  await harness.hostFixture.clearEvents();
  clock += 16_500;
  for (let i = 0; i < 30 && harness.desktop.status().connected; i++) {
    await new Promise(r => setTimeout(r, 60));
  }
  await harness.desktop.run(() => Promise.resolve());

  assert.equal(harness.desktop.status().connected, false);
  const snapPath = join(harness.desktopState, 'display-modes-snapshot.json');
  await assert.rejects(stat(restorePath), { code: 'ENOENT' });
  await assert.rejects(stat(snapPath), { code: 'ENOENT' });
  const events = await harness.hostFixture.getEvents();
  assert.ok(events.some((/** @type {Value} */ e) => e.type === 'restore-windows' && ['stop', 'SIGTERM', 'startup'].includes(e.trigger)));
  assert.ok(
    events.some((/** @type {Value} */ e) => e.type === 'stop-capture-before-virtual-release')
    || events.some((/** @type {Value} */ e) => e.type === 'restore-windows' && e.trigger === 'startup'),
  );
  assert.ok(
    events.some((/** @type {Value} */ e) => e.type === 'restore-mode' && e.scope === 'permanent')
    || events.some((/** @type {Value} */ e) => e.type === 'startup-display-snapshot-reconcile'),
  );
});
