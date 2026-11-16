# Independent remote desktop

Status: implementation contract, 2026-11-16.

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
[Mobile remote desktop experience](codelight-remote-desktop-mobile-experience.md).

### Spaces confirmation and recovery

While a Spaces operation is pending, the phone cannot confirm the old picture
as ready or reinstall its input queue. A ready acknowledgment belongs to the
exact starting connection, grant object, track and geometry; a later view change
invalidates that acknowledgment even if a track identifier is reused. Only the
current confirmed picture permits subsequent input or another Spaces action.
An input queue retired by a Spaces, display or quality operation cannot change
the current connection when one of its old requests later fails. Reserve input
sequence numbers in order, but tolerate the resulting stale-request rejection
without disconnecting the new view or replaying that old input.

Spaces failure and unconfirmed-result explanations remain visible in the
connection details after picture recovery. A successful readiness check does
not erase them. Display/view changes are distinguished from an unavailable Mac.
Unknown operations are not replayed to try to force a desktop transition.

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
- Entering remote desktop locks the phone into landscape; leaving restores the
  prior orientation, preserving portrait Sessions even if the simulator was
  rotated for desktop testing. This feature never changes the app-wide native
  orientation manifest. Display selection and clarity/smoothness settings
  live in a separate settings panel. Pointer, drag, scrolling, zoom and keyboard
  tools form their own operation surface. Immersive fullscreen hides app chrome
  and tools, preserving an accessible exit control.
- Available physical displays come from the Mac's current native inventory.
  Switching displays during a connection releases pressed buttons, pauses input,
  updates capture and geometry, and preserves the room/connection. Input resumes
  only after a decoded frame from the new publication is confirmed. Old display
  geometry and old publication readiness cannot enable or dispatch input.
- macOS Spaces are independent from physical/virtual displays. The operation
  toolbar exposes Previous desktop, Next desktop and Mission Control overview.
  Previous/next use the user's enabled system keyboard shortcuts (documented
  defaults when no override is stored); overview opens the system Mission Control
  application. CodeLight never modifies shortcut preferences, creates/deletes
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
  shown separately. Missing permission is actionable and never implies success.
- Capture runs only during an explicit phone connection. Ending the connection,
  backgrounding the phone, revoking its device, disabling remote desktop, changing
  relay configuration or closing CodeLight ends capture and releases pressed
  buttons/modifiers. No desktop input is queued or replayed after reconnection.

## Transport and identity

- Existing authenticated sealed peer APIs authorize status, display selection,
  joins, desktop input and disconnect. All routes are machine scoped, never
  session scoped. Desktop input bodies are sealed end to end as well as replies.
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
- Input is bounded, ordered and tagged with the connection, generation and
  selected display geometry. Replayed, expired, wrong-device, old-display and
  disconnected inputs fail closed. Continuous pointer updates have bounded
  backpressure. Unknown click/key outcomes are not automatically dispatched again.
- Display capture uses ScreenCaptureKit and native input uses macOS public event
  APIs. Existing native session owners and their model/runtime configuration are
  untouched. Desktop clicks prove an OS action, never agent admission.

## First release and acceptance

The first release supports selecting a display, live video, fit/zoom/pan, pointer
click/drag/right-click, scrolling, text and common keyboard shortcuts. Independent
clarity (1280/1920/2560 maximum capture width) and smoothness (15/30/60 fps)
controls update the active video without ending its desktop connection. Capture
dimensions never exceed the native display; adaptive transport may deliver lower
quality on weak networks, so configured quality is not reported as measured quality.
Lock-screen
login, remote wake, file transfer, clipboard synchronization and virtual displays
are outside this release. Locking and permission loss stop input and capture.
Here virtual displays means additional display hardware surfaces; macOS Spaces
navigation is included in this release.

Required acceptance: remote-desktop defaults and persistence; independent
phone entry with zero sessions; no capture while disabled or unviewed; local and
external relay; genuine encrypted native media; paired-device enforcement;
revocation and disable during capture; incorrect/stale/replayed input rejection;
Chinese text, drag, modifiers and geometry mapping; multi-display switching,
Spaces navigation/overview, direct Mac Space changes, disabled/remapped shortcuts,
unconfirmed transitions, preserved room identity and stale-view input rejection;
landscape entry/exit, separate settings/tools and immersive fullscreen; clarity and smoothness changes
during genuine video capture; foreground/background and
disconnect cleanup; unreachable relay and permission errors; Mac/phone build,
typecheck, lint and targeted protocol regression gates. Use an isolated worktree,
profile, bundle IDs, simulator and synthetic desktop target. Record physical
phone and public-network acceptance separately. The user narrowed this iteration
to simulator testing and will personally exercise the completed simulator build;
physical-phone and public-network deployment are not gates for this iteration.
Present the prepared simulator only after development and automated verification
are complete, and retain the worktree until the user confirms their manual test.
Merge only after required gates
are actually satisfied or the user explicitly changes the acceptance scope.
