# Build and verify Codelync

The standalone source is at this repository root. The current distribution supports
Codex, Antigravity Desktop and Claude Desktop (Gateway), using their original
session owners and confirmed capabilities. Claude's complete formal controls
still require the source's acceptance gates. Standalone CLI/TUI families and
window sources remain deferred research. Use Node 24.15.0 and pnpm 10.11.0. Dependencies and generated
native caches stay outside Git. Current scope is defined in
[the product contract](../spec/codelync-product.md).

## Gates

- `pnpm typecheck:all`: bridge, phone and production relay TypeScript.
- `pnpm lint`: bridge, scripts and root tests.
- `pnpm security:release`: production dependency gate (`image-size` patch check), `website/testflight.json` schema check, and Mac EN/ZH/JA localization key parity.
- Root automated test suite: `pnpm test` (plus targeted native protocol/model/device tests: `node --test test/codex-ipc.test.mjs test/codex-backend.test.mjs test/codex-native-controls.test.mjs test/happy-native-connector.test.mjs test/discovery-daemon.test.mjs test/project-identity.test.mjs test/device-registry.test.mjs test/pairing-gateway.test.mjs`).
- Mobile Vitest unit suite (`apps/mobile`): `pnpm --filter @codelync/mobile test` (covering paging, progress, navigation, push-free registration, Android image picker normalization, IME/modal layout, and model controls under `apps/mobile/sources`).
- Project activity checks must cover original-owner status, waiting operations,
  stale/disconnected state, foreground/background transitions and bounded status
  payloads without fetching every conversation's history. The contract is in
  [codelync-project-activity.md](../spec/codelync-project-activity.md).
- Verify discovery and restored observers for Codex, Antigravity Desktop and
  Claude Desktop (Gateway), including unsupported versions and unavailable
  controls. Historical CLI and window tests do not establish enabled support.
- Run connection and recovery regressions for cached browsing, live-channel
  failure, original-app unavailability, paged history and original operation
  receipts. Native mutation controls must stay disabled while disconnected;
  reconnecting never resubmits unknown operations.
- UI checks cover the session select box, long titles, large projects and the
  supported language strings. Record fixture, iOS Simulator, Android Emulator
  and physical-phone observations separately.

Native UI acceptance uses the dedicated Codelync iOS Simulator, the installed iPhone, and the Android Emulator running the standalone Release APK (`app-release.apk`). Keep the original desktop apps (`Codex`, `Antigravity Desktop`, `Claude Desktop`) and any running user `Codelync.app` untouched as session/runtime owners; use isolated ports/state directories and controlled backends for automated E2E probes, and never capture private user conversations in saved screenshots or UI hierarchy dumps. Do not send additional model test prompts to validate transport or settings. Model updates can be verified without a new turn.

Measure request/byte budgets and bounded render work for performance changes.
Do not describe synthetic timings as measured phone frame rate, battery use or
temperature. Unsupported protocol versions and unavailable OS capabilities must
remain visible rather than silently enabling a fallback runner or window mode.

## Mac

Build helper binaries (`CodelyncDesktopHost`) with `pnpm build:native`, then `pnpm build:mac` (embeds `package.json` version `1.0.2` and `codelyncBuild` `2026112001`, overridable via `CODELYNC_MAC_BUILD`). The app contains the relay, bridge, Node and cloudflared. Developer ID signing is explicit through `scripts/sign-mac-app.mjs`. Apple notarization is a separate distribution gate.

Copy signed bundles with `ditto` or Node `cp(..., { recursive: true,
verbatimSymlinks: true })`. Changing relative symlink text breaks the resource
seal. Verify the installed destination before launching it and preserve the
previous bundle during replacement.

## iPhone

Run `pod install` from `apps/mobile/ios`, then use `pnpm build:mobile --device YOUR_DEVICE_ID --team YOUR_TEAM_ID` or `pnpm build:mobile --simulator YOUR_SIMULATOR_ID`. The build entry point resolves signed entitlement files from this repository and propagates the actual Xcode exit status. Use the Codelync bundle ID. `CODELYNC_NONINVASIVE_LOCAL=1 EXPO_NO_DOTENV=1` enables the Codelync distribution. Keep the system Keychain entitlement for simulator builds. Development profile installs are not App Store releases.

The Podfile raises dependency and resource-bundle deployment targets below iOS
15.1 to 15.1, matching the native dependency floor. Xcode 27.2 rejects the older
9–13.x targets inherited by several third-party resource bundles. Install the
frozen pnpm workspace before CocoaPods so its generated local source paths match
the current lockfile; a moved checkout or changed peer-dependency layout may need
ordinary `pod install` to refresh those paths without changing native versions.

The fixed RevenueCat dependency keeps its designated `PaywallColor` initializer
inside the struct when CocoaPods installs it. This avoids a synthesized memberwise
initializer collision in the current Swift compiler, while preserving the
published color parsing API and native dependency versions.
The installed Expo Router menu subtitle assignment has an iOS 16 availability
guard so its iOS 15.1 dependency target can compile with the current SDK.

Background processing uses `com.expo.modules.backgroundtask.processing`; the v2
refresh task requests a 60-minute minimum interval. iOS may delay or omit runs.
Real APNs requires a push-enabled profile and publisher configuration; the app
does not use the upstream Happy Expo publisher.

## Android

Android builds target application ID `com.learnings.codelync` (`versionName` `1.0.2`, `versionCode` `2026112001`, main activity `com.learnings.codelync/.MainActivity`, URI scheme `codelync://`, `CODELYNC_NONINVASIVE_LOCAL=1 EXPO_NO_DOTENV=1`).

### Toolchain and environment

Use `Node 24.15.0`, `pnpm 10.11.0`, `JDK 21` (for example Android Studio's bundled JBR), and Android SDK `36` (`compileSdk 36`, `targetSdk 36`, `minSdk 24`, `build-tools 36.0.0`, NDK `27.1.12297006`):

```sh
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="${NVM_DIR:-$HOME/.nvm}/versions/node/v24.15.0/bin:$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
```

Verify `node -v` (`v24.15.0`), `pnpm -v` (`10.11.0`), and `java -version` (`21.x`) before running Gradle or verification gates. (If `pnpm` is installed in another local NVM bin directory via `#!/usr/bin/env node`, keep `v24.15.0/bin` ahead of it in `PATH` so `node` resolves to `v24.15.0`.)

### Build Debug and standalone Release APKs

Both commands propagate Gradle's exit code and must exit `0`:

```sh
# Local Debug APK -> apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
node scripts/build-mobile.mjs --platform android --configuration Debug
pnpm --filter @codelync/mobile build:android:debug

# Standalone Release APK (APP_ENV=production ./gradlew assembleRelease)
# -> apps/mobile/android/app/build/outputs/apk/release/app-release.apk
node scripts/build-mobile.mjs --platform android --configuration Release
pnpm --filter @codelync/mobile build:android:release
```

`app-release.apk` embeds the production Hermes bytecode bundle, assets and native `.so` libraries (`libsodium`, `mmkv`, `expo-camera`, `expo-secure-store`, `@livekit/react-native`, `react-native-keyboard-controller`, `unistyles`, `reanimated`), and runs standalone on a device or Android Emulator with zero Metro bundler process.

### Manifest, network security and secret hygiene

- **LAN cleartext HTTP + E2EE**: `AndroidManifest.xml` enables cleartext local HTTP (`android:usesCleartextTraffic="true"` and/or `network_security_config.xml`) so private LAN endpoints (`http://<mac-lan-ip>:<port>` and `ws://<mac-lan-ip>:<port>`) work in Release APKs while every request and payload remains end-to-end authenticated and encrypted (`Authorization: Codelync <proof>`, X25519 box pairing, Peer Codec v3).
- **Least-privilege permissions & push-free contract**: Push notifications are excluded on Android. `AndroidManifest.xml` must not declare `android.permission.POST_NOTIFICATIONS`, `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`, `READ_MEDIA_IMAGES`, or `READ_MEDIA_VIDEO`. Media uploads use the permissionless Android System Photo Picker (`PickMultipleVisualMedia`).
- **Signing & secret hygiene**: Supply an explicit release keystore via `CODELYNC_UPLOAD_STORE_FILE` (and companion store/key credentials) when needed; otherwise local Release builds generate an untracked keystore under a gitignored path (`apps/mobile/android/.signing/`). Never commit `.keystore` / `.jks` files, credentials, device registries, pairing invitations, `.gradle` / `build` directories, APK binaries, or private QA evidence.

### Static and unit verification

Run all static and unit checks with exit code `0` before emulator acceptance:

```sh
pnpm typecheck:all
pnpm lint
pnpm test
pnpm --filter @codelync/mobile test
pnpm security:release
```

### Android Emulator end-to-end verification

Verify against an Android Emulator (for example `Pixel_7_API_34`) using an isolated test relay/daemon bound to ephemeral ports and temporary state directories — never stop, restart, or mutate running user desktop apps (`Codex`, `Antigravity Desktop`, `Claude Desktop`, or live `/Applications/Codelync.app`):

1. **Standalone Release APK install & Metro-free cold start**: Stop Metro, install `apps/mobile/android/app/build/outputs/apk/release/app-release.apk` (`adb install -r`), cold-start `com.learnings.codelync/.MainActivity`, verify the onboarding screen renders with Codelync branding, and check `adb logcat` for zero crashes (`FATAL EXCEPTION`) or unhandled JS/native exceptions.
2. **LAN pairing (`codelync://pair?...` & QR camera) and E2EE sync**: Verify direct LAN HTTP pairing (`http://<mac-lan-ip>:<port>`) via deep link (`adb shell am start -W -a android.intent.action.VIEW -d "codelync://pair?..."`), in-app `expo-camera` QR scanning (`CameraView` runtime `CAMERA` permission grant, denial -> system Settings redirect via `Linking.openSettings()`, and Paste pairing link fallback), and `codelync-mac-locator.json` bootstrap where configured.
3. **Push-free foreground mode**: Confirm Android never invokes `Notifications.requestPermissionsAsync()`, `getDevicePushTokenAsync()`, or `POST /codelync/notifications/device` with `enabled: true`, emits zero push errors or prompts, and keeps realtime `/v1/updates` Socket.IO sync plus `<45s` `POST /codelync/notifications/presence` viewer leases active.
4. **Core three-Desktop functional parity**: Verify project and native session sync across `Codex`, `Antigravity Desktop`, and `Claude Desktop (Gateway)` (never discovering or advertising deferred CLI/TUI/window harnesses), lightweight foreground project/session activity (`active`/`waiting`/`unknown`/`total` and subagents without inferring from message recency or coercing `unknown` to `0`), session history paging, encrypted message send/steer/abort, confirmed-owner model/effort `PickerSheet` controls and non-Compose usage row trigger, interactive approvals and `AgentQuestionModal`, subagent hierarchy and Claude native background tasks, Android System Photo Picker `<=3072px` JPEG normalization (`0.92`) and `MAX_FILE_SIZE - 40` byte validation before encrypted blob upload/preview, and optional Settings Remote Desktop toggle -> `/desktop` LiveKit WebRTC + E2EE video decode (`framesDecoded > 0`) + touch and keyboard bar input.
5. **Edge-to-edge safe areas, soft keyboard (IME) & system Back navigation**: Capture UI hierarchy dumps (`uiautomator dump`), window inset proofs (`dumpsys window`), and screenshots across all five surfaces — (a) Onboarding/Pairing, (b) Project & Session list, (c) Session detail & composer, (d) Remote Desktop, and (e) Settings:
   - Top headers and modal controls never overlap `ITYPE_STATUS_BAR`.
   - Bottom navigation bars, composers, and sheet actions never overlap `ITYPE_NAVIGATION_BAR` in both gesture and 3-button navigation modes.
   - Focused inputs and submit controls remain fully visible above `ITYPE_IME` across the session composer, `WebPromptModal`/`BaseModal`, `AgentQuestionModal`, search, and `RemoteDesktopKeyboard` (with `statusBarTranslucent` and `navigationBarTranslucent` enabled on modals).
   - System Back gesture and `KEYCODE_BACK` dismiss one layer at a time in priority order: open modals/sheets/scanner/image preview -> `SessionView` file/diff overlays -> `RemoteDesktopView` (`keyboardOpen` -> `panel` -> `immersive` -> clean `/leave`, LiveKit disconnect & portrait restore) -> child subagent to parent -> stack screens and root tabs (`/`, `/desktop`, `/settings`), with zero white screens or crashes.

## Source export

`pnpm package:source` produces a repository source ZIP using Git-known files and an additional private-state exclusion filter. Generated products and state are excluded.

Run `node scripts/verify-codelync-source.mjs --install` after export to extract the ZIP, check private-path exclusions, install the frozen workspace and typecheck it independently.

Add `--generic` to a device build when the phone is offline; Xcode builds the signed iOS artifact without waiting for hardware. Install verification still requires the paired device.
