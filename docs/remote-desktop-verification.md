# Remote desktop verification

Implementation is isolated on `codex/remote-desktop`, based on main `99e0911`.
The user requested simulator-only acceptance and a manual test before merge.

## Verified automatically

- Node 24.15.0 / pnpm 10.11.0; bridge, mobile and production relay type checks.
- Root ESLint and targeted existing pairing/connection regressions.
- Thirty-three protocol tests covering defaults, private settings, sealed requests,
  device-bound JWTs, replay/expiry rejection, quality changes, display switching,
  old geometry/publication readiness rejection, revoke/disable cleanup and
  separate v0/v1 media signaling proxy authentication.
- Spaces previous/next/overview controls, OS-change view invalidation, fresh
  publication readiness, non-replay of navigation, and unconfirmed/disabled
  shortcut handling. The helper runs the AppKit event loop to receive the public
  NSWorkspace Spaces notifications.
- Mobile coordinate inversion, letterboxing and bounded pointer input ordering.
- Swift capture/control helper and pinned LiveKit 1.13.11 server compilation.
- Mac packaging, including a packaged helper startup check; signed simulator
  build with preserved CodeLight identity and native secure storage.
- Genuine encrypted video from the Mac to the isolated simulator, desktop-only
  landscape layout, separate quality/display panel and live clarity/fps changes.
- Immersive fullscreen and exit, disconnect/media-process cleanup, and native
  navigation restoring portrait Sessions after leaving the desktop route.

## Acceptance boundaries

The current Mac has one available native display. Multi-display selection and
stale-frame/input fencing are covered by two-display protocol fixtures; physical
multi-display switching needs an additional connected display.

Physical-phone, public-network NAT/TURN and external-server deployment are outside
this user-selected simulator iteration. A local SFU requires reachable media
ports; the existing HTTP/WebSocket tunnel carries signaling only.

On 2026-11-16 the user accepted this iteration, explicitly stopped continued
testing, and requested committing the work and notifying the main chat to
integrate and repackage it. Physical multi-display validation remains unperformed;
final AppKit event-loop compilation/packaging passed, without an additional live
transition confirmation run after the user's stop instruction. Raw images, pairing grants,
credentials, profiles, test app bundles and device state stay in ignored private
evidence and are never committed.
