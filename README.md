# Codelync

[Website](https://codelync.novarock.io/) · [Source repository](https://github.com/mapix/Codelync) · [MIT license](LICENSE) · [中文](README.zh-CN.md) · [日本語](README.ja.md)

Codelync is a native iPhone and Android companion (`com.learnings.codelync`) for
people who have configured Gateway mode in Codex, Antigravity Desktop or Claude
Desktop. Open the Mac companion and scan its QR code to view existing projects,
sessions and available child logs with end-to-end encrypted sync. Actions follow
each original desktop's confirmed capabilities; Android matches the iPhone
client's full session, media and optional remote desktop feature set in a
push-free foreground mode (push notifications are excluded on Android).

For everyday subscription use, we recommend the vendors' official apps.
Codelync is an independent project. The source is public on GitHub; pairing requires no separate phone account or VPN.

The public Mac preview targets Apple Silicon with macOS 14+ and includes
the three-Desktop integration within each owner's confirmed capabilities. Public downloads
are Developer ID signed, Apple notarized and stapled. The website shows current
iPhone TestFlight beta availability; iOS source builds use your own Apple signing,
and Android source builds produce local Debug and standalone installable Release
APKs (`com.learnings.codelync`). Device-bound IPAs and local signing keystores
are not public downloads. Remote desktop is hidden by default on iPhone and
Android; enable its feature switch in Settings when needed.

The app and website support English, Chinese and Japanese and default to your
system language. Select a language in mobile Settings (iPhone or Android) or on
the website to override it. The GitHub README, contributor documentation and
releases use English as their primary language.

Read [security and trust boundaries](SECURITY.md) before pairing a phone. A paired
device can control the exposed sessions of your Mac's Codelync account.

## Supported scope

- Codex, Antigravity Desktop and Claude Desktop (Gateway) keep their original native sessions. Each app/mode exposes only its confirmed capabilities; support for a desktop does not imply identical controls across apps. Claude Desktop's complete formal controls remain under verification.
- Session IDs, history increments, input admission, stop actions, questions, permissions and model/effort settings keep the original Codex identity and confirmed capability boundaries.
- CLI families, other harnesses, window sharing and accessibility control are deferred. Historical source files and research specs remain in the repository; they are not advertised as enabled product support.

### Gateway release scope

Gateway here means the desktop's third-party model inference gateway, separate
from Codelync pairing, Relay and network channels.

| Desktop | Current release audience | Native connection |
| --- | --- | --- |
| Codex | Users with Gateway mode configured | Verified, already-running Desktop IPC owner and original session identity |
| Antigravity Desktop | Users with Gateway mode configured | Verified, already-running native Language Server owner and original session identity |
| Claude Desktop | Only a verified Gateway mode is currently supported; ordinary official-login/non-Gateway mode is not supported | Explicitly installed and verified native owner bridge/runtime manifest, with the effective Gateway configuration verified |

Available actions follow each original owner's confirmed capabilities. Claude's
production installation and complete native-control acceptance gates remain open.

Build the current source for the three-Desktop implementation. Integration and
live verification are tracked in the [Antigravity contract](spec/antigravity-remote-control.md)
and [Claude Desktop contract](spec/claude-desktop-native.md).

See the [current product contract](spec/codelync-product.md),
[project activity contract](spec/codelync-project-activity.md) and
[standalone project contract](spec/codelync-standard-project.md).

## Workspace

| Directory | Purpose |
| --- | --- |
| `apps/mobile` | Expo / React Native phone App (iPhone and Android, `com.learnings.codelync`) |
| `apps/mac` | SwiftUI Mac App |
| `packages/relay` | Embedded encrypted sync API |
| `packages/wire` | Licensed shared wire protocol |
| `src` | Native session bridge, discovery, pairing and device authorization |
| `native` | Mac helper sources and native build entitlements |
| `spec` | Current product/protocol rules and marked historical research |
| `assets/branding` | Generated Codelync brand assets |

## Self-hosting

See the [Relay and remote desktop deployment guide](docs/SELF-HOSTING.md)
([中文](docs/SELF-HOSTING.zh-CN.md)) and [Linux Compose templates](deploy/self-host/).
The Mac already includes a local LiveKit server. A self-hosted HTTP/WebSocket
relay provides a communication route; public video requires independently
reachable media paths or the optional external LiveKit configuration.

## Development

The current source also includes an optional, independent remote desktop. It is
off by default on the Mac and uses a bundled local LiveKit media server, or an
explicitly configured external LiveKit server. The phone has a separate desktop
tab with landscape, display switching, quality controls and immersive fullscreen.
See [the remote desktop contract](spec/codelync-remote-desktop.md). This feature
is under simulator acceptance and is not included in the older public downloads.

Building its native runtime additionally requires Go 1.26+ and Xcode with Swift
6.1+. `pnpm build:native` builds the pinned LiveKit server and Swift capture helper;
`pnpm build:desktop` rebuilds only those desktop runtime components.

Use Node 24.15.0 and pnpm 10.11.0:

```sh
pnpm install
pnpm typecheck:all
pnpm lint
pnpm dev:mobile
```

Build the Mac helpers and App:

```sh
pnpm build:native
CODELYNC_CLOUDFLARED_BINARY=/absolute/path/to/cloudflared pnpm build:mac
node scripts/sign-mac-app.mjs /absolute/path/to/Codelync.app 'Developer ID Application: Your Name (TEAMID)'
```

The packaging script uses the running Node executable. Supply `CODELYNC_NODE_BINARY` to choose another Node 24 binary. Node's license is included under `licenses/`. Supply a compatible cloudflared executable via `CODELYNC_CLOUDFLARED_BINARY`, or place it under `.runtime/cloudflared`.

For a signed iPhone trial, use `pnpm build:mobile --device YOUR_DEVICE_ID --team YOUR_TEAM_ID` (add `--generic` to compile while the phone is offline). The wrapper uses the local-trial entitlement file. The Xcode workspace remains `apps/mobile/ios/Codelync.xcworkspace`; use your own Apple Development identity/team. The current bundle identifier is `com.learnings.codelync`; the generated target name is an implementation detail retained for existing installs.

For Android (`com.learnings.codelync`, URI scheme `codelync://`), use Node 24.15.0, pnpm 10.11.0, JDK 21, and Android SDK 36 (`build-tools 36.0.0`, NDK `27.1.12297006`) to build a local Debug APK or a standalone installable Release APK (embeds the production Hermes bundle and runs without Metro):

```sh
# Debug APK -> apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
node scripts/build-mobile.mjs --platform android --configuration Debug
pnpm --filter @codelync/mobile build:android:debug

# Standalone Release APK -> apps/mobile/android/app/build/outputs/apk/release/app-release.apk
node scripts/build-mobile.mjs --platform android --configuration Release
pnpm --filter @codelync/mobile build:android:release
```

Supply an explicit keystore via `CODELYNC_UPLOAD_STORE_FILE` (and companion store/key credentials) when needed, or let local builds use an untracked gitignored keystore under `apps/mobile/android/.signing/`. Never commit `.keystore` or `.jks` files. See [build and verification details](docs/BUILD-AND-VERIFY.md).

## Behavior

- Titles publish most recent first using the original desktop update time, grouped by project across worktrees and isolated by app/host. Codex sessions older than 72 hours initially load basic title/project/time fields; opening one loads its richer data.
- Paired phones restore an account-bound encrypted title cache. Existing rows remain usable while titles synchronize; stale connection results show synchronization until a current request can confirm failure. Opening a chat never waits for the whole title catalog.
- A session tap requests desktop selection immediately and starts synchronization; no extra Open Desktop step.
- Native project conversations use a session select box. Long titles fit the closed control, and the platform menu lists the available conversations.
- Foreground project headers and visible session rows use lightweight native active/waiting summaries. Unknown, stale or disconnected observations remain explicit; message history is loaded only for selected sessions.
- Mac prepares directory snapshots and maintains a bounded native status replica every five seconds, independently of phone connections. Native directory scans run separately every twenty seconds. The default background status pool covers sixteen ordinary sessions plus existing message actors, within 128 total observers. Sessions without reliable current proof remain unconfirmed.
- Opening a warm session displays its retained recent window first, then confirms the original owner in the background. Cold sessions use the existing fresh-read path. Earlier history loads in bounded pages only when you scroll upward; list/background work does not prefetch old history. A long active turn's start time is not used to date every new message.
- An authenticated HTTP route remains readable while its realtime socket recovers. Same-Mac route changes retain cached messages, expanded rows and drafts. Directory and activity reads use independent incremental watermarks; unknown writes only query their original receipt IDs.
- After pairing, the Mac App defaults to a statistics dashboard with realtime/cumulative gateway traffic and interaction counts. Use the Statistics/Pairing switch to scan again.
- Mac **Start** and **Pause** control the Codelync service. Pause completes its owned service shutdown before Start becomes available. Pairing, settings and operation journals are retained; the original desktop sessions keep running.
- Mac **Sources** independently enables Codex, Antigravity Desktop and Claude Desktop (Gateway), with all three selected by default. Choices persist. Turning a source off stops Codelync discovery, observation and controls for that source; the original app and sessions continue running. Re-enabling loads current source state without replaying old commands.
- Mac **Connections** has independent Local network and Cloudflare checkboxes,
  plus Relay after a compatible HTTPS Relay server/key has been configured.
  Available channels start enabled by default; later checkbox choices persist.
  They can run together, and a failed channel does not stop the others.
- One QR carries the enabled connection addresses and pinned Mac identity.
  The phone automatically chooses an available verified route. Open its
  **Connection** sheet from global Settings or the session header icon to choose another channel or return to Automatic at any
  time; the same peer/session cache and original command IDs are retained.
- Use **Configure Relay** on Mac to validate and save a compatible server/key.
  The public Relay forwards opaque HTTP/WebSocket streams and holds no session
  or account store. Local networking keeps content and device authorization
  sealed; public channels retain HTTPS/WSS certificate validation.
- New question prompts remain accessible while you read earlier history.
  Select an option, then explicitly submit; the original question identity and
  native acceptance/unknown-receipt rules still apply.
- Device authorization, rename and individual revocation are managed by the Mac App.
- Phone background refresh requests a 60-minute minimum schedule from iOS; the operating system chooses actual runs. On both iPhone and Android, active foreground viewing maintains `<45s` `/codelync/notifications/presence` leases and realtime socket/HTTP synchronization while Mac keeps collecting the selected native sources.
- Where confirmed for the desktop app and mode, native model and reasoning controls update the existing session with conflict and unknown-receipt protection. Unverified settings controls stay unavailable.
- User-facing strings follow the phone's selected language with a documented fallback. Native UI and runtime support are verified separately from TypeScript or fixture results.

Local addresses/ports and Cloudflare Quick Tunnel addresses can change on Mac
restart. A configured Relay keeps its authenticated route across reconnections.
The phone can obtain updated addresses through a working authenticated channel;
scan the current QR if every stored route is unavailable. Allow local-network
access when iOS prompts if you want to use LAN; on Android, private LAN routes
(`http://<mac-lan-ip>:<port>` and `ws://<mac-lan-ip>:<port>`) permit local
cleartext HTTP transport while keeping every device proof and payload sealed
end-to-end. Push notifications are iPhone-only (APNs): Android omits
`POST_NOTIFICATIONS` and push token registration without errors or sync
blocking. Live APNs push needs publisher credentials and push-enabled phone
signing; the source-built iPhone client is not an App Store/TestFlight release.
See [iPhone notification setup and verification](docs/NOTIFICATIONS.md).

The normal user entry point is the Mac App. `scripts/codelync-daemon.mjs` remains
an advanced self-hosted/diagnostic entry point with an explicit server/profile;
it retains the same verified native source boundary. Legacy server-selection and
manual-account flows are not the current one-scan phone onboarding.

## Licensing

See `THIRD-PARTY-NOTICES.md` and `licenses/Happy-LICENSE` for the Happy-derived mobile, API and protocol sources. Bundled runtime licenses are retained separately.

See [contribution guidance](CONTRIBUTING.md) and the [public release workflow](docs/PUBLIC-RELEASE.md).

## Origin and attribution

Codelync was previously named CodeLight. Its early iPhone client and encrypted
sync server were derived from [Happy](https://github.com/slopus/happy), under the
MIT license. Those license and copyright notices are retained in
[third-party notices](THIRD-PARTY-NOTICES.md) and [Happy license](licenses/Happy-LICENSE).
The current native Desktop connector, paired route recovery, Mac app and
original-owner controls were added for this product. Desktop applications and
model runtimes remain with their original owners and are not redistributed.
