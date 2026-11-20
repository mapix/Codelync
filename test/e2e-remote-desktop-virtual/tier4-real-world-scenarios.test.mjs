import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { DesktopHostProcess } from '../../src/codelync/desktop-host.mjs';
import {
  createProgrammableHostBinary,
  createDesktopGatewayHarness,
  createSimulatedMobilePeerClient,
  loadTranspiledMobileModule,
  computeSpecPortraitLadder,
  runNativeHostSwiftTest,
} from './harness.mjs';
import {
  flattenStyle,
  loadRemoteDesktopLabelsRuntime,
  mountDesktopScreenRuntime,
  mountRemoteDesktopViewRuntime,
} from './mobile-runtime-harness.mjs';

/** @typedef {Record<string, any>} Value */

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

test('[T4-S01][F02xF03xF04xF08xF09xF10xF11xF12xF13xF14xF15xF16] Commuter Mobile Code Review on Xcode / VS Code via Adaptive Phone Screen', async t => {
  const harness = await createDesktopGatewayHarness(t, {
    hostConfig: {
      physicalDisplays: [
        { id: '1', name: 'Studio Display', kind: 'physical', width: 5120, height: 2880, logicalWidth: 2560, logicalHeight: 1440, refreshRate: 60, ioModeID: 9, geometry: 'phys-1', drifted: true },
      ],
      windowsList: [
        { id: '1001:5001', pid: 1001, windowId: 5001, appName: 'Notes', bundleId: 'com.apple.Notes', title: 'Sprint Checklist', bounds: { x: 80, y: 90, width: 520, height: 760 }, minimized: false, onVirtualDisplay: false },
        { id: '1002:5002', pid: 1002, windowId: 5002, appName: 'Xcode', bundleId: 'com.apple.dt.Xcode', title: 'RemoteDesktopHost.swift — codelight', bounds: { x: 160, y: 60, width: 1440, height: 920 }, minimized: false, onVirtualDisplay: false },
      ],
      windowMinSizes: { '1002:5002': { width: 825, height: 900 } },
    },
  });
  assert.ok(harness.hostFixture);

  const focusMod = await loadTranspiledMobileModule('apps/mobile/sources/sync/desktopViewportFocus.ts');
  const portraitVp = { width: 393, height: 759 };
  const expectedInitial = computeSpecPortraitLadder(portraitVp);
  assert.equal(expectedInitial.baseWidth, 540);
  assert.equal(expectedInitial.baseHeight, 1043);

  const rt = await mountDesktopScreenRuntime({
    harness,
    autoDecodeFrames: false,
    initialDecodedFrames: 0,
    window: { width: 393, height: 852 },
    insets: { top: 59, bottom: 34, left: 0, right: 0 },
    platform: 'ios',
    isPad: false,
  });

  const restorePath = join(harness.desktopState, 'window-restore.json');
  try {
    await rt.pressTestId('desktop-choose-display');
    await rt.pressTestId('desktop-display-virtual');
    assert.equal(rt.getStackScreenOptions().orientation, 'portrait');
    assert.equal(rt.getStackScreenOptions().statusBarHidden, false);

    await harness.hostFixture.clearEvents();
    await rt.pressTestId('desktop-connect');

    const joinEvents = await harness.hostFixture.getEvents();
    const startRpc = joinEvents.find((/** @type {Value} */ e) => e.type === 'rpc' && e.op === 'start');
    assert.ok(startRpc);
    assert.deepEqual(startRpc.msg.viewport, portraitVp);

    const initialDisplay = harness.desktop.status().display;
    assert.ok(initialDisplay);
    assert.equal(initialDisplay.id, 'virtual');
    assert.equal(initialDisplay.logicalWidth, 540);
    assert.equal(initialDisplay.logicalHeight, 1043);
    assert.equal(initialDisplay.width, 1080);
    assert.equal(initialDisplay.height, 2086);

    assert.equal(harness.desktop.active?.ready, false);
    await rt.setDecodedFrames(2, 1080, 2086);
    assert.equal(harness.desktop.active?.ready, true);

    await rt.pressTestId('desktop-windows');
    assert.ok(rt.findByTestId('desktop-window-1001:5001'));
    assert.ok(rt.findByTestId('desktop-window-1002:5002'));

    await rt.pressTestId('desktop-window-1002:5002');
    const upshiftedDisplay = harness.desktop.status().display;
    assert.ok(upshiftedDisplay);
    assert.equal(upshiftedDisplay.logicalWidth, 830);
    assert.equal(upshiftedDisplay.logicalHeight, 1603);
    assert.equal(upshiftedDisplay.width, 1660);
    assert.equal(upshiftedDisplay.height, 3206);
    assert.equal(harness.desktop.active?.ready, false, 'Input stays fenced until decoded frame confirmed on upshifted trackSid');

    const restoreStat = await stat(restorePath);
    assert.equal(restoreStat.mode & 0o777, 0o600);
    const savedRestore = JSON.parse(await readFile(restorePath, 'utf8'));
    assert.deepEqual(savedRestore.records[0].originalFrame, { x: 160, y: 60, width: 1440, height: 920 });

    await rt.setDecodedFrames(2, 1660, 3206);
    assert.equal(harness.desktop.active?.ready, true);

    await rt.pressTestId('desktop-panel-close');
    await rt.layoutCanvas(portraitVp.width, portraitVp.height);
    await harness.hostFixture.clearEvents();

    const responder = rt.findCanvasResponder();
    assert.ok(responder);
    await responder.grant(196, 540);
    await responder.move(196, 460);
    await responder.release(196, 460);

    await responder.grant(220, 620);
    await responder.release(220, 620);

    const gestureEvents = await harness.hostFixture.getEvents();
    const scrollEvt = gestureEvents.find((/** @type {Value} */ e) => e.type === 'input' && e.action === 'scroll');
    assert.ok(scrollEvt, '1-finger vertical pan on Phone Screen dispatches scroll');
    assert.equal(scrollEvt.deltaY, -80);
    const clickEvt = gestureEvents.find((/** @type {Value} */ e) => e.type === 'input' && e.action === 'pointer');
    assert.ok(clickEvt, 'Tap on Phone Screen dispatches pointer click');

    await rt.pressTestId('desktop-keyboard');
    await rt.emitKeyboard('keyboardDidShow', { endCoordinates: { height: 300, screenY: 552 } });
    await rt.layoutCanvas(portraitVp.width, portraitVp.height - 300);

    const kbCamera = focusMod.desktopViewportFocus(
      { width: 1660, height: 3206 },
      portraitVp,
      { width: 393, height: 759 - 300 },
      { zoom: 1, offset: { x: 0, y: 0 } },
      clickEvt.cursor,
    );
    assert.ok(kbCamera && kbCamera.zoom > 1);

    const canvasNode = rt.findByTestId('remote-desktop-canvas');
    assert.ok(canvasNode);
    const videoWrapper = canvasNode.children.find((/** @type {Value} */ c) => typeof c === 'object' && Array.isArray(flattenStyle(c.props?.style).transform));
    assert.ok(videoWrapper);
    const scaleTransform = flattenStyle(videoWrapper.props.style).transform.find((/** @type {Value} */ tItem) => typeof tItem.scale === 'number');
    assert.ok(scaleTransform && scaleTransform.scale > 1, 'Canvas zoomed in when soft keyboard shrunk stage');

    const textInput = rt.findByTestId('desktop-text-input');
    assert.ok(textInput);
    await rt.act(async () => {
      textInput.props.onChangeText('// LGTM: clean non-intrusive window fill');
    });
    await rt.flush();
    await rt.pressTestId('desktop-type');
    await rt.pressTestId('desktop-keyboard-shortcuts');
    await rt.pressTestId('desktop-key-enter-plain');

    const inputRpcs = (await harness.hostFixture.getEvents()).filter((/** @type {Value} */ e) => e.type === 'rpc' && e.op === 'input');
    assert.ok(inputRpcs.some((/** @type {Value} */ e) => e.msg.action === 'text' && e.msg.text === '// LGTM: clean non-intrusive window fill'));
    assert.ok(inputRpcs.some((/** @type {Value} */ e) => e.msg.action === 'key' && e.msg.key === 'enter'));
    for (const pkt of inputRpcs) {
      if (pkt.msg.action === 'key') {
        assert.equal(['+', '=', '-'].includes(pkt.msg.key), false, 'Zero Cmd+/Cmd- zoom keystrokes injected');
      }
    }

    await rt.pressTestId('desktop-keyboard-close');
    await harness.hostFixture.clearEvents();
    await rt.pressTestId('desktop-exit');
    assert.equal(rt.getStackScreenOptions().orientation, 'portrait');
  } finally {
    await rt.unmount();
  }

  for (let w = 0; w < 40 && harness.desktop.status().connected; w++) {
    await new Promise(r => setTimeout(r, 15));
  }
  await harness.desktop.run(() => Promise.resolve());
  assert.equal(harness.desktop.status().connected, false);

  await assert.rejects(stat(restorePath), { code: 'ENOENT' });
  const teardownEvents = await harness.hostFixture.getEvents();
  const idxRestoreWin = teardownEvents.findIndex((/** @type {Value} */ e) => e.type === 'restore-windows' && e.trigger === 'stop');
  const idxStopStream = teardownEvents.findIndex((/** @type {Value} */ e) => e.type === 'stop-capture-before-virtual-release');
  const idxReleaseVirt = teardownEvents.findIndex((/** @type {Value} */ e) => e.type === 'release-virtual-display');
  const idxRestoreMode = teardownEvents.findIndex((/** @type {Value} */ e) => e.type === 'restore-mode' && e.scope === 'permanent');
  assert.ok(idxRestoreWin >= 0);
  assert.ok(idxStopStream > idxRestoreWin);
  assert.ok(idxReleaseVirt > idxStopStream);
  assert.ok(idxRestoreMode > idxReleaseVirt);
});

test('[T4-S02][F03xF05xF06xF09xF10xF11xF12xF13xF14xF15] Landscape Physical Monitor -> Portrait Phone Screen -> Fill Terminal -> Switch to Wide IDE -> Switch Back to Physical Monitor', async t => {
  const harness = await createDesktopGatewayHarness(t, {
    hostConfig: {
      physicalDisplays: [
        { id: '1', name: 'Pro Display XDR', kind: 'physical', width: 6016, height: 3384, logicalWidth: 3008, logicalHeight: 1692, refreshRate: 60, ioModeID: 14, geometry: 'phys-1', drifted: true },
      ],
      windowsList: [
        { id: '2001:7001', pid: 2001, windowId: 7001, appName: 'Terminal', bundleId: 'com.apple.Terminal', title: 'pnpm test', bounds: { x: 40, y: 50, width: 500, height: 640 }, minimized: false, onVirtualDisplay: false },
        { id: '2002:7002', pid: 2002, windowId: 7002, appName: 'Xcode', bundleId: 'com.apple.dt.Xcode', title: 'Codelync.xcworkspace', bounds: { x: 300, y: 80, width: 1600, height: 980 }, minimized: false, onVirtualDisplay: false },
      ],
      windowMinSizes: {
        '2001:7001': { width: 480, height: 360 },
        '2002:7002': { width: 855, height: 740 },
      },
    },
  });
  assert.ok(harness.hostFixture);

  const client = createSimulatedMobilePeerClient(harness, {
    window: { width: 393, height: 852 },
    insets: { top: 59, bottom: 34, left: 0, right: 0 },
    platform: { OS: 'ios', isPad: false },
  });
  await client.refreshDisplays();

  const physGrant = await client.connect('1');
  assert.ok(physGrant);
  assert.equal(physGrant.display.id, '1');
  assert.equal(client.screenOptions().orientation, 'landscape');
  assert.equal(client.screenOptions().statusBarHidden, true);
  assert.equal(await client.videoReady(physGrant.trackSid), true);

  client.setViewportMetrics({
    window: { width: 852, height: 393 },
    insets: { top: 0, bottom: 21, left: 59, right: 59 },
  });
  assert.deepEqual(client.resolvePortraitViewport(), { width: 393, height: 759 }, 'Cached portrait viewport survives landscape lock');

  const virtView = await client.switchDisplay('virtual');
  assert.equal(virtView.display.id, 'virtual');
  assert.equal(virtView.display.logicalWidth, 540);
  assert.equal(client.screenOptions().orientation, 'portrait');
  assert.equal(client.screenOptions().statusBarHidden, false);
  assert.equal(await client.videoReady(virtView.trackSid), true);

  const fillTerm = await client.fillWindow('2001:7001');
  assert.equal(fillTerm.activeWindowId, '2001:7001');
  assert.equal(fillTerm.upshifted, false);
  assert.equal(fillTerm.display.logicalWidth, 540);
  assert.equal(await client.videoReady(fillTerm.trackSid), true);
  assert.equal(await client.sendInput({ action: 'text', text: 'pnpm test' }), true);

  await harness.hostFixture.clearEvents();
  const fillIde = await client.fillWindow('2002:7002');
  assert.equal(fillIde.activeWindowId, '2002:7002');
  assert.equal(fillIde.upshifted, true);
  assert.equal(fillIde.display.logicalWidth, 860);
  assert.equal(await client.videoReady(fillIde.trackSid), true);

  const midEvents = await harness.hostFixture.getEvents();
  const idxTermRestore = midEvents.findIndex((/** @type {Value} */ e) => e.type === 'restore-windows' && e.trigger === 'window-switch');
  const idxIdeFill = midEvents.findIndex((/** @type {Value} */ e) => e.type === 'window-filled' && e.windowId === '2002:7002');
  assert.ok(idxTermRestore >= 0 && idxIdeFill > idxTermRestore, 'Terminal restored before Xcode filled');

  await harness.hostFixture.clearEvents();
  const backToPhys = await client.switchDisplay('1');
  assert.equal(backToPhys.display.id, '1');
  assert.equal(client.screenOptions().orientation, 'landscape');
  assert.equal(client.screenOptions().statusBarHidden, true);

  const switchBackEvents = await harness.hostFixture.getEvents();
  assert.ok(switchBackEvents.some((/** @type {Value} */ e) => e.type === 'restore-windows' && e.trigger === 'display-switch' && e.records[0].windowId === 7002));
  assert.ok(switchBackEvents.some((/** @type {Value} */ e) => e.type === 'stop-capture-before-virtual-release'));
  assert.ok(switchBackEvents.some((/** @type {Value} */ e) => e.type === 'restore-mode' && e.scope === 'permanent'));
  await assert.rejects(stat(join(harness.desktopState, 'window-restore.json')), { code: 'ENOENT' });
  await assert.rejects(stat(join(harness.desktopState, 'display-modes-snapshot.json')), { code: 'ENOENT' });

  assert.equal(await client.videoReady(backToPhys.trackSid), true);
  await client.leave();
});

test('[T4-S03][F03xF07xF08xF12xF14xF15] Portrait Clarity Adaptation on Cellular vs Wi-Fi (1280 -> 1920 -> 2560 Long-Edge) + Chinese/English IME Text + desktopViewportFocus Target Mapping', async t => {
  const swiftCapture = await runNativeHostSwiftTest('CaptureAndInputTests/testLongEdgeCaptureDimensionsAcrossLandscapePortraitSquareSmallAndOddSizes');
  assert.equal(swiftCapture.ok, true);

  const harness = await createDesktopGatewayHarness(t, {
    hostConfig: { windowMinSizes: { '1002:5002': { width: 795, height: 960 } } },
  });
  assert.ok(harness.hostFixture);
  const focusMod = await loadTranspiledMobileModule('apps/mobile/sources/sync/desktopViewportFocus.ts');
  const syncMod = await loadTranspiledMobileModule('apps/mobile/sources/sync/remoteDesktop.ts', REMOTE_DESKTOP_SYNC_STUBS);
  const draftMod = await loadTranspiledMobileModule('apps/mobile/sources/sync/desktopKeyboardDraft.ts');

  const client = createSimulatedMobilePeerClient(harness, {
    window: { width: 412, height: 915 },
    insets: { top: 36, bottom: 24, left: 0, right: 0 },
    platform: { OS: 'android', isPad: false },
  });

  const grant = await client.connect('virtual', { viewport: { width: 540, height: 1080 } });
  assert.ok(grant);
  assert.equal(hasExtraCaptureDimensionField(grant), false);
  const initialConnId = grant.connectionId;
  assert.equal(await client.videoReady(grant.trackSid), true);

  const fillRes = await client.fillWindow('1002:5002');
  assert.equal(fillRes.upshifted, true);
  assert.equal(fillRes.display.width, 1600);
  assert.equal(fillRes.display.height, 3200);
  assert.equal(await client.videoReady(fillRes.trackSid), true);

  let prevTrackSid = fillRes.trackSid;
  for (const profile of [{ width: 1280, fps: 15 }, { width: 1920, fps: 30 }, { width: 2560, fps: 60 }]) {
    await harness.hostFixture.clearEvents();
    const qView = await client.setQuality(profile);
    assert.equal(hasExtraCaptureDimensionField(qView), false);
    assert.equal(client.state.grant?.connectionId, initialConnId, 'Connection ID preserved across clarity switches');
    assert.equal(client.screenOptions().orientation, 'portrait');
    assert.deepEqual(qView.quality, profile);
    assert.deepEqual(harness.desktop.status().quality, profile);
    assert.notEqual(qView.trackSid, prevTrackSid);
    prevTrackSid = qView.trackSid;
    assert.equal(qView.display.width, 1600);
    assert.equal(qView.display.height, 3200);

    const qEvents = await harness.hostFixture.getEvents();
    const qRpc = qEvents.find((/** @type {Value} */ e) => e.type === 'rpc' && e.op === 'quality');
    assert.ok(qRpc);
    assert.deepEqual(qRpc.msg.quality, profile);
    assert.equal(await client.videoReady(qView.trackSid), true);
  }

  const stageBeforeIme = { width: 412, height: 855 };
  const fitScale = Math.min(stageBeforeIme.width / 1600, stageBeforeIme.height / 3200);
  const dispW = 1600 * fitScale;
  const dispH = 3200 * fitScale;
  const tapX = (stageBeforeIme.width - dispW) / 2 + 0.85 * dispW;
  const tapY = (stageBeforeIme.height - dispH) / 2 + 0.92 * dispH;

  const tapField = await client.touchGesture({ startX: tapX, startY: tapY, moves: [], stageViewport: stageBeforeIme });
  assert.equal(tapField.kind, 'click');
  assert.ok(tapField.point);

  const stageDuringIme = { width: 412, height: 855 - 310 };
  const focused = focusMod.desktopViewportFocus(
    { width: 1600, height: 3200 },
    stageBeforeIme,
    stageDuringIme,
    { zoom: 1, offset: { x: 0, y: 0 } },
    tapField.point,
  );
  assert.ok(focused);
  const mappedCenter = syncMod.desktopPoint(
    stageDuringIme.width / 2,
    stageDuringIme.height / 2,
    stageDuringIme,
    { width: 1600, height: 3200 },
    focused.zoom,
    focused.offset,
  );
  assert.ok(mappedCenter);
  assert.ok(Math.abs(mappedCenter.x - 0.85) < 1e-5);
  assert.ok(Math.abs(mappedCenter.y - 0.92) < 1e-5);

  const imeDraft = { text: '修复竖屏滚动 bug — verified 2560p', revision: 3 };
  const submitted = draftMod.desktopTextSubmission(imeDraft);
  assert.ok(submitted);
  assert.equal(await client.sendInput({ action: 'text', text: submitted.text }), true);
  const remainingDraft = draftMod.acknowledgeDesktopText({ text: submitted.text + ' next', revision: 4 }, submitted, true);
  assert.equal(remainingDraft, ' next', 'Concurrent IME suffix preserved after prefix acknowledgement');
  assert.equal(await client.sendInput({ action: 'key', key: 'enter', modifiers: [] }), true);

  await client.leave();
});

test('[T4-S04][F04xF05xF09xF10xF11xF12] Abrupt Host Crash (SIGKILL) While Running Window Is Filled on Upshifted Phone Screen -> Next Startup Idempotent Crash Recovery', async t => {
  const harness = await createDesktopGatewayHarness(t, {
    hostConfig: {
      physicalDisplays: [
        { id: '1', name: 'Display 1', kind: 'physical', width: 3840, height: 2160, logicalWidth: 1920, logicalHeight: 1080, refreshRate: 60, ioModeID: 5, geometry: 'phys-1', drifted: true },
      ],
      windowMinSizes: { '1002:5002': { width: 775, height: 900 } },
    },
  });
  assert.ok(harness.hostFixture);
  const client = createSimulatedMobilePeerClient(harness);

  const grant = await client.connect('virtual');
  assert.ok(grant);
  assert.equal(await client.videoReady(grant.trackSid), true);
  const fillRes = await client.fillWindow('1002:5002');
  assert.equal(fillRes.upshifted, true);
  assert.equal(await client.videoReady(fillRes.trackSid), true);

  const restorePath = join(harness.desktopState, 'window-restore.json');
  const snapPath = join(harness.desktopState, 'display-modes-snapshot.json');
  assert.equal((await stat(restorePath)).mode & 0o777, 0o600);
  assert.equal((await stat(snapPath)).mode & 0o777, 0o600);

  await harness.hostFixture.clearEvents();
  const liveChild = harness.desktop.host?.child;
  assert.ok(liveChild, 'Expected active child CodelyncDesktopHost process');
  liveChild.kill('SIGKILL');

  for (let i = 0; i < 40 && harness.desktop.status().connected; i++) {
    await new Promise(r => setTimeout(r, 25));
  }
  await harness.desktop.run(() => Promise.resolve());
  assert.equal(harness.desktop.status().connected, false, 'Bridge marks session disconnected after abrupt host SIGKILL');

  const postCrashEvents = await harness.hostFixture.getEvents();
  assert.equal(postCrashEvents.some((/** @type {Value} */ e) => e.type === 'restore-windows' && e.trigger === 'SIGTERM'), false, 'SIGKILL prevented SIGTERM handler');
  assert.ok(postCrashEvents.some((/** @type {Value} */ e) => e.type === 'restore-windows' && e.trigger === 'startup'), 'Respawned host reconciled window-restore.json on startup');
  assert.ok(postCrashEvents.some((/** @type {Value} */ e) => e.type === 'startup-display-snapshot-reconcile'), 'Respawned host reconciled display-modes-snapshot.json on startup');
  await assert.rejects(stat(restorePath), { code: 'ENOENT' });
  await assert.rejects(stat(snapPath), { code: 'ENOENT' });

  // Also verify cold-boot crash recovery + idempotent second startup + corrupt JSON quarantine when both bridge & host died
  const coldDir = await mkdtemp(join(tmpdir(), 'codelync-cold-crash-'));
  t.after(() => rm(coldDir, { recursive: true, force: true }));
  const coldState = join(coldDir, 'desktop');
  await mkdir(coldState, { recursive: true, mode: 0o700 });
  const coldHostFixture = await createProgrammableHostBinary(join(coldDir, 'bin'), {
    windowMinSizes: { '1002:5002': { width: 760, height: 900 } },
  });

  const proc1 = new DesktopHostProcess({ binary: coldHostFixture.binaryPath, state: coldState });
  await proc1.request('start', { connectionId: 'c1', displayId: 'virtual', viewport: { width: 540, height: 1080 }, quality: { width: 1920, fps: 30 } });
  await proc1.request('window', { connectionId: 'c1', geometry: 'virt-540x1080-g2', sequence: 1, mode: 'fill', windowId: '1002:5002' });
  const coldRestorePath = join(coldState, 'window-restore.json');
  const coldSnapPath = join(coldState, 'display-modes-snapshot.json');
  await stat(coldRestorePath);
  await stat(coldSnapPath);

  proc1.child?.kill('SIGKILL');
  await new Promise(r => setTimeout(r, 50));
  await stat(coldRestorePath);
  await stat(coldSnapPath);

  await coldHostFixture.clearEvents();
  const proc2 = new DesktopHostProcess({ binary: coldHostFixture.binaryPath, state: coldState });
  t.after(() => proc2.close());
  const statusAfterColdRecovery = await proc2.request('status');
  assert.equal(statusAfterColdRecovery.connected, false);
  await assert.rejects(stat(coldRestorePath), { code: 'ENOENT' });
  await assert.rejects(stat(coldSnapPath), { code: 'ENOENT' });
  const coldEvents = await coldHostFixture.getEvents();
  assert.equal(coldEvents.filter((/** @type {Value} */ e) => e.type === 'restore-windows' && e.trigger === 'startup').length, 1);

  await proc2.close();
  await coldHostFixture.clearEvents();
  const proc3 = new DesktopHostProcess({ binary: coldHostFixture.binaryPath, state: coldState });
  t.after(() => proc3.close());
  await proc3.request('status');
  const secondBootEvents = await coldHostFixture.getEvents();
  assert.equal(secondBootEvents.some((/** @type {Value} */ e) => e.type === 'restore-windows'), false, 'Second startup is an idempotent no-op');
  await proc3.close();

  await writeFile(coldRestorePath, '{corrupt-partial-write', { mode: 0o600 });
  const proc4 = new DesktopHostProcess({ binary: coldHostFixture.binaryPath, state: coldState });
  t.after(() => proc4.close());
  const statusAfterQuarantine = await proc4.request('status');
  assert.equal(statusAfterQuarantine.capturing, false);
  await assert.rejects(stat(coldRestorePath), { code: 'ENOENT' });
  const coldFiles = await readdir(coldState);
  assert.ok(coldFiles.some(name => name.startsWith('window-restore.json.corrupt-')), 'Corrupt restore file quarantined safely without crash');
});

test('[T4-S05][F10xF12xF14xF15] Network Drop & 503 desktop-operation-unknown Mid-Upshift Window Fill -> Non-Replay Sequence -> Heartbeat recoverView -> ready Unblock', async t => {
  const hostDir = await mkdtemp(join(tmpdir(), 'codelync-s05-host-'));
  t.after(() => rm(hostDir, { recursive: true, force: true }));
  const stateDir = join(hostDir, 'state');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const hostFixture = await createProgrammableHostBinary(join(hostDir, 'bin'), {
    windowMinSizes: { '1002:5002': { width: 755, height: 900 } },
  });

  let dropNextWindowReply = true;
  /** @type {DesktopHostProcess | null} */
  let underlyingProc = null;

  const harness = await createDesktopGatewayHarness(t, {
    hostFactory: () => {
      const proc = new DesktopHostProcess({ binary: hostFixture.binaryPath, state: stateDir });
      underlyingProc = proc;
      const proxy = new EventEmitter();
      proc.on('stopped', () => proxy.emit('stopped'));
      proc.on('view-invalidated', (/** @type {string} */ cid) => proxy.emit('view-invalidated', cid));
      Object.assign(proxy, {
        /** @param {string} op @param {Value} [val] */
        async request(op, val = {}) {
          const res = await proc.request(op, val);
          if (op === 'window' && val.mode === 'fill' && dropNextWindowReply) {
            dropNextWindowReply = false;
            throw Object.assign(new Error('IPC reply lost after host upshift'), { code: 'desktop-operation-unknown' });
          }
          return res;
        },
        interrupt() { proc.interrupt(); },
        close() { return proc.close(); },
      });
      return proxy;
    },
  });
  t.after(async () => { await underlyingProc?.close(); });

  const i18n = await loadRemoteDesktopLabelsRuntime('ja');
  const rt = await mountRemoteDesktopViewRuntime({
    harness,
    language: 'ja',
    autoDecodeFrames: false,
    initialDecodedFrames: 0,
    window: { width: 393, height: 852 },
    insets: { top: 59, bottom: 34, left: 0, right: 0 },
  });

  try {
    await rt.pressTestId('desktop-choose-display');
    await rt.pressTestId('desktop-display-virtual');
    await rt.pressTestId('desktop-connect');

    const initialDisplay = harness.desktop.status().display;
    assert.ok(initialDisplay);
    assert.equal(initialDisplay.logicalWidth, 540);
    assert.equal(initialDisplay.logicalHeight, 1043);
    const preUpshiftGeo = initialDisplay.geometry;

    await rt.setDecodedFrames(2, 1080, 2086);
    assert.equal(harness.desktop.active?.ready, true);
    const activeSnap = {
      connectionId: harness.desktop.active?.id,
      generation: harness.desktop.active?.generation,
    };

    await rt.pressTestId('desktop-windows');
    await rt.pressTestId('desktop-window-1002:5002');

    for (const lang of ['ja', 'zh-Hans', 'zh-Hant', 'en']) {
      i18n.setLanguage(lang);
      const msg = i18n.remoteDesktopError('desktop-operation-unknown');
      assert.ok(typeof msg === 'string' && msg.length > 0);
    }
    i18n.setLanguage('ja');
    const jaUncertain = i18n.remoteDesktopError('desktop-operation-unknown');

    await rt.pressTestId('desktop-connection-indicator');
    const statusPanel = rt.findByTestId('desktop-status-panel');
    assert.ok(statusPanel);
    assert.ok(collectRenderedText(statusPanel).includes(jaUncertain), 'Uncertain operation notice rendered in status panel');
    await rt.pressTestId('desktop-panel-close');

    // Verify sequence 1 is reserved on Bridge and NEVER replayed to the host
    await hostFixture.clearEvents();
    const illegalReplay = await harness.requestDesktopHttp('window', {
      connectionId: activeSnap.connectionId,
      generation: activeSnap.generation,
      geometry: preUpshiftGeo,
      sequence: 1,
      mode: 'fill',
      windowId: '1002:5002',
    });
    assert.equal(illegalReplay.ok, false);
    assert.equal(illegalReplay.status, 409);
    assert.equal(illegalReplay.error, 'desktop-sequence-out-of-order');
    const replayEvents = await hostFixture.getEvents();
    assert.equal(replayEvents.some((/** @type {Value} */ e) => e.type === 'rpc' && e.op === 'window'), false, 'Reserved sequence rejected before host IPC');

    // Verify heartbeat recoverView() already adopted upshifted 760x1468 (1520x2936 backing) display while keeping ready=false
    const adoptedDisplay = harness.desktop.status().display;
    assert.ok(adoptedDisplay);
    assert.equal(adoptedDisplay.logicalWidth, 760);
    assert.equal(adoptedDisplay.logicalHeight, 1468);
    assert.equal(adoptedDisplay.width, 1520);
    assert.equal(adoptedDisplay.height, 2936);
    assert.notEqual(adoptedDisplay.geometry, preUpshiftGeo);
    assert.equal(harness.desktop.active?.ready, false, 'Input stays gated until decoded frame confirmed on upshifted trackSid');

    await rt.setDecodedFrames(2, 1520, 2936);
    assert.equal(harness.desktop.active?.ready, true);

    const indicator = rt.findByTestId('desktop-connection-indicator');
    assert.ok(indicator);
    assert.ok(String(indicator.props.accessibilityLabel).includes(jaUncertain), 'Unconfirmed notice preserved after ready confirmation');

    await rt.layoutCanvas(393, 759);
    await hostFixture.clearEvents();
    const responder = rt.findCanvasResponder();
    assert.ok(responder);
    await responder.grant(196, 500);
    await responder.move(196, 380);
    await responder.release(196, 380);

    const postRecoveryEvents = await hostFixture.getEvents();
    const scrollEvt = postRecoveryEvents.find((/** @type {Value} */ e) => e.type === 'input' && e.action === 'scroll');
    assert.ok(scrollEvt);
    assert.equal(scrollEvt.sequence, 2, 'Next input advances monotonically to sequence 2');

    await rt.pressTestId('desktop-exit');
  } finally {
    await rt.unmount();
    i18n.dispose();
  }
});

test('[T4-S06][F02xF03xF06xF09xF11xF12xF13] Headless Mac Mini Server (0 Physical Monitors) Remote Administration via Virtual Phone Screen', async t => {
  const harness = await createDesktopGatewayHarness(t, {
    hostConfig: {
      headless: true,
      windowsList: [
        { id: '3001:8001', pid: 3001, windowId: 8001, appName: 'Activity Monitor', bundleId: 'com.apple.ActivityMonitor', title: 'codelync-relay — CPU & Memory', bounds: { x: 0, y: 0, width: 700, height: 900 }, minimized: false, onVirtualDisplay: false },
      ],
      windowMinSizes: { '3001:8001': { width: 680, height: 720 } },
    },
  });
  assert.ok(harness.hostFixture);
  const client = createSimulatedMobilePeerClient(harness);

  const inv = await client.refreshDisplays();
  assert.equal(inv.virtualDisplaySupported, true);
  assert.equal(inv.displays.length, 1);
  assert.equal(inv.displays[0].id, 'virtual');

  const grant = await client.connect('virtual', { viewport: { width: 393, height: 759 } });
  assert.ok(grant);
  assert.equal(client.screenOptions().orientation, 'portrait');
  assert.equal(await client.videoReady(grant.trackSid), true);

  const wins = await client.listWindows();
  assert.equal(wins.windows.length, 1);
  const fillRes = await client.fillWindow('3001:8001');
  assert.equal(fillRes.upshifted, true);
  assert.equal(fillRes.display.logicalWidth, 680);
  assert.equal(await client.videoReady(fillRes.trackSid), true);

  const logScroll = await client.touchGesture({
    startX: 196,
    startY: 500,
    moves: [{ x: 196, y: 380 }, { x: 196, y: 260 }],
    stageViewport: { width: 393, height: 759 },
  });
  assert.equal(logScroll.kind, 'scroll');
  assert.equal(await client.sendInput({ action: 'text', text: 'codelync' }), true);

  await harness.hostFixture.clearEvents();
  const leaveRes = await client.leave();
  assert.equal(leaveRes.stopped, true);
  assert.equal(harness.desktop.status().connected, false);

  const events = await harness.hostFixture.getEvents();
  const idxRestore = events.findIndex((/** @type {Value} */ e) => e.type === 'restore-windows' && e.trigger === 'stop');
  const idxStopStream = events.findIndex((/** @type {Value} */ e) => e.type === 'stop-capture-before-virtual-release');
  const idxReleaseVirt = events.findIndex((/** @type {Value} */ e) => e.type === 'release-virtual-display');
  assert.ok(idxRestore >= 0);
  assert.ok(idxStopStream > idxRestore, 'Headless Mac stops SCStream after window restore');
  assert.ok(idxReleaseVirt > idxStopStream, 'Headless Mac stops SCStream strictly before releasing CGVirtualDisplay');
  await assert.rejects(stat(join(harness.desktopState, 'window-restore.json')), { code: 'ENOENT' });
});

test('[T4-S07][F02xF06xF07xF12xF13xF14xF16] Future macOS Private Symbol Deprecation (virtualDisplaySupported: false) Graceful Fallback to Physical-Only Remote Desktop Without Regression', async t => {
  const harness = await createDesktopGatewayHarness(t, {
    hostConfig: {
      virtualDisplaySupported: false,
      physicalDisplays: [
        { id: '1', name: 'Built-in Retina Display', kind: 'physical', width: 3840, height: 2160, logicalWidth: 1920, logicalHeight: 1080, refreshRate: 60, ioModeID: 1, geometry: 'phys-1' },
      ],
    },
  });
  assert.ok(harness.hostFixture);

  const rejectedVirtJoin = await harness.requestDesktopHttp('join', { displayId: 'virtual' });
  assert.equal(rejectedVirtJoin.ok, false);
  assert.equal(rejectedVirtJoin.status, 409);
  assert.equal(rejectedVirtJoin.error, 'desktop-virtual-display-unavailable');

  const rt = await mountDesktopScreenRuntime({
    harness,
    window: { width: 800, height: 450 },
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
  });
  try {
    assert.equal(rt.findByTestId('desktop-choose-display'), null, 'Single physical display hides virtual display picker');
    assert.equal(rt.getStackScreenOptions().orientation, 'landscape');
    assert.equal(rt.getStackScreenOptions().statusBarHidden, true);

    await rt.pressTestId('desktop-connect');
    assert.equal(harness.desktop.status().display?.id, '1');
    assert.equal(rt.findByTestId('desktop-windows'), null, 'Windows picker hidden on physical display');
    assert.equal(rt.getStackScreenOptions().orientation, 'landscape');

    await rt.layoutCanvas(800, 450);
    await harness.hostFixture.clearEvents();
    const responder = rt.findCanvasResponder();
    assert.ok(responder);
    await responder.grant(400, 200);
    await responder.release(400, 200);
    await new Promise(r => setTimeout(r, 65));
    await responder.grant(400, 200);
    await responder.move(460, 240);
    await responder.release(460, 240);

    const physInputEvents = await harness.hostFixture.getEvents();
    assert.ok(physInputEvents.some((/** @type {Value} */ e) => e.type === 'rpc' && e.op === 'input' && e.msg.action === 'pointer' && e.msg.phase === 'click'));
    assert.ok(physInputEvents.some((/** @type {Value} */ e) => e.type === 'rpc' && e.op === 'input' && e.msg.action === 'pointer' && e.msg.phase === 'move'));
    assert.equal(physInputEvents.some((/** @type {Value} */ e) => e.type === 'rpc' && e.op === 'input' && e.msg.action === 'scroll'), false);

    await rt.pressTestId('desktop-more');
    await rt.pressTestId('desktop-settings');
    let prevSid = harness.desktop.active?.trackSid;
    for (const tier of [1280, 1920, 2560]) {
      await harness.hostFixture.clearEvents();
      await rt.pressTestId(`desktop-clarity-${tier}`);
      const statusSnap = harness.desktop.status();
      assert.equal(hasExtraCaptureDimensionField(statusSnap), false);
      assert.deepEqual(statusSnap.quality, { width: tier, fps: 30 });
      assert.equal(statusSnap.display?.width, 3840);
      assert.equal(statusSnap.display?.height, 2160);
      assert.notEqual(harness.desktop.active?.trackSid, prevSid);
      prevSid = harness.desktop.active?.trackSid;

      const qEvents = await harness.hostFixture.getEvents();
      const qRpc = qEvents.find((/** @type {Value} */ e) => e.type === 'rpc' && e.op === 'quality');
      assert.ok(qRpc);
      assert.deepEqual(qRpc.msg.quality, { width: tier, fps: 30 });
    }
    await rt.pressTestId('desktop-panel-close');

    await rt.pressTestId('desktop-keyboard');
    const textInput = rt.findByTestId('desktop-text-input');
    assert.ok(textInput);
    await rt.act(async () => {
      textInput.props.onChangeText('echo physical-fallback-ok');
    });
    await rt.flush();
    await rt.pressTestId('desktop-type');
    await rt.pressTestId('desktop-keyboard-close');

    await rt.pressTestId('desktop-more');
    await rt.pressTestId('desktop-spaces-menu');
    await harness.hostFixture.clearEvents();
    await rt.pressTestId('desktop-space-next');
    const spaceEvents = await harness.hostFixture.getEvents();
    assert.ok(spaceEvents.some((/** @type {Value} */ e) => e.type === 'rpc' && e.op === 'space' && e.msg.kind === 'next'));
    await rt.pressTestId('desktop-panel-close');

    const activeNow = harness.desktop.active;
    assert.ok(activeNow);
    const nextSeq = Number(activeNow.sequence ?? 0) + 1;
    const rejectedWinOnPhys = await harness.requestDesktopHttp('window', {
      connectionId: activeNow.id,
      generation: activeNow.generation,
      geometry: activeNow.display.geometry,
      sequence: nextSeq,
      mode: 'fill',
      windowId: '1001:5001',
    });
    assert.equal(rejectedWinOnPhys.ok, false);
    assert.equal(rejectedWinOnPhys.status, 409);
    assert.equal(rejectedWinOnPhys.error, 'desktop-virtual-display-required');
    assert.equal(harness.desktop.active?.ready, true, 'Pre-mutation 409 preserves ready=true on physical session');

    await rt.pressTestId('desktop-exit');
  } finally {
    await rt.unmount();
  }
});

test('[T4-S08][F05xF06xF11xF12xF16] Security & Revocation Emergency Stop: Active Paired Device Revoked Mid-Window-Fill Session -> Immediate HTTP 401 Cut & Full Restore', async t => {
  const harness = await createDesktopGatewayHarness(t, {
    hostConfig: {
      physicalDisplays: [
        { id: '1', name: 'Main Retina', kind: 'physical', width: 3840, height: 2160, logicalWidth: 1920, logicalHeight: 1080, refreshRate: 60, ioModeID: 3, geometry: 'phys-1', drifted: true },
      ],
    },
  });
  assert.ok(harness.hostFixture);
  const client = createSimulatedMobilePeerClient(harness);

  const grant = await client.connect('virtual');
  assert.ok(grant);
  assert.equal(await client.videoReady(grant.trackSid), true);
  const fillRes = await client.fillWindow('1001:5001');
  assert.equal(await client.videoReady(fillRes.trackSid), true);
  assert.equal(await client.sendInput({ action: 'scroll', deltaY: -80, x: 0.5, y: 0.5 }), true);

  const mediaPath = '/api/peer/desktop/media/rtc?access_token=' + encodeURIComponent(grant.token);
  const authorizedMedia = await harness.desktop.mediaUpstream(mediaPath);
  assert.ok(authorizedMedia.origin);

  const restorePath = join(harness.desktopState, 'window-restore.json');
  const snapPath = join(harness.desktopState, 'display-modes-snapshot.json');
  await stat(restorePath);
  await stat(snapPath);
  await harness.hostFixture.clearEvents();

  // Emergency stop #1: Mac user revokes active paired phone mid-session
  await harness.devices.revoke(harness.deviceId);
  await harness.desktop.run(() => Promise.resolve());

  assert.equal(harness.desktop.status().connected, false);

  const cutInput = await harness.requestDesktopHttp('input', {
    connectionId: grant.connectionId,
    generation: grant.generation,
    geometry: fillRes.geometry,
    sequence: client.state.sequence + 1,
    input: { action: 'pointer', phase: 'click', x: 0.5, y: 0.5, button: 'left' },
  });
  assert.equal(cutInput.ok, false);
  assert.equal(cutInput.status, 401);

  const cutWindow = await harness.requestDesktopHttp('window', {
    connectionId: grant.connectionId,
    generation: grant.generation,
    geometry: fillRes.geometry,
    sequence: client.state.sequence + 1,
    mode: 'restore',
  });
  assert.equal(cutWindow.ok, false);
  assert.equal(cutWindow.status, 401);

  await assert.rejects(
    () => harness.desktop.mediaUpstream(mediaPath),
    (/** @type {Value} */ err) => err.code === 'desktop-media-unauthorized' && err.status === 401,
  );

  await assert.rejects(stat(restorePath), { code: 'ENOENT' });
  await assert.rejects(stat(snapPath), { code: 'ENOENT' });
  const revokeEvents = await harness.hostFixture.getEvents();
  assert.ok(revokeEvents.some((/** @type {Value} */ e) => e.type === 'restore-windows' && ['stop', 'SIGTERM', 'startup'].includes(e.trigger)));
  assert.ok(
    revokeEvents.some((/** @type {Value} */ e) => e.type === 'stop-capture-before-virtual-release')
    || revokeEvents.some((/** @type {Value} */ e) => e.type === 'restore-windows' && e.trigger === 'startup'),
  );
  assert.ok(
    revokeEvents.some((/** @type {Value} */ e) => e.type === 'restore-mode' && e.scope === 'permanent')
    || revokeEvents.some((/** @type {Value} */ e) => e.type === 'startup-display-snapshot-reconcile'),
  );

  // Emergency stop #2: Re-approve device with fresh pairing timestamp, fill window, then disable Remote Desktop on Mac
  await harness.devices.approve(
    Buffer.from(harness.phone.publicKey).toString('base64url'),
    'Re-Paired Phone',
    harness.token,
    Date.now() + 50,
  );
  const client2 = createSimulatedMobilePeerClient(harness);
  const grant2 = await client2.connect('virtual');
  assert.ok(grant2);
  assert.equal(await client2.videoReady(grant2.trackSid), true);
  const fill2 = await client2.fillWindow('1001:5001');
  assert.equal(await client2.videoReady(fill2.trackSid), true);
  await stat(restorePath);

  await harness.hostFixture.clearEvents();
  await harness.desktop.configure({ enabled: false });
  assert.equal(harness.desktop.status().enabled, false);
  assert.equal(harness.desktop.status().connected, false);
  await assert.rejects(stat(restorePath), { code: 'ENOENT' });

  const disabledInput = await harness.requestDesktopHttp('input', {
    connectionId: grant2.connectionId,
    generation: grant2.generation,
    geometry: fill2.geometry,
    sequence: 2,
    input: { action: 'pointer', phase: 'click', x: 0.5, y: 0.5, button: 'left' },
  });
  assert.equal(disabledInput.ok, false);
  assert.equal(disabledInput.status, 409);
  assert.equal(disabledInput.error, 'desktop-disabled');
});
