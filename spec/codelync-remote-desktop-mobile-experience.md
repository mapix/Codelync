# Mobile remote desktop experience

Status: implementation contract, 2026-11-18.

## Job and boundaries

The remote desktop page lets a phone user view, point, scroll and type on their
Mac across either a physical Mac monitor or an optional adaptive 2x HiDPI
Virtual **Phone Screen**. The picture is the main surface. This page has no
Sessions/Desktop/Settings bottom navigation.

Native route navigation (`<Stack.Screen>` on `/desktop`) owns orientation
declaratively without altering the app-wide orientation manifest or installing a
separate global orientation lock:
- When paired and focused on a physical wide display, `<Stack.Screen>` locks
  `orientation: 'landscape'` and hides the system status bar
  (`statusBarHidden: true`).
- When paired and focused with the Virtual **Phone Screen** (`id: "virtual"`,
  `kind: "virtual"`) selected or connected, `<Stack.Screen>` locks
  `orientation: 'portrait'` and keeps the system status bar visible inside the
  top safe area (`statusBarHidden: false`).
- Switching between a physical display and the Virtual Phone Screen transitions
  orientation and status-bar visibility dynamically in place while keeping the
  single `<DesktopCanvas />` mounted.
- Leaving remote desktop (explicit exit, losing route focus, unpairing, or
  turning `remoteDesktopEnabled` off) restores `orientation: 'portrait'` and
  `statusBarHidden: false` so ordinary portrait navigation resumes cleanly.

An explicit exit stops local input and detaches the local stream before
navigation. Remote leave cleanup—including restoring any Phase 2 moved window to
its persisted `RestoreRecord` frame, retiring `SCStream` capture, tearing down
any active Virtual Phone Screen, and restoring snapshotted physical display
modes—runs on the Mac in the background; a weak network must not hold the user
on the desktop page while waiting for that acknowledgment.

Keep the current authenticated sealed desktop transport, permissions, monotonic
operation sequence reservation, and fresh-picture `geometry` / `trackSid`
decoded-frame guards. Remote desktop remains optional and disabled by default.
Original Desktop applications and sessions (`Codex`, `Antigravity Desktop`,
`Claude Desktop (Gateway)`, and all other running Mac apps) retain their runtime
owners: remote desktop and Phase 2 window placement never close, quit, modify or
restart any original Desktop app, never tamper with application configuration
files, never launch replacement model runners or submit model prompts, never
activate deferred window session adapters (`native/MacOSAX*`), never treat
window identifiers (`<pid>:<cgWindowId>`), Accessibility frames or screen video
as native session support or agent admission, never automatically inject `⌘+` /
`⌘-` (`⌘=` / `⌘-`) font-zoom shortcuts, never install a Mac-side global
`CGEventTap` to hijack mouse drags, never sniff third-party remote-control logs
or Accessibility UI (such as UU Remote), and never bundle a static
`phone-models.json` device catalog.

### Phone feature visibility

The local `remoteDesktopEnabled` preference defaults to false on first install
and upgrade. Previous visits, saved peer routes and Mac-side enablement never
provide consent to show it. Settings contains an explicit Remote Desktop switch;
its value uses the existing device-local settings persistence and is not synced.

Off removes the desktop tab and entry points. A direct route/deep link redirects
to Settings without mounting a desktop controller or requesting a stream. Turning
the switch off while that route is mounted removes its controller and returns to
Settings. On makes the phone entry available; it does not enable the Mac backend
or grant screen recording/Accessibility permissions. The immersive video page
continues to have no bottom navigation.

## Canvas and controls

- The connected picture fills the active display viewport without placing a
  permanent title row or a scrolling bank of text buttons above or below it:
  - For physical wide displays (`landscape`, `statusBarHidden: true`), the stage
    fills the horizontal-safe-area-inset landscape viewport.
  - For the Virtual **Phone Screen** (`portrait`, `statusBarHidden: false`), the
    video stage (`desktop-video-stage`) applies portrait top and bottom
    safe-area insets (`paddingTop: insets.top`,
    `paddingBottom: keyboardOpen ? 0 : insets.bottom`) so the Dynamic Island or
    notch never clips the Mac virtual display's menu bar and `DesktopCanvas`
    measures the exact portrait safe-area aspect ratio for borderless 2x HiDPI
    streaming.
- Mount one `<DesktopCanvas />` video canvas. Showing controls, the running
  window picker (`panel === 'windows'`), keyboard, display/picture settings,
  immersive mode, switching displays, or dynamically rotating `<Stack.Screen>`
  between `landscape` and `portrait` must not unmount or replace that canvas or
  create a duplicate Room subscription.
- Display selection (`panel === 'display'` and the disconnected empty-stage
  chooser) lists physical Mac displays (`kind: "physical"`) alongside a
  localized **Phone Screen** option (`id: "virtual"`, `name: "Phone Screen"`,
  `kind: "virtual"`) whenever `displays` includes the `"virtual"` entry
  (`virtualDisplaySupported: true`, including Headless Macs with zero physical
  monitors). If `CGVirtualDisplay` runtime classes or selectors are unavailable
  on the Mac (`virtualDisplaySupported: false`, `"virtual"` absent), the mobile
  client gracefully hides **Phone Screen** while physical display control works
  normally.
- When joining with or switching to `displayId: "virtual"`
  (`/api/peer/desktop/join` or `/api/peer/desktop/display`), the phone submits
  its portrait safe-area `viewport: { width, height }` (exact keys
  `['width', 'height']`, finite integers in `100..10000` with `height >= width`;
  malformed values fail closed with `400 invalid-desktop-viewport`, and omitted
  `viewport` defaults on the host to `{ width: 540, height: 1080 }`,
  `ratio = 2.0`). Because the user may select **Phone Screen** while still
  locked in `landscape` on a physical display, portrait safe-area dimensions are
  resolved without static `phone-models.json` tables using a three-tier
  priority:
  1. Latest cached live portrait safe-area metrics recorded when
     `window.height > window.width && keyboardHeight === 0`
     (`width = round(window.width - insets.left - insets.right)`,
     `height = round(window.height - insets.top - insets.bottom)`),
  2. Startup `initialWindowMetrics` from `react-native-safe-area-context` when
     `frame.height > frame.width`,
  3. Deterministic landscape-to-portrait inset fallback
     (`portraitWidth = min(w, h)`, `portraitHeight = max(w, h)`,
     `portraitTop = max(insets.top, insets.left, insets.right)`,
     `portraitBottom = Platform.OS === 'ios' && !Platform.isPad && insets.bottom > 0 ? 34 : insets.bottom`).
- Use a compact translucent dark `Glass` control dock (`desktop-control-dock`)
  centered inside horizontal and bottom safe areas (`bottom: insets.bottom + 12`,
  `maxWidth: window.width - insets.left - insets.right - 24`) without clipping
  or horizontal overflow on narrow portrait widths (`>= 375pt`) or landscape
  viewports. Primary dock actions are exit (`desktop-exit`), connection status
  indicator (`desktop-connection-indicator`), a contextual **Windows**
  quick-picker icon (`desktop-windows`, shown when connected to the Virtual
  Phone Screen), keyboard (`desktop-keyboard`), and more controls
  (`desktop-more`), with every touch target at least `44x44pt`.
- Put pointer modes, zoom, display selection, picture clarity/smoothness
  settings, Spaces, running-window fill/restore (`panel === 'windows'`, also
  reachable via a labeled `desktop-windows-menu` row in `panel === 'controls'`
  when connected to the Virtual Phone Screen), and connection details/disconnect
  in secondary expandable `Glass` panels
  (`type Panel = 'controls' | 'display' | 'quality' | 'spaces' | 'windows' | 'status' | null`).
  Picture clarity tiers (`1280 / 1920 / 2560`) cap the display's **long edge**
  `max(width, height)` in even backing pixels (`>= 2`) without upscaling above
  native display resolution, preserving sharp 2x portrait text as well as
  landscape clarity while retaining the `{ width: 1280 | 1920 | 2560, fps: 15 | 30 | 60 }`
  wire payload. All panel touch targets are at least `44pt`.
- Expanded panels stay inside safe areas
  (`width <= min(360, window.width - insets.left - insets.right - 24)`,
  `maxHeight = window.height - insets.top - insets.bottom - 92`), scroll
  internally when necessary, and do not intercept picture gestures outside their
  own bounds. On compact landscape viewports (`height < 460pt`), panel headers
  and content padding tighten while preserving at least `44pt` touch targets,
  single-line panel titles and menu labels truncate cleanly without hiding
  detail values or chevrons, and the disconnected empty state scrolls cleanly in
  both portrait and landscape so it never clips behind the bottom dock. Only one
  panel is open at a time. The fullscreen action hides controls rather than
  opening another native modal containing another video view; a visible
  `>= 44pt` restore control (`desktop-restore-controls`) brings them back.
- Keyboard appearance closes any open popover, hides the floating dock, applies
  `keyboardInset` on the root container (iOS `keyboardWillChangeFrame` /
  `keyboardDidShow` overlap and Android edge-to-edge `ITYPE_IME` inset), switches portrait stage
  bottom safe-area padding to `0` (`paddingBottom: keyboardOpen ? 0 : insets.bottom`
  while keeping `paddingTop: insets.top` in portrait), and docks
  `RemoteDesktopKeyboard` directly above the OS keyboard
  (`paddingBottom: keyboardHeight > 0 ? 8 : insets.bottom + 8`, supporting
  hardware-keyboard mode when `keyboardHeight === 0`) without overlapping the
  shrunk video stage. `RemoteDesktopKeyboard` remains mounted while hidden so
  uncommitted English/Chinese IME drafts survive hide/show transitions. Preserve
  accurate normalized `[0, 1]` `desktopPoint()` coordinate mapping across every
  orientation, safe-area, `--set-mode` upshift (`adoptView`), and keyboard
  layout change. When the user has selected a point in the remote picture,
  opening the keyboard runs `desktopViewportFocus()` locally to keep that point
  visible and retain the previous picture scale within the `1x..4x` zoom limit
  without sending media or input requests; closing the keyboard restores the
  prior camera, and without a selected point ordinary fit behavior is retained.
- Connection errors and unconfirmed operation notices (including Spaces and
  Phase 2 window operations) update a fixed indicator and expandable status
  details. They do not add or remove layout rows that shift the picture.
  Permission, waiting, unconfirmed-action, and reconnecting states use distinct
  actionable copy.

### Touch gestures and native portrait scrolling

- Gesture mode and local camera reset to
  `{ mode: 'pointer', zoom: 1, offset: { x: 0, y: 0 } }` whenever the active
  display identifier or `geometry` token changes, and touch dispatch is gated on
  `controlsEnabled` (confirmed `ready` frame, writable peer route, Accessibility
  granted, and `!busy`).
- When connected to the Virtual **Phone Screen** (`id: "virtual"` /
  `kind: "virtual"`) in default `'pointer'` mode at unzoomed fit (`zoom === 1`):
  - A stationary single-finger tap (`Math.hypot(dx, dy) <= 6pt`) records the
    local focus target (`onTarget`) and sends a left click
    `{ action: 'pointer', phase: 'click', x, y, button: 'left' }` at the initial
    touch's normalized `[0, 1]` coordinate.
  - Single-finger movement exceeding `6pt` (`Math.hypot(dx, dy) > 6pt`) acts
    natively on the phone as touch scrolling (`60ms` throttle), sending
    `{ action: 'scroll', deltaY, x, y }` where `deltaY` is an integer clamped to
    `-1200..1200` (`round(y - lastY)`, producing natural content scrolling on
    macOS) and `(x, y)` is anchored at the initial touch's normalized `[0, 1]`
    display coordinate (`initial.point`). `CodelyncDesktopHost` updates
    `DesktopHost.location` on `selectedDisplay` from `(x, y)` before posting
    `CGEvent(scrollWheelEvent2Source: ...)` so scroll events always land on the
    touched view even before any prior pointer click.
- On **physical displays** in `'pointer'` mode at `zoom === 1`, single-finger
  movement continues to dispatch `{ action: 'pointer', phase: 'move', x, y }`
  and taps `<= 6pt` dispatch left clicks.
- Across **both** Virtual Phone Screen and physical displays:
  - `'pointer'` mode with `zoom > 1` pans the zoomed local canvas (`setOffset`);
  - Explicit `'drag'` mode sends `pointer` `down` on touch grant, `move` during
    drag, and `up` on release or responder termination (preserving single-finger
    text selection and window dragging on the Virtual Phone Screen);
  - Explicit `'right'` mode sends right-click on tap `<= 6pt` and `pointer`
    `move` on drag;
  - Explicit `'scroll'` mode forces scroll packets at any zoom level (including
    the initial touch `(x, y)` anchor when valid);
  - Two-finger gestures (`touches.length >= 2`) perform local pinch-zoom
    (`1x..4x`) and two-finger pan (`setOffset`) while cleanly releasing any
    active `'drag'` (`phase: 'up'`).
- Single-finger touch scrolling is implemented strictly on the mobile client
  over Codelync's sealed `input` channel—never via a Mac-side global
  `CGEventTap` mouse-drag interceptor and never by inspecting third-party
  remote-control logs or Accessibility trees.

## Visual direction

Use the desktop picture as the full-screen stage, with a small thumb-operated
dock as the signature. Native system type carries labels, while technical size
and frame-rate values use a compact utility face. No decorative headings.

Tokens: canvas `#020406`, glass `rgba(16,25,34,0.76)`, foreground `#E8EEF4`,
quiet text `#80929C`, action `#88C9E5`, warning `#F2B765`. Use restrained blur,
thin translucent borders and clear pressed/selected/disabled states across all
dock controls and `Glass` popovers (including **Phone Screen** selection and the
Phase 2 **Windows** picker). Respect safe-area insets, explicit localized UI and
VoiceOver labels across all four Remote Desktop locales (`en`, `zh`, `zhHant`,
`ja` in `remoteDesktopLabels.ts`, without English fallback), and reduced motion;
no continuous animations.

## Running window fill, auto-upshift gate and restore

When actively connected to the Virtual **Phone Screen**
(`grant.display.id === "virtual"` or `grant.display.kind === "virtual"`), the
phone exposes a non-intrusive running-window picker (`panel === 'windows'`,
`testID="desktop-windows-panel"`) via both a 1-tap contextual icon in
`desktop-control-dock` (`desktop-windows`) and a labeled menu row in
`panel === 'controls'` (`desktop-windows-menu`):

- **Popover UX and localization**: `desktop-windows-panel` renders inside the
  existing `Glass` popover system (never a native `Modal` that obscures status
  or remounts `<DesktopCanvas />`), obeys the single-open-panel rule, keeps
  every interactive row and button `>= 44pt`, scrolls inside safe areas, and
  provides complete localized copy across `en`, `zh`, `zhHant`, and `ja` (panel
  title, dock/menu labels, window app/title rows, minimized/active badges,
  empty/loading states, **Refresh**, **Restore**, and deterministic domain error
  messages).
- **Window inventory (`POST /api/peer/desktop/windows`)**: Opening or refreshing
  the panel sends a sealed machine-scoped request (`{ connectionId: string }` or
  `{}`, allowed as a read-like POST in `peerNetwork.ts`, `25,000ms` mobile
  timeout / `20,000ms` host timeout; Bridge verifies active viewer via `device`
  + optional `connectionId`, validating `generation` when supplied) returning
  `{ windows: DesktopWindowItem[], activeWindowId: string | null }` for standard
  windows (`kAXStandardWindowSubrole`) of regular running Mac apps (`1.0s`
  `AXUIElement` messaging timeout, excluding Codelync itself), identified by
  `"<pid>:<cgWindowId>"` (`/^\d{1,10}:\d{1,10}$/u`).
- **Move-to-fill and manual restore (`POST /api/peer/desktop/window`)**:
  Selecting a window row dispatches a sealed request with
  `{ connectionId: string, geometry: string, sequence: number, mode: 'fill', windowId: string }`;
  activating **Restore** dispatches a sealed request with
  `{ connectionId: string, geometry: string, sequence: number, mode: 'restore' }`
  (if optional `generation` is included in the sealed request body, it must
  match `active.generation`). Both are write-fenced in `peerNetwork.ts`
  (`25,000ms` mobile timeout / `20,000ms` host timeout), require an active
  Virtual Phone Screen (`409 desktop-virtual-display-required`), Accessibility
  permission (`409 desktop-accessibility-required`), a confirmed live picture
  (`!viewPending && ready`, else `409 desktop-view-changed`), and matching
  `geometry` (else `409 desktop-display-changed`), and reserve a strictly
  monotonic `sequence` (`active.sequence + 1 .. active.sequence + 1024`)
  *before* host IPC dispatch.
- **Auto-upshift and decoded-frame `geometry` gate**: Before sending `window`,
  the mobile controller closes `inputQueue`, sets `ready = false` and
  `busy = true`, and fences all input. On the Mac host, after atomically
  persisting the write-ahead `RestoreRecord`, the target window is unminimized /
  exited from native fullscreen if needed and moved/resized
  (`setSize -> setPosition -> setSize` retry loop) into the Virtual Phone
  Screen's `NSScreen.visibleFrame` converted to AX top-left coordinates (with no
  `28pt` third-party home-bar subtraction). If the window's clamped minimum
  width or height exceeds `visibleFrame` (`+ 2pt` tolerance), the host
  automatically upshifts the Virtual Phone Screen via a short-lived `--set-mode`
  subprocess to the smallest pre-registered proportional `10pt` step
  (`<= 1080pt`) fitting
  `max(base * got.width / area.width, base * got.height / area.height)`, refills
  the window, executes `if !viewDirty { invalidateView() }; try await refreshView()`,
  and returns updated `{ display, geometry, trackSid, viewPending, permissions, activeWindowId, upshifted }`.
  Both Bridge `adoptView` and Mobile `adoptView` update the full `display`
  metadata (`width`, `height`, `logicalWidth`, `logicalHeight`, `kind`,
  `geometry`) alongside `trackSid` and `viewPending` so `desktopPoint()` and
  `desktopViewportFocus()` reflect the upshifted dimensions immediately, while
  input stays blocked until `DesktopCanvas` decodes a frame
  (`framesDecoded > 0`) on the new `trackSid` and confirms
  `POST /api/peer/desktop/ready`.
- **Uncertain outcomes and deterministic errors**: Explicit `409` domain codes
  (`desktop-virtual-display-unavailable`, `desktop-virtual-display-required`,
  `desktop-accessibility-required`, `desktop-window-unavailable`,
  `desktop-window-unresponsive`, `desktop-restore-persist-failed`,
  `desktop-view-changed`, `desktop-display-changed`) surface localized notices;
  uncertain `5xx` (`503 desktop-operation-unknown`) or network failures on
  `window` classify as `'desktop-operation-unknown'`, retain the reserved
  `sequence` without automatic replay, keep the notice visible in connection
  details, and reconcile view state via `recoverView()` (`heartbeat`).
- **Write-ahead `RestoreRecord` and automatic restoration**: The Mac host
  persists `<state-dir>/window-restore.json` (`0o700` dir / `0o600` atomic file)
  *before* moving any window (aborting the move with
  `desktop-restore-persist-failed` if disk write fails) and automatically
  restores moved windows to their saved `originalFrame`, `wasFullScreen`, and
  `wasMinimized` states when switching to another window, tapping **Restore**,
  switching back to a physical display,
  disconnecting/backgrounding/revoking/disabling remote desktop (`15,000ms`
  heartbeat watchdog included), shutting down the host (`stop()`, `SIGTERM`), or
  recovering on next `CodelyncDesktopHost --state-dir=<stateDir>` startup after
  an abnormal exit.
- **Strict R4 non-intrusion & deferred session-adapter boundary**: Phase 2
  `AXUIElement` usage only lists standard desktop windows and repositions/resizes/restores
  a user-selected window on the Remote Desktop Virtual Phone Screen. It never
  activates deferred window session adapters (`native/MacOSAX*`), never treats
  `<pid>:<cgWindowId>`, AX frames or screen video as native session support or
  agent admission, never sends `⌘+` / `⌘-` font-size shortcuts, never edits
  desktop app settings/configs, and never launches, closes, or restarts original
  Desktop apps.

## Keyboard

Opening the keyboard focuses a real native input control. English and Chinese
IME text must be usable without unwanted duplicate insertion. Submit committed
text through the existing ordered input path; only a confirmed accepted result
clears the submitted draft. Rejected or unconfirmed input keeps the draft and
is never retried automatically. Concurrent edits after submission are retained.

Enter, Tab, Escape, Backspace, arrows and common Command shortcuts have explicit
accessible controls with localized screen-reader labels across English (`en`),
Simplified Chinese (`zh`), Traditional Chinese (`zhHant`) and Japanese (`ja`).
Codelync never automatically synthesizes `⌘+` / `⌘-` zoom keystrokes when
connecting, switching modes, or filling windows. The keyboard hint/limit row
collapses when empty so normal typing preserves picture height. Shortcut keys
follow the same permission, connection and fresh-view guards as pointer input.
Respect the current 2,048 UTF-16-unit text limit; oversized input is not
silently truncated or partially submitted. Local editing and keyboard dismissal
do not send input to a Desktop session composer.

Pointer moves and adjacent scrolls in the same direction (`Math.sign(deltaY)`
equal) may coalesce in `DesktopInputQueue` while a request is in flight. Keep
the coalesced scroll total inside the `-1200..1200` pixel packet bound,
**preserve the initial scroll packet's normalized `(x, y)` coordinate anchor**
(`0..1`, both `x` and `y` finite numbers when supplied; malformed partial or
out-of-range coordinates fail closed with `400 invalid-desktop-input`), preserve
direction changes, and never merge text, keys, clicks, pointer down/up, or
window commands. The bounded queue (max 16 waiting items) cannot replay an
uncertain input. Queue saturation reports an input backlog (`desktop-input-busy`)
rather than a misleading media failure.

## Android parity, orientation, IME and system back

- **Native WebRTC and E2EE media parity**: On Android (`com.learnings.codelync`,
  Debug and standalone Release APK), `@livekit/react-native` (`RNKeyProvider` and
  `RNE2EEManager`) connects to the active peer channel's `/api/peer/desktop/media/rtc`
  signaling proxy and advertised ICE TCP/UDP candidates (including private RFC1918
  LAN channels where Android cleartext HTTP/WS is explicitly permitted) and decrypts
  the video track end-to-end with the 32-byte join key. Pointer, scroll, key and
  text inputs remain gated until `RemoteVideoTrack` receiver stats confirm
  `framesDecoded > 0` and `POST /api/peer/desktop/ready` succeeds for the active
  `(connectionId, trackSid, geometry)`.
- **Display-aware orientation lock and portrait restore**: Route orientation
  (`expo-router` `<Stack.Screen>` / `expo-screen-orientation`) locks physical
  wide displays into `'landscape'` (hiding the status bar while connected and
  focused) and preserves `'portrait'` (keeping portrait status-bar and bottom
  safe-area insets respected) whenever an adaptive portrait virtual display
  (Phone Screen, `kind: 'virtual'`) is selected or active. Switching between
  physical and portrait virtual displays updates orientation dynamically without
  remounting the single video canvas or reconnecting the LiveKit room. Leaving
  `/desktop` or turning `remoteDesktopEnabled` off deterministically restores
  `'portrait'` navigation without modifying the app-wide Android manifest
  orientation.
- **Edge-to-edge safe areas and Android IME lift**: Under `<KeyboardProvider>`
  (`setDecorFitsSystemWindows(window, false)`), Android does not auto-resize the
  root view when the soft keyboard (`ITYPE_IME`) opens. When `keyboardOpen` is
  true on Android, `RemoteDesktopView` and `RemoteDesktopKeyboard` apply the
  measured positive IME inset (`keyboardInset > 0`) so the input row, send/close
  actions, status/limit hint and expandable shortcut strip lift completely above
  `ITYPE_IME` in both landscape physical-display mode and portrait virtual-display
  mode, while `desktopViewportFocus` recalculates canvas zoom/offset so any
  selected remote target point remains visible and normalized coordinate mapping
  stays exact. Disconnected empty states, floating docks and expandable panels
  respect `ITYPE_STATUS_BAR` and `ITYPE_NAVIGATION_BAR` (gesture pill and
  3-button navigation) as well as TalkBack / VoiceOver accessibility labels.
- **Android system Back priority**: While `/desktop` is focused, stack edge-swipe
  navigation remains disabled (`gestureEnabled: false`) so horizontal pointer,
  drag and scroll gestures near screen edges are not intercepted by route pop
  gestures. A focused `BackHandler` handles Android hardware and system gesture
  Back one layer at a time in strict priority order:
  1. `keyboardOpen` -> closes `RemoteDesktopKeyboard`, dismisses the IME and
     restores the pre-keyboard viewport camera (`closeKeyboard()`);
  2. `panel !== null` -> closes the open popover panel (`controls`, `display`,
     `quality`, `spaces`, `windows` or `status`) without disconnecting;
  3. `immersive` -> exits fullscreen chrome-hidden mode and restores the control
     dock (`setImmersive(false)`);
  4. otherwise -> invokes `exit()`, synchronously stopping local input, detaching
     the local LiveKit stream, dispatching `/api/peer/desktop/leave` in the
     background without blocking on weak networks, restoring `'portrait'`
     orientation, and returning cleanly to the prior route or `/` with zero white
     screen or crash.

## Verification and delivery

Pass `pnpm typecheck:all`, `pnpm lint`, and `pnpm build:native` (with synced
`desktop-runtime.json` SHA-256) with zero errors, and verify the mobile, bridge,
and native host remote-desktop behavior with focused automated regression sets:
- **Phone Screen inventory & cross-orientation `viewport`**: **Phone Screen**
  appears when `virtualDisplaySupported` is `true` (including Headless Mac
  virtual-only inventory), hides cleanly when `false` without affecting physical
  displays, and submits accurate portrait safe-area `viewport: { width, height }`
  across portrait and landscape-locked states (`initialWindowMetrics`, cached
  live portrait metrics, and fallback) with zero static `phone-models.json`.
- **Dynamic orientation, safe-area layout & keyboard avoidance**: Declarative
  `<Stack.Screen>` locks `landscape` (`statusBarHidden: true`) for physical
  displays and `portrait` (`statusBarHidden: false`) for Virtual Phone Screen,
  transitions dynamically when switching display types while keeping the single
  `<DesktopCanvas />` mounted, and restores `portrait` on exit/disable without
  manifest changes; portrait `stage` safe-area insets (`paddingTop: insets.top`,
  `paddingBottom: keyboardOpen ? 0 : insets.bottom`), unclipped `>= 44x44pt`
  bottom `Glass` dock, soft-keyboard avoidance, mounted IME draft retention, and
  `desktopViewportFocus()` / `desktopPoint()` `[0, 1]` coordinate accuracy hold
  across portrait, landscape, and upshift transitions.
- **Native single-finger scroll & long-edge clarity**: Phone Screen `'pointer'`
  mode (`zoom === 1`) maps `<= 6pt` taps to left clicks and `> 6pt` drags to
  `{ action: 'scroll', deltaY, x, y }` coalesced within `|deltaY| <= 1200` while
  preserving initial `(x, y)` and anchoring host scroll location, with zero Mac
  `CGEventTap` mouse hijacking and zero third-party log/AX sniffing; clarity
  tiers (`1280 / 1920 / 2560`) cap `max(width, height)` accurately in both
  portrait and landscape.
- **Phase 2 window picker, `--set-mode` `geometry` gate, `RestoreRecord` & R4
  non-intrusion**: `desktop-windows-panel` (`Glass` popover via dock + Controls
  menu, single-open-panel rule, `>= 44pt` targets, 4-locale parity across `en`,
  `zh`, `zhHant`, `ja`) lists running windows and executes `fill` / `restore`
  with monotonic `sequence` reservation and non-replay on
  `desktop-operation-unknown`; `--set-mode` min-width auto-upshift updates
  `adoptView` `display` dimensions + `geometry` + `trackSid` and blocks input
  until `videoReady` decoded-frame confirmation; write-ahead
  `window-restore.json` restores windows on window switch, physical display
  switch, disconnect/background, and host crash recovery; deferred window
  session adapters (`native/MacOSAX*`) remain inactive; and the codebase
  contains zero `⌘+` / `⌘-` zoom injection and zero original Desktop app config
  tampering or restart logic.

Review the portrait and landscape layouts with isolated fixtures/simulator
verification as appropriate without interacting with, modifying, or restarting
any running original Desktop session (`Codex`, `Antigravity Desktop`, `Claude
Desktop (Gateway)`). Source review, automated test acceptance, simulator/fixture
layout review, and physical-phone confirmation remain separate evidence. Retain
pairing, drafts, unknown operation IDs, private state, unrelated local work, and
historical deferred research sources/tests through the update.

On Android, verify both local Debug and standalone Release APK builds (cold-started
on Android Emulator without Metro) across Settings toggle gating, LAN/relay
LiveKit E2EE frame decoding, landscape/portrait orientation transitions, pointer
and Chinese/English IME text submission with `RemoteDesktopKeyboard` lifted above
`ITYPE_IME`, `ITYPE_STATUS_BAR` / `ITYPE_NAVIGATION_BAR` non-occlusion, and
multi-step `gestural` and `threebutton` system Back dismissal (`keyboardOpen` ->
`panel` -> `immersive` -> clean `/leave` and portrait restore) without touching
live user Desktop sessions.
