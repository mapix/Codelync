# Independent remote desktop

Status: implementation contract, 2026-11-18.

Packaging keeps the SDK resource bundle under `Contents/Resources` (and beside
the embedded helper as needed), never at the `.app` root. The app root must
remain a standard signed macOS bundle without unsealed extra content.

Public desktop helpers are rebuilt with Swift/Clang source and debug prefix
maps, a neutral compilation directory, and standard removal of debug symbols.
SwiftPM uses a fresh scratch directory under `/private/tmp` so its generated SDK
resource fallback never embeds the publisher's home directory. The installed
SDK bundle remains the preferred resource path. These packaging steps preserve
the pinned SDK/server revisions and runtime operations; a public candidate must
pass a scan of its final signed bytes before publication.

## Product

The phone interaction/layout contract is defined in
[Mobile remote desktop experience](codelync-remote-desktop-mobile-experience.md).

### Spaces confirmation and recovery

While a Spaces, display/mode-switch or virtual-display window-placement
operation is pending, the phone cannot confirm the old picture as ready or
reinstall its input queue. A ready acknowledgment belongs to the exact starting
connection, grant object, track and geometry; a later view change invalidates
that acknowledgment even if a track identifier is reused. Only the current
confirmed picture permits subsequent input, another Spaces action, or a
virtual-display window-placement action. An input queue retired by a Spaces,
display, quality, mode-switch or window-placement operation cannot change the
current connection when one of its old requests later fails. Reserve input and
mutating operation sequence numbers in order, but tolerate the resulting
stale-request rejection without disconnecting the new view or replaying that old
request.

Spaces or window-placement failure and unconfirmed-result explanations remain
visible in the connection details after picture recovery. A successful readiness
check does not erase them. Display/view changes are distinguished from an
unavailable Mac. Unknown operations are not replayed to try to force a desktop
or window transition.

The native switch must use the intended display and an available system
operation, then confirm the actual Spaces transition. Enabled default keyboard
shortcuts are not assumed to be disabled because their explicit parameters are
absent from the user's preferences. A posted shortcut alone is not proof that
the desktop switched.

- Remote desktop is independent of all integrations and defaults to disabled.
  Its media relay defaults to an owned local LiveKit server bundled with the Mac
  app. Users may configure an external LiveKit server with URL and API credentials.
  These media settings are distinct from the existing HTTP/WebSocket Relay.
- The phone exposes Remote desktop as its own top-level feature for the paired
  Mac. No session ID, source, model, conversation or message is created or needed.
- Screen orientation on the phone is display-type-aware and driven declaratively
  without unmounting the single video canvas: selecting or connecting to a
  physical wide display locks the page into `landscape` (with system status bar
  hidden), whereas selecting or connecting to the adaptive virtual **Phone
  Screen** locks and maintains `portrait` (with system status bar visible above
  the top safe-area inset). Switching between physical and virtual display types
  dynamically updates orientation; leaving remote desktop restores the prior
  `portrait` orientation, preserving portrait Sessions even if the simulator was
  rotated for desktop testing. This feature never changes the app-wide native
  orientation manifest. Display selection and clarity/smoothness settings live in
  separate expandable panels, alongside a running-window picker panel when
  viewing the Virtual Phone Screen. Pointer, drag, scrolling, zoom and keyboard
  tools form their own operation surface; in Virtual Phone Screen pointer mode at
  `1x` zoom, single-finger movement beyond `6pt` performs native touch scrolling
  anchored at the touch start coordinate, without installing any Mac-side global
  `CGEventTap`. Immersive fullscreen hides app chrome and tools, preserving an
  accessible exit control.
- Available displays come from the Mac's current native physical display
  inventory (`kind: "physical"`) plus, when dynamic `CGVirtualDisplay` runtime
  support is present on the Mac (`virtualDisplaySupported: true`), an optional
  adaptive 2x HiDPI portrait **Phone Screen** (`id: "virtual"`, `name: "Phone
  Screen"`, `kind: "virtual"`). If those private classes or selectors are absent
  or altered on a future macOS release, `virtualDisplaySupported` is `false`,
  `"virtual"` is omitted so the phone automatically hides the Phone Screen
  option, and ordinary physical display remote desktop operates unaffected. On a
  headless Mac with zero active physical displays (`CGGetActiveDisplayList` count
  `0`), `displays` still succeeds with `[virtualRow]` whenever
  `virtualDisplaySupported` is `true` instead of failing with
  `desktop-display-unavailable`. Switching displays during a connection releases
  pressed buttons, pauses input, updates capture, display dimensions (`width`,
  `height`, `logicalWidth`, `logicalHeight`), `trackSid` and `geometry`, and
  preserves the room/connection; switching from the Virtual Phone Screen back to
  a physical display first restores any moved window, retires capture, destroys
  the virtual display (after enforcing its `>= 2.5s` minimum lifetime), and
  restores physical display modes before rebinding capture. Input resumes only
  after a decoded frame from the new publication is confirmed. Old display
  geometry and old publication readiness cannot enable or dispatch input.
- macOS Spaces are independent from physical/virtual displays
  (`NSWorkspace.activeSpaceDidChangeNotification` continues to run
  `invalidateView()` on both physical displays and the Virtual Phone Screen). The
  operation toolbar exposes Previous desktop, Next desktop and Mission Control
  overview.
  Previous/next use the user's enabled system keyboard shortcuts (documented
  defaults when no override is stored); overview opens the system Mission Control
  application. Codelync never modifies shortcut preferences, creates/deletes
  Spaces or fabricates a numbered Space catalog.
- Observe Spaces changes with NSWorkspace's public workspace notification center.
  A real change immediately releases pressed input and invalidates the view,
  including changes initiated directly on the Mac. Refresh the selected display's
  capture/publication inside the existing encrypted room; read-only heartbeat
  reconciliation carries the new geometry/publication to the phone. New input is
  permitted only after the current decoded publication is acknowledged.
- Each Space operation has a reserved input sequence and is dispatched once.
  A posted shortcut is not proof of a desktop transition: confirmation uses the
  OS notification. Missing confirmation remains explicit; a boundary desktop or
  disabled/custom shortcut never produces a fabricated successful transition.
  Mission Control's fresh video lets the user visually choose existing desktops
  and fullscreen app Spaces with ordinary pointer controls. Keyboard navigation
  follows macOS focus/Spaces policy and positions the pointer in the selected
  display; different per-display Spaces configurations retain OS behavior.
- Mac screen recording and Accessibility permissions are required capabilities,
  shown separately. Accessibility (`AXIsProcessTrusted()`) is required both for
  desktop input/Spaces actions and for Phase 2 `AXUIElement` running-window
  enumeration, move-to-fill, and restoration. Missing permission is actionable
  and never implies success.
- Capture runs only during an explicit phone connection. Ending the connection
  (`leave` or `15,000ms` heartbeat timeout), backgrounding the phone, locking the
  Mac or losing permission, revoking its device, disabling remote desktop,
  changing relay configuration or closing Codelync (`stop()`, `SIGTERM`, `stdin`
  EOF) releases pressed buttons/modifiers, restores any window moved onto the
  Virtual Phone Screen back to its saved desktop frame (`RestoreRecord`), retires
  `captureGeneration` and stops `SCStream` capture, destroys any active Virtual
  Phone Screen (enforcing `>= 2.5s` minimum lifetime), and restores physical
  display modes and refresh rates (`.permanently`). No desktop input or window
  mutation is queued or replayed after reconnection.

### Adaptive virtual phone screen and display mode protection

- **Dynamic Objective-C runtime bridge (`CGVirtualDisplayRuntime`)**:
  `CodelyncDesktopHost` resolves `CGVirtualDisplay`, `CGVirtualDisplayDescriptor`,
  `CGVirtualDisplaySettings` and `CGVirtualDisplayMode` dynamically at runtime via
  `NSClassFromString` / `objc_lookUpClass` and verifies every required instance
  selector with `instancesRespondToSelector:` (`Descriptor`: `init`, `setName:`,
  `setMaxPixelsWide:`, `setMaxPixelsHigh:`, `setSizeInMillimeters:`,
  `setVendorID:`, `setProductID:`, `setSerialNum:`; `Mode`:
  `initWithWidth:height:refreshRate:`; `Settings`: `init`, `setHiDPI:`,
  `setModes:`; `Display`: `initWithDescriptor:`, `applySettings:`, `displayID`;
  optional selectors such as `setQueue:` and `setTerminationHandler:` are guarded
  with `respondsToSelector:` without failing capability detection). Method calls
  go through typed Objective-C `@protocol` casts on `id` so scalar/struct ABI
  (`CGSize`, `NSUInteger`, `double`, `BOOL`, `CGDirectDisplayID`) is preserved
  with zero static `OBJC_CLASS_$_CGVirtualDisplay*` linker imports (`nm -u`
  clean). Creation, `applySettings:` and teardown run inside `autoreleasepool` on
  `@MainActor` under the `.accessory` `NSApplication` runloop.
- **Viewport-driven 2x HiDPI portrait mode ladder (no `phone-models.json`)**:
  Codelync maintains no static phone model database (`phone-models.json`) and
  subtracts no third-party toolbar inset. When joining or switching to
  `displayId: "virtual"`, the phone reports its portrait safe-area `viewport`
  (`{ width, height }`, defaulting to `{ width: 540, height: 1080 }` when
  omitted). `CodelyncDesktopHost` clamps
  `ratio = clamp(Double(viewport.height) / Double(viewport.width), 1.0...2.5)`
  and builds proportional logical widths across `540pt ~ 1080pt` in `10pt` steps.
  Because macOS only marks 2x HiDPI desktop modes usable when logical `width >=
  540pt` and `height >= 800pt`, the initial `baseWidth` is the smallest `10pt`
  step `>= 540pt` satisfying `round(Double(w) * ratio) >= 800` (with fallback
  `1080pt`) and `baseHeight = Int((Double(baseWidth) * ratio).rounded())`. Every
  step `w` from `baseWidth` through `1080pt` is registered as a
  `CGVirtualDisplayMode(width: UInt(w), height: UInt(round(Double(w) * ratio)),
  refreshRate: 60.0)` (1x logical point arguments) with `settings.hiDPI = true`.
  The descriptor sets `maxPixelsWide = 2160` and `maxPixelsHigh = 5400` so every
  step up to `ratio = 2.5` receives true 2x Retina backing pixels (`2 * w` by
  `2 * h`), computes `sizeInMillimeters` from `maxPixels` at `~220 PPI`
  (`Double(maxPixels) / 220.0 * 25.4`, never physical phone `~460 PPI`, which
  causes WindowServer to blacklist the serial), and uses Codelync's vendor/product
  IDs with a bounded 3-serial fallback pool (retrying the next serial on stale
  offline transitions while bounding ColorSync ICC files). If the virtual display
  is already online and only the viewport ratio changes, `applySettings:` updates
  the mode table in place without consuming a new serial. A `minimumLifetime` of
  `2.5s` is enforced before releasing any `CGVirtualDisplay` instance so rapid
  teardown never wedges WindowServer.
- **Short-lived `--set-mode` and `--restore-mode` subprocess execution**:
  Calling `CGCompleteDisplayConfiguration` inside the long-lived process that owns
  `CGVirtualDisplay` causes WindowServer to retain a zombie online display for
  `40+ seconds` after release. `CodelyncDesktopHost` therefore spawns itself as a
  short-lived child process (`10s` parent timeout, terminating a hung child) and
  intercepts `--set-mode` and `--restore-mode` at the entry of `Main.main()`
  before initializing LiveKit, `NSApplication`, Spaces observers, or `stdin` RPC:
  - `--set-mode <displayID:UInt32> <logicalWidth:Int> <logicalHeight:Int>`
    queries `CGDisplayCopyAllDisplayModes(id,
    [kCGDisplayShowDuplicateLowResolutionModes: true])`, selects the 2x HiDPI
    mode (`width == logicalWidth && height == logicalHeight && pixelWidth == 2 *
    logicalWidth`), commits with `.forSession`, and exits `0` (`1` on failure).
    After initial virtual display creation comes online and settles, the host
    switches from the default widest mode to `baseWidth x baseHeight` and polls up
    to `2s` (`50ms` interval) for the mode and `NSScreen` frame to converge.
  - `--restore-mode <displayID:UInt32> <ioModeIDBitPattern:UInt32> <width:Int>
    <height:Int> <pixelWidth:Int> <pixelHeight:Int> <refreshRate:Double>
    <session|permanent>` passes `ioDisplayModeID` (`Int32`, which can be negative
    for system-reserved modes) as `UInt32(bitPattern: ioModeID)` so CLI parsing
    never misreads negative IDs as flags, matches exact logical/pixel dimensions
    and `abs(refreshRate - target) < 0.01` (preferring matching `ioDisplayModeID`,
    then `isUsableForDesktopGUI()`, then first match), commits with `.forSession`
    or `.permanently`, and exits `0` or `1`.
- **Physical display mode protection & headless Mac stream safety**:
  Before creating a virtual display and before retiring/destroying it, the host
  snapshots all other online physical displays (`ioModeID`, logical `width` and
  `height`, backing `pixelWidth` and `pixelHeight`, `refreshRate`, and
  `CGDisplayIsAsleep(id) != 0`, persisted atomically to
  `<state-dir>/display-modes-snapshot.json` when `--state-dir` is supplied). After
  topology settles on mount (`.forSession` scope) and after virtual display
  teardown goes offline (`.permanently` scope, counteracting WindowServer's
  permanent topology mode overwrites), any still-online physical display whose
  mode drifted is restored via `--restore-mode`; unplugged displays are skipped,
  and asleep displays (`CGDisplayIsAsleep != 0`) defer restoration until the
  virtual display is offline and displays wake. Before releasing
  `CGVirtualDisplay`, `DesktopHost` always clears `captureGeneration` and stops
  the active `SCStream` (`stopCapture()`) so ScreenCaptureKit never emits a
  spurious `desktop-stopped` error or captures a deallocated display. On a
  headless Mac with zero physical monitors (`otherDisplays().isEmpty`, where macOS
  removes its synthesized fallback display while `CGVirtualDisplay` is online),
  disconnecting stops `SCStream` before virtual display release, and switching
  back to a default screen pauses input (`invalidateView()`), stops the virtual
  display's `SCStream`, releases `CGVirtualDisplay` (after `>= 2.5s` lifetime),
  waits until the virtual display is offline and macOS's restored default display
  is online in `CGGetOnlineDisplayList` / `SCShareableContent`, and then binds
  capture and completes `refreshView()`.

### Running window fill, auto-upshift gate and crash-resilient restore

- **Candidate window enumeration (`AXUIElement`)**:
  `CodelyncDesktopHost` sets a `1.0s` system-wide Accessibility messaging timeout
  (`AXUIElementSetMessagingTimeout(..., 1.0)`) so an unresponsive app cannot stall
  serial host RPCs. Window enumeration inspects running apps in
  `NSWorkspace.shared.runningApplications` with `activationPolicy == .regular &&
  !isTerminated` (explicitly excluding Codelync's own app and helper bundles),
  queries `kAXWindowsAttribute` filtered to `kAXSubroleAttribute ==
  kAXStandardWindowSubrole`, binds each element to its `CGWindowID`
  (`id = "<pid>:<cgWindowId>"`), extracts sanitized title, bounds, `minimized`,
  and `onVirtualDisplay` (whether window center lies inside the active virtual
  display), and sorts front-to-back using `CGWindowListCopyWindowInfo`.
- **Write-ahead atomic `RestoreRecord` persistence**:
  Before moving or resizing any selected window (and after restoring any
  previously placed window), `CodelyncDesktopHost` captures the window's current
  `(frame, wasFullScreen, wasMinimized)`; if its center already lies inside the
  virtual display bounds, a fallback `originalFrame` centered on the primary
  physical display's `visibleFrame` is recorded instead. The host persists the
  `RestoreRecord` atomically (`0o700` directory, `0o600` temp file + `fsync` +
  atomic rename to `<state-dir>/window-restore.json`) *before* mutating the
  window. If persisting `RestoreRecord` fails (or `--state-dir` is unavailable),
  the move aborts immediately (`409 desktop-restore-persist-failed`) without
  altering the window. If a target window is minimized, it is unminimized first;
  if it is in native macOS fullscreen (`AXFullScreen == true`), fullscreen is
  exited first and `RestoreRecord` is atomically updated with the windowed frame
  before moving.
- **Target `visibleFrame` placement, min-width auto-upshift & `geometry` gate**:
  Target fill bounds use the virtual display's `NSScreen.visibleFrame` (excluding
  the macOS menu bar and Dock) converted from AppKit bottom-left coordinates to
  Accessibility top-left coordinates (`x = visibleFrame.minX`, `y =
  primaryScreenHeight - visibleFrame.maxY`, `width = visibleFrame.width`,
  `height = visibleFrame.height`), with zero `28pt` third-party home-bar
  subtraction because Codelync's dock lives on the phone. Placement runs a
  `setSize -> setPosition -> setSize` retry loop (up to `10` attempts, `0.25s`
  apart) until `AX.frame` matches `fillArea` within `2pt` or stabilizes at the
  origin across two consecutive reads (app minimum-size clamp), then raises and
  activates the window. If the placed window's clamped width or height exceeds
  `fillArea + 2pt`, the host computes
  `needed = max(CGFloat(currentWidth) * got.width / fillArea.width,
  CGFloat(currentWidth) * got.height / fillArea.height)` (multiplying before
  dividing to avoid IEEE-754 rounding drift) and selects the smallest pre-registered
  `10pt` step `nextWidth >= ceil(needed)` capped at `1080pt`. When `nextWidth >
  currentWidth`, the host invalidates the view (`invalidateView()`), upshifts the
  virtual display via `--set-mode`, waits for `NSScreen.visibleFrame` to reflect
  `nextWidth`, and refills the window into the expanded `fillArea` (top-left
  aligned at `1080pt` if the app's minimum width exceeds `1080pt`). Every
  window-fill or window-restore mutation concludes with
  `if !viewDirty { invalidateView() }; try await refreshView()` and returns the
  updated `display` (`width`, `height`, `logicalWidth`, `logicalHeight`,
  `kind`, `geometry`), `geometry`, `trackSid`, `viewPending`, `activeWindowId` and
  `upshifted`, keeping mobile input blocked until a frame from the new `trackSid`
  is decoded and confirmed via `ready`.
- **Automatic restoration triggers & startup crash recovery**:
  Saved `RestoreRecord` entries restore `originalFrame` (plus `wasMinimized` /
  `wasFullScreen`) and settle `<state-dir>/window-restore.json` automatically on:
  (1) selecting a different window to fill or invoking explicit `mode: "restore"`,
  (2) switching display selection from the Virtual Phone Screen to a physical
  display, (3) remote desktop disconnect/`leave`, `15,000ms` heartbeat expiry,
  lock or permission loss, device revocation, disabling remote desktop, or
  graceful host shutdown (`stop()`, `SIGTERM`, `stdin` EOF), and (4) idempotent
  startup crash recovery when `CodelyncDesktopHost` starts (or becomes
  Accessibility-trusted) with `--state-dir` (quarantining corrupt JSON files,
  verifying window identity via `CGWindowListCopyWindowInfo`, restoring existing
  windows, deleting records for closed windows, and retaining records only while
  an existing window's owner process is temporarily unresponsive; any leftover
  `display-modes-snapshot.json` is likewise reconciled).
- **Strict non-intrusion & deferred session-adapter boundaries**:
  Original desktop applications (including Codex, Antigravity Desktop, Claude
  Desktop (Gateway), IDEs and terminals) remain sole owners of their sessions,
  runtimes and settings. Phase 2 `AXUIElement` usage in `CodelyncDesktopHost` only
  enumerates standard desktop windows and moves/resizes/restores a user-selected
  window on the Remote Desktop Virtual Phone Screen: it never activates deferred
  window session adapters (`native/MacOSAX*`), and window identifiers
  (`<pid>:<cgWindowId>`), Accessibility frames, and screen video never count as
  native session support, session identities, or agent admission. Codelync never
  sends `⌘+` / `⌘=` / `⌘-` font or UI zoom keystrokes, never edits or mutates
  desktop application configuration/workspace files, never launches replacement
  model runners, never opens/closes/quits/force-quits/restarts original desktop
  applications or renders an in-screen app-launcher HUD, never installs a global
  Mac `CGEventTap` to hijack mouse drags, and never sniffs logs or Accessibility
  UI of third-party remote-control software (such as UU Remote).

## Transport and identity

### Self-hosting documentation

The Mac's custom media-server fields expose a localized Deployment guide link
to the rendered `docs/SELF-HOSTING.md` or `docs/SELF-HOSTING.zh-CN.md` on the
canonical GitHub repository's main branch. This guide distinguishes LiveKit
media from Codelync's HTTP/WebSocket network relay, documents Linux Compose
deployment and optional TURN/TLS, using the public source repository.
Opening the guide is independent of service availability
and does not alter saved settings or start a connection. Saving media settings
validates their format; actual RoomService/media reachability is tested at join.

Templates generate independent credentials on the deployment machine, retain
them only in ignored private files, and expose HTTPS/WSS through TLS termination.
Their checks report API/service reachability separately from a phone's actual
encrypted media/input acceptance. TURN/TLS on port 5349 does not promise access
from networks permitting only TCP 443; that requires a separate IP or an
appropriate layer-four routing design.

- Existing authenticated sealed peer APIs authorize `status`, `displays`, `join`,
  `ready`, `heartbeat`, `quality`, `display`, `space`, `windows`, `window`,
  `input` and `leave` under `/api/peer/desktop/<action>` (`16,384`-byte gateway
  request cap, `30,000ms` timestamp window and `60,000ms` nonce replay guard).
  All routes are machine scoped, never session scoped. Request and response
  bodies are sealed end to end (`windows` is read-allowed on admitted peer routes;
  mutating actions including `join`, `display`, `quality`, `space`, `window` and
  `input` are write-fenced).
- Each join owns a fresh room, unpredictable connection ID, generation, E2EE key
  and short-lived restricted LiveKit tokens. One paired phone controls at a time.
  Room identity and tokens bind the approved device and generation. Join keys and
  server secrets never enter public metadata, ordinary logs or source control.
- Media E2EE is required before publishing or enabling input. Keys are generated
  on the Mac and delivered only through the paired sealed response; the SFU never
  receives these keys. Native SDK version interoperability is an acceptance gate.
- Local LiveKit signaling is proxied at a dedicated media path. Each upgrade
  verifies its issued token, active device, connection and generation before
  forwarding. The HTTP Relay/Cloudflare transports signaling; WebRTC media uses
  separately advertised ICE candidates. External servers require TLS except
  explicit private-LAN development endpoints.
- Input and mutating desktop operations (`input`, `space`, `window`) are bounded,
  ordered and tagged with the active connection and selected display geometry
  (validating `generation` whenever supplied). Replayed, expired, wrong-device,
  old-display and disconnected requests fail closed. Monotonic sequence numbers
  (`active.sequence + 1 .. active.sequence + 1024`) are reserved before host IPC
  dispatch; unknown click, key, scroll, Space or window-placement outcomes (`503
  desktop-operation-unknown` or transport timeout) retain their reserved sequence
  ID, close the active input queue, and are never automatically replayed.
  Continuous pointer updates and same-sign scrolls have bounded backpressure.
- Display capture uses ScreenCaptureKit, native input uses macOS public `CGEvent`
  APIs posted to `.cghidEventTap` (never global `CGEventTap` mouse interception),
  optional Virtual Phone Screen creation uses dynamic Objective-C runtime lookup
  of `CGVirtualDisplay*` with zero static symbol linking, and Phase 2 window
  enumeration/fill/restore uses `AXUIElement` and `CGWindowListCopyWindowInfo`.
  Scroll inputs (`action: "scroll"`) accept optional normalized `(x, y)`
  coordinates (`0..1`) that update `DesktopHost.location` on `selectedDisplay`
  before posting pixel-unit `CGEvent(scrollWheelEvent2Source: ...)` events (with
  `DesktopInputQueue` preserving the initial `(x, y)` anchor across coalesced
  same-sign scroll packets). Existing native session owners and their
  model/runtime configuration are untouched, deferred session-window adapters
  (`native/MacOSAX*`) remain inactive, and desktop clicks, window IDs
  (`<pid>:<cgWindowId>`), AX frames and screen video prove an OS action, never
  native session support or agent admission.

### Sealed wire, host IPC and persistence contracts

- **Host CLI modes (`CodelyncDesktopHost`)**:
  - Daemon mode: `CodelyncDesktopHost` (`0` arguments — must stay fast,
    non-blocking and side-effect-free so packaging `verifyDesktopHelper()` status
    probes succeed) or `CodelyncDesktopHost --state-dir=<stateDir>` (passed by
    `DesktopHostProcess` when `options.state` is set; used for atomic
    `window-restore.json` and `display-modes-snapshot.json` persistence and
    startup crash recovery when `AXIsProcessTrusted()` is `true`).
  - Short-lived mode helpers (intercepted at top of `Main.main()` before
    LiveKit/AppKit/stdin):
    `CodelyncDesktopHost --set-mode <displayID:UInt32> <logicalWidth:Int>
    <logicalHeight:Int>` and `CodelyncDesktopHost --restore-mode
    <displayID:UInt32> <ioModeIDBitPattern:UInt32> <width:Int> <height:Int>
    <pixelWidth:Int> <pixelHeight:Int> <refreshRate:Double> <session|permanent>`.
- **Display inventory & `viewport` payloads**:
  - `DesktopDisplay`: `{ id: string, name: string, kind?: 'physical' | 'virtual',
    width: number, height: number, logicalWidth?: number, logicalHeight?: number,
    geometry: string }` where `id` is `String(CGDirectDisplayID)` for physical
    displays or `"virtual"` for Phone Screen, and `width`/`height` report backing
    pixels (`2 * logicalWidth` by `2 * logicalHeight` on the 2x HiDPI virtual
    display).
  - `POST /api/peer/desktop/displays` (host `displays`): returns
    `{ displays: DesktopDisplay[], permissions: DesktopPermissions,
    virtualDisplaySupported: boolean }`.
  - `POST /api/peer/desktop/join` (`25,000ms` client / `20,000ms` host `start`
    timeout) and `POST /api/peer/desktop/display` (`25,000ms` client / `20,000ms`
    host `display` timeout): accept `displayId` (numeric physical ID
    `/^\d{1,10}$/u` or `"virtual"`) and optional
    `viewport: { width: number, height: number }` (exact keys `['width',
    'height']`, finite integers in `100..10000`, `height >= width`; malformed
    values fail closed with `400 invalid-desktop-viewport`; omitted `viewport` on
    `"virtual"` defaults to `{ width: 540, height: 1080 }`, `ratio = 2.0`). Both
    responses return the active `display: DesktopDisplay` with live `width`,
    `height`, `logicalWidth`, `logicalHeight`, `kind` and `geometry`.
- **Scroll coordinate anchor (`POST /api/peer/desktop/input`, `action: "scroll"`)**:
  - Payload: `{ action: 'scroll', deltaY: number, x?: number, y?: number }` with
    integer `deltaY` in `-1200..1200`; if either `x` or `y` is supplied, both
    must be finite numbers in `0..1` (otherwise `400 invalid-desktop-input`).
- **Phase 2 window enumeration & placement (`windows` and `window`)**:
  - `DesktopWindowItem`: `{ id: string /* "<pid>:<cgWindowId>" matching
    /^\d{1,10}:\d{1,10}$/u */, pid: number, windowId: number, appName: string,
    bundleId: string | null, title: string, bounds: { x: number, y: number,
    width: number, height: number }, minimized: boolean, onVirtualDisplay:
    boolean }`.
  - `POST /api/peer/desktop/windows` (read-allowed in `peerNetwork.ts`,
    `25,000ms` mobile / `20,000ms` host timeout): sealed request body
    `{ connectionId: string }` (or `{}`; Bridge verifies active viewer via
    `device` + optional `connectionId`, validating `generation` when supplied) ->
    response `{ windows: DesktopWindowItem[], activeWindowId: string | null }`.
  - `POST /api/peer/desktop/window` (write-fenced in `peerNetwork.ts`,
    `25,000ms` mobile / `20,000ms` host timeout): sealed request body:
    - Fill: `{ connectionId: string, geometry: string, sequence: number, mode:
      'fill', windowId: string }`
    - Restore: `{ connectionId: string, geometry: string, sequence: number, mode:
      'restore' }`
    (If optional `generation` is included in the sealed request body, it must
    match `active.generation`.) Bridge validates active viewer, active Virtual
    Phone Screen (`active.display?.id === 'virtual' || active.display?.kind ===
    'virtual'`, else `409 desktop-virtual-display-required`),
    `!active.viewPending && active.ready` (else `409 desktop-view-changed`),
    `body.geometry === active.geometry` (else `409 desktop-display-changed`), and
    monotonic `sequence` (`active.sequence + 1 .. active.sequence + 1024`),
    reserving `active.sequence = body.sequence` *before* IPC dispatch (never
    auto-replayed on `503 desktop-operation-unknown`). Returns updated `display`,
    `geometry`, `trackSid`, `viewPending`, `activeWindowId` and `upshifted`; both
    Bridge `adoptView` and Mobile `adoptView` propagate the updated `display`
    (`width`, `height`, `logicalWidth`, `logicalHeight`, `kind`, `geometry`),
    `trackSid` and `viewPending` while holding `ready = false` until
    `POST /api/peer/desktop/ready` confirms a decoded frame on the new `trackSid`.
- **Deterministic HTTP `409`, `429` and `503` error codes**:
  - `409`: `desktop-virtual-display-unavailable`,
    `desktop-virtual-display-required`, `desktop-accessibility-required`,
    `desktop-window-unavailable`, `desktop-window-unresponsive`,
    `desktop-restore-persist-failed`, `desktop-view-changed`,
    `desktop-display-changed` (alongside existing state/replay `409` codes).
  - `429`: `desktop-input-busy`, `desktop-request-busy`.
  - `503`: `desktop-operation-unknown`, `desktop-capture-unavailable`,
    `desktop-display-unavailable`.
- **`RestoreRecord` on-disk schema (`<state-dir>/window-restore.json`, `0o700` dir / `0o600` atomic file)**:
  `{ "version": 1, "records": [{ "pid": number, "windowId": number, "bundleId":
  string | null, "appName": string, "title": string, "originalFrame": { "x":
  number, "y": number, "width": number, "height": number }, "wasFullScreen":
  boolean, "wasMinimized": boolean, "savedAt": string }] }`.

## Release scope and acceptance

Remote desktop supports selecting a physical display or the optional adaptive 2x
HiDPI Virtual Phone Screen (a single session-scoped portrait `CGVirtualDisplay`
created only during an active Phone Screen session, never persistent multi-monitor
virtual hardware drivers), live E2EE video, fit/zoom/pan, pointer
click/drag/right-click, native single-finger touch scrolling (in Virtual Phone
Screen pointer mode at `1x` zoom) and tool-mode scrolling, text and common
keyboard shortcuts, macOS Spaces navigation, and Phase 2 non-intrusive
running-window fill, minimum-width auto-upshift and crash-resilient restoration.
Independent clarity (`1280` / `1920` / `2560` maximum capture long edge,
`max(width, height)`, scaled proportionally to even dimensions `>= 2` while
preserving the `{ width: 1280 | 1920 | 2560, fps: 15 | 30 | 60 }` wire payload)
and smoothness (`15` / `30` / `60` fps) controls update the active video without
ending its desktop connection. Capture dimensions never exceed the native display
backing pixels; adaptive transport may deliver lower quality on weak networks, so
configured quality is not reported as measured quality. Lock-screen login, remote
wake, file transfer and clipboard synchronization are outside this release.
Locking and permission loss stop input, restore any moved window, retire capture,
destroy any active virtual display, restore physical display modes and end the
session.

Required acceptance:
- **Baseline & transport gates**: remote-desktop defaults and persistence;
  independent phone entry with zero sessions; no capture while disabled or
  unviewed; local and external relay; genuine encrypted native media;
  paired-device enforcement; revocation and disable during capture;
  incorrect/stale/replayed input rejection; Chinese text, drag, modifiers and
  geometry mapping; multi-display switching, Spaces navigation/overview, direct
  Mac Space changes, disabled/remapped shortcuts, unconfirmed transitions,
  preserved room identity and stale-view input rejection; separate settings/tools
  and immersive fullscreen; clarity and smoothness changes during genuine video
  capture; foreground/background and disconnect cleanup; unreachable relay and
  permission errors.
- **Phase 1 host virtual portrait display, long-edge clarity & fallback gates**:
  dynamic 2x HiDPI `CGVirtualDisplay` creation from mobile portrait safe-area
  `viewport` (`baseWidth >= 540pt`, `baseHeight >= 800pt`, `540pt ~ 1080pt` step
  `10pt` ladder, `ratio` clamped `1.0...2.5`, `maxPixels = 2160 x 5400`, `~220
  PPI` `sizeInMillimeters`, `2.5s` `minimumLifetime`, 3-serial pool, zero
  `phone-models.json`); short-lived `--set-mode` and `--restore-mode` subprocess
  switching (`10s` timeout, `UInt32(bitPattern: ioModeID)`); virtual display
  destruction and full physical display resolution/pixel-scale/refresh-rate
  restoration on switch back to physical screen, disconnect, disable or quit;
  `DesktopHost.publish()` long-edge clarity scaling (`max(width, height) <= 1280
  | 1920 | 2560`) verified across portrait and landscape displays; dynamic
  Objective-C runtime `CGVirtualDisplay` lookup (`nm -u` free of static
  `OBJC_CLASS_$_CGVirtualDisplay*` symbols) with automatic Phone Screen hide
  fallback (`virtualDisplaySupported: false`) leaving physical remote desktop
  unaffected; headless Mac (`count == 0`) stream retirement and default-display
  fallback safety before virtual display teardown with zero crashes or dangling
  streams.
- **Phase 1 mobile adaptive portrait orientation, safe-area & native scroll gates**:
  Phone Screen option in display selector (hidden when unsupported); dynamic
  orientation switching (`landscape` for physical wide displays, `portrait` for
  Virtual Phone Screen, dynamic transition on screen-type switch, prior
  orientation restored on exit without manifest changes); portrait safe-area
  stage insets, unclipped bottom dock, and soft-keyboard avoidance without
  occluding controls or breaking normalized coordinate mapping; native mobile
  single-finger touch scroll mapped to `(x, y)`-anchored scroll packets
  (preserving `(x, y)` across `DesktopInputQueue` coalescing), with zero Mac
  global `CGEventTap` mouse hijacking and zero UU Remote log/AX sniffing.
- **Phase 2 window fill, auto-upshift `geometry` gate, `RestoreRecord` & non-intrusion gates**:
  running standard window enumeration (`1.0s` AX timeout, excluding Codelync) and
  move-to-fill into `NSScreen.visibleFrame` (AX top-left conversion, zero `28pt`
  home-bar subtraction, `setSize -> setPosition -> setSize` retry); post-move
  clamped min-width/height auto-upshift via `--set-mode` to the smallest fitting
  `10pt` step (`<= 1080pt`) gated by `invalidateView()` -> `refreshView()` ->
  decoded-frame `ready` confirmation (`geometry`, `trackSid`, and updated
  `display` dimensions) with sequence reservation and non-replay on
  `desktop-operation-unknown`; atomic write-ahead `RestoreRecord` persistence
  (`<state-dir>/window-restore.json`, `0o700`/`0o600`, aborting move on persist
  failure) and automatic restoration on window switch, display switch to
  physical, disconnect/quit, and `--state-dir` startup crash recovery; deferred
  session-window adapters (`native/MacOSAX*`) kept inactive; zero automatic
  `⌘+` / `⌘-` zoom keystrokes, zero desktop app configuration tampering, and zero
  launching replacement model runners or modifying/restarting original desktop
  applications.
- **Engineering & verification gates**: `spec/codelync-remote-desktop.md` and
  `spec/codelync-remote-desktop-mobile-experience.md` updated before code edits;
  `pnpm typecheck:all`, `pnpm lint`, `pnpm build:native` (including synchronized
  `desktop-runtime.json` SHA-256 manifest and `0`-arg helper probe), and targeted
  protocol, bridge state-machine, native host, and mobile automated test suites
  pass with zero errors. Use an isolated profile, state directory, simulator or
  synthetic desktop target as appropriate, and record physical-phone and
  public-network evidence separately from simulator/automated verification.
  Merge only after required gates are actually satisfied or the user explicitly
  changes the acceptance scope.
