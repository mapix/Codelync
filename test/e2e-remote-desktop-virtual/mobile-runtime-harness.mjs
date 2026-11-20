import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuildBuild } from 'esbuild';
import nacl from 'tweetnacl';
import * as wireCodelync from '@codelync/wire/codelync';
import * as wirePeerCodec from '@codelync/wire/peer-codec';

/** @typedef {Record<string, any>} AnyRecord */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MOBILE_ROOT = join(REPO_ROOT, 'apps/mobile');
const MOBILE_SOURCES_ROOT = join(MOBILE_ROOT, 'sources');
const mobileRequire = createRequire(join(MOBILE_ROOT, 'package.json'));

const React = mobileRequire('react');
const jsxRuntime = mobileRequire('react/jsx-runtime');
const ReactTestRenderer = mobileRequire('react-test-renderer');
const { act: rawAct, create: createRenderer } = ReactTestRenderer;

/** @type {AnyRecord} */ (globalThis).IS_REACT_ACT_ENVIRONMENT = true;
if (typeof globalThis.requestAnimationFrame !== 'function') {
  /** @type {AnyRecord} */ (globalThis).requestAnimationFrame = (/** @type {(time: number) => void} */ cb) => {
    cb(0);
    return 1;
  };
}
if (typeof globalThis.cancelAnimationFrame !== 'function') {
  /** @type {AnyRecord} */ (globalThis).cancelAnimationFrame = () => {};
}

/**
 * @param {unknown} style
 * @returns {AnyRecord}
 */
export function flattenStyle(style) {
  if (!style) return {};
  if (typeof style === 'function') {
    return flattenStyle(style({ pressed: false }));
  }
  if (Array.isArray(style)) {
    /** @type {AnyRecord} */
    const merged = {};
    for (const item of style) {
      Object.assign(merged, flattenStyle(item));
    }
    return merged;
  }
  return typeof style === 'object' ? { .../** @type {AnyRecord} */ (style) } : {};
}

/**
 * @param {string} tagName
 * @param {AnyRecord} rawProps
 */
function renderHostElement(tagName, rawProps) {
  const props = rawProps ? { ...rawProps } : {};
  const children = props.children;
  delete props.children;
  if (props.style !== undefined) {
    props.style = flattenStyle(props.style);
  }
  return children !== undefined
    ? React.createElement(tagName, props, children)
    : React.createElement(tagName, props);
}

/** @type {Map<string, AnyRecord>} */
const instanceRegistry = /** @type {AnyRecord} */ (globalThis).__codelyncMobileRtRegistry
  ?? new Map();
/** @type {AnyRecord} */ (globalThis).__codelyncMobileRtRegistry = instanceRegistry;

/** @type {AnyRecord} */ (globalThis).__codelyncMobileRtShared = {
  React,
  jsxRuntime,
  ReactTestRenderer,
  nacl,
  wireCodelync,
  wirePeerCodec,
  flattenStyle,
  renderHostElement,
  /** @param {number} size */
  getRandomBytes(size) {
    return new Uint8Array(randomBytes(size));
  },
};

const ENTRY_MODULE_SOURCE = [
  "export { default as DesktopScreen } from './apps/mobile/sources/app/(app)/desktop.tsx';",
  "export { RemoteDesktopView } from './apps/mobile/sources/components/RemoteDesktopView.tsx';",
  "export { RemoteDesktopKeyboard } from './apps/mobile/sources/components/RemoteDesktopKeyboard.tsx';",
  "export { useRemoteDesktop } from './apps/mobile/sources/hooks/useRemoteDesktop.ts';",
  "export { desktopRequest, DesktopRequestError, desktopBinding, desktopPoint } from './apps/mobile/sources/sync/remoteDesktop.ts';",
  "export { DesktopInputQueue, DesktopInputQueueError, desktopInputAcknowledged } from './apps/mobile/sources/sync/desktopInputQueue.ts';",
  "export { desktopViewportFocus } from './apps/mobile/sources/sync/desktopViewportFocus.ts';",
  "export { DESKTOP_TEXT_LIMIT, desktopTextSubmission, acknowledgeDesktopText } from './apps/mobile/sources/sync/desktopKeyboardDraft.ts';",
  "export { peerAuthorization, decodePeerResponse, decodePeerResponseAsync, setPeerRouteWriteFence, peerRouteWritable } from './apps/mobile/sources/sync/peerNetwork.ts';",
  "export { remoteDesktopLabels, remoteDesktopError } from './apps/mobile/sources/text/remoteDesktopLabels.ts';",
  "export { resolvePreferredLanguage, resolveLanguage } from './apps/mobile/sources/text/resolveLanguage.ts';",
].join('\n');

/** @type {Record<string, string>} */
const STUB_MODULES = {
  tweetnacl: [
    'const N = globalThis.__codelyncMobileRtShared.nacl;',
    'export default N;',
    'export const { box, secretbox, sign, hash, verify, randomBytes } = N;',
  ].join('\n'),

  '@codelync/wire/codelync': [
    'const W = globalThis.__codelyncMobileRtShared.wireCodelync;',
    'export const { CHANNEL_KINDS, isPrivateHost, channelOrigin, channelList, channelPath, peerMaterial, rpcTarget } = W;',
  ].join('\n'),

  '@codelync/wire/peer-codec': [
    'const P = globalThis.__codelyncMobileRtShared.wirePeerCodec;',
    'export const {',
    '  PEER_RESPONSE_CODEC_HEADER, PEER_RESPONSE_CODEC_VALUE, PEER_RESPONSE_MAX_BYTES,',
    '  decodeCompactPeerPlaintext, inspectCompactPeerPlaintext, parseCompactPeerJson,',
    '} = P;',
  ].join('\n'),

  react: [
    'const S = globalThis.__codelyncMobileRtShared;',
    'const R = S.React;',
    'export default R;',
    'export const {',
    '  Children, Component, Fragment, PureComponent, StrictMode, Suspense,',
    '  cloneElement, createContext, createElement, createRef, forwardRef, isValidElement, lazy, memo,',
    '  startTransition, use, useActionState, useCallback, useContext, useDebugValue, useDeferredValue,',
    '  useEffect, useId, useImperativeHandle, useInsertionEffect, useLayoutEffect, useMemo,',
    '  useOptimistic, useReducer, useRef, useState, useSyncExternalStore, useTransition, version,',
    '} = R;',
  ].join('\n'),

  'react/jsx-runtime': [
    'const J = globalThis.__codelyncMobileRtShared.jsxRuntime;',
    'export const Fragment = J.Fragment;',
    'export const jsx = J.jsx;',
    'export const jsxs = J.jsxs;',
    'export default J;',
  ].join('\n'),

  'react/jsx-dev-runtime': [
    'const J = globalThis.__codelyncMobileRtShared.jsxRuntime;',
    'export const Fragment = J.Fragment;',
    'export const jsxDEV = J.jsx;',
    'export default J;',
  ].join('\n'),

  'react-native': [
    'const S = globalThis.__codelyncMobileRtShared;',
    'const R = S.React;',
    'const inst = () => globalThis.__codelyncMobileRtRegistry.get(__INSTANCE_ID__);',
    'const host = (name) => (props) => S.renderHostElement(name, props);',
    'export const View = host("View");',
    'export const Text = host("Text");',
    'export const Pressable = host("Pressable");',
    'export const ScrollView = host("ScrollView");',
    'export const ActivityIndicator = host("ActivityIndicator");',
    'export const Modal = host("Modal");',
    'export const TextInput = R.forwardRef((props, ref) => {',
    '  R.useImperativeHandle(ref, () => ({ focus: () => {}, blur: () => {}, isFocused: () => false }));',
    '  return S.renderHostElement("TextInput", props);',
    '});',
    'export const Platform = {',
    '  get OS() { return inst().platform; },',
    '  get isPad() { return inst().isPad; },',
    '  select: (values) => values[inst().platform] ?? values.default,',
    '};',
    'export const Dimensions = {',
    '  get: () => ({ width: inst().window.width, height: inst().window.height }),',
    '};',
    'export function useWindowDimensions() {',
    '  const cur = inst();',
    '  cur.useEnvSubscription();',
    '  return cur.window;',
    '}',
    'export const AppState = {',
    '  currentState: "active",',
    '  addEventListener: (_event, handler) => inst().addAppStateListener(handler),',
    '};',
    'export const BackHandler = {',
    '  addEventListener: (_event, handler) => inst().addBackListener(handler),',
    '};',
    'export const Keyboard = {',
    '  dismiss: () => { inst().keyboardDismissCalls += 1; },',
    '  addListener: (name, handler) => inst().addKeyboardListener(name, handler),',
    '};',
    'export const PanResponder = {',
    '  create: (config) => ({ panHandlers: config }),',
    '};',
    'const absFill = { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 };',
    'export const StyleSheet = {',
    '  hairlineWidth: 0.5,',
    '  absoluteFill: absFill,',
    '  absoluteFillObject: absFill,',
    '  flatten: S.flattenStyle,',
    '  create: (styles) => (typeof styles === "function" ? styles() : styles),',
    '};',
  ].join('\n'),

  'react-native-unistyles': [
    'const S = globalThis.__codelyncMobileRtShared;',
    'const absFill = { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 };',
    'export const StyleSheet = {',
    '  hairlineWidth: 0.5,',
    '  absoluteFill: absFill,',
    '  absoluteFillObject: absFill,',
    '  flatten: S.flattenStyle,',
    '  create: (styles) => (typeof styles === "function" ? styles() : styles),',
    '};',
  ].join('\n'),

  'react-native-safe-area-context': [
    'const inst = () => globalThis.__codelyncMobileRtRegistry.get(__INSTANCE_ID__);',
    'export function useSafeAreaInsets() {',
    '  const cur = inst();',
    '  cur.useEnvSubscription();',
    '  return cur.insets;',
    '}',
    'export const initialWindowMetrics = {',
    '  get frame() {',
    '    const m = inst().initialMetrics;',
    '    return m && m.frame ? m.frame : { x: 0, y: 0, width: 0, height: 0 };',
    '  },',
    '  get insets() {',
    '    const m = inst().initialMetrics;',
    '    return m && m.insets ? m.insets : { top: 0, right: 0, bottom: 0, left: 0 };',
    '  },',
    '};',
  ].join('\n'),

  'expo-blur': [
    'const S = globalThis.__codelyncMobileRtShared;',
    'export const BlurView = (props) => S.renderHostElement("BlurView", props);',
  ].join('\n'),

  '@expo/vector-icons': [
    'const S = globalThis.__codelyncMobileRtShared;',
    'export const Ionicons = (props) => S.renderHostElement("Ionicons", props);',
  ].join('\n'),

  'expo-router': [
    'const S = globalThis.__codelyncMobileRtShared;',
    'const inst = () => globalThis.__codelyncMobileRtRegistry.get(__INSTANCE_ID__);',
    'export const Stack = {',
    '  Screen: (props) => {',
    '    if (props && props.options) inst().lastScreenOptions = props.options;',
    '    return S.renderHostElement("Screen", props);',
    '  },',
    '};',
    'export const Redirect = (props) => S.renderHostElement("Redirect", props);',
    'export const useRouter = () => inst().router;',
  ].join('\n'),

  '@react-navigation/native': [
    'const inst = () => globalThis.__codelyncMobileRtRegistry.get(__INSTANCE_ID__);',
    'export function useIsFocused() {',
    '  const cur = inst();',
    '  cur.useEnvSubscription();',
    '  return cur.getIsFocused();',
    '}',
  ].join('\n'),

  '@/auth/AuthContext': [
    'const inst = () => globalThis.__codelyncMobileRtRegistry.get(__INSTANCE_ID__);',
    'export function useAuth() {',
    '  const cur = inst();',
    '  cur.useEnvSubscription();',
    '  return cur.getAuth();',
    '}',
  ].join('\n'),

  '@/sync/storage': [
    'const inst = () => globalThis.__codelyncMobileRtRegistry.get(__INSTANCE_ID__);',
    'export function useLocalSetting(key) {',
    '  const cur = inst();',
    '  cur.useEnvSubscription();',
    '  return key === "remoteDesktopEnabled" ? cur.enabled : undefined;',
    '}',
  ].join('\n'),

  '@/components/onboarding/CodelyncScanScreen': [
    'const S = globalThis.__codelyncMobileRtShared;',
    'export const CodelyncScanScreen = (props) => S.renderHostElement("CodelyncScanScreen", props);',
  ].join('\n'),

  'livekit-client': [
    'const inst = () => globalThis.__codelyncMobileRtRegistry.get(__INSTANCE_ID__);',
    'export const Track = { Source: { ScreenShare: "screen_share" } };',
    'export const RoomEvent = {',
    '  Disconnected: "disconnected",',
    '  Reconnecting: "reconnecting",',
    '  EncryptionError: "encryptionError",',
    '};',
    'export function setLogLevel() {}',
    'export class RemoteVideoTrack {',
    '  constructor(trackSid) { this.sid = trackSid; }',
    '  async getReceiverStats() { return inst().getReceiverStats(this.sid); }',
    '}',
    'export class Room {',
    '  constructor() {',
    '    this.connected = false;',
    '    this.url = "";',
    '    this.token = "";',
    '    this.hostIdentity = "";',
    '    this.listeners = new Map();',
    '  }',
    '  on(ev, cb) {',
    '    if (!this.listeners.has(ev)) this.listeners.set(ev, new Set());',
    '    this.listeners.get(ev).add(cb);',
    '    return this;',
    '  }',
    '  emit(ev, ...args) {',
    '    for (const cb of this.listeners.get(ev) ?? []) cb(...args);',
    '  }',
    '  async setE2EEEnabled() {}',
    '  async connect(url, token) {',
    '    this.url = url;',
    '    this.token = token;',
    '    this.connected = true;',
    '    inst().onRoomConnect(this, url, token);',
    '  }',
    '  async disconnect() {',
    '    this.connected = false;',
    '    inst().onRoomDisconnect(this);',
    '  }',
    '}',
  ].join('\n'),

  '@livekit/react-native': [
    'import { RemoteVideoTrack } from "livekit-client";',
    'const S = globalThis.__codelyncMobileRtShared;',
    'const R = S.React;',
    'const inst = () => globalThis.__codelyncMobileRtRegistry.get(__INSTANCE_ID__);',
    'export const RoomContext = R.createContext(null);',
    'export const VideoTrack = (props) => S.renderHostElement("VideoTrack", props);',
    'export function isTrackReference(ref) { return Boolean(ref && ref.__isTrackRef); }',
    'export function useTracks() {',
    '  const cur = inst();',
    '  const room = R.useContext(RoomContext);',
    '  cur.useMediaSubscription();',
    '  return cur.buildTrackReferences(room, RemoteVideoTrack);',
    '}',
    'export function registerGlobals() {}',
    'export class RNKeyProvider {',
    '  constructor() { this.disposed = false; }',
    '  async setSharedKey() {}',
    '  dispose() { this.disposed = true; }',
    '}',
    'export class RNE2EEManager {',
    '  constructor() {}',
    '}',
  ].join('\n'),

  'expo-crypto': [
    'const S = globalThis.__codelyncMobileRtShared;',
    'export const getRandomBytes = (size) => S.getRandomBytes(size);',
  ].join('\n'),

  '@/auth/tokenStorage': [
    'const inst = () => globalThis.__codelyncMobileRtRegistry.get(__INSTANCE_ID__);',
    'export const TokenStorage = {',
    '  getCredentials: async () => inst().getCredentials(),',
    '  setCredentials: async (val) => inst().setCredentials(val),',
    '};',
  ].join('\n'),

  '@/sync/serverConfig': [
    'const inst = () => globalThis.__codelyncMobileRtRegistry.get(__INSTANCE_ID__);',
    'export const getServerUrl = () => inst().getServerUrl();',
    'export const commitPeerServerUrl = (url) => inst().setServerUrl(url);',
  ].join('\n'),

  '@/sync/codelyncConnection': [
    'const inst = () => globalThis.__codelyncMobileRtRegistry.get(__INSTANCE_ID__);',
    'export const getConnectionSnapshot = () => inst().getConnectionSnapshot();',
    'export const subscribeConnection = (cb) => inst().subscribeConnection(cb);',
  ].join('\n'),

  '@/text': [
    'const inst = () => globalThis.__codelyncMobileRtRegistry.get(__INSTANCE_ID__);',
    'export const getCurrentLanguage = () => inst().language;',
    'export const t = (key) => String(key);',
  ].join('\n'),
};

/** @type {Promise<string> | null} */
let compiledBundlePromise = null;
let nextInstanceCounter = 0;

/** @returns {Promise<string>} */
function getCompiledMobileBundle() {
  if (!compiledBundlePromise) {
    compiledBundlePromise = (async () => {
      const result = await esbuildBuild({
        stdin: {
          contents: ENTRY_MODULE_SOURCE,
          resolveDir: REPO_ROOT,
          sourcefile: 'mobile-runtime-entry.tsx',
          loader: 'tsx',
        },
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'node',
        target: 'node24',
        jsx: 'automatic',
        logLevel: 'silent',
        nodePaths: [join(MOBILE_ROOT, 'node_modules'), join(REPO_ROOT, 'node_modules')],
        tsconfigRaw: JSON.stringify({
          compilerOptions: {
            jsx: 'react-jsx',
            strict: true,
            target: 'ES2022',
          },
        }),
        plugins: [
          {
            name: 'codelync-mobile-rt-stubs',
            setup(build) {
              build.onResolve({ filter: /.*/ }, async (args) => {
                if (Object.prototype.hasOwnProperty.call(STUB_MODULES, args.path)) {
                  return { path: args.path, namespace: 'codelync-rt-stub' };
                }
                if (args.path === './serverConfig' && args.importer.includes('/sources/sync/')) {
                  return { path: '@/sync/serverConfig', namespace: 'codelync-rt-stub' };
                }
                if (args.path === './index' && args.importer.includes('/sources/text/')) {
                  return { path: '@/text', namespace: 'codelync-rt-stub' };
                }
                if (args.path.startsWith('@/')) {
                  const subPath = './' + args.path.slice(2);
                  const resolved = await build.resolve(subPath, {
                    resolveDir: MOBILE_SOURCES_ROOT,
                    kind: args.kind,
                  });
                  if (resolved.errors.length === 0 && resolved.path) {
                    return { path: resolved.path };
                  }
                }
                return null;
              });

              build.onLoad({ filter: /.*/, namespace: 'codelync-rt-stub' }, (args) => ({
                contents: STUB_MODULES[args.path],
                loader: 'js',
                resolveDir: MOBILE_ROOT,
              }));
            },
          },
        ],
      });
      const { stop: stopEsbuild } = await import('esbuild');
      await stopEsbuild();

      const outFile = result.outputFiles?.[0];
      if (!outFile) {
        throw new Error('Failed to bundle mobile runtime entry');
      }
      return outFile.text;
    })();
  }
  return compiledBundlePromise;
}

/**
 * @param {string} instanceId
 * @returns {Promise<AnyRecord>}
 */
async function importBundleForInstance(instanceId) {
  const baseCode = await getCompiledMobileBundle();
  const preamble = [
    `const __INSTANCE_ID__ = ${JSON.stringify(instanceId)};`,
    'const fetch = (...args) => globalThis.__codelyncMobileRtRegistry.get(__INSTANCE_ID__).fetch(...args);',
  ].join('\n');
  const fullSource = `${preamble}\n${baseCode}`;
  const dataUrl = `data:text/javascript;base64,${Buffer.from(fullSource, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

/**
 * @param {string} token
 * @returns {string}
 */
function parseHostIdentityFromViewerJwt(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length < 2) return '';
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const roomName = typeof claims?.video?.room === 'string' ? claims.video.room : '';
    const prefix = 'codelync-desktop-';
    return roomName.startsWith(prefix) ? 'host-' + roomName.slice(prefix.length) : '';
  } catch {
    return '';
  }
}

/**
 * @param {AnyRecord | string | null | undefined} harnessOrInput
 * @param {AnyRecord} [options]
 */
function createRuntimeInstanceState(harnessOrInput, options = {}) {
  const id = `mobile_rt_${++nextInstanceCounter}`;
  const harness = typeof harnessOrInput === 'object' && harnessOrInput !== null ? harnessOrInput : null;
  const macPair = harness?.mac ?? options.mac ?? nacl.box.keyPair();
  const phonePair = harness?.phone ?? options.phone ?? nacl.box.keyPair();
  const peerId = String(harness?.peerId ?? options.peerId ?? 'synthetic-e2e-peer');
  const token = String(harness?.token ?? options.token ?? 'synthetic-e2e-device-token');
  const deviceId = String(harness?.deviceId ?? options.deviceId ?? 'synthetic-e2e-device');

  const inputBaseUrl = typeof harnessOrInput === 'string'
    ? harnessOrInput
    : (options.baseUrl ?? harness?.baseUrl ?? null);
  const channelObj = inputBaseUrl
    ? { id: 'local-custom', kind: 'local', url: String(inputBaseUrl).replace(/\/$/, '') }
    : (harness?.channel ?? { id: 'local-default', kind: 'local', url: 'http://127.0.0.1:9' });

  const originUrl = String(channelObj.url).replace(/\/$/, '');
  const initialRewriteOrigin = String(
    options.rewriteOriginTo
      ?? harness?.rewriteOriginTo
      ?? (inputBaseUrl ? originUrl : (harness?.loopbackBase ?? originUrl)),
  ).replace(/\/$/, '');

  const rawPlatform = options.platform;
  const platformOs = typeof rawPlatform === 'object' && rawPlatform !== null
    ? String(rawPlatform.OS ?? 'ios')
    : String(rawPlatform ?? 'ios');
  const initialIsPad = typeof rawPlatform === 'object' && rawPlatform !== null && rawPlatform.isPad !== undefined
    ? Boolean(rawPlatform.isPad)
    : Boolean(options.isPad ?? false);

  const autoDecodeFrames = options.autoDecodeFrames !== undefined ? Boolean(options.autoDecodeFrames) : true;
  const defaultFirstFrames = options.initialDecodedFrames !== undefined
    ? Number(options.initialDecodedFrames)
    : (autoDecodeFrames ? 2 : 0);

  /** @type {Set<() => void>} */
  const envListeners = new Set();
  /** @type {Set<() => void>} */
  const connListeners = new Set();
  /** @type {Set<() => void>} */
  const mediaListeners = new Set();
  /** @type {Map<string, Set<(ev: AnyRecord) => void>>} */
  const keyboardListeners = new Map();
  /** @type {Set<() => boolean>} */
  const backListeners = new Set();
  /** @type {Set<(state: string) => void>} */
  const appStateListeners = new Set();
  /** @type {Set<Promise<unknown>>} */
  const inFlightUiFetches = new Set();
  /** @type {Set<Promise<unknown>>} */
  const inFlightAllFetches = new Set();

  let envVersion = 0;
  let mediaVersion = 0;
  /** @type {Map<string, { frames: number, trackInstance: AnyRecord | null }>} */
  const trackEntries = new Map();
  let seenAnyTrack = false;
  /** @type {number | null} */
  let pendingDecodedFrames = null;

  /** @type {AnyRecord} */
  const inst = {
    id,
    harness,
    disposed: false,
    hookMode: Boolean(options.hookMode),
    enabled: options.enabled !== undefined ? Boolean(options.enabled) : true,
    paired: options.paired !== undefined ? Boolean(options.paired) : true,
    focused: options.focused !== undefined ? Boolean(options.focused) : true,
    writable: options.writable !== undefined ? Boolean(options.writable) : true,
    canGoBack: options.canGoBack !== undefined ? Boolean(options.canGoBack) : true,
    language: String(options.language ?? 'en'),
    platform: platformOs,
    isPad: initialIsPad,
    window: options.window ? { width: options.window.width, height: options.window.height } : { width: 393, height: 852 },
    insets: options.insets
      ? { ...options.insets }
      : { top: 59, bottom: 34, left: 0, right: 0 },
    initialMetrics: options.initialMetrics !== undefined
      ? options.initialMetrics
      : {
          frame: { x: 0, y: 0, width: 393, height: 852 },
          insets: { top: 59, bottom: 34, left: 0, right: 0 },
        },
    autoDecodeFrames,
    frameWidth: 1080,
    frameHeight: 2086,
    origin: originUrl,
    rewriteOriginTo: initialRewriteOrigin,
    serverUrl: originUrl,
    keyboardDismissCalls: 0,
    lastScreenOptions: /** @type {AnyRecord | null} */ (null),
    orientationMode: 'landscape',
    activeRoom: /** @type {AnyRecord | null} */ (null),
    lastHostIdentity: '',
    lastTrackSid: '',
    bundleMod: /** @type {AnyRecord | null} */ (null),
    inFlightUiFetches,
    inFlightAllFetches,
    routerCalls: {
      back: 0,
      /** @type {string[]} */
      replace: [],
      /** @type {string[]} */
      push: [],
    },
    router: {
      canGoBack: () => inst.canGoBack,
      back: () => { inst.routerCalls.back += 1; },
      /** @param {string} href */
      replace: (href) => { inst.routerCalls.replace.push(String(href)); },
      /** @param {string} href */
      push: (href) => { inst.routerCalls.push.push(String(href)); },
    },

    buildPeerObject() {
      const candidateList = !inputBaseUrl && Array.isArray(harness?.service?.candidates?.()) && harness.service.candidates().length > 0
        ? harness.service.candidates()
        : [channelObj];
      const hasOrigin = candidateList.some((/** @type {AnyRecord} */ c) => c.url === inst.origin);
      const channels = hasOrigin ? candidateList : [...candidateList, channelObj];
      return {
        id: peerId,
        key: Buffer.from(macPair.publicKey).toString('base64url'),
        device: {
          id: deviceId,
          publicKey: Buffer.from(phonePair.publicKey).toString('base64url'),
          secretKey: Buffer.from(phonePair.secretKey).toString('base64url'),
        },
        channels,
        automatic: inst.writable,
        selectedChannel: channelObj.id,
      };
    },

    buildCredentials() {
      if (!inst.paired) return null;
      return {
        token,
        serverUrl: inst.serverUrl,
        peer: inst.buildPeerObject(),
      };
    },

    syncWriteFence() {
      if (!inst.bundleMod?.setPeerRouteWriteFence) return;
      if (!inst.writable && inst.paired) {
        inst.bundleMod.setPeerRouteWriteFence(inst.buildPeerObject(), null);
      } else {
        inst.bundleMod.setPeerRouteWriteFence(null, null);
      }
    },

    getIsFocused() {
      return inst.hookMode ? Boolean(inst.focused && inst.enabled) : Boolean(inst.focused);
    },

    getAuth() {
      const creds = inst.buildCredentials();
      return {
        isAuthenticated: Boolean(inst.paired && creds),
        credentials: creds,
      };
    },

    getCredentials() {
      return inst.buildCredentials();
    },

    /** @param {AnyRecord} nextCreds */
    setCredentials(nextCreds) {
      if (nextCreds?.serverUrl) {
        inst.serverUrl = String(nextCreds.serverUrl);
      }
      return true;
    },

    getServerUrl() {
      return inst.serverUrl;
    },

    /** @param {string} url */
    setServerUrl(url) {
      inst.serverUrl = String(url);
    },

    _cachedConnSnap: /** @type {AnyRecord | null} */ (null),
    _cachedConnKey: '',
    getConnectionSnapshot() {
      const key = `${inst.paired ? peerId : 'unpaired'}:${inst.writable ? '1' : '0'}:${inst.origin}`;
      if (inst._cachedConnKey !== key || !inst._cachedConnSnap) {
        inst._cachedConnKey = key;
        inst._cachedConnSnap = inst.paired
          ? {
              peerId,
              channels: [{ ...channelObj, state: 'connected' }],
              selectedId: channelObj.id,
              activeId: channelObj.id,
              automatic: inst.writable,
              connecting: false,
              writable: inst.writable,
              readable: true,
              failureCode: null,
            }
          : {
              peerId: null,
              channels: [],
              selectedId: null,
              activeId: null,
              automatic: true,
              connecting: false,
              writable: false,
              readable: false,
              failureCode: null,
            };
      }
      return inst._cachedConnSnap;
    },

    /** @param {() => void} cb */
    subscribeConnection(cb) {
      connListeners.add(cb);
      return () => { connListeners.delete(cb); };
    },

    notifyConnection() {
      inst.syncWriteFence();
      for (const cb of Array.from(connListeners)) cb();
    },

    notifyEnv() {
      envVersion += 1;
      for (const cb of Array.from(envListeners)) cb();
    },

    useEnvSubscription() {
      React.useSyncExternalStore(
        (/** @type {() => void} */ cb) => {
          envListeners.add(cb);
          return () => { envListeners.delete(cb); };
        },
        () => envVersion,
      );
    },

    notifyMedia() {
      mediaVersion += 1;
      for (const cb of Array.from(mediaListeners)) cb();
    },

    useMediaSubscription() {
      React.useSyncExternalStore(
        (/** @type {() => void} */ cb) => {
          mediaListeners.add(cb);
          return () => { mediaListeners.delete(cb); };
        },
        () => mediaVersion,
      );
    },

    /** @param {(state: string) => void} cb */
    addAppStateListener(cb) {
      appStateListeners.add(cb);
      return { remove: () => { appStateListeners.delete(cb); } };
    },

    /** @param {() => boolean} cb */
    addBackListener(cb) {
      backListeners.add(cb);
      return { remove: () => { backListeners.delete(cb); } };
    },

    triggerHardwareBackRaw() {
      const handlers = Array.from(backListeners).reverse();
      for (const fn of handlers) {
        if (fn()) return true;
      }
      return false;
    },

    /**
     * @param {string} name
     * @param {(ev: AnyRecord) => void} cb
     */
    addKeyboardListener(name, cb) {
      if (!keyboardListeners.has(name)) {
        keyboardListeners.set(name, new Set());
      }
      keyboardListeners.get(name)?.add(cb);
      return { remove: () => { keyboardListeners.get(name)?.delete(cb); } };
    },

    /**
     * @param {string} name
     * @param {AnyRecord | number} [payloadOrHeight]
     */
    emitKeyboardRaw(name, payloadOrHeight) {
      const height = typeof payloadOrHeight === 'number' ? payloadOrHeight : 0;
      const event = typeof payloadOrHeight === 'object' && payloadOrHeight !== null
        ? payloadOrHeight
        : {
            endCoordinates: {
              height,
              screenY: Math.max(0, inst.window.height - height),
              width: inst.window.width,
              screenX: 0,
            },
          };
      for (const cb of Array.from(keyboardListeners.get(name) ?? [])) {
        cb(event);
      }
    },

    /**
     * @param {AnyRecord} room
     * @param {string} _url
     * @param {string} jwtToken
     */
    onRoomConnect(room, _url, jwtToken) {
      inst.activeRoom = room;
      const hostId = parseHostIdentityFromViewerJwt(jwtToken)
        || (harness?.desktop?.active?.id ? `host-${harness.desktop.active.id}` : '');
      room.hostIdentity = hostId;
      if (hostId) inst.lastHostIdentity = hostId;
      if (harness?.desktop?.active?.trackSid) {
        inst.lastTrackSid = String(harness.desktop.active.trackSid);
      }
    },

    /** @param {AnyRecord} room */
    onRoomDisconnect(room) {
      if (inst.activeRoom === room) {
        inst.activeRoom = null;
      }
    },

    /** @param {string} trackSid */
    ensureTrackEntry(trackSid) {
      let entry = trackEntries.get(trackSid);
      if (!entry) {
        let initialFrames;
        if (pendingDecodedFrames !== null) {
          initialFrames = pendingDecodedFrames;
          pendingDecodedFrames = null;
        } else if (!seenAnyTrack) {
          initialFrames = defaultFirstFrames;
        } else {
          initialFrames = inst.autoDecodeFrames ? 2 : 0;
        }
        seenAnyTrack = true;
        entry = { frames: initialFrames, trackInstance: null };
        trackEntries.set(trackSid, entry);
      }
      return entry;
    },

    resolveActiveTrackSid() {
      const serverSid = harness?.desktop?.active?.trackSid;
      if (typeof serverSid === 'string' && serverSid.length > 0) {
        inst.lastTrackSid = serverSid;
        return serverSid;
      }
      return inst.lastTrackSid;
    },

    /** @param {string} trackSid */
    getFramesForTrack(trackSid) {
      if (!trackSid) return 0;
      return inst.ensureTrackEntry(trackSid).frames;
    },

    /**
     * @param {number} count
     * @param {number} [width]
     * @param {number} [height]
     */
    setFramesForCurrentTrack(count, width, height) {
      if (typeof width === 'number' && Number.isFinite(width)) inst.frameWidth = width;
      if (typeof height === 'number' && Number.isFinite(height)) inst.frameHeight = height;
      const sid = inst.resolveActiveTrackSid();
      if (sid) {
        const entry = inst.ensureTrackEntry(sid);
        entry.frames = Number(count);
        entry.trackInstance = null;
      } else {
        pendingDecodedFrames = Number(count);
      }
      inst.notifyMedia();
    },

    /** @param {string} trackSid */
    getReceiverStats(trackSid) {
      return {
        framesDecoded: inst.getFramesForTrack(trackSid),
        frameWidth: inst.frameWidth,
        frameHeight: inst.frameHeight,
      };
    },

    /**
     * @param {AnyRecord | null} room
     * @param {new (sid: string) => AnyRecord} RemoteVideoTrackCtor
     */
    buildTrackReferences(room, RemoteVideoTrackCtor) {
      if (!room || !room.connected) return [];
      const hostIdentity = room.hostIdentity
        || (harness?.desktop?.active?.id ? `host-${harness.desktop.active.id}` : inst.lastHostIdentity);
      const trackSid = inst.resolveActiveTrackSid();
      if (!hostIdentity || !trackSid) return [];
      const entry = inst.ensureTrackEntry(trackSid);
      if (!entry.trackInstance) {
        entry.trackInstance = new RemoteVideoTrackCtor(trackSid);
      }
      return [
        {
          __isTrackRef: true,
          participant: { identity: hostIdentity },
          source: 'screen_share',
          publication: {
            trackSid,
            track: entry.trackInstance,
          },
        },
      ];
    },

    /**
     * @param {string | URL | Request} input
     * @param {RequestInit} [init]
     */
    async fetch(input, init) {
      const rawUrl = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      let targetUrl = rawUrl;
      if (inst.origin && inst.rewriteOriginTo && rawUrl.startsWith(inst.origin)) {
        targetUrl = inst.rewriteOriginTo + rawUrl.slice(inst.origin.length);
      }
      const isLeave = targetUrl.endsWith('/api/peer/desktop/leave');
      const fetchFn = /** @type {typeof globalThis.fetch} */ (options.fetchImpl ?? globalThis.fetch);
      const reqPromise = (async () => {
        const response = await fetchFn(targetUrl, init);
        if (harness?.desktop?.active?.trackSid) {
          inst.lastTrackSid = String(harness.desktop.active.trackSid);
        }
        if (harness?.desktop?.active?.id) {
          inst.lastHostIdentity = `host-${harness.desktop.active.id}`;
        }
        return response;
      })();
      inFlightAllFetches.add(reqPromise);
      if (!isLeave) {
        inFlightUiFetches.add(reqPromise);
      }
      try {
        return await reqPromise;
      } finally {
        inFlightUiFetches.delete(reqPromise);
        inFlightAllFetches.delete(reqPromise);
      }
    },
  };

  instanceRegistry.set(id, inst);
  return inst;
}

/** @type {Record<string, string>} */
const TEST_ID_ALIASES = {
  'desktop-more-panel': 'desktop-controls-panel',
  'desktop-hide-controls': 'desktop-fullscreen',
};

/**
 * @param {AnyRecord} inst
 * @param {number} [ticks]
 * @param {number} [maxNetworkMs]
 */
async function settleActAndNetwork(inst, ticks = 4, maxNetworkMs = 2500) {
  const effectiveBudgetMs = Math.max(1500, maxNetworkMs);
  const deadline = Date.now() + effectiveBudgetMs;
  for (let round = 0; round < 32; round += 1) {
    await rawAct(async () => {
      for (let i = 0; i < ticks; i += 1) {
        await Promise.resolve();
      }
      if (inst.inFlightUiFetches.size > 0 && Date.now() < deadline) {
        const remainingMs = Math.max(1, deadline - Date.now());
        await Promise.race([
          Promise.allSettled(Array.from(inst.inFlightUiFetches)),
          new Promise((resolve) => setTimeout(resolve, remainingMs)),
        ]);
      }
      await new Promise((resolve) => setImmediate(resolve));
    });
    if (inst.inFlightUiFetches.size === 0 || Date.now() >= deadline) {
      break;
    }
  }
}

/**
 * @param {string} [initialLanguage]
 */
export async function loadRemoteDesktopLabelsRuntime(initialLanguage = 'en') {
  const inst = createRuntimeInstanceState(null, { language: initialLanguage });
  const mod = await importBundleForInstance(inst.id);
  inst.bundleMod = mod;
  return {
    /** @param {string} lang */
    setLanguage(lang) {
      inst.language = String(lang ?? '');
    },
    getLanguage() {
      return inst.language;
    },
    /** @returns {AnyRecord} */
    remoteDesktopLabels() {
      return mod.remoteDesktopLabels();
    },
    /** @param {string} code @returns {string} */
    remoteDesktopError(code) {
      return mod.remoteDesktopError(code);
    },
    /** @param {unknown} preferred */
    resolvePreferredLanguage(preferred) {
      return mod.resolvePreferredLanguage(preferred);
    },
    /**
     * @param {unknown} preferred
     * @param {readonly AnyRecord[] | (() => readonly AnyRecord[])} locales
     */
    resolveLanguage(preferred, locales) {
      return mod.resolveLanguage(preferred, locales);
    },
    dispose() {
      inst.disposed = true;
      instanceRegistry.delete(inst.id);
    },
  };
}

/**
 * @param {AnyRecord | string | null | undefined} harness
 * @param {AnyRecord} [options]
 */
export async function createMobileSyncRuntime(harness, options = {}) {
  const inst = createRuntimeInstanceState(harness, options);
  const mod = await importBundleForInstance(inst.id);
  inst.bundleMod = mod;
  inst.syncWriteFence();

  const syncMod = {
    desktopRequest: mod.desktopRequest,
    DesktopRequestError: mod.DesktopRequestError,
    desktopBinding: mod.desktopBinding,
    desktopPoint: mod.desktopPoint,
  };
  const focusMod = {
    desktopViewportFocus: mod.desktopViewportFocus,
  };
  const draftMod = {
    DESKTOP_TEXT_LIMIT: mod.DESKTOP_TEXT_LIMIT,
    desktopTextSubmission: mod.desktopTextSubmission,
    acknowledgeDesktopText: mod.acknowledgeDesktopText,
  };
  const queueMod = {
    DesktopInputQueue: mod.DesktopInputQueue,
    DesktopInputQueueError: mod.DesktopInputQueueError,
    desktopInputAcknowledged: mod.desktopInputAcknowledged,
  };
  const peerNetworkMod = {
    peerAuthorization: mod.peerAuthorization,
    decodePeerResponse: mod.decodePeerResponse,
    decodePeerResponseAsync: mod.decodePeerResponseAsync,
    setPeerRouteWriteFence: mod.setPeerRouteWriteFence,
    peerRouteWritable: mod.peerRouteWritable,
  };

  /** @param {string} [initialText] */
  function createKeyboardDraftController(initialText = '') {
    let draft = { text: String(initialText), revision: initialText ? 1 : 0 };
    return {
      getDraft() {
        return { ...draft };
      },
      /** @param {string} nextText */
      edit(nextText) {
        if (draft.text !== nextText) {
          draft = { text: nextText, revision: draft.revision + 1 };
        }
        return { ...draft };
      },
      /** @param {(payload: { action: 'text', text: string }) => Promise<boolean>} dispatchFn */
      async submit(dispatchFn) {
        const submitted = mod.desktopTextSubmission(draft);
        if (!submitted) return false;
        const prefixBefore = submitted.text;
        const accepted = await dispatchFn({ action: 'text', text: submitted.text });
        if (!accepted) return false;
        const prefixUnchanged = draft.text.startsWith(prefixBefore);
        const remaining = mod.acknowledgeDesktopText(draft, submitted, prefixUnchanged);
        if (remaining !== draft.text) {
          draft = { text: remaining, revision: draft.revision + 1 };
        }
        return true;
      },
    };
  }

  return {
    desktopRequest: mod.desktopRequest,
    DesktopRequestError: mod.DesktopRequestError,
    desktopBinding: mod.desktopBinding,
    DesktopInputQueue: mod.DesktopInputQueue,
    DesktopInputQueueError: mod.DesktopInputQueueError,
    desktopInputAcknowledged: mod.desktopInputAcknowledged,
    desktopPoint: mod.desktopPoint,
    desktopViewportFocus: mod.desktopViewportFocus,
    DESKTOP_TEXT_LIMIT: mod.DESKTOP_TEXT_LIMIT,
    desktopTextSubmission: mod.desktopTextSubmission,
    acknowledgeDesktopText: mod.acknowledgeDesktopText,
    createKeyboardDraftController,
    syncMod,
    focusMod,
    draftMod,
    queueMod,
    peerNetworkMod,
    /** @param {boolean} writable */
    setWritable(writable) {
      inst.writable = Boolean(writable);
      inst.notifyConnection();
    },
    /** @param {string} nextOrigin */
    setRewriteOrigin(nextOrigin) {
      inst.rewriteOriginTo = String(nextOrigin).replace(/\/$/, '');
    },
    /** @param {AnyRecord} opts */
    setWindowMetrics(opts) {
      if (opts.window) inst.window = { width: opts.window.width, height: opts.window.height };
      if (opts.insets) inst.insets = { ...opts.insets };
      if (opts.initialMetrics !== undefined) inst.initialMetrics = opts.initialMetrics;
      if (opts.platform !== undefined) inst.platform = String(opts.platform);
      if (opts.isPad !== undefined) inst.isPad = Boolean(opts.isPad);
      inst.notifyEnv();
    },
    dispose() {
      inst.disposed = true;
      instanceRegistry.delete(inst.id);
    },
  };
}

/**
 * @param {AnyRecord} options
 */
export async function mountUseRemoteDesktopRuntime(options) {
  const inst = createRuntimeInstanceState(options?.harness, { ...options, hookMode: true });
  const mod = await importBundleForInstance(inst.id);
  inst.bundleMod = mod;
  inst.syncWriteFence();

  /** @type {AnyRecord} */
  let latestHook = /** @type {any} */ (null);
  let unmounted = false;

  function HookHost() {
    const controller = mod.useRemoteDesktop();
    inst.useMediaSubscription();
    latestHook = controller;
    const activeSid = controller.grant?.trackSid ?? '';
    const decodedCount = activeSid ? inst.getFramesForTrack(activeSid) : 0;
    React.useEffect(() => {
      if (!activeSid || controller.ready || controller.busy || decodedCount <= 0) return;
      void controller.videoReady(activeSid);
    }, [activeSid, controller.ready, controller.busy, controller.videoReady, decodedCount]);
    return null;
  }

  /** @type {AnyRecord} */
  let renderer = /** @type {any} */ (null);
  await rawAct(async () => {
    renderer = createRenderer(React.createElement(HookHost));
  });
  await settleActAndNetwork(inst);

  return {
    get current() {
      return latestHook;
    },
    act: rawAct,
    /**
     * @template T
     * @param {(hook: AnyRecord) => T | Promise<T>} fn
     * @returns {Promise<T>}
     */
    async call(fn) {
      /** @type {any} */
      let out;
      await rawAct(async () => {
        out = await fn(latestHook);
      });
      await settleActAndNetwork(inst);
      return out;
    },
    /** @param {boolean} val */
    async setEnabled(val) {
      await rawAct(async () => {
        inst.enabled = Boolean(val);
        inst.notifyEnv();
      });
      await settleActAndNetwork(inst);
    },
    /** @param {boolean} val */
    async setPaired(val) {
      await rawAct(async () => {
        inst.paired = Boolean(val);
        inst.notifyConnection();
        inst.notifyEnv();
      });
      await settleActAndNetwork(inst);
    },
    /** @param {boolean} val */
    async setFocused(val) {
      await rawAct(async () => {
        inst.focused = Boolean(val);
        inst.notifyEnv();
      });
      await settleActAndNetwork(inst);
    },
    /** @param {boolean} val */
    async setWritable(val) {
      await rawAct(async () => {
        inst.writable = Boolean(val);
        inst.notifyConnection();
        inst.notifyEnv();
      });
      await settleActAndNetwork(inst);
    },
    /**
     * @param {number} frames
     * @param {number} [width]
     * @param {number} [height]
     */
    async setDecodedFrames(frames, width, height) {
      await rawAct(async () => {
        inst.setFramesForCurrentTrack(frames, width, height);
      });
      await settleActAndNetwork(inst);
    },
    /** @param {AnyRecord} opts */
    async setWindowMetrics(opts) {
      await rawAct(async () => {
        if (opts.window) inst.window = { width: opts.window.width, height: opts.window.height };
        if (opts.insets) inst.insets = { ...opts.insets };
        if (opts.initialMetrics !== undefined) inst.initialMetrics = opts.initialMetrics;
        if (opts.platform !== undefined) inst.platform = String(opts.platform);
        if (opts.isPad !== undefined) inst.isPad = Boolean(opts.isPad);
        inst.notifyEnv();
      });
      await settleActAndNetwork(inst);
    },
    /** @param {number} [ticks] */
    async flush(ticks = 4) {
      await settleActAndNetwork(inst, ticks);
    },
    async unmount() {
      if (unmounted) return;
      unmounted = true;
      await rawAct(async () => {
        renderer.unmount();
      });
      if (inst.inFlightAllFetches.size > 0) {
        await Promise.race([
          Promise.allSettled(Array.from(inst.inFlightAllFetches)),
          new Promise((resolve) => setTimeout(resolve, 150)),
        ]);
      }
      inst.disposed = true;
      instanceRegistry.delete(inst.id);
    },
  };
}

/**
 * @param {'screen' | 'view'} mode
 * @param {AnyRecord} options
 */
async function mountUiRuntime(mode, options) {
  const inst = createRuntimeInstanceState(options?.harness, options);
  const mod = await importBundleForInstance(inst.id);
  inst.bundleMod = mod;
  inst.syncWriteFence();

  let unmounted = false;

  const renderElement = () => (
    mode === 'screen'
      ? React.createElement(mod.DesktopScreen)
      : React.createElement(mod.RemoteDesktopView, {
          focused: inst.focused,
          onOrientationModeChange: (/** @type {string} */ nextMode) => {
            inst.orientationMode = nextMode;
            options?.onOrientationModeChange?.(nextMode);
          },
        })
  );

  /** @type {AnyRecord} */
  let renderer = /** @type {any} */ (null);
  await rawAct(async () => {
    renderer = createRenderer(renderElement());
  });
  await settleActAndNetwork(inst);

  const rerenderTree = async () => {
    if (unmounted) return;
    await rawAct(async () => {
      inst.notifyEnv();
      renderer.update(renderElement());
    });
    await settleActAndNetwork(inst);
  };

  /**
   * @param {string} testId
   * @returns {AnyRecord[]}
   */
  const findAllByTestId = (testId) => {
    if (unmounted) return [];
    /** @param {string} targetId */
    const queryExact = (targetId) => {
      const hostMatches = renderer.root.findAll(
        (/** @type {AnyRecord} */ node) => typeof node.type === 'string' && node.props?.testID === targetId,
      );
      if (hostMatches.length > 0) return hostMatches;
      return renderer.root.findAll(
        (/** @type {AnyRecord} */ node) => node.props?.testID === targetId,
      );
    };
    const direct = queryExact(testId);
    if (direct.length > 0) return direct;
    const alias = TEST_ID_ALIASES[testId];
    return alias ? queryExact(alias) : [];
  };

  /**
   * @param {string} testId
   * @returns {AnyRecord | null}
   */
  const findByTestId = (testId) => findAllByTestId(testId)[0] ?? null;

  /**
   * @param {unknown} typeOrName
   * @returns {AnyRecord[]}
   */
  const findAllByType = (typeOrName) => {
    if (unmounted) return [];
    return renderer.root.findAll((/** @type {AnyRecord} */ node) => (
      node.type === typeOrName
      || (typeof typeOrName === 'string'
        && typeof node.type === 'function'
        && (node.type.displayName === typeOrName || node.type.name === typeOrName))
    ));
  };

  /**
   * @param {string} testId
   */
  const pressTestId = async (testId) => {
    const node = findByTestId(testId);
    if (!node) {
      throw new Error(`Unable to find element with testID="${testId}"`);
    }
    if (node.props?.disabled) {
      return false;
    }
    if (typeof node.props?.onPress !== 'function') {
      throw new Error(`Element testID="${testId}" has no onPress handler`);
    }
    const isExitAction = testId === 'desktop-exit' || testId === 'desktop-disconnect';
    /** @type {any} */
    let result;
    await rawAct(async () => {
      result = await node.props.onPress();
    });
    if (isExitAction) {
      await rawAct(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    } else {
      await settleActAndNetwork(inst);
    }
    return result ?? true;
  };

  /**
   * @param {number} width
   * @param {number} height
   */
  const layoutCanvas = async (width, height) => {
    const canvas = findByTestId('remote-desktop-canvas');
    if (!canvas || typeof canvas.props?.onLayout !== 'function') {
      throw new Error('Active remote-desktop-canvas with onLayout not found');
    }
    await rawAct(async () => {
      canvas.props.onLayout({
        nativeEvent: {
          layout: { x: 0, y: 0, width, height },
        },
      });
    });
    await settleActAndNetwork(inst, 2, 100);
  };

  const findCanvasResponder = () => {
    const resolveHandlers = () => {
      const canvas = findByTestId('remote-desktop-canvas');
      if (!canvas) return null;
      const responderNode = canvas.findAll(
        (/** @type {AnyRecord} */ node) => typeof node.type === 'string' && typeof node.props?.onPanResponderGrant === 'function',
      )[0];
      return responderNode?.props ?? null;
    };
    if (!resolveHandlers()) return null;

    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastY = 0;

    /**
     * @param {number} x
     * @param {number} y
     * @param {AnyRecord} [extra]
     */
    const buildTouches = (x, y, extra) => {
      if (Array.isArray(extra?.touches)) return extra.touches;
      const count = Number(extra?.numberActiveTouches ?? 1);
      if (count >= 2) {
        const spread = Number(extra?.spread ?? 120);
        return [
          { locationX: x, locationY: y, pageX: x, pageY: y },
          { locationX: x + spread, locationY: y, pageX: x + spread, pageY: y },
        ];
      }
      return [{ locationX: x, locationY: y, pageX: x, pageY: y }];
    };

    /**
     * @param {number} x
     * @param {number} y
     * @param {number} dx
     * @param {number} dy
     * @param {AnyRecord} [extra]
     */
    const buildSynthArgs = (x, y, dx, dy, extra) => {
      const touches = buildTouches(x, y, extra);
      const event = {
        nativeEvent: {
          locationX: x,
          locationY: y,
          pageX: x,
          pageY: y,
          touches,
        },
        touchHistory: extra?.touchHistory ?? { touchBank: [] },
      };
      const gestureState = {
        dx,
        dy,
        moveX: x,
        moveY: y,
        x0: startX,
        y0: startY,
        vx: 0,
        vy: 0,
        numberActiveTouches: touches.length,
      };
      return { event, gestureState };
    };

    return {
      get panHandlers() {
        return resolveHandlers();
      },
      /**
       * @param {number} x
       * @param {number} y
       * @param {AnyRecord} [extra]
       */
      async grant(x, y, extra) {
        const handlers = resolveHandlers();
        if (!handlers?.onPanResponderGrant) return;
        startX = x;
        startY = y;
        lastX = x;
        lastY = y;
        const { event, gestureState } = buildSynthArgs(x, y, 0, 0, extra);
        await rawAct(async () => {
          handlers.onPanResponderGrant(event, gestureState);
        });
        await settleActAndNetwork(inst, 2, 120);
      },
      /**
       * @param {number} x
       * @param {number} y
       * @param {number | AnyRecord} [dxOrExtra]
       * @param {number} [dy]
       * @param {AnyRecord} [extra]
       */
      async move(x, y, dxOrExtra, dy, extra) {
        const handlers = resolveHandlers();
        if (!handlers?.onPanResponderMove) return;
        const resolvedExtra = typeof dxOrExtra === 'object' && dxOrExtra !== null ? dxOrExtra : extra;
        const resolvedDx = typeof dxOrExtra === 'number' ? dxOrExtra : x - startX;
        const resolvedDy = typeof dy === 'number' ? dy : y - startY;
        lastX = x;
        lastY = y;
        const { event, gestureState } = buildSynthArgs(x, y, resolvedDx, resolvedDy, resolvedExtra);
        await rawAct(async () => {
          handlers.onPanResponderMove(event, gestureState);
        });
        await settleActAndNetwork(inst, 2, 120);
      },
      /**
       * @param {number} [x]
       * @param {number} [y]
       * @param {number | AnyRecord} [dxOrExtra]
       * @param {number} [dy]
       * @param {AnyRecord} [extra]
       */
      async release(x = lastX, y = lastY, dxOrExtra, dy, extra) {
        const handlers = resolveHandlers();
        if (!handlers?.onPanResponderRelease) return;
        const resolvedExtra = typeof dxOrExtra === 'object' && dxOrExtra !== null ? dxOrExtra : extra;
        const resolvedDx = typeof dxOrExtra === 'number' ? dxOrExtra : x - startX;
        const resolvedDy = typeof dy === 'number' ? dy : y - startY;
        const { event, gestureState } = buildSynthArgs(x, y, resolvedDx, resolvedDy, resolvedExtra);
        await rawAct(async () => {
          handlers.onPanResponderRelease(event, gestureState);
        });
        await settleActAndNetwork(inst, 2, 120);
      },
      async terminate() {
        const handlers = resolveHandlers();
        if (!handlers?.onPanResponderTerminate) return;
        const { event, gestureState } = buildSynthArgs(lastX, lastY, lastX - startX, lastY - startY);
        await rawAct(async () => {
          handlers.onPanResponderTerminate(event, gestureState);
        });
        await settleActAndNetwork(inst, 2, 120);
      },
    };
  };

  return {
    renderer,
    act: rawAct,
    env: inst,
    routerCalls: inst.routerCalls,
    getStackScreenOptions() {
      const screenNodes = findAllByType('Screen');
      if (screenNodes.length > 0) {
        return screenNodes[screenNodes.length - 1].props?.options ?? null;
      }
      if (inst.lastScreenOptions) return inst.lastScreenOptions;
      const portrait = !inst.enabled || !inst.paired || !inst.focused || inst.orientationMode === 'portrait';
      return {
        headerShown: false,
        statusBarHidden: !portrait,
        orientation: portrait ? 'portrait' : 'landscape',
        gestureEnabled: false,
        fullScreenGestureEnabled: false,
      };
    },
    /** @param {boolean} val */
    async setEnabled(val) {
      inst.enabled = Boolean(val);
      await rerenderTree();
    },
    /** @param {boolean} val */
    async setPaired(val) {
      await rawAct(async () => {
        inst.paired = Boolean(val);
        inst.notifyConnection();
      });
      await rerenderTree();
    },
    /** @param {boolean} val */
    async setFocused(val) {
      inst.focused = Boolean(val);
      await rerenderTree();
    },
    /** @param {boolean} val */
    async setWritable(val) {
      await rawAct(async () => {
        inst.writable = Boolean(val);
        inst.notifyConnection();
      });
      await rerenderTree();
    },
    /** @param {string} lang */
    async setLanguage(lang) {
      inst.language = String(lang ?? '');
      await rerenderTree();
    },
    /**
     * @param {number | { width: number, height: number }} widthOrSize
     * @param {number} [height]
     */
    async setWindow(widthOrSize, height) {
      if (typeof widthOrSize === 'object' && widthOrSize !== null) {
        inst.window = { width: Number(widthOrSize.width), height: Number(widthOrSize.height) };
      } else {
        inst.window = { width: Number(widthOrSize), height: Number(height) };
      }
      await rerenderTree();
    },
    /** @param {AnyRecord} insets */
    async setInsets(insets) {
      inst.insets = { ...insets };
      await rerenderTree();
    },
    /** @param {AnyRecord | null} metrics */
    async setInitialMetrics(metrics) {
      inst.initialMetrics = metrics;
      await rerenderTree();
    },
    /**
     * @param {string} eventName
     * @param {AnyRecord | number} [payloadOrHeight]
     */
    async emitKeyboard(eventName, payloadOrHeight) {
      await rawAct(async () => {
        inst.emitKeyboardRaw(eventName, payloadOrHeight);
      });
      await settleActAndNetwork(inst, 2, 80);
    },
    async triggerHardwareBack() {
      let handled = false;
      await rawAct(async () => {
        handled = inst.triggerHardwareBackRaw();
      });
      await rawAct(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      return handled;
    },
    /**
     * @param {number} count
     * @param {number} [width]
     * @param {number} [height]
     */
    async setDecodedFrames(count, width, height) {
      await rawAct(async () => {
        inst.setFramesForCurrentTrack(count, width, height);
      });
      await settleActAndNetwork(inst);
    },
    findByTestId,
    findAllByTestId,
    findAllByType,
    pressTestId,
    layoutCanvas,
    findCanvasResponder,
    /** @param {number} [ticks] */
    async flush(ticks = 4) {
      await settleActAndNetwork(inst, ticks);
    },
    async unmount() {
      if (unmounted) return;
      unmounted = true;
      await rawAct(async () => {
        renderer.unmount();
      });
      if (inst.inFlightAllFetches.size > 0) {
        await Promise.race([
          Promise.allSettled(Array.from(inst.inFlightAllFetches)),
          new Promise((resolve) => setTimeout(resolve, 150)),
        ]);
      }
      inst.disposed = true;
      instanceRegistry.delete(inst.id);
    },
  };
}

/**
 * @param {AnyRecord} options
 */
export async function mountDesktopScreenRuntime(options) {
  return mountUiRuntime('screen', options);
}

/**
 * @param {AnyRecord} options
 */
export async function mountRemoteDesktopViewRuntime(options) {
  return mountUiRuntime('view', options);
}

/**
 * @param {AnyRecord} [options]
 */
export async function mountRemoteDesktopKeyboardRuntime(options = {}) {
  const inst = createRuntimeInstanceState(null, {
    language: options.language ?? 'en',
    platform: options.platform ?? 'ios',
    window: options.window ?? { width: 393, height: 852 },
    insets: options.insets ?? { top: 59, bottom: 34, left: 0, right: 0 },
  });
  const mod = await importBundleForInstance(inst.id);
  inst.bundleMod = mod;

  let unmounted = false;
  /** @type {AnyRecord} */
  let currentProps = {
    visible: options.visible !== undefined ? Boolean(options.visible) : true,
    enabled: options.enabled !== undefined ? Boolean(options.enabled) : true,
    onClose: options.onClose ?? (() => {}),
    onInput: options.onInput ?? (async () => true),
    ...(options.hint !== undefined ? { hint: options.hint } : {}),
    ...(options.onKeyboardHeight !== undefined ? { onKeyboardHeight: options.onKeyboardHeight } : {}),
  };

  /** @type {AnyRecord} */
  let renderer = /** @type {any} */ (null);
  await rawAct(async () => {
    renderer = createRenderer(React.createElement(mod.RemoteDesktopKeyboard, currentProps));
  });

  /**
   * @param {string} testId
   * @returns {AnyRecord[]}
   */
  const findAllByTestId = (testId) => {
    if (unmounted) return [];
    const hostMatches = renderer.root.findAll(
      (/** @type {AnyRecord} */ node) => typeof node.type === 'string' && node.props?.testID === testId,
    );
    if (hostMatches.length > 0) return hostMatches;
    return renderer.root.findAll(
      (/** @type {AnyRecord} */ node) => node.props?.testID === testId,
    );
  };

  /**
   * @param {string} testId
   * @returns {AnyRecord | null}
   */
  const findByTestId = (testId) => findAllByTestId(testId)[0] ?? null;

  /**
   * @param {string} testId
   */
  const pressTestId = async (testId) => {
    const node = findByTestId(testId);
    if (!node) {
      throw new Error(`Unable to find element with testID="${testId}"`);
    }
    if (node.props?.disabled) {
      return false;
    }
    if (typeof node.props?.onPress !== 'function') {
      throw new Error(`Element testID="${testId}" has no onPress handler`);
    }
    /** @type {any} */
    let out;
    await rawAct(async () => {
      out = await node.props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    return out;
  };

  return {
    renderer,
    act: rawAct,
    findByTestId,
    findAllByTestId,
    /** @param {AnyRecord} nextProps */
    async rerender(nextProps) {
      if (unmounted) return;
      if (nextProps.language !== undefined) {
        inst.language = String(nextProps.language);
      }
      currentProps = { ...currentProps, ...nextProps };
      await rawAct(async () => {
        renderer.update(React.createElement(mod.RemoteDesktopKeyboard, currentProps));
      });
    },
    /** @param {string} text */
    async changeText(text) {
      const inputNode = findByTestId('desktop-text-input');
      if (!inputNode || typeof inputNode.props?.onChangeText !== 'function') {
        throw new Error('Active desktop-text-input not found');
      }
      await rawAct(async () => {
        inputNode.props.onChangeText(text);
      });
    },
    async pressType() {
      return pressTestId('desktop-type');
    },
    pressTestId,
    /** @param {number} [ticks] */
    async flush(ticks = 4) {
      await rawAct(async () => {
        for (let i = 0; i < ticks; i += 1) {
          await Promise.resolve();
        }
        await new Promise((resolve) => setImmediate(resolve));
      });
    },
    async unmount() {
      if (unmounted) return;
      unmounted = true;
      await rawAct(async () => {
        renderer.unmount();
      });
      inst.disposed = true;
      instanceRegistry.delete(inst.id);
    },
  };
}
