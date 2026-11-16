# Codex source command and version catalogue

Updated 2026-11-13 for the authorized Codex plus Antigravity scope.

## Original owner and compatibility

CodeLight reads the existing Codex follower IPC owner. The running local app's
bundle version is read from its actual process path and verified
`com.openai.codex` Info.plist, not a guessed application name or CLI version.
Version display and native protocol support remain independent. A missing or
ambiguous app version cannot manufacture a supported command catalogue.

The inspected app is `/Applications/ChatGPT.app`, version `26.1103.60933`.
Native state uses follower stream version 11; settings read uses version 1;
compact uses follower request version 1. Future app versions need a rechecked
command contract. Existing model/effort owner-confirmation rules stay intact.

## Command semantics

- `/compact` is a native action, not user/model text. It requires an idle current
  conversation and sends `thread-follower-compact-thread` to the verified owner
  with the stable operation ID. Its native `{ok:true}` response confirms a
  compaction request, not the end of asynchronous compaction work.
- `/model` opens the source's existing native model/effort selector and retains
  its original-owner read/update CAS contract. It does not submit model text.
- `/goal` opens a desktop frontend editor before native goal configuration. No
  follower goal-editor contract has been verified, so it remains unsupported in
  the phone command menu rather than being forwarded as ordinary text.
- The shipped main-process app-server connection implements `skills/list`, but
  the inspected follower IPC handler set does not expose that catalogue. This
  adapter does not read CLI skill directories and advertise them as desktop
  commands. Full desktop skill and plugin menus remain an explicit unknown.

The phone receives only source-owned, version-bound command definitions. Native
actions use the shared persistent receipt journal. Unknown results retain the
original command ID and are not automatically replayed. Unsupported commands are
not inserted as executable drafts. Antigravity commands never enter this list.

## Evidence and verification

Shipped ASAR analysis and a read-only original follower snapshot are documented
in `docs/research/codex-source-catalog.md`. Verification covers actual process
identity, version gates, native compact routing, stale/active owners, foreign
commands, and unchanged model CAS behavior. No live compaction or prompt is sent
to the user's original Codex session merely to test this catalogue.
