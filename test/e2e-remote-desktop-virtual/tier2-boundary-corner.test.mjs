import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { isCodelyncNativeSource } from '../../src/codelync/source-scope.mjs';
import { copyPublicSourceSnapshot } from '../../src/release/source-snapshot.mjs';
import {
  REPO_ROOT, checkPublicSourceHygiene, createDesktopGatewayHarness, createProgrammableHostBinary,
  inspectNativeHostUndefinedSymbols, listWorkspaceSourceFiles, probeNativeHostCli, probeNativeHostDaemon,
  readWorkspaceFile, runNativeHostSwiftTest, verifyNativeRuntimeManifest,
} from './harness.mjs';
import {
  createMobileSyncRuntime, flattenStyle, loadRemoteDesktopLabelsRuntime, mountDesktopScreenRuntime,
  mountRemoteDesktopKeyboardRuntime, mountRemoteDesktopViewRuntime, mountUseRemoteDesktopRuntime,
} from './mobile-runtime-harness.mjs';

/** @typedef {Record<string, any>} Value */

/** @param {import('node:test').TestContext} t @param {Value} [opts] @returns {Promise<Value>} */
const bootGateway = (t, opts = {}) => createDesktopGatewayHarness(t, opts);

/** @param {Value} h @param {string} [displayId] @param {Value} [extra] */
async function connectReadySession(h, displayId = 'virtual', extra = {}) {
  const joinRes = await h.requestDesktopHttp('join', { displayId, ...extra });
  assert.equal(joinRes.ok, true, `Expected join(${displayId}) 200, got ${joinRes.status}:${joinRes.error}`);
  const grant = joinRes.data;
  const binding = { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry };
  const readyRes = await h.requestDesktopHttp('ready', { ...binding, trackSid: grant.trackSid });
  assert.equal(readyRes.ok, true, `Expected ready 200, got ${readyRes.status}:${readyRes.error}`);
  return { grant, binding };
}

/** @param {{ allowedKeys?: Set<string>, maxUtf16?: number, emptyQualityTrack?: boolean }} [rules] */
function createInputValidatingHostFactory(rules = {}) {
  const allowedKeys = rules.allowedKeys ?? new Set([
    'enter', 'tab', 'escape', 'backspace', 'delete', 'left', 'right', 'down', 'up',
    'space', 'a', 'c', 'v', 'x', 'z', 's', 'f', 'w', 'r',
  ]);
  const maxUtf16 = rules.maxUtf16 ?? 2048;
  /** @type {Value[]} */ const acceptedInputs = [];
  const hostFactory = () => {
    let epoch = 1;
    let disp = {
      id: 'virtual', name: 'Phone Screen', kind: 'virtual',
      width: 1080, height: 2160, logicalWidth: 540, logicalHeight: 1080, geometry: 'virt-540x1080-g1',
    };
    const perms = { screenRecording: true, accessibility: true, locked: false };
    return Object.assign(new EventEmitter(), {
      async request(/** @type {string} */ op, /** @type {Value} */ msg = {}) {
        if (op === 'displays') return { displays: [disp], permissions: perms, virtualDisplaySupported: true };
        if (op === 'start') {
          disp = { ...disp, geometry: `virt-g${++epoch}` };
          return { connected: true, capturing: true, viewerConnected: true, permissions: perms, display: disp, geometry: disp.geometry, trackSid: `TR_${++epoch}`, viewPending: false };
        }
        if (op === 'heartbeat') return { connected: true, capturing: true, viewerConnected: true, permissions: perms, display: disp, geometry: disp.geometry, trackSid: `TR_${epoch}`, viewPending: false };
        if (op === 'quality') {
          const nextSid = rules.emptyQualityTrack ? '' : `TR_${++epoch}`;
          return { connected: true, capturing: true, viewerConnected: true, permissions: perms, display: disp, geometry: disp.geometry, trackSid: nextSid, viewPending: false };
        }
        if (op === 'stop') return { stopped: true };
        if (op === 'input') {
          if (msg.action === 'text' && (typeof msg.text !== 'string' || msg.text.length === 0 || msg.text.length > maxUtf16)) {
            throw Object.assign(new Error('Text exceeds UTF-16 limit'), { code: 'invalid-desktop-input' });
          }
          if (msg.action === 'key') {
            const mods = Array.isArray(msg.modifiers) ? msg.modifiers : null;
            if (typeof msg.key !== 'string' || !allowedKeys.has(msg.key) || !mods || mods.length > 4
              || !mods.every((/** @type {unknown} */ m) => typeof m === 'string' && ['command', 'shift', 'option', 'control'].includes(m))) {
              throw Object.assign(new Error('Unsupported key input'), { code: 'invalid-desktop-input' });
            }
          }
          acceptedInputs.push(msg);
          return { accepted: true, sequence: msg.sequence };
        }
        throw Object.assign(new Error('Unsupported op'), { code: 'invalid-desktop-operation' });
      },
      async close() {},
    });
  };
  return { hostFactory, acceptedInputs };
}

// --- F01: Spec-First Contract Completeness & Public Hygiene (5 tests) ---

test('[T2-F01-01] specs contain zero legacy landscape-only or physical-only remote desktop contradictions', async () => {
  const [hostSpec, mobileSpec] = await Promise.all([
    readWorkspaceFile('spec/codelync-remote-desktop.md'),
    readWorkspaceFile('spec/codelync-remote-desktop-mobile-experience.md'),
  ]);
  for (const [name, content] of [['hostSpec', hostSpec], ['mobileSpec', mobileSpec]]) {
    assert.doesNotMatch(content, /always\s+locks?\s+(?:to\s+)?landscape/iu, `${name} must not claim unconditional landscape lock`);
    assert.doesNotMatch(content, /physical\s+displays?\s+only/iu, `${name} must not claim physical-only support`);
  }
  assert.match(mobileSpec, /portrait/u);
  assert.match(mobileSpec, /landscape/u);
  assert.match(hostSpec, /Virtual Phone Screen/u);
});

test('[T2-F01-02] specs mandate max(width, height) long-edge clarity cap with zero width-only cap contradiction', async () => {
  const [hostSpec, mobileSpec] = await Promise.all([
    readWorkspaceFile('spec/codelync-remote-desktop.md'),
    readWorkspaceFile('spec/codelync-remote-desktop-mobile-experience.md'),
  ]);
  assert.match(hostSpec, /max\(\s*(?:nativeWidth,\s*nativeHeight|width,\s*height)\s*\)/u);
  assert.match(hostSpec, /1280[\s/`|]*1920[\s/`|]*2560/u);
  assert.doesNotMatch(hostSpec, /caps?\s+horizontal\s+width\s+only/iu);
  assert.doesNotMatch(mobileSpec, /caps?\s+horizontal\s+width\s+only/iu);
});

test('[T2-F01-03] specs explicitly prohibit 28pt third-party home-bar subtraction, Mac CGEventTap hijacking, and UU sniffing', async () => {
  const [hostSpec, mobileSpec] = await Promise.all([
    readWorkspaceFile('spec/codelync-remote-desktop.md'),
    readWorkspaceFile('spec/codelync-remote-desktop-mobile-experience.md'),
  ]);
  const combined = `${hostSpec}\n${mobileSpec}`;
  assert.match(hostSpec, /zero\s+`?28pt`?/iu);
  assert.match(combined, /CGEventTap/u);
  assert.match(hostSpec, /never\s+global\s+`?CGEventTap`?/iu);
});

test('[T2-F01-04] specs reject static phone-models.json catalogs and forbid IDE zoom shortcut or config tampering', async () => {
  const [hostSpec, mobileSpec] = await Promise.all([
    readWorkspaceFile('spec/codelync-remote-desktop.md'),
    readWorkspaceFile('spec/codelync-remote-desktop-mobile-experience.md'),
  ]);
  const combined = `${hostSpec}\n${mobileSpec}`;
  assert.doesNotMatch(combined, /load\s+`?phone-models\.json`?/iu);
  assert.match(combined, /phone-models\.json/u);
  assert.match(combined, /⌘\+|Cmd\+/u);
  assert.match(hostSpec, /sole\s+owners\s+of\s+their\s+sessions/iu);
});

test('[T2-F01-05] specs and all E2E suite .mjs files pass checkPublicSourceHygiene, negative leak fault-injection, ENOENT, and symlink refusal', async t => {
  for (const rel of ['spec/codelync-remote-desktop.md', 'spec/codelync-remote-desktop-mobile-experience.md']) {
    const res = await checkPublicSourceHygiene(rel);
    assert.equal(res.allowedInPublicSnapshot, true, `${rel} must be allowed in public snapshot`);
    assert.deepEqual(res.leaks, [], `${rel} leaked: ${res.leaks.join(',')}`);
    assert.equal(res.clean, true);
  }

  const suiteDir = join(REPO_ROOT, 'test/e2e-remote-desktop-virtual');
  const suiteFiles = (await readdir(suiteDir)).filter(f => f.endsWith('.mjs')).sort();
  assert.ok(suiteFiles.length >= 5, `Expected E2E .mjs suite files, got ${suiteFiles.join(',')}`);
  for (const file of suiteFiles) {
    const report = await checkPublicSourceHygiene(`test/e2e-remote-desktop-virtual/${file}`);
    assert.equal(report.allowedInPublicSnapshot, true);
    assert.deepEqual(report.leaks, []);
    assert.equal(report.clean, true, `Suite hygiene failure in ${file}`);
  }

  const faultRoot = await mkdtemp(join(tmpdir(), 'codelync-hygiene-fault-'));
  try {
    await mkdir(join(faultRoot, 'spec'), { recursive: true });
    const poisoned = [
      'path=' + '/' + 'Users/alice/private',
      'win=' + 'C:\\' + 'Users\\alice\\secret',
      'meta=' + '.' + 'agents/teamwork/handoff.md',
      '-----BEGIN ' + 'PRIVATE KEY-----',
    ].join('\n');
    await writeFile(join(faultRoot, 'spec/codelync-remote-desktop.md'), poisoned, 'utf8');

    const dirty = await checkPublicSourceHygiene('spec/codelync-remote-desktop.md', faultRoot);
    assert.equal(dirty.allowedInPublicSnapshot, true);
    assert.equal(dirty.clean, false);
    assert.deepEqual(dirty.leaks, ['macos-home-path', 'win-home-path', 'agents-dir-leak', 'private-key-leak']);

    const missing = await checkPublicSourceHygiene('spec/nonexistent-spec.md', faultRoot);
    assert.equal(missing.clean, false);
    assert.ok(missing.leaks.includes('missing-file'));
  } finally {
    await rm(faultRoot, { recursive: true, force: true });
  }

  const tmp = await mkdtemp(join(tmpdir(), 'codelync-t2-snap-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = join(tmp, 'root'), stage = join(tmp, 'stage');
  await mkdir(join(root, 'spec'), { recursive: true });
  await writeFile(join(tmp, 'outside.md'), 'secret');
  await symlink(join(tmp, 'outside.md'), join(root, 'spec/codelync-remote-desktop.md'));
  await assert.rejects(copyPublicSourceSnapshot(root, stage, ['spec/codelync-remote-desktop.md']), /symlink refused/u);
});

// --- F02: Dynamic ObjC Runtime CGVirtualDisplay Bridge & Fallback (5 tests) ---

test('[T2-F02-01] live ObjC runtime capability probe negative fallbacks pass and virtualDisplaySupported false omits virtual row', async t => {
  const sw = await runNativeHostSwiftTest('RuntimeAndLadderTests/testLiveObjCRuntimeCapabilityProbeAndNegativeFallbacks');
  assert.equal(sw.ok, true, sw.output);

  const h = await bootGateway(t, { hostConfig: { virtualDisplaySupported: false } });
  const res = await h.requestDesktopHttp('displays', {});
  assert.equal(res.ok, true);
  assert.equal(res.data.virtualDisplaySupported, false);
  assert.equal(res.data.displays.some((/** @type {Value} */ d) => d.id === 'virtual' || d.kind === 'virtual'), false);
  assert.equal(res.data.displays.length, 1);
  assert.equal(res.data.displays[0].id, '1');
});

test('[T2-F02-02] join with displayId virtual fails closed with 409 when virtualDisplaySupported is false', async t => {
  const h = await bootGateway(t, { hostConfig: { virtualDisplaySupported: false } });
  const res = await h.requestDesktopHttp('join', { displayId: 'virtual', viewport: { width: 393, height: 759 } });
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.ok(['desktop-virtual-display-unavailable', 'desktop-display-unavailable'].includes(res.error));
  assert.equal(h.desktop.active, null);
  const evts = await h.hostFixture.getEvents();
  assert.equal(evts.some((/** @type {Value} */ e) => e.type === 'rpc' && e.op === 'start'), false);
});

test('[T2-F02-03] switching from physical display to virtual fails closed with 409 when virtualDisplaySupported is false and headless safety holds', async t => {
  const sw = await runNativeHostSwiftTest('DesktopHostStateMachineTests/testHeadlessMacSwitchFromVirtualToDefaultDisplayReEmergenceAndZeroDisplaySafety');
  assert.equal(sw.ok, true, sw.output);

  const h = await bootGateway(t, { hostConfig: { virtualDisplaySupported: false } });
  const { binding } = await connectReadySession(h, '1');
  const swRes = await h.requestDesktopHttp('display', { ...binding, displayId: 'virtual', viewport: { width: 540, height: 1080 } });
  assert.equal(swRes.ok, false);
  assert.equal(swRes.status, 409);
  assert.equal(swRes.error, 'desktop-virtual-display-unavailable');
  assert.equal(h.desktop.active, null);
});

test('[T2-F02-04] physical display remote control continues unaffected when virtualDisplaySupported is false', async t => {
  const h = await bootGateway(t, { hostConfig: { virtualDisplaySupported: false } });
  const { grant, binding } = await connectReadySession(h, '1');
  assert.equal(grant.display.id, '1');
  const inp = await h.requestDesktopHttp('input', { ...binding, sequence: 1, input: { action: 'pointer', phase: 'click', x: 0.25, y: 0.75, button: 'left' } });
  assert.equal(inp.ok, true);
  assert.equal(inp.data.accepted, true);
  const q = await h.requestDesktopHttp('quality', { ...binding, quality: { width: 1280, fps: 30 } });
  assert.equal(q.ok, true);
  const lv = await h.requestDesktopHttp('leave', { connectionId: grant.connectionId, generation: grant.generation });
  assert.equal(lv.ok, true);
});

test('[T2-F02-05] native binary has zero static CGVirtualDisplay linker symbols in nm -u', async () => {
  const sym = await inspectNativeHostUndefinedSymbols();
  assert.ok(sym.symbols.length > 0);
  assert.equal(sym.hasStaticVirtualDisplaySymbols, false, `Unexpected symbols: ${sym.virtualDisplaySymbols.join(', ')}`);
  assert.deepEqual(sym.virtualDisplaySymbols, []);
});

// --- F03: Adaptive 2x HiDPI Portrait Display & Mode Ladder Boundaries (6 tests) ---

test('[T2-F03-01] square viewport 500x500 (ratio 1.0) steps baseWidth up to 800x800 in Swift ladder and Bridge join', async t => {
  const sw = await runNativeHostSwiftTest('RuntimeAndLadderTests/testPortraitModeLadderAcrossEdgeRatiosAndHardwareBounds');
  assert.equal(sw.ok, true, sw.output);

  const h = await bootGateway(t);
  const joinRes = await h.requestDesktopHttp('join', { displayId: 'virtual', viewport: { width: 500, height: 500 } });
  assert.equal(joinRes.ok, true);
  assert.equal(joinRes.data.display.logicalWidth, 800);
  assert.equal(joinRes.data.display.logicalHeight, 800);
  assert.equal(joinRes.data.display.width, 1600);
  assert.equal(joinRes.data.display.height, 1600);
});

test('[T2-F03-02] near-800pt threshold viewport 547x800 skips 540pt (790pt < 800pt) and selects 550x804', async t => {
  const sw = await runNativeHostSwiftTest('RuntimeAndLadderTests/testPortraitModeLadderAcrossEdgeRatiosAndHardwareBounds');
  assert.equal(sw.ok, true, sw.output);

  const h = await bootGateway(t);
  const joinRes = await h.requestDesktopHttp('join', { displayId: 'virtual', viewport: { width: 547, height: 800 } });
  assert.equal(joinRes.ok, true);
  assert.equal(joinRes.data.display.logicalWidth, 550);
  assert.equal(joinRes.data.display.logicalHeight, 804);
  assert.equal(joinRes.data.display.width, 1100);
  assert.equal(joinRes.data.display.height, 1608);
});

test('[T2-F03-03] ultra-tall viewport 300x900 (rawRatio 3.0) clamps ratio to 2.5 and builds 540x1350 (1080x2700)', async t => {
  const sw = await runNativeHostSwiftTest('RuntimeAndLadderTests/testPortraitModeLadderAcrossEdgeRatiosAndHardwareBounds');
  assert.equal(sw.ok, true, sw.output);

  const h = await bootGateway(t);
  const joinRes = await h.requestDesktopHttp('join', { displayId: 'virtual', viewport: { width: 300, height: 900 } });
  assert.equal(joinRes.ok, true);
  assert.equal(joinRes.data.display.logicalWidth, 540);
  assert.equal(joinRes.data.display.logicalHeight, 1350);
  assert.equal(joinRes.data.display.width, 1080);
  assert.equal(joinRes.data.display.height, 2700);
});

test('[T2-F03-04] exact minimum 100x100, tall 100x500, and maximum 10000x10000 integer viewport boundaries succeed', async t => {
  const sw = await runNativeHostSwiftTest('DesktopHostStateMachineTests/testViewportAndStrictJSONValidationRejectsCFBooleansFloatsAndLandscape');
  assert.equal(sw.ok, true, sw.output);

  const h = await bootGateway(t);
  const minJoin = await h.requestDesktopHttp('join', { displayId: 'virtual', viewport: { width: 100, height: 100 } });
  assert.equal(minJoin.ok, true);
  assert.equal(minJoin.data.display.logicalWidth, 800);
  assert.equal(minJoin.data.display.logicalHeight, 800);

  const tallSwitch = await h.requestDesktopHttp('display', {
    connectionId: minJoin.data.connectionId, generation: minJoin.data.generation,
    geometry: minJoin.data.display.geometry, displayId: 'virtual', viewport: { width: 100, height: 500 },
  });
  assert.equal(tallSwitch.ok, true);
  assert.equal(tallSwitch.data.display.logicalWidth, 540);
  assert.equal(tallSwitch.data.display.logicalHeight, 1350);

  const maxSwitch = await h.requestDesktopHttp('display', {
    connectionId: minJoin.data.connectionId, generation: minJoin.data.generation,
    geometry: tallSwitch.data.display.geometry, displayId: 'virtual', viewport: { width: 10000, height: 10000 },
  });
  assert.equal(maxSwitch.ok, true);
  assert.equal(maxSwitch.data.display.logicalWidth, 800);
  assert.equal(maxSwitch.data.display.logicalHeight, 800);
});

test('[T2-F03-05] landscape, sub-100, and over-10000 viewports fail closed with 400 invalid-desktop-viewport in Swift and Bridge', async t => {
  const sw = await runNativeHostSwiftTest('DesktopHostStateMachineTests/testViewportAndStrictJSONValidationRejectsCFBooleansFloatsAndLandscape');
  assert.equal(sw.ok, true, sw.output);

  const h = await bootGateway(t);
  for (const bad of [{ width: 852, height: 393 }, { width: 541, height: 540 }, { width: 99, height: 200 }, { width: 500, height: 10001 }, { width: 10001, height: 10001 }]) {
    const res = await h.requestDesktopHttp('join', { displayId: 'virtual', viewport: bad });
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.equal(res.error, 'invalid-desktop-viewport');
  }
  const evts = await h.hostFixture.getEvents();
  assert.equal(evts.some((/** @type {Value} */ e) => e.type === 'rpc' && e.op === 'start'), false);
});

test('[T2-F03-06] float, NaN, non-numeric, null/array, and extra-key viewports fail closed on join and display', async t => {
  const h = await bootGateway(t);
  for (const bad of [
    { width: 393.5, height: 852 }, { width: 393, height: 852.2 }, { width: Number.NaN, height: 852 },
    { width: '393', height: 852 }, { width: 540, height: 1080, scale: 2 }, { width: 540 }, null, [540, 1080],
  ]) {
    const res = await h.requestDesktopHttp('join', { displayId: 'virtual', viewport: bad });
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.equal(res.error, 'invalid-desktop-viewport');
  }
  const { binding } = await connectReadySession(h, '1');
  const badSwitch = await h.requestDesktopHttp('display', { ...binding, displayId: 'virtual', viewport: { width: 540, height: 1080, extra: true } });
  assert.equal(badSwitch.ok, false);
  assert.equal(badSwitch.status, 400);
  assert.equal(badSwitch.error, 'invalid-desktop-viewport');
});

// --- F04: Short-Lived --set-mode & --restore-mode CLI Fail-Closed Probes (5 tests) ---

test('[T2-F04-01] native CLI --set-mode missing args exits 1 and coordinator throws when unsupported or all serials fail', async () => {
  const sw = await runNativeHostSwiftTest('RuntimeAndLadderTests/testCoordinatorThrowsWhenUnsupportedOrAllThreeSerialsFail');
  assert.equal(sw.ok, true, sw.output);

  const res = await probeNativeHostCli(['--set-mode']);
  assert.equal(res.timedOut, false);
  assert.equal(res.signal, null);
  assert.equal(res.exitCode, 1);
  assert.ok(res.durationMs < 5000);
});

test('[T2-F04-02] native CLI --set-mode rejects non-numeric/negative dims and coordinator serial fallback/upshift/lifetime pass', async () => {
  const sw = await runNativeHostSwiftTest('RuntimeAndLadderTests/testCoordinatorSerialFallbackInPlaceUpdateUpshiftAndMinimumLifetime');
  assert.equal(sw.ok, true, sw.output);

  for (const args of [['--set-mode', 'abc', '540', '1080'], ['--set-mode', '1', '-540', '1080'], ['--set-mode', '1', '540.5', '1080']]) {
    const res = await probeNativeHostCli(args);
    assert.equal(res.timedOut, false);
    assert.equal(res.signal, null);
    assert.equal(res.exitCode, 1);
  }
});

test('[T2-F04-03] native CLI --set-mode on displayID 0 exits 1 without daemon init and heartbeat unwedges geometry drift', async () => {
  const sw = await runNativeHostSwiftTest('DesktopHostStateMachineTests/testHeartbeatRecoversUnconfirmedGeometryDriftAndUnwedgesRequireActive');
  assert.equal(sw.ok, true, sw.output);

  const res = await probeNativeHostCli(['--set-mode', '0', '540', '1080']);
  assert.equal(res.timedOut, false);
  assert.equal(res.signal, null);
  assert.equal(res.exitCode, 1);
  assert.equal(res.stdout.trim(), '');
});

test('[T2-F04-04] native CLI --restore-mode accepts UInt32.max bitPattern for negative Int32 ioModeID and exits 1 on display 0', async () => {
  const sw = await runNativeHostSwiftTest('SubprocessAndSnapshotTests/testCLIArgumentParsingAndSignedIOModeIDRoundTrip');
  assert.equal(sw.ok, true, sw.output);

  const res = await probeNativeHostCli(['--restore-mode', '0', '4294967295', '1920', '1080', '3840', '2160', '60.0', 'session']);
  assert.equal(res.timedOut, false);
  assert.equal(res.signal, null);
  assert.equal(res.exitCode, 1);
  assert.ok(res.durationMs < 5000);
});

test('[T2-F04-05] native CLI rejects invalid --restore-mode scope bogus / unknown flags and SubprocessBox cancellation/SIGKILL pass', async () => {
  const sw = await runNativeHostSwiftTest('SubprocessAndSnapshotTests/testSubprocessBoxPreCancelledZeroTimeoutMidFlightCancelAndSigkill');
  assert.equal(sw.ok, true, sw.output);

  const badScope = await probeNativeHostCli(['--restore-mode', '0', '1', '1920', '1080', '3840', '2160', '60.0', 'bogus']);
  assert.equal(badScope.timedOut, false);
  assert.equal(badScope.exitCode, 1);
  const unknownFlag = await probeNativeHostCli(['--bogus-flag']);
  assert.equal(unknownFlag.timedOut, false);
  assert.equal(unknownFlag.exitCode, 1);
});

// --- F05: Physical Display Mode & Refresh Rate Snapshot/Restore Boundaries (5 tests) ---

test('[T2-F05-01] unplugged physical display is skipped without error and non-convergent post-mount drift preserves baseline', async t => {
  const sw = await runNativeHostSwiftTest('SubprocessAndSnapshotTests/testRestoreDriftedAfterMountNonConvergencePreservesBaselineForPermanentRestore');
  assert.equal(sw.ok, true, sw.output);

  const h = await bootGateway(t, {
    hostConfig: {
      physicalDisplays: [
        { id: '1', name: 'Display 1', kind: 'physical', width: 3840, height: 2160, logicalWidth: 1920, logicalHeight: 1080, refreshRate: 60, ioModeID: 1, geometry: 'phys-1' },
        { id: '2', name: 'Unplugged Ext', kind: 'physical', width: 2560, height: 1440, logicalWidth: 2560, logicalHeight: 1440, refreshRate: 60, ioModeID: 2, geometry: 'phys-2', unplugged: true, drifted: true },
      ],
    },
  });
  const { grant } = await connectReadySession(h, 'virtual');
  await h.requestDesktopHttp('leave', { connectionId: grant.connectionId, generation: grant.generation });
  const evts = await h.hostFixture.getEvents();
  const snap = evts.find((/** @type {Value} */ e) => e.type === 'snapshot-physical-modes' && e.phase === 'mount');
  assert.equal(snap?.count, 1);
  assert.equal(evts.some((/** @type {Value} */ e) => e.type === 'restore-mode' && e.id === '2'), false);
});

test('[T2-F05-02] asleep physical display defers session mode restoration without forcing display wake', async t => {
  const sw = await runNativeHostSwiftTest('SubprocessAndSnapshotTests/testPhysicalDisplayModeProtectorDriftSleepDeferralAndStartupRecovery');
  assert.equal(sw.ok, true, sw.output);

  const h = await bootGateway(t, {
    hostConfig: {
      physicalDisplays: [{ id: '1', name: 'Sleeping Builtin', kind: 'physical', width: 3024, height: 1964, logicalWidth: 1512, logicalHeight: 982, refreshRate: 120, ioModeID: 11, geometry: 'phys-1', isAsleep: true, drifted: true }],
    },
  });
  await connectReadySession(h, 'virtual');
  const evts = await h.hostFixture.getEvents();
  assert.equal(evts.some((/** @type {Value} */ e) => e.type === 'defer-asleep-display' && e.id === '1'), true);
  assert.equal(evts.some((/** @type {Value} */ e) => e.type === 'restore-mode' && e.scope === 'session' && e.id === '1'), false);
});

test('[T2-F05-03] sub-0.01Hz refresh rate delta (59.997 vs 60.0) and ioDisplayModeID priority avoid needless reconfiguration', async t => {
  const sw = await runNativeHostSwiftTest('SubprocessAndSnapshotTests/testVirtualHiDPIAndPhysicalRestoreModeSelectionPriority');
  assert.equal(sw.ok, true, sw.output);

  const swiftFiles = (await listWorkspaceSourceFiles(['native/remote-desktop/Sources'])).filter(p => p.endsWith('.swift'));
  assert.ok(swiftFiles.length > 0);
  const swiftContents = await Promise.all(swiftFiles.map(rel => readWorkspaceFile(rel)));
  assert.equal(swiftContents.some(text => /ioDisplayModeID/u.test(text)), true);
  assert.equal(swiftContents.some(text => /0\.01/u.test(text)), true);

  const h = await bootGateway(t, {
    hostConfig: {
      physicalDisplays: [{ id: '1', name: 'Display 1', kind: 'physical', width: 3840, height: 2160, logicalWidth: 1920, logicalHeight: 1080, refreshRate: 59.997, ioModeID: 1, geometry: 'phys-1', drifted: Math.abs(59.997 - 60.0) >= 0.01 }],
    },
  });
  const { grant } = await connectReadySession(h, 'virtual');
  await h.requestDesktopHttp('leave', { connectionId: grant.connectionId, generation: grant.generation });
  const evts = await h.hostFixture.getEvents();
  assert.equal(evts.some((/** @type {Value} */ e) => e.type === 'restore-mode'), false);
});

test('[T2-F05-04] refresh rate drift >= 0.01Hz (30.0 vs 60.0) triggers session restore on mount, permanent restore on teardown, and store defenses', async t => {
  const sw = await runNativeHostSwiftTest('SubprocessAndSnapshotTests/testDurableJSONStorePermissionsQuarantineAndSymlinkDefense');
  assert.equal(sw.ok, true, sw.output);

  const h = await bootGateway(t, {
    hostConfig: {
      physicalDisplays: [{ id: '1', name: 'Display 1', kind: 'physical', width: 3840, height: 2160, logicalWidth: 1920, logicalHeight: 1080, refreshRate: 30.0, ioModeID: 1, geometry: 'phys-1', drifted: Math.abs(30.0 - 60.0) >= 0.01 }],
    },
  });
  const { grant } = await connectReadySession(h, 'virtual');
  const snapFile = join(h.desktopState, 'display-modes-snapshot.json');
  await access(snapFile);
  await h.requestDesktopHttp('leave', { connectionId: grant.connectionId, generation: grant.generation });
  await assert.rejects(access(snapFile));
  const evts = await h.hostFixture.getEvents();
  assert.equal(evts.some((/** @type {Value} */ e) => e.type === 'restore-mode' && e.id === '1' && e.scope === 'session'), true);
  assert.equal(evts.some((/** @type {Value} */ e) => e.type === 'restore-mode' && e.id === '1' && e.scope === 'permanent'), true);
});

test('[T2-F05-05] missing or corrupt display-modes-snapshot.json on native startup is handled safely and quarantined with 0o600', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codelync-t2-nosnap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const daemon = await probeNativeHostDaemon([{ id: 's1', operation: 'status' }], [`--state-dir=${dir}`]);
  assert.equal(daemon.timedOut, false);
  assert.equal(daemon.exitCode, 0);
  assert.equal(daemon.replies[0]?.ok, true);

  const corruptDir = await mkdtemp(join(tmpdir(), 'codelync-t2-corrupt-disp-'));
  t.after(() => rm(corruptDir, { recursive: true, force: true }));
  await writeFile(join(corruptDir, 'display-modes-snapshot.json'), '{corrupt-display-snapshot', { mode: 0o600 });
  const qDaemon = await probeNativeHostDaemon([{ id: 's2', operation: 'status' }], [`--state-dir=${corruptDir}`]);
  assert.equal(qDaemon.timedOut, false);
  assert.equal(qDaemon.exitCode, 0);
  assert.equal(qDaemon.replies[0]?.ok, true);
  const entries = await readdir(corruptDir);
  const quarantined = entries.find(e => e.startsWith('display-modes-snapshot.json.corrupt-'));
  assert.ok(quarantined, `Expected display-modes-snapshot.json.corrupt-* in ${entries.join(',')}`);
  assert.equal(entries.includes('display-modes-snapshot.json'), false);
  assert.equal((await stat(join(corruptDir, quarantined))).mode & 0o777, 0o600);

  const h = await bootGateway(t);
  const dispRes = await h.requestDesktopHttp('displays', {});
  assert.equal(dispRes.ok, true);
  const evts = await h.hostFixture.getEvents();
  assert.equal(evts.some((/** @type {Value} */ e) => e.type === 'startup-display-snapshot-reconcile'), false);
});

// --- F06: Virtual Display Teardown & Headless Mac Stream Safety (5 tests) ---

test('[T2-F06-01] headless Mac with virtualDisplaySupported false fails closed without crash', async t => {
  const h = await bootGateway(t, { hostConfig: { headless: true, virtualDisplaySupported: false } });
  const inv = await h.requestDesktopHttp('displays', {});
  assert.equal(inv.ok, true);
  assert.deepEqual(inv.data.displays, []);
  assert.equal(inv.data.virtualDisplaySupported, false);

  const joinVirt = await h.requestDesktopHttp('join', { displayId: 'virtual' });
  assert.equal(joinVirt.ok, false);
  assert.equal(joinVirt.status, 409);
  assert.equal(joinVirt.error, 'desktop-virtual-display-unavailable');

  const joinPhys = await h.requestDesktopHttp('join', { displayId: '1' });
  assert.equal(joinPhys.ok, false);
  assert.equal(joinPhys.status, 409);
  assert.equal(joinPhys.error, 'desktop-display-unavailable');
});

test('[T2-F06-02] switching from virtual display to non-existent physical display fails closed and tears down virtual display', async t => {
  const sw = await runNativeHostSwiftTest('DesktopHostStateMachineTests/testHeadlessMacSwitchFromVirtualToDefaultDisplayReEmergenceAndZeroDisplaySafety');
  assert.equal(sw.ok, true, sw.output);

  const h = await bootGateway(t);
  const { binding } = await connectReadySession(h, 'virtual');
  const swRes = await h.requestDesktopHttp('display', { ...binding, displayId: '99' });
  assert.equal(swRes.ok, false);
  assert.ok([409, 503].includes(swRes.status));
  assert.equal(swRes.error, 'desktop-display-unavailable');
  assert.equal(h.desktop.active, null);

  const evts = await h.hostFixture.getEvents();
  const stopIdx = evts.findIndex((/** @type {Value} */ e) => e.type === 'stop-capture-before-virtual-release');
  const relIdx = evts.findIndex((/** @type {Value} */ e) => e.type === 'release-virtual-display');
  assert.ok(stopIdx >= 0 && relIdx > stopIdx);
});

test('[T2-F06-03] screen-locked host rejects virtual display join with 409 desktop-locked', async t => {
  const h = await bootGateway(t, { hostConfig: { locked: true } });
  const res = await h.requestDesktopHttp('join', { displayId: 'virtual', viewport: { width: 393, height: 759 } });
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.equal(res.error, 'desktop-locked');
  assert.equal(h.desktop.active, null);
  assert.equal(h.relayCalls.length, 0);
});

test('[T2-F06-04] missing Screen Recording permission rejects virtual display join with 409 desktop-screen-permission-required', async t => {
  const h = await bootGateway(t, { hostConfig: { screenRecording: false } });
  const res = await h.requestDesktopHttp('join', { displayId: 'virtual', viewport: { width: 393, height: 759 } });
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.equal(res.error, 'desktop-screen-permission-required');
  assert.equal(h.desktop.active, null);
  const evts = await h.hostFixture.getEvents();
  assert.equal(evts.some((/** @type {Value} */ e) => e.type === 'rpc' && e.op === 'start'), false);
});

test('[T2-F06-05] rapid join then immediate leave before ready stops capture before virtual release and passes coalesced stop/rollback XCTests', async t => {
  const [sw1, sw2] = await Promise.all([
    runNativeHostSwiftTest('DesktopHostStateMachineTests/testCoalescedStopShutdownUpgradeConcurrentRoomDisconnectAndBoundedDeadline'),
    runNativeHostSwiftTest('DesktopHostStateMachineTests/testPublishCaptureThrowStopsLeakedStreamAndSwitchDisplayRollsBackPostRetireFailures'),
  ]);
  assert.equal(sw1.ok, true, sw1.output);
  assert.equal(sw2.ok, true, sw2.output);

  const h = await bootGateway(t, { hostConfig: { headless: true } });
  const joinRes = await h.requestDesktopHttp('join', { displayId: 'virtual', viewport: { width: 540, height: 1080 } });
  assert.equal(joinRes.ok, true);
  const leaveRes = await h.requestDesktopHttp('leave', { connectionId: joinRes.data.connectionId, generation: joinRes.data.generation });
  assert.equal(leaveRes.ok, true);
  assert.equal(leaveRes.data.stopped, true);
  assert.equal(h.desktop.active, null);
  assert.equal(h.relayCalls.some((/** @type {Value} */ c) => Boolean(c.delete)), true);

  const evts = await h.hostFixture.getEvents();
  const stopIdx = evts.findIndex((/** @type {Value} */ e) => e.type === 'stop-capture-before-virtual-release');
  const relIdx = evts.findIndex((/** @type {Value} */ e) => e.type === 'release-virtual-display');
  assert.ok(stopIdx >= 0 && relIdx > stopIdx);
  assert.equal(evts[relIdx].minimumLifetimeMs, 2500);
});

// --- F07: Long-Edge Capture Clarity Scaling Boundaries (5 tests) ---

test('[T2-F07-01] portrait 1080x2160 at 2560 clarity preserves backing display in Swift/Bridge and fails closed on empty trackSid', async t => {
  const sw = await runNativeHostSwiftTest('CaptureAndInputTests/testLongEdgeCaptureDimensionsAcrossLandscapePortraitSquareSmallAndOddSizes');
  assert.equal(sw.ok, true, sw.output);

  const h = await bootGateway(t);
  const { binding } = await connectReadySession(h, 'virtual', { viewport: { width: 540, height: 1080 } });
  const qRes = await h.requestDesktopHttp('quality', { ...binding, quality: { width: 2560, fps: 60 } });
  assert.equal(qRes.ok, true);
  assert.deepEqual(qRes.data.quality, { width: 2560, fps: 60 });
  assert.equal(qRes.data.display.width, 1080);
  assert.equal(qRes.data.display.height, 2160);

  const { hostFactory } = createInputValidatingHostFactory({ emptyQualityTrack: true });
  const failGw = await bootGateway(t, { hostFactory });
  const failConn = await connectReadySession(failGw, 'virtual');
  const badTrackRes = await failGw.requestDesktopHttp('quality', { ...failConn.binding, quality: { width: 1280, fps: 30 } });
  assert.equal(badTrackRes.ok, false);
  assert.equal(badTrackRes.status, 503);
  assert.equal(badTrackRes.error, 'desktop-capture-unavailable');
  assert.equal(failGw.desktop.active, null);
  assert.equal(failGw.relayCalls.some((/** @type {Value} */ c) => Boolean(c.delete)), true);
});

test('[T2-F07-02] odd-aspect portrait 393x759 at 1280 clarity rotates trackSid and re-fences ready before input', async t => {
  const h = await bootGateway(t);
  const { grant, binding } = await connectReadySession(h, 'virtual', { viewport: { width: 393, height: 759 }, quality: { width: 1920, fps: 30 } });
  const qRes = await h.requestDesktopHttp('quality', { ...binding, quality: { width: 1280, fps: 30 } });
  assert.equal(qRes.ok, true);
  assert.deepEqual(qRes.data.quality, { width: 1280, fps: 30 });
  assert.notEqual(qRes.data.trackSid, grant.trackSid);
  assert.equal(h.desktop.active?.ready, false);

  const nextBind = { connectionId: grant.connectionId, generation: grant.generation, geometry: qRes.data.geometry };
  const prematureInput = await h.requestDesktopHttp('input', {
    ...nextBind, sequence: 1, input: { action: 'pointer', phase: 'click', x: 0.5, y: 0.5, button: 'left' },
  });
  assert.equal(prematureInput.ok, false);
  assert.equal(prematureInput.status, 409);
  assert.equal(prematureInput.error, 'desktop-not-ready');

  const readyRes = await h.requestDesktopHttp('ready', { ...nextBind, trackSid: qRes.data.trackSid });
  assert.equal(readyRes.ok, true);
  const okInput = await h.requestDesktopHttp('input', {
    ...nextBind, sequence: 1, input: { action: 'pointer', phase: 'click', x: 0.5, y: 0.5, button: 'left' },
  });
  assert.equal(okInput.ok, true);
});

test('[T2-F07-03] Swift DesktopCaptureMath clamps 1x1->2x2 and odd sizes while Bridge rejects out-of-tier widths on 100x100 Phone Screen', async t => {
  const sw = await runNativeHostSwiftTest('CaptureAndInputTests/testLongEdgeCaptureDimensionsAcrossLandscapePortraitSquareSmallAndOddSizes');
  assert.equal(sw.ok, true, sw.output);

  const h = await bootGateway(t);
  const { binding } = await connectReadySession(h, 'virtual', { viewport: { width: 100, height: 100 } });
  for (const bad of [{ width: 2, fps: 30 }, { width: 640, fps: 30 }, { width: 5400, fps: 30 }]) {
    const res = await h.requestDesktopHttp('quality', { ...binding, quality: bad });
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.equal(res.error, 'invalid-desktop-quality');
  }
  const okRes = await h.requestDesktopHttp('quality', { ...binding, quality: { width: 1280, fps: 15 } });
  assert.equal(okRes.ok, true);
  assert.deepEqual(okRes.data.quality, { width: 1280, fps: 15 });
});

test('[T2-F07-04] unsupported quality width and fps tiers fail closed with 400 invalid-desktop-quality', async t => {
  const h = await bootGateway(t);
  for (const bad of [{ width: 1080, fps: 30 }, { width: 720, fps: 30 }, { width: 3840, fps: 60 }, { width: 1920, fps: 24 }, { width: 1920, fps: 120 }, { width: 1920, fps: 0 }]) {
    const res = await h.requestDesktopHttp('join', { displayId: 'virtual', quality: bad });
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.equal(res.error, 'invalid-desktop-quality');
  }
});

test('[T2-F07-05] extra-key, missing-key, or non-object quality payloads fail closed without mutating active session', async t => {
  const h = await bootGateway(t);
  const { grant, binding } = await connectReadySession(h, 'virtual');
  await h.hostFixture.clearEvents();
  for (const bad of [{ width: 1920, fps: 30, bitrate: 5000 }, { width: 1920 }, { fps: 30 }, null, ['1920', 30]]) {
    const res = await h.requestDesktopHttp('quality', { ...binding, quality: bad });
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.equal(res.error, 'invalid-desktop-quality');
  }
  assert.equal(h.desktop.active?.id, grant.connectionId);
  const evts = await h.hostFixture.getEvents();
  assert.equal(evts.some((/** @type {Value} */ e) => e.type === 'rpc' && e.op === 'quality'), false);
});

// --- F08: Host Scroll Coordinate Anchor (x, y) Boundaries & Rejections (5 tests) ---

test('[T2-F08-01] partial scroll coordinates (x without y or y without x) fail closed with 400 invalid-desktop-input', async t => {
  const { hostFactory, acceptedInputs } = createInputValidatingHostFactory();
  const h = await bootGateway(t, { hostFactory });
  const { binding } = await connectReadySession(h, 'virtual');
  for (const partial of [{ action: 'scroll', deltaY: -40, x: 0.5 }, { action: 'scroll', deltaY: -40, y: 0.5 }]) {
    const res = await h.requestDesktopHttp('input', { ...binding, sequence: 1, input: partial });
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.equal(res.error, 'invalid-desktop-input');
  }
  assert.equal(acceptedInputs.length, 0);
});

test('[T2-F08-02] out-of-range and non-numeric scroll anchors fail closed with 400 invalid-desktop-input', async t => {
  const { hostFactory, acceptedInputs } = createInputValidatingHostFactory();
  const h = await bootGateway(t, { hostFactory });
  const { binding } = await connectReadySession(h, 'virtual');
  for (const bad of [
    { action: 'scroll', deltaY: 30, x: -0.01, y: 0.5 }, { action: 'scroll', deltaY: 30, x: 0.5, y: 1.01 },
    { action: 'scroll', deltaY: 30, x: -1, y: 0 }, { action: 'scroll', deltaY: 30, x: null, y: 0.5 }, { action: 'scroll', deltaY: 30, x: '0.5', y: 0.5 },
  ]) {
    const res = await h.requestDesktopHttp('input', { ...binding, sequence: 1, input: bad });
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.equal(res.error, 'invalid-desktop-input');
  }
  assert.equal(acceptedInputs.length, 0);
});

test('[T2-F08-03] float deltaY and unexpected scroll fields fail closed with 400 invalid-desktop-input', async t => {
  const { hostFactory, acceptedInputs } = createInputValidatingHostFactory();
  const h = await bootGateway(t, { hostFactory });
  const { binding } = await connectReadySession(h, 'virtual');
  for (const bad of [
    { action: 'scroll', deltaY: 12.5, x: 0.5, y: 0.5 }, { action: 'scroll', deltaY: -0.1, x: 0.2, y: 0.8 },
    { action: 'scroll', deltaY: 20, x: 0.5, y: 0.5, button: 'left' }, { action: 'scroll', deltaY: '20', x: 0.5, y: 0.5 },
  ]) {
    const res = await h.requestDesktopHttp('input', { ...binding, sequence: 1, input: bad });
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.equal(res.error, 'invalid-desktop-input');
  }
  assert.equal(acceptedInputs.length, 0);
});

test('[T2-F08-04] overflow deltaY 1201 and -1201 fail closed without burning active sequence', async t => {
  const { hostFactory, acceptedInputs } = createInputValidatingHostFactory();
  const h = await bootGateway(t, { hostFactory });
  const { binding } = await connectReadySession(h, 'virtual');
  for (const deltaY of [1201, -1201, 50000]) {
    const res = await h.requestDesktopHttp('input', { ...binding, sequence: 1, input: { action: 'scroll', deltaY, x: 0.4, y: 0.6 } });
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.equal(res.error, 'invalid-desktop-input');
  }
  assert.equal(h.desktop.active?.sequence, 0);
  assert.equal(acceptedInputs.length, 0);
});

test('[T2-F08-05] exact boundary anchors (0, 0) at -1200 and (1, 1) at +1200 succeed and update host cursor', async t => {
  const h = await bootGateway(t);
  const { binding } = await connectReadySession(h, 'virtual');
  await h.hostFixture.clearEvents();
  const r1 = await h.requestDesktopHttp('input', { ...binding, sequence: 1, input: { action: 'scroll', deltaY: -1200, x: 0, y: 0 } });
  const r2 = await h.requestDesktopHttp('input', { ...binding, sequence: 2, input: { action: 'scroll', deltaY: 1200, x: 1, y: 1 } });
  assert.equal(r1.ok && r2.ok, true);
  const inputs = (await h.hostFixture.getEvents()).filter((/** @type {Value} */ e) => e.type === 'input');
  assert.equal(inputs.length, 2);
  assert.deepEqual([inputs[0].cursor, inputs[0].deltaY], [{ x: 0, y: 0 }, -1200]);
  assert.deepEqual([inputs[1].cursor, inputs[1].deltaY], [{ x: 1, y: 1 }, 1200]);
});

// --- F09: AX Standard Window Enumeration & visibleFrame Fill Boundaries (5 tests) ---

test('[T2-F09-01] missing Accessibility trust fails closed with 409 desktop-accessibility-required on windows and window', async t => {
  const h = await bootGateway(t, { hostConfig: { accessibilityTrusted: false } });
  const { binding } = await connectReadySession(h, 'virtual');
  const listRes = await h.requestDesktopHttp('windows', { connectionId: binding.connectionId });
  assert.equal(listRes.ok, false);
  assert.equal(listRes.status, 409);
  assert.equal(listRes.error, 'desktop-accessibility-required');

  const fillRes = await h.requestDesktopHttp('window', { ...binding, sequence: 1, mode: 'fill', windowId: '1001:5001' });
  assert.equal(fillRes.ok, false);
  assert.equal(fillRes.status, 409);
  assert.equal(fillRes.error, 'desktop-accessibility-required');
  assert.equal(h.desktop.active?.ready, true);
});

test('[T2-F09-02] closed or unknown windowId 9999:8888 returns 409 desktop-window-unavailable without writing restore file', async t => {
  const h = await bootGateway(t);
  const { binding } = await connectReadySession(h, 'virtual');
  const res = await h.requestDesktopHttp('window', { ...binding, sequence: 1, mode: 'fill', windowId: '9999:8888' });
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.equal(res.error, 'desktop-window-unavailable');
  await assert.rejects(access(join(h.desktopState, 'window-restore.json')));
  assert.equal(h.desktop.active?.ready, true);
});

test('[T2-F09-03] unresponsive window target returns 409 desktop-window-unresponsive without moving window', async t => {
  const h = await bootGateway(t, { hostConfig: { unresponsiveWindowIds: ['1001:5001'] } });
  const { binding } = await connectReadySession(h, 'virtual');
  const res = await h.requestDesktopHttp('window', { ...binding, sequence: 1, mode: 'fill', windowId: '1001:5001' });
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.equal(res.error, 'desktop-window-unresponsive');
  await assert.rejects(access(join(h.desktopState, 'window-restore.json')));
  assert.equal((await h.hostFixture.getEvents()).some((/** @type {Value} */ e) => e.type === 'window-filled'), false);
});

test('[T2-F09-04] calling windows and window on unstarted native daemon enforces spec error contracts without invalid-desktop-operation or crash', async () => {
  const daemon = await probeNativeHostDaemon([
    { id: 's-init', operation: 'status' },
    { id: 'w-list', operation: 'windows' },
    { id: 'w-fill', operation: 'window', mode: 'fill', windowId: '1001:5001', sequence: 1, geometry: 'g1' },
  ]);
  assert.equal(daemon.timedOut, false);
  assert.equal(daemon.signal, null);
  assert.equal(daemon.exitCode, 0);
  assert.equal(daemon.replies.length, 3);

  const statusReply = daemon.replies[0];
  const wList = daemon.replies[1];
  const wFill = daemon.replies[2];
  assert.equal(statusReply?.ok, true);

  assert.equal(wList?.id, 'w-list');
  assert.notEqual(wList?.error, 'invalid-desktop-operation');
  if (statusReply?.result?.permissions?.accessibility === true) {
    assert.equal(wList?.ok, true);
    assert.equal(Array.isArray(wList?.result?.windows), true);
    assert.equal(wList?.result?.activeWindowId === null || typeof wList?.result?.activeWindowId === 'string', true);
  } else {
    assert.equal(wList?.ok, false);
    assert.equal(wList?.error, 'desktop-accessibility-required');
  }

  assert.equal(wFill?.id, 'w-fill');
  assert.equal(wFill?.ok, false);
  assert.notEqual(wFill?.error, 'invalid-desktop-operation');
  assert.equal(
    ['desktop-disconnected', 'desktop-virtual-display-required', 'desktop-accessibility-required'].includes(wFill?.error),
    true,
    `Unexpected unstarted window error: ${String(wFill?.error)}`,
  );
});

test('[T2-F09-05] window already on virtual display records centered primary-screen fallback originalFrame', async t => {
  const h = await bootGateway(t, {
    hostConfig: {
      windowsList: [{
        id: '1001:5001', pid: 1001, windowId: 5001, appName: 'Notes', bundleId: 'com.apple.Notes',
        title: 'Already Virtual', bounds: { x: -540, y: 24, width: 540, height: 960 }, minimized: false, onVirtualDisplay: true,
      }],
    },
  });
  const { binding } = await connectReadySession(h, 'virtual');
  const fillRes = await h.requestDesktopHttp('window', { ...binding, sequence: 1, mode: 'fill', windowId: '1001:5001' });
  assert.equal(fillRes.ok, true);
  const saved = JSON.parse(await readFile(join(h.desktopState, 'window-restore.json'), 'utf8'));
  assert.equal(saved.records.length, 1);
  assert.notEqual(saved.records[0].originalFrame.x, -540);
  assert.deepEqual(saved.records[0].originalFrame, { x: 320, y: 130, width: 540, height: 960 });
});

// --- F10: Post-Move Clamped Min-Width Auto-Upshift & Geometry Gate (5 tests) ---

test('[T2-F10-01] IEEE-754 float boundary (580 * 630) / 522 computes exact 700pt nextWidth instead of 710pt in Swift and Bridge', async t => {
  const sw = await runNativeHostSwiftTest('WindowCoordinatorTests/testAutoUpshiftMultiplyBeforeDivideSelectsSmallest10ptStepAndTriggersViewRefresh');
  assert.equal(sw.ok, true, sw.output);

  const h = await bootGateway(t, {
    hostConfig: { fillArea: { width: 522, height: 1000 }, windowMinSizes: { '1001:5001': { width: 630, height: 800 } } },
  });
  const { grant, binding } = await connectReadySession(h, 'virtual', { viewport: { width: 580, height: 805 } });
  assert.equal(grant.display.logicalWidth, 580);
  const fillRes = await h.requestDesktopHttp('window', { ...binding, sequence: 1, mode: 'fill', windowId: '1001:5001' });
  assert.equal(fillRes.ok, true);
  assert.equal(fillRes.data.upshifted, true);
  assert.equal(fillRes.data.display.logicalWidth, 700);
  assert.equal(fillRes.data.display.width, 1400);
});

test('[T2-F10-02] +2pt clamp tolerance (542 on 540) stays at 540pt while +3pt (543 on 540) upshifts to 550pt', async t => {
  const sw = await runNativeHostSwiftTest('WindowCoordinatorTests/testPlacementRetryLoopConvergesAndDetectsClampedMinSizeEarly');
  assert.equal(sw.ok, true, sw.output);

  const h = await bootGateway(t, {
    hostConfig: { fillArea: { width: 540, height: 1056 }, windowMinSizes: { '1001:5001': { width: 542, height: 900 }, '1002:5002': { width: 543, height: 900 } } },
  });
  const { grant, binding } = await connectReadySession(h, 'virtual', { viewport: { width: 540, height: 1080 } });
  const tolRes = await h.requestDesktopHttp('window', { ...binding, sequence: 1, mode: 'fill', windowId: '1001:5001' });
  assert.equal(tolRes.ok, true);
  assert.equal(tolRes.data.upshifted, false);
  assert.equal(tolRes.data.display.logicalWidth, 540);

  const rdy = await h.requestDesktopHttp('ready', { connectionId: grant.connectionId, generation: grant.generation, geometry: tolRes.data.geometry, trackSid: tolRes.data.trackSid });
  assert.equal(rdy.ok, true);
  const upRes = await h.requestDesktopHttp('window', { connectionId: grant.connectionId, generation: grant.generation, geometry: tolRes.data.geometry, sequence: 2, mode: 'fill', windowId: '1002:5002' });
  assert.equal(upRes.ok, true);
  assert.equal(upRes.data.upshifted, true);
  assert.equal(upRes.data.display.logicalWidth, 550);
});

test('[T2-F10-03] ultra-wide window minWidth 1280pt > 1080pt caps virtual display upshift cleanly at 1080pt', async t => {
  const sw = await runNativeHostSwiftTest('WindowCoordinatorTests/testAutoUpshiftCapsAt1080ptAndTopLeftAlignsOversizedMinWidthWindow');
  assert.equal(sw.ok, true, sw.output);

  const h = await bootGateway(t, { hostConfig: { windowMinSizes: { '1001:5001': { width: 1280, height: 900 } } } });
  const { binding } = await connectReadySession(h, 'virtual', { viewport: { width: 540, height: 1080 } });
  const fillRes = await h.requestDesktopHttp('window', { ...binding, sequence: 1, mode: 'fill', windowId: '1001:5001' });
  assert.equal(fillRes.ok, true);
  assert.equal(fillRes.data.upshifted, true);
  assert.equal(fillRes.data.display.logicalWidth, 1080);
  assert.equal(fillRes.data.display.width, 2160);
});

test('[T2-F10-04] stale geometry on window and input fails closed with 409 before host dispatch', async t => {
  const h = await bootGateway(t);
  const { grant } = await connectReadySession(h, 'virtual');
  await h.hostFixture.clearEvents();

  const badWin = await h.requestDesktopHttp('window', {
    connectionId: grant.connectionId, generation: grant.generation, geometry: 'stale-geom-0', sequence: 1, mode: 'fill', windowId: '1001:5001',
  });
  assert.equal(badWin.ok, false);
  assert.equal(badWin.status, 409);
  assert.equal(badWin.error, 'desktop-display-changed');

  const badInp = await h.requestDesktopHttp('input', {
    connectionId: grant.connectionId, generation: grant.generation, geometry: 'stale-geom-0', sequence: 1,
    input: { action: 'pointer', phase: 'click', x: 0.5, y: 0.5, button: 'left' },
  });
  assert.equal(badInp.ok, false);
  assert.equal(badInp.status, 409);
  assert.equal(badInp.error, 'desktop-view-changed');
  assert.equal((await h.hostFixture.getEvents()).length, 0);
});

test('[T2-F10-05] real useRemoteDesktop concurrent fillWindow guard blocks second fillWindow/input in-flight and Bridge fences viewPending', async t => {
  const h = await bootGateway(t, {
    hostConfig: { failOperation: { window: { hangMs: 120 } }, windowMinSizes: { '1001:5001': { width: 700, height: 900 } } },
  });
  const hookRt = await mountUseRemoteDesktopRuntime({ harness: h });
  try {
    await hookRt.call(hook => hook.connect('virtual', { width: 540, height: 1080 }));
    await hookRt.flush();
    assert.equal(hookRt.current.ready, true);
    await h.hostFixture.clearEvents();

    const outcomes = await hookRt.call(async hook => {
      const firstPromise = hook.fillWindow('1001:5001');
      const secondFill = await hook.fillWindow('1002:5002');
      const blockedInput = await hook.input({ action: 'scroll', deltaY: 80 });
      const firstFill = await firstPromise;
      return { firstFill, secondFill, blockedInput };
    });
    assert.equal(outcomes.firstFill, true);
    assert.equal(outcomes.secondFill, false);
    assert.equal(outcomes.blockedInput, false);

    const evts = await h.hostFixture.getEvents();
    const winRpcs = evts.filter((/** @type {Value} */ e) => e.type === 'rpc' && e.op === 'window');
    const inpRpcs = evts.filter((/** @type {Value} */ e) => e.type === 'rpc' && e.op === 'input');
    assert.equal(winRpcs.length, 1);
    assert.equal(winRpcs[0].msg.windowId, '1001:5001');
    assert.equal(inpRpcs.length, 0);
  } finally {
    await hookRt.unmount();
  }

  const vpGw = await bootGateway(t, { hostConfig: { windowViewPending: true, windowMinSizes: { '1001:5001': { width: 700, height: 900 } } } });
  const { grant, binding } = await connectReadySession(vpGw, 'virtual');
  const fillRes = await vpGw.requestDesktopHttp('window', { ...binding, sequence: 1, mode: 'fill', windowId: '1001:5001' });
  assert.equal(fillRes.ok, true);
  assert.equal(fillRes.data.viewPending, true);
  const nextBind = { connectionId: grant.connectionId, generation: grant.generation, geometry: fillRes.data.geometry };
  const blockedWin = await vpGw.requestDesktopHttp('window', { ...nextBind, sequence: 2, mode: 'restore' });
  assert.equal(blockedWin.status, 409);
  assert.equal(blockedWin.error, 'desktop-view-changed');
  const hb = await vpGw.requestDesktopHttp('heartbeat', nextBind);
  assert.equal(hb.ok, true);
  assert.equal(hb.data.viewPending, false);
  const rdy = await vpGw.requestDesktopHttp('ready', { connectionId: grant.connectionId, generation: grant.generation, geometry: hb.data.geometry, trackSid: hb.data.trackSid });
  assert.equal(rdy.ok, true);
});

// --- F11: Write-Ahead RestoreRecord Persistence & Recovery Boundaries (5 tests) ---

test('[T2-F11-01] persistence failure aborts pre-move with 409 desktop-restore-persist-failed', async t => {
  const h = await bootGateway(t, { hostConfig: { persistFailure: true } });
  const { binding } = await connectReadySession(h, 'virtual');
  const res = await h.requestDesktopHttp('window', { ...binding, sequence: 1, mode: 'fill', windowId: '1001:5001' });
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.equal(res.error, 'desktop-restore-persist-failed');
  assert.equal(h.desktop.active?.ready, true);
  assert.equal((await h.hostFixture.getEvents()).some((/** @type {Value} */ e) => e.type === 'window-filled'), false);
});

test('[T2-F11-02] corrupt window-restore.json on startup is quarantined without crashing on programmable and native hosts', async t => {
  const tmp = await mkdtemp(join(tmpdir(), 'codelync-t2-corrupt-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));

  const mockHostDir = join(tmp, 'mock-bin');
  const mockHost = await createProgrammableHostBinary(mockHostDir, {});
  const h = await bootGateway(t, { hostBinary: mockHost.binaryPath });
  await writeFile(join(h.desktopState, 'window-restore.json'), '{corrupt', { mode: 0o600 });
  const inv = await h.requestDesktopHttp('displays', {});
  assert.equal(inv.ok, true);
  const mockFiles = await readdir(h.desktopState);
  assert.equal(mockFiles.some(f => f.startsWith('window-restore.json.corrupt-')), true);

  const nativeState = join(tmp, 'native-state');
  await mkdir(nativeState, { recursive: true, mode: 0o700 });
  await writeFile(join(nativeState, 'window-restore.json'), '{corrupt', { mode: 0o600 });
  const daemon = await probeNativeHostDaemon([{ id: 'c1', operation: 'status' }], [`--state-dir=${nativeState}`]);
  assert.equal(daemon.timedOut, false);
  assert.equal(daemon.exitCode, 0);
  assert.equal(daemon.replies[0]?.ok, true);
  if (daemon.replies[0]?.result?.permissions?.accessibility === true) {
    const nativeFiles = await readdir(nativeState);
    assert.equal(nativeFiles.some(f => f.startsWith('window-restore.json.corrupt-')), true);
  }
});

test('[T2-F11-03] stale dead pid 999999 and corrupt window-restore.json on native startup reconcile cleanly without invalid-desktop-operation', async t => {
  const [sw1, sw2] = await Promise.all([
    runNativeHostSwiftTest('SubprocessAndSnapshotTests/testDurableJSONStorePermissionsQuarantineAndSymlinkDefense'),
    runNativeHostSwiftTest('WindowCoordinatorTests/testRecoverIfTrustedDropsClosedWindowAndPreventsRecycledPIDMisTargeting'),
  ]);
  assert.equal(sw1.ok, true, sw1.output);
  assert.equal(sw2.ok, true, sw2.output);

  const tmp = await mkdtemp(join(tmpdir(), 'codelync-t2-deadpid-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const deadRecord = {
    version: 1,
    records: [{
      pid: 999999, windowId: 888888, bundleId: 'com.example.Dead', appName: 'DeadApp', title: 'Gone',
      originalFrame: { x: 100, y: 100, width: 600, height: 800 }, wasFullScreen: false, wasMinimized: false, savedAt: '2026-11-18T00:00:00Z',
    }],
  };
  const nativeRestorePath = join(tmp, 'window-restore.json');
  await writeFile(nativeRestorePath, JSON.stringify(deadRecord), { mode: 0o600 });
  const daemon = await probeNativeHostDaemon(
    [{ id: 'd1', operation: 'status' }, { id: 'd2', operation: 'windows' }],
    [`--state-dir=${tmp}`],
  );
  assert.equal(daemon.timedOut, false);
  assert.equal(daemon.exitCode, 0);
  assert.equal(daemon.replies[0]?.ok, true);
  assert.notEqual(daemon.replies[1]?.error, 'invalid-desktop-operation');
  if (daemon.replies[0]?.result?.permissions?.accessibility === true) {
    await assert.rejects(access(nativeRestorePath));
  } else {
    assert.equal(daemon.replies[1]?.error, 'desktop-accessibility-required');
    await access(nativeRestorePath);
  }

  const corruptTmp = await mkdtemp(join(tmpdir(), 'codelync-t2-broken-restore-'));
  t.after(() => rm(corruptTmp, { recursive: true, force: true }));
  await writeFile(join(corruptTmp, 'window-restore.json'), '{broken', { mode: 0o600 });
  const corruptDaemon = await probeNativeHostDaemon([{ id: 's1', operation: 'status' }], [`--state-dir=${corruptTmp}`]);
  assert.equal(corruptDaemon.timedOut, false);
  assert.equal(corruptDaemon.exitCode, 0);
  assert.equal(corruptDaemon.replies[0]?.ok, true);
  if (corruptDaemon.replies[0]?.result?.permissions?.accessibility === true) {
    const entries = await readdir(corruptTmp);
    assert.equal(entries.some(f => f.startsWith('window-restore.json.corrupt-')), true);
  }

  const h = await bootGateway(t);
  await writeFile(join(h.desktopState, 'window-restore.json'), JSON.stringify(deadRecord), { mode: 0o600 });
  const inv = await h.requestDesktopHttp('displays', {});
  assert.equal(inv.ok, true);
  const evts = await h.hostFixture.getEvents();
  assert.equal(evts.some((/** @type {Value} */ e) => e.type === 'restore-windows' && e.trigger === 'startup'), true);
});

test('[T2-F11-04] window restore with no active moved window is a safe idempotent operation', async t => {
  const h = await bootGateway(t);
  const { binding } = await connectReadySession(h, 'virtual');
  const res = await h.requestDesktopHttp('window', { ...binding, sequence: 1, mode: 'restore' });
  assert.equal(res.ok, true);
  assert.equal(res.data.accepted, true);
  assert.equal(res.data.activeWindowId, null);
});

test('[T2-F11-05] window-restore.json enforces 0o700 state directory and 0o600 file permissions', async t => {
  const h = await bootGateway(t);
  const { binding } = await connectReadySession(h, 'virtual');
  const fillRes = await h.requestDesktopHttp('window', { ...binding, sequence: 1, mode: 'fill', windowId: '1001:5001' });
  assert.equal(fillRes.ok, true);
  const dirMode = (await stat(h.desktopState)).mode & 0o777;
  const fileMode = (await stat(join(h.desktopState, 'window-restore.json'))).mode & 0o777;
  assert.equal(dirMode, 0o700);
  assert.equal(fileMode, 0o600);
});

// --- F12: Bridge Virtual Display, Window RPC & Sequence State Machine Boundaries (6 tests) ---

test('[T2-F12-01] calling /api/peer/desktop/window on physical display fails closed with 409 desktop-virtual-display-required', async t => {
  const h = await bootGateway(t);
  const { binding } = await connectReadySession(h, '1');
  await h.hostFixture.clearEvents();
  const res = await h.requestDesktopHttp('window', { ...binding, sequence: 1, mode: 'fill', windowId: '1001:5001' });
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.equal(res.error, 'desktop-virtual-display-required');
  assert.equal((await h.hostFixture.getEvents()).some((/** @type {Value} */ e) => e.type === 'rpc' && e.op === 'window'), false);
});

test('[T2-F12-02] malformed windowId, missing/extra windowId, and unsupported mode maximize fail closed with 400', async t => {
  const { hostFactory } = createInputValidatingHostFactory();
  const h = await bootGateway(t, { hostFactory });
  const { binding } = await connectReadySession(h, 'virtual');
  for (const bad of [
    { ...binding, sequence: 1, mode: 'fill', windowId: '../bad' },
    { ...binding, sequence: 1, mode: 'fill', windowId: '' },
    { ...binding, sequence: 1, mode: 'fill', windowId: '1001' },
    { ...binding, sequence: 1, mode: 'fill' },
    { ...binding, sequence: 1, mode: 'restore', windowId: '1001:5001' },
    { ...binding, sequence: 1, mode: 'maximize', windowId: '1001:5001' },
  ]) {
    const res = await h.requestDesktopHttp('window', bad);
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.equal(res.error, 'invalid-desktop-window');
  }
  assert.equal(h.desktop.active?.sequence, 0);
});

test('[T2-F12-03] replayed and out-of-window sequence numbers on window fail closed with 409 desktop-sequence-out-of-order', async t => {
  const h = await bootGateway(t);
  const { grant, binding } = await connectReadySession(h, 'virtual');
  await h.hostFixture.clearEvents();

  for (const seq of [0, -1, 1025]) {
    const res = await h.requestDesktopHttp('window', { ...binding, sequence: seq, mode: 'restore' });
    assert.equal(res.ok, false);
    assert.equal(res.status, 409);
    assert.equal(res.error, 'desktop-sequence-out-of-order');
  }
  assert.equal((await h.hostFixture.getEvents()).length, 0);

  const okFill = await h.requestDesktopHttp('window', { ...binding, sequence: 5, mode: 'fill', windowId: '1001:5001' });
  assert.equal(okFill.ok, true);
  await h.requestDesktopHttp('ready', { connectionId: grant.connectionId, generation: grant.generation, geometry: okFill.data.geometry, trackSid: okFill.data.trackSid });
  await h.hostFixture.clearEvents();

  const replay = await h.requestDesktopHttp('window', { connectionId: grant.connectionId, generation: grant.generation, geometry: okFill.data.geometry, sequence: 5, mode: 'restore' });
  assert.equal(replay.ok, false);
  assert.equal(replay.status, 409);
  assert.equal(replay.error, 'desktop-sequence-out-of-order');
  assert.equal((await h.hostFixture.getEvents()).length, 0);
});

test('[T2-F12-04] real desktopRequest classifies 500/502/503/socket-destroy errors and useRemoteDesktop preserves uncertain sequence without auto-replay', async t => {
  let faultMode = '500';
  const faultServer = createServer((req, res) => {
    if (faultMode === 'destroy') {
      req.socket.destroy();
      return;
    }
    const status = Number(faultMode);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status === 503 ? { error: 'internal-host-timeout' } : { error: 'upstream-gateway-fault' }));
  });
  await new Promise(/** @param {(v?: unknown) => void} resolve */ resolve => faultServer.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => new Promise(resolve => faultServer.close(() => resolve(undefined))));
  const addr = /** @type {{ port: number }} */ (faultServer.address());
  const syncRt = await createMobileSyncRuntime(`http://127.0.0.1:${addr.port}`);
  try {
    for (const mode of ['500', '502', '503', 'destroy']) {
      faultMode = mode;
      await assert.rejects(
        syncRt.desktopRequest('window', { connectionId: 'c1', generation: 'g1', geometry: 'geom1', sequence: 1, mode: 'fill', windowId: '1001:5001' }),
        (/** @type {Value} */ err) => err instanceof syncRt.DesktopRequestError && err.code === 'desktop-operation-unknown',
      );
    }
    faultMode = 'destroy';
    await assert.rejects(
      syncRt.desktopRequest('windows', { connectionId: 'c1' }),
      (/** @type {Value} */ err) => err instanceof syncRt.DesktopRequestError && err.code === 'desktop-relay-unavailable',
    );
  } finally {
    syncRt.dispose();
  }

  const h = await bootGateway(t, { hostConfig: { failOperation: { window: { error: 'host-ipc-dropped' } } } });
  const hookRt = await mountUseRemoteDesktopRuntime({ harness: h });
  try {
    await hookRt.call(hook => hook.connect('virtual', { width: 540, height: 1080 }));
    await hookRt.flush();
    assert.equal(hookRt.current.ready, true);
    const grant = hookRt.current.grant;
    assert.ok(grant);

    const filled = await hookRt.call(hook => hook.fillWindow('1001:5001'));
    assert.equal(filled, false);
    assert.equal(hookRt.current.notice, 'desktop-operation-unknown');
    assert.equal(h.desktop.active?.sequence, 1);
    assert.ok(hookRt.current.grant);

    const replayAttempt = await h.requestDesktopHttp('window', {
      connectionId: grant.connectionId, generation: grant.generation, geometry: hookRt.current.grant.display.geometry,
      sequence: 1, mode: 'fill', windowId: '1001:5001',
    });
    assert.equal(replayAttempt.ok, false);
    assert.equal(replayAttempt.status, 409);
    assert.equal(replayAttempt.error, 'desktop-sequence-out-of-order');

    const evts = await h.hostFixture.getEvents();
    assert.equal(evts.filter((/** @type {Value} */ e) => e.type === 'rpc' && e.op === 'window').length, 1);
    assert.equal(evts.some((/** @type {Value} */ e) => e.type === 'rpc' && e.op === 'heartbeat'), true);
  } finally {
    await hookRt.unmount();
  }
});

test('[T2-F12-05] unknown desktop route /api/peer/desktop/bogus and query string ?x=1 fail closed with 404 and 400', async t => {
  const h = await bootGateway(t);
  const bogus = await h.requestDesktopHttp('bogus', {});
  assert.equal(bogus.ok, false);
  assert.equal(bogus.status, 404);
  assert.equal(bogus.error, 'unsupported-peer-route');

  const qPath = '/api/peer/desktop/windows?x=1';
  const qRes = await fetch(h.loopbackBase + qPath, {
    method: 'POST',
    headers: { Authorization: h.authHeader(qPath, 'POST'), 'Content-Type': 'application/json' },
    body: JSON.stringify(h.sealDesktopBody('windows', {})),
  });
  assert.equal(qRes.status, 400);
  const qJson = /** @type {Value} */ (await qRes.json());
  assert.equal(qJson.error, 'invalid-peer-request');
});

test('[T2-F12-06] 120-window NDJSON payload (>32KiB) streams cleanly through DesktopHostProcess without truncation', async t => {
  const h = await bootGateway(t, { hostConfig: { windowsCount: 120 } });
  const { binding } = await connectReadySession(h, 'virtual');
  const res = await h.requestDesktopHttp('windows', { connectionId: binding.connectionId });
  assert.equal(res.ok, true);
  assert.equal(res.data.windows.length, 120);
  assert.ok(JSON.stringify(res.data.windows).length > 32_768);
});

// --- F13: Mobile Phone Screen Selection & Portrait Safe-Area Viewport Boundaries (5 tests) ---

test('[T2-F13-01] DesktopScreen hides Phone Screen and windows control when virtualDisplaySupported is false while physical connect locks landscape', async t => {
  const h = await bootGateway(t, { hostConfig: { virtualDisplaySupported: false } });
  const rt = await mountDesktopScreenRuntime({ harness: h });
  try {
    assert.equal(rt.findByTestId('desktop-choose-display'), null);
    assert.equal(rt.findByTestId('desktop-display-virtual'), null);
    assert.equal(rt.findByTestId('desktop-windows'), null);

    await rt.pressTestId('desktop-connect');
    assert.equal(h.desktop.active?.display?.id, '1');
    assert.equal(rt.getStackScreenOptions().orientation, 'landscape');
    assert.equal(rt.getStackScreenOptions().statusBarHidden, true);
    assert.equal(rt.findByTestId('desktop-windows'), null);

    const startRpc = (await h.hostFixture.getEvents()).find((/** @type {Value} */ e) => e.type === 'rpc' && e.op === 'start');
    assert.ok(startRpc);
    assert.equal(startRpc.msg.displayId, '1');
    assert.equal(startRpc.msg.viewport, undefined);
  } finally {
    await rt.unmount();
  }
});

test('[T2-F13-02] RemoteDesktopView clamps near-square foldable 700x710 to 700x700 and tiny 20x40 screen to 100x100 on Gateway join', async t => {
  const hFold = await bootGateway(t, { hostConfig: { headless: true } });
  const rtFold = await mountRemoteDesktopViewRuntime({
    harness: hFold,
    window: { width: 700, height: 710 },
    insets: { top: 48, bottom: 34, left: 0, right: 0 },
    initialMetrics: null,
  });
  try {
    await rtFold.pressTestId('desktop-connect');
    const startFold = (await hFold.hostFixture.getEvents()).find((/** @type {Value} */ e) => e.type === 'rpc' && e.op === 'start');
    assert.deepEqual(startFold?.msg?.viewport, { width: 700, height: 700 });
    assert.equal(hFold.desktop.active?.display?.logicalWidth, 800);
    assert.equal(hFold.desktop.active?.display?.logicalHeight, 800);
  } finally {
    await rtFold.unmount();
  }

  const hTiny = await bootGateway(t, { hostConfig: { headless: true } });
  const rtTiny = await mountRemoteDesktopViewRuntime({
    harness: hTiny,
    window: { width: 20, height: 40 },
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
    initialMetrics: null,
  });
  try {
    await rtTiny.pressTestId('desktop-connect');
    const startTiny = (await hTiny.hostFixture.getEvents()).find((/** @type {Value} */ e) => e.type === 'rpc' && e.op === 'start');
    assert.deepEqual(startTiny?.msg?.viewport, { width: 100, height: 100 });
  } finally {
    await rtTiny.unmount();
  }
});

test('[T2-F13-03] RemoteDesktopView ignores open soft keyboard height (350pt) on connect and preserves 393x759 across display switches', async t => {
  const h = await bootGateway(t);
  const rt = await mountRemoteDesktopViewRuntime({
    harness: h,
    window: { width: 393, height: 852 },
    insets: { top: 59, bottom: 34, left: 0, right: 0 },
  });
  try {
    await rt.pressTestId('desktop-choose-display');
    await rt.pressTestId('desktop-display-virtual');
    await rt.emitKeyboard('keyboardDidShow', 350);
    await rt.pressTestId('desktop-connect');

    const startRpc = (await h.hostFixture.getEvents()).find((/** @type {Value} */ e) => e.type === 'rpc' && e.op === 'start');
    assert.deepEqual(startRpc?.msg?.viewport, { width: 393, height: 759 });

    await rt.pressTestId('desktop-keyboard');
    await rt.emitKeyboard('keyboardDidShow', 350);
    await rt.setWindow(393, 502);
    assert.equal(flattenStyle(rt.findByTestId('remote-desktop-page')?.props?.style).paddingBottom, 350);

    await rt.setWindow(852, 393);
    await rt.pressTestId('desktop-keyboard-close');
    await rt.pressTestId('desktop-more');
    await rt.pressTestId('desktop-display-menu');
    await rt.pressTestId('desktop-display-1');
    assert.equal(h.desktop.active?.display?.id, '1');

    await h.hostFixture.clearEvents();
    await rt.pressTestId('desktop-more');
    await rt.pressTestId('desktop-display-menu');
    await rt.pressTestId('desktop-display-virtual');
    const switchRpc = (await h.hostFixture.getEvents()).find((/** @type {Value} */ e) => e.type === 'rpc' && e.op === 'display');
    assert.deepEqual(switchRpc?.msg?.viewport, { width: 393, height: 759 });
  } finally {
    await rt.unmount();
  }
});

test('[T2-F13-04] omitted viewport on join and display switch to virtual defaults cleanly to 540x1080', async t => {
  const h = await bootGateway(t);
  const joinRes = await h.requestDesktopHttp('join', { displayId: 'virtual' });
  assert.equal(joinRes.ok, true);
  assert.equal(joinRes.data.display.logicalWidth, 540);
  assert.equal(joinRes.data.display.logicalHeight, 1080);
  assert.equal(joinRes.data.display.width, 1080);
  assert.equal(joinRes.data.display.height, 2160);

  const physSw = await h.requestDesktopHttp('display', {
    connectionId: joinRes.data.connectionId, generation: joinRes.data.generation, geometry: joinRes.data.display.geometry, displayId: '1',
  });
  assert.equal(physSw.ok, true);
  const virtSw = await h.requestDesktopHttp('display', {
    connectionId: joinRes.data.connectionId, generation: joinRes.data.generation, geometry: physSw.data.geometry, displayId: 'virtual',
  });
  assert.equal(virtSw.ok, true);
  assert.equal(virtSw.data.display.logicalWidth, 540);
  assert.equal(virtSw.data.display.logicalHeight, 1080);
});

test('[T2-F13-05] degenerate NaN/0x0 window falls back to 540x1080 and oversized 15000x25000 clamps to 10000x10000 on Gateway join', async t => {
  const hDegenerate = await bootGateway(t, { hostConfig: { headless: true } });
  const rtDegenerate = await mountRemoteDesktopViewRuntime({
    harness: hDegenerate,
    window: { width: Number.NaN, height: 0 },
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
    initialMetrics: null,
  });
  try {
    await rtDegenerate.pressTestId('desktop-connect');
    const startDegenerate = (await hDegenerate.hostFixture.getEvents()).find((/** @type {Value} */ e) => e.type === 'rpc' && e.op === 'start');
    assert.deepEqual(startDegenerate?.msg?.viewport, { width: 540, height: 1080 });
    assert.equal(hDegenerate.desktop.active?.display?.logicalWidth, 540);
    assert.equal(hDegenerate.desktop.active?.display?.logicalHeight, 1080);
  } finally {
    await rtDegenerate.unmount();
  }

  const hHuge = await bootGateway(t, { hostConfig: { headless: true } });
  const rtHuge = await mountRemoteDesktopViewRuntime({
    harness: hHuge,
    window: { width: 15000, height: 25000 },
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
    initialMetrics: null,
  });
  try {
    await rtHuge.pressTestId('desktop-connect');
    const startHuge = (await hHuge.hostFixture.getEvents()).find((/** @type {Value} */ e) => e.type === 'rpc' && e.op === 'start');
    assert.deepEqual(startHuge?.msg?.viewport, { width: 10000, height: 10000 });
    assert.equal(hHuge.desktop.active?.display?.logicalWidth, 800);
    assert.equal(hHuge.desktop.active?.display?.logicalHeight, 800);
  } finally {
    await rtHuge.unmount();
  }
});

// --- F14: Dynamic Orientation, Safe-Area Dock & Keyboard Boundaries (5 tests) ---

test('[T2-F14-01] DesktopScreen forces portrait and hides RemoteDesktopView when disabled, unpaired, or unfocused', async t => {
  const h = await bootGateway(t);
  const rtDisabled = await mountDesktopScreenRuntime({ harness: h, enabled: false });
  try {
    assert.equal(rtDisabled.getStackScreenOptions().orientation, 'portrait');
    assert.equal(rtDisabled.getStackScreenOptions().statusBarHidden, false);
    assert.equal(rtDisabled.findByTestId('remote-desktop-page'), null);
  } finally {
    await rtDisabled.unmount();
  }

  const rtUnpaired = await mountDesktopScreenRuntime({ harness: h, enabled: true, paired: false });
  try {
    assert.equal(rtUnpaired.getStackScreenOptions().orientation, 'portrait');
    assert.equal(rtUnpaired.getStackScreenOptions().statusBarHidden, false);
    assert.equal(rtUnpaired.findByTestId('remote-desktop-page'), null);
  } finally {
    await rtUnpaired.unmount();
  }

  const rtLive = await mountDesktopScreenRuntime({ harness: h, enabled: true, paired: true, focused: true });
  try {
    await rtLive.pressTestId('desktop-connect');
    assert.equal(rtLive.getStackScreenOptions().orientation, 'landscape');
    assert.equal(rtLive.getStackScreenOptions().statusBarHidden, true);

    await rtLive.setFocused(false);
    assert.equal(rtLive.getStackScreenOptions().orientation, 'portrait');
    assert.equal(rtLive.getStackScreenOptions().statusBarHidden, false);

    await rtLive.setFocused(true);
    assert.equal(rtLive.getStackScreenOptions().orientation, 'landscape');

    await rtLive.setEnabled(false);
    assert.equal(rtLive.getStackScreenOptions().orientation, 'portrait');
    assert.equal(rtLive.findByTestId('remote-desktop-page'), null);
  } finally {
    await rtLive.unmount();
  }
});

test('[T2-F14-02] RemoteDesktopKeyboard disables desktop-type at 2050 > 2048 UTF-16 code units and Bridge rejects oversized text with 400', async t => {
  /** @type {Value[]} */ const dispatched = [];
  const oversized = '😀'.repeat(1025);
  const exactLimit = '😀'.repeat(1024);
  assert.equal(oversized.length, 2050);
  assert.equal(exactLimit.length, 2048);

  const kb = await mountRemoteDesktopKeyboardRuntime({
    visible: true,
    enabled: true,
    onInput: async (/** @type {Value} */ item) => { dispatched.push(item); return true; },
  });
  try {
    await kb.changeText(oversized);
    assert.equal(kb.findByTestId('desktop-type')?.props?.disabled, true);
    const blockedPress = await kb.pressType();
    assert.equal(blockedPress, false);
    assert.equal(dispatched.length, 0);

    await kb.changeText(exactLimit);
    assert.equal(kb.findByTestId('desktop-type')?.props?.disabled, false);
  } finally {
    await kb.unmount();
  }

  const { hostFactory, acceptedInputs } = createInputValidatingHostFactory();
  const h = await bootGateway(t, { hostFactory });
  const { binding } = await connectReadySession(h, 'virtual');
  const res = await h.requestDesktopHttp('input', { ...binding, sequence: 1, input: { action: 'text', text: oversized } });
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.equal(res.error, 'invalid-desktop-input');
  assert.equal(acceptedInputs.length, 0);
});

test('[T2-F14-03] 320x568 screen keeps 296pt dock maxWidth with 44x44pt hit areas and rejected keyboard draft preserves text/suffix', async t => {
  const h = await bootGateway(t, { hostConfig: { headless: true } });
  const rt = await mountRemoteDesktopViewRuntime({
    harness: h,
    window: { width: 320, height: 568 },
    insets: { top: 20, bottom: 0, left: 0, right: 0 },
  });
  try {
    await rt.pressTestId('desktop-connect');
    const dockStyle = flattenStyle(rt.findByTestId('desktop-control-dock')?.props?.style);
    assert.equal(dockStyle.maxWidth, 296);
    for (const id of ['desktop-exit', 'desktop-connection-indicator', 'desktop-windows', 'desktop-keyboard', 'desktop-more']) {
      const btnStyle = flattenStyle(rt.findByTestId(id)?.props?.style);
      assert.equal(btnStyle.width, 44, `${id} width must be 44pt`);
      assert.equal(btnStyle.height, 44, `${id} height must be 44pt`);
    }
  } finally {
    await rt.unmount();
  }

  const kb = await mountRemoteDesktopKeyboardRuntime({ visible: true, enabled: true, onInput: async () => false });
  try {
    await kb.changeText('git status');
    const inputNode = kb.findByTestId('desktop-text-input');
    inputNode?.props?.onEndEditing?.({ nativeEvent: { text: 'git status' } });
    await kb.flush();
    assert.equal(kb.findByTestId('desktop-text-input')?.props?.value, 'git status');
  } finally {
    await kb.unmount();
  }

  const syncRt = await createMobileSyncRuntime(null);
  try {
    const submitted = { text: 'git status', revision: 1 };
    assert.equal(syncRt.acknowledgeDesktopText({ text: 'git status', revision: 1 }, submitted, true), '');
    assert.equal(syncRt.acknowledgeDesktopText({ text: 'git status -s', revision: 2 }, submitted, true), ' -s');
    assert.equal(syncRt.acknowledgeDesktopText({ text: ' edited prefix', revision: 2 }, submitted, false), ' edited prefix');
  } finally {
    syncRt.dispose();
  }
});

test('[T2-F14-04] Android BackHandler dismisses keyboard -> panel -> immersive -> exit in priority order with IME keyboardInset', async t => {
  const h = await bootGateway(t);
  const rt = await mountDesktopScreenRuntime({ harness: h, platform: 'android', canGoBack: true });
  try {
    await rt.pressTestId('desktop-choose-display');
    await rt.pressTestId('desktop-display-virtual');
    await rt.pressTestId('desktop-connect');
    assert.equal(h.desktop.active?.display?.id, 'virtual');

    await rt.pressTestId('desktop-keyboard');
    assert.notEqual(rt.findByTestId('desktop-keyboard-panel'), null);
    await rt.emitKeyboard('keyboardDidShow', 320);
    assert.equal(flattenStyle(rt.findByTestId('remote-desktop-page')?.props?.style).paddingBottom, 320);

    assert.equal(await rt.triggerHardwareBack(), true);
    assert.equal(rt.findByTestId('desktop-keyboard-panel'), null);
    assert.equal(flattenStyle(rt.findByTestId('remote-desktop-page')?.props?.style).paddingBottom, 0);
    assert.notEqual(h.desktop.active, null);
    assert.equal(rt.routerCalls.back, 0);

    await rt.pressTestId('desktop-windows');
    assert.notEqual(rt.findByTestId('desktop-windows-panel'), null);
    assert.equal(await rt.triggerHardwareBack(), true);
    assert.equal(rt.findByTestId('desktop-windows-panel'), null);
    assert.notEqual(h.desktop.active, null);
    assert.equal(rt.routerCalls.back, 0);

    await rt.pressTestId('desktop-more');
    await rt.pressTestId('desktop-hide-controls');
    assert.equal(rt.findByTestId('desktop-control-dock'), null);
    assert.notEqual(rt.findByTestId('desktop-restore-controls'), null);
    assert.equal(await rt.triggerHardwareBack(), true);
    assert.notEqual(rt.findByTestId('desktop-control-dock'), null);
    assert.notEqual(h.desktop.active, null);
    assert.equal(rt.routerCalls.back, 0);

    assert.equal(await rt.triggerHardwareBack(), true);
    assert.equal(rt.getStackScreenOptions().orientation, 'portrait');
    assert.equal(rt.routerCalls.back, 1);

    for (let i = 0; i < 20 && h.desktop.active !== null; i += 1) {
      await new Promise(r => setTimeout(r, 15));
    }
    assert.equal(h.desktop.active, null);
  } finally {
    await rt.unmount();
  }
});

test('[T2-F14-05] stalled 200ms host stop on leave does not block synchronous DesktopScreen exit or portrait restore', async t => {
  const h = await bootGateway(t, { hostConfig: { failOperation: { stop: { hangMs: 200 } } } });
  const rt = await mountDesktopScreenRuntime({ harness: h, canGoBack: true });
  try {
    await rt.pressTestId('desktop-connect');
    assert.equal(rt.getStackScreenOptions().orientation, 'landscape');

    const t0 = Date.now();
    await rt.pressTestId('desktop-exit');
    const syncElapsed = Date.now() - t0;
    assert.ok(syncElapsed < 50, `Expected synchronous exit < 50ms, took ${syncElapsed}ms`);
    assert.equal(rt.getStackScreenOptions().orientation, 'portrait');
    assert.equal(rt.routerCalls.back, 1);

    for (let i = 0; i < 25 && h.desktop.active !== null; i += 1) {
      await new Promise(r => setTimeout(r, 15));
    }
    assert.equal(h.desktop.active, null);
  } finally {
    await rt.unmount();
  }
});

// --- F15: Native Touch Scroll, Coalescing Queue, Write-Fence & Localization Boundaries (6 tests) ---

test('[T2-F15-01] DesktopCanvas PanResponder dispatches click at exact 6.0pt and throttled anchored scroll at 6.01pt (60ms gate)', async t => {
  const h = await bootGateway(t, { hostConfig: { headless: true } });
  const rt = await mountRemoteDesktopViewRuntime({ harness: h });
  const realDateNow = Date.now;
  try {
    await rt.pressTestId('desktop-connect');
    await rt.layoutCanvas(393, 786);
    const responder = rt.findCanvasResponder();
    assert.ok(responder);
    await h.hostFixture.clearEvents();

    await responder.grant(196.5, 393);
    await responder.move(196.5, 399.0);
    await responder.release(196.5, 399.0);

    const exact6Inputs = (await h.hostFixture.getEvents()).filter((/** @type {Value} */ e) => e.type === 'input');
    assert.equal(exact6Inputs.length, 1);
    assert.equal(exact6Inputs[0].action, 'pointer');
    assert.deepEqual(exact6Inputs[0].cursor, { x: 0.5, y: 0.5 });

    await h.hostFixture.clearEvents();
    let mockClock = realDateNow() + 1000;
    Date.now = () => mockClock;

    await responder.grant(196.5, 393);
    await responder.move(196.5, 399.01);
    mockClock += 20;
    await responder.move(196.5, 410);
    mockClock += 50;
    await responder.move(196.5, 425);
    await responder.release(196.5, 425);

    const scrollInputs = (await h.hostFixture.getEvents()).filter((/** @type {Value} */ e) => e.type === 'input');
    assert.equal(scrollInputs.length, 2);
    assert.equal(scrollInputs[0].action, 'scroll');
    assert.equal(scrollInputs[0].deltaY, 6);
    assert.deepEqual(scrollInputs[0].cursor, { x: 0.5, y: 0.5 });
    assert.equal(scrollInputs[1].action, 'scroll');
    assert.equal(scrollInputs[1].deltaY, 26);
    assert.deepEqual(scrollInputs[1].cursor, { x: 0.5, y: 0.5 });
  } finally {
    Date.now = realDateNow;
    await rt.unmount();
  }
});

test('[T2-F15-02] real DesktopInputQueue preserves (0,0) anchor, unanchored-before-anchored keys, and splits >1200 coalesced scrolls', async () => {
  const syncRt = await createMobileSyncRuntime(null);
  try {
    const { DesktopInputQueue } = syncRt;
    /** @type {(() => void) | null} */ let releaseFirst = null;
    const gate = new Promise(/** @param {(v?: unknown) => void} r */ r => { releaseFirst = () => r(); });
    /** @type {Value[]} */ const dispatched = [];
    const queue = new DesktopInputQueue(async (/** @type {Value} */ item) => {
      dispatched.push(item);
      if (dispatched.length === 1) await gate;
    }, () => { throw new Error('unexpected queue failure'); });

    const p0 = queue.send({ action: 'pointer', phase: 'down', x: 0.1, y: 0.1 });
    const p1 = queue.send({ action: 'scroll', deltaY: 100, x: 0, y: 0 });
    const p2 = queue.send({ action: 'scroll', deltaY: 150, x: 0.85, y: 0.75 });
    const p3 = queue.send({ action: 'scroll', deltaY: -60, x: 1, y: 1 });
    const p4 = queue.send({ action: 'scroll', deltaY: -40, x: 0.2, y: 0.3 });
    const p5 = queue.send({ action: 'text', text: '中' });
    const p6 = queue.send({ action: 'scroll', deltaY: 50 });
    const p7 = queue.send({ action: 'scroll', deltaY: 70, x: 0.9, y: 0.9 });
    const p8 = queue.send({ action: 'text', text: 'split' });
    const p9 = queue.send({ action: 'scroll', deltaY: 800, x: 0.3, y: 0.4 });
    const p10 = queue.send({ action: 'scroll', deltaY: 500, x: 0.7, y: 0.8 });

    /** @type {any} */ (releaseFirst)?.();
    await Promise.all([p0, p1, p2, p3, p4, p5, p6, p7, p8, p9, p10]);

    assert.deepEqual(dispatched, [
      { action: 'pointer', phase: 'down', x: 0.1, y: 0.1 },
      { action: 'scroll', deltaY: 250, x: 0, y: 0 },
      { action: 'scroll', deltaY: -100, x: 1, y: 1 },
      { action: 'text', text: '中' },
      { action: 'scroll', deltaY: 120 },
      { action: 'text', text: 'split' },
      { action: 'scroll', deltaY: 800, x: 0.3, y: 0.4 },
      { action: 'scroll', deltaY: 500, x: 0.7, y: 0.8 },
    ]);
    assert.deepEqual(Object.keys(dispatched[4]), ['action', 'deltaY']);
  } finally {
    syncRt.dispose();
  }
});

test('[T2-F15-03] real DesktopInputQueue never coalesces opposite-sign scrolls or scrolls separated by key input', async () => {
  const syncRt = await createMobileSyncRuntime(null);
  try {
    const { DesktopInputQueue } = syncRt;
    /** @type {Value[]} */ const sent = [];
    /** @type {(() => void) | null} */ let releaseFirst = null;
    const q = new DesktopInputQueue(
      async (/** @type {Value} */ item) => {
        sent.push(item);
        if (sent.length === 1) await new Promise(r => { releaseFirst = /** @type {() => void} */ (r); });
      },
      () => { throw new Error('unexpected queue failure'); },
    );
    const jobs = [
      q.send({ action: 'pointer', phase: 'click', x: 0.5, y: 0.5 }),
      q.send({ action: 'scroll', deltaY: 300, x: 0.2, y: 0.3 }),
      q.send({ action: 'scroll', deltaY: -200, x: 0.4, y: 0.5 }),
      q.send({ action: 'key', key: 'escape', modifiers: [] }),
      q.send({ action: 'scroll', deltaY: -100, x: 0.6, y: 0.7 }),
    ];
    await new Promise(r => setTimeout(r, 5));
    /** @type {any} */ (releaseFirst)?.();
    await Promise.all(jobs);
    assert.equal(sent.length, 5);
    assert.deepEqual(sent.slice(1).map(s => s.action === 'scroll' ? s.deltaY : s.key), [300, -200, 'escape', -100]);
  } finally {
    syncRt.dispose();
  }
});

test('[T2-F15-04] real DesktopInputQueue fails closed at >16 waiting items with DesktopInputQueueError desktop-input-busy', async () => {
  const syncRt = await createMobileSyncRuntime(null);
  try {
    const { DesktopInputQueue, DesktopInputQueueError } = syncRt;
    /** @type {Value[]} */ const failures = [];
    /** @type {(() => void) | null} */ let releaseFirst = null;
    const q = new DesktopInputQueue(
      async () => { await new Promise(r => { releaseFirst = /** @type {() => void} */ (r); }); },
      (/** @type {Value} */ err) => { failures.push(err); },
    );
    const inFlight = q.send({ action: 'key', key: 'a', modifiers: [] });
    const queued = Array.from({ length: 16 }, () => q.send({ action: 'key', key: 'tab', modifiers: [] }));
    const overflow = await q.send({ action: 'key', key: 'enter', modifiers: [] });
    assert.equal(overflow, false);
    assert.equal(failures.length, 1);
    assert.equal(failures[0] instanceof DesktopInputQueueError, true);
    assert.equal(failures[0].code, 'desktop-input-busy');
    /** @type {any} */ (releaseFirst)?.();
    assert.deepEqual(await Promise.all(queued), Array(16).fill(false));
    assert.equal(await inFlight, false);
  } finally {
    syncRt.dispose();
  }
});

test('[T2-F15-05] real peerNetwork route write fence admits POST windows while blocking POST window and input with preferred-route-unavailable', async () => {
  const syncRt = await createMobileSyncRuntime(null);
  const { peerNetworkMod } = syncRt;
  const macPair = nacl.box.keyPair(), devPair = nacl.box.keyPair();
  const origin = 'http://192.168.50.2:41234';
  const peer = {
    id: 'a'.repeat(64),
    key: Buffer.from(macPair.publicKey).toString('base64url'),
    channels: [{ id: 'lan_1', kind: 'local', url: origin, label: 'Local' }],
    device: {
      publicKey: Buffer.from(devPair.publicKey).toString('base64url'),
      secretKey: Buffer.from(devPair.secretKey).toString('base64url'),
    },
  };
  peerNetworkMod.setPeerRouteWriteFence(peer, null);
  try {
    const winListAuth = peerNetworkMod.peerAuthorization('tok', peer, origin, 'POST', `${origin}/api/peer/desktop/windows`);
    assert.match(winListAuth, /^Codelync\s+/u);

    assert.throws(
      () => peerNetworkMod.peerAuthorization('tok', peer, origin, 'POST', `${origin}/api/peer/desktop/window`),
      (/** @type {Value} */ err) => err?.code === 'preferred-route-unavailable' && err?.effectMayHaveOccurred === false,
    );
    assert.throws(
      () => peerNetworkMod.peerAuthorization('tok', peer, origin, 'POST', `${origin}/api/peer/desktop/input`),
      (/** @type {Value} */ err) => err?.code === 'preferred-route-unavailable' && err?.effectMayHaveOccurred === false,
    );
  } finally {
    peerNetworkMod.setPeerRouteWriteFence(null);
    syncRt.dispose();
  }
});

test('[T2-F15-06] Localization boundaries: zh-CN vs zh-Hant prefix disambiguation, unknown locale -> en fallback, and unknown error code -> localized unavailable across all 4 locales', async () => {
  const i18n = await loadRemoteDesktopLabelsRuntime();
  try {
    i18n.setLanguage('en');
    const en = i18n.remoteDesktopLabels();
    i18n.setLanguage('zh-Hans');
    const zhHans = i18n.remoteDesktopLabels();
    i18n.setLanguage('zh-Hant');
    const zhHant = i18n.remoteDesktopLabels();

    i18n.setLanguage('zh-CN');
    assert.deepEqual(i18n.remoteDesktopLabels(), zhHans);
    assert.equal(i18n.remoteDesktopError('desktop-virtual-display-required'), zhHans.virtualDisplayRequired);
    assert.notEqual(zhHant.virtualDisplayRequired, zhHans.virtualDisplayRequired);

    assert.equal(i18n.resolvePreferredLanguage('zh-CN'), 'zh-Hans');
    assert.equal(i18n.resolvePreferredLanguage('zh-TW'), 'zh-Hant');
    assert.equal(i18n.resolvePreferredLanguage('zh-HK'), 'zh-Hant');
    assert.equal(i18n.resolveLanguage('fr-FR', []), 'en');

    for (const fallbackLang of ['fr-FR', 'de-DE', '']) {
      i18n.setLanguage(fallbackLang);
      assert.deepEqual(i18n.remoteDesktopLabels(), en);
      assert.equal(i18n.remoteDesktopError('desktop-window-unavailable'), en.windowUnavailable);
    }

    for (const lang of ['en', 'zh-Hans', 'zh-Hant', 'ja']) {
      i18n.setLanguage(lang);
      const labels = i18n.remoteDesktopLabels();
      for (const unknownCode of ['unknown-future-desktop-error', 'invalid-desktop-operation', '']) {
        assert.equal(i18n.remoteDesktopError(unknownCode), labels.unavailable);
      }
      assert.equal(
        i18n.remoteDesktopError('desktop-accessibility-required'),
        i18n.remoteDesktopError('desktop-input-permission-required'),
      );
      assert.equal(i18n.remoteDesktopError('desktop-accessibility-required'), labels.inputPermission);
    }
  } finally {
    i18n.dispose();
  }
});

// --- F16: R4 Non-Intrusion, Session Admission Fence & Security Boundaries (6 tests) ---

test('[T2-F16-01] synthetic zoom keys (+, -, =) and unknown input keys fail closed with 400 invalid-desktop-input', async t => {
  const { hostFactory, acceptedInputs } = createInputValidatingHostFactory();
  const h = await bootGateway(t, { hostFactory });
  const { binding } = await connectReadySession(h, 'virtual');

  let seq = 0;
  for (const zoomKey of ['+', '-', '=']) {
    const res = await h.requestDesktopHttp('input', {
      ...binding, sequence: ++seq, input: { action: 'key', key: zoomKey, modifiers: ['command'] },
    });
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.equal(res.error, 'invalid-desktop-input');
  }
  const extraKeyRes = await h.requestDesktopHttp('input', {
    ...binding, sequence: ++seq, input: { action: 'key', key: 'c', modifiers: ['command'], keyCode: 24 },
  });
  assert.equal(extraKeyRes.ok, false);
  assert.equal(extraKeyRes.status, 400);
  assert.equal(extraKeyRes.error, 'invalid-desktop-input');
  assert.equal(acceptedInputs.length, 0);
});

test('[T2-F16-02] isCodelyncNativeSource rejects window descriptors across Codex, Antigravity, and Claude and blocks windowId session route', async t => {
  const hostHash = 'a'.repeat(64);
  assert.equal(isCodelyncNativeSource({ app: 'codex', kind: 'window', id: '1001:5001' }), false);
  assert.equal(isCodelyncNativeSource({ app: 'codex', kind: 'session', id: 's1' }, { controlMode: 'window' }), false);
  assert.equal(isCodelyncNativeSource({ app: 'codex', kind: 'session', id: 's1' }, { bridge: { controlMode: 'window' } }), false);
  assert.equal(isCodelyncNativeSource({
    app: 'antigravity', kind: 'window', protocol: 'antigravity-connect', runtimeGeneration: 'g1', hostId: `local:antigravity:${hostHash}`,
  }), false);
  assert.equal(isCodelyncNativeSource({
    app: 'claude-desktop', kind: 'window', id: '1001:5001', protocol: 'claude-desktop-native',
    runtimeGeneration: 'g1', hostId: `local:claude-desktop:${hostHash}`, appMode: 'code', nativeCollection: 'claude-code-sessions',
  }), false);

  const h = await bootGateway(t);
  const path = '/api/peer/sessions/1001%3A5001/history';
  const res = await fetch(h.loopbackBase + path, { method: 'GET', headers: { Authorization: h.authHeader(path, 'GET') } });
  assert.equal(res.status, 503);
  const json = /** @type {Value} */ (await res.json());
  assert.equal(json.error, 'source-unavailable');
});

test('[T2-F16-03] 1-byte tampered CodelyncDesktopHost copy fails verifyNativeRuntimeManifest with SHA-256 mismatch', async t => {
  const validManifest = await verifyNativeRuntimeManifest();
  assert.equal(validManifest.version, 1);

  const tmp = await mkdtemp(join(tmpdir(), 'codelync-t2-manifest-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  await cp(join(REPO_ROOT, 'native/bin/desktop-runtime.json'), join(tmp, 'desktop-runtime.json'));
  const binBytes = Buffer.from(await readFile(join(REPO_ROOT, 'native/bin/CodelyncDesktopHost')));
  binBytes[0] ^= 0xff;
  await writeFile(join(tmp, 'CodelyncDesktopHost'), binBytes);
  await assert.rejects(verifyNativeRuntimeManifest(tmp), /SHA-256 mismatch for CodelyncDesktopHost/u);
});

test('[T2-F16-04] >16KiB gateway body, unauthorized device, expired timestamp, and replayed sealed packet fail closed', async t => {
  const clock = Date.now();
  const h = await bootGateway(t, { now: () => clock });
  const { binding } = await connectReadySession(h, 'virtual');

  const bigRes = await h.requestDesktopHttp('window', {}, { rawBody: JSON.stringify({ pad: 'x'.repeat(17_000) }) });
  assert.equal(bigRes.ok, false);
  assert.equal(bigRes.status, 400);
  assert.equal(bigRes.error, 'peer-request-failed');

  const unauthRes = await h.requestDesktopHttp('window', { ...binding, sequence: 1, mode: 'restore' }, { signer: h.intruder });
  assert.equal(unauthRes.ok, false);
  assert.equal(unauthRes.status, 401);

  const sealed = JSON.stringify(h.sealDesktopBody('window', { ...binding, sequence: 1, mode: 'restore' }));
  const firstOk = await h.requestDesktopHttp('window', {}, { rawBody: sealed });
  assert.equal(firstOk.ok, true);

  const replayRes = await h.requestDesktopHttp('window', {}, { rawBody: sealed });
  assert.equal(replayRes.ok, false);
  assert.equal(replayRes.status, 409);
  assert.equal(replayRes.error, 'desktop-request-replayed');

  const expiredNonce = randomBytes(24);
  const expiredPlain = Buffer.from(JSON.stringify({ version: 1, at: clock - 35_000, action: 'windows' }));
  const expiredPacket = JSON.stringify({
    version: 1,
    nonce: expiredNonce.toString('base64url'),
    ciphertext: Buffer.from(nacl.box(expiredPlain, expiredNonce, h.mac.publicKey, h.phone.secretKey)).toString('base64url'),
  });
  const expiredRes = await h.requestDesktopHttp('windows', {}, { rawBody: expiredPacket });
  assert.equal(expiredRes.ok, false);
  assert.equal(expiredRes.status, 409);
  assert.equal(expiredRes.error, 'desktop-request-expired');
});

test('[T2-F16-05] mismatched optional generation fails closed on windows/window and RemoteDesktopView writable false fences mutations', async t => {
  const h = await bootGateway(t);
  const { grant } = await connectReadySession(h, 'virtual');

  const omittedList = await h.requestDesktopHttp('windows', { connectionId: grant.connectionId });
  assert.equal(omittedList.ok, true);

  const badList = await h.requestDesktopHttp('windows', { connectionId: grant.connectionId, generation: 'stale-generation' });
  assert.equal(badList.ok, false);
  assert.equal(badList.status, 409);
  assert.equal(badList.error, 'desktop-not-active');

  const badWin = await h.requestDesktopHttp('window', {
    connectionId: grant.connectionId, generation: 'stale-generation', geometry: grant.display.geometry, sequence: 1, mode: 'restore',
  });
  assert.equal(badWin.ok, false);
  assert.equal(badWin.status, 409);
  assert.equal(badWin.error, 'desktop-disconnected');

  const omittedWin = await h.requestDesktopHttp('window', {
    connectionId: grant.connectionId, geometry: grant.display.geometry, sequence: 1, mode: 'restore',
  });
  assert.equal(omittedWin.ok, true);

  const uiGw = await bootGateway(t, { hostConfig: { headless: true } });
  const rt = await mountRemoteDesktopViewRuntime({ harness: uiGw, writable: true });
  try {
    await rt.pressTestId('desktop-connect');
    await rt.setWritable(false);
    await rt.pressTestId('desktop-windows');
    assert.notEqual(rt.findByTestId('desktop-windows-panel'), null);
    assert.equal(rt.findByTestId('desktop-window-1001:5001')?.props?.disabled, true);
    assert.equal(rt.findByTestId('desktop-windows-restore')?.props?.disabled, true);
    assert.equal(await rt.pressTestId('desktop-window-1001:5001'), false);
  } finally {
    await rt.unmount();
  }
});

test('[T2-F16-06] revoking paired device mid-Phone-Screen session tears down virtual display, revokes media, and blocks HTTP', async t => {
  const h = await bootGateway(t);
  const { grant, binding } = await connectReadySession(h, 'virtual');
  const fillRes = await h.requestDesktopHttp('window', { ...binding, sequence: 1, mode: 'fill', windowId: '1001:5001' });
  assert.equal(fillRes.ok, true);

  await h.devices.revoke(h.deviceId);
  await h.desktop.serial;
  assert.equal(h.desktop.active, null);

  await assert.rejects(
    h.desktop.mediaUpstream(`/api/peer/desktop/media/rtc?access_token=${encodeURIComponent(grant.token)}`),
    (/** @type {Value} */ err) => err?.code === 'desktop-media-unauthorized' && err?.status === 401,
  );

  const revokedHttp = await h.requestDesktopHttp('windows', {});
  assert.equal(revokedHttp.ok, false);
  assert.equal(revokedHttp.status, 401);

  let evts = await h.hostFixture.getEvents();
  for (let i = 0; i < 20 && !evts.some((/** @type {Value} */ e) => e.type === 'restore-windows'); i++) {
    await new Promise(r => setTimeout(r, 10));
    evts = await h.hostFixture.getEvents();
  }
  assert.equal(
    evts.some((/** @type {Value} */ e) => e.type === 'restore-windows' && ['stop', 'SIGTERM', 'stdin-eof', 'startup'].includes(e.trigger)),
    true,
  );
  assert.equal(evts.some((/** @type {Value} */ e) => e.type === 'release-virtual-display'), true);
  await assert.rejects(access(join(h.desktopState, 'window-restore.json')));
});
