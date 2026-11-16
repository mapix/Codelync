# Mobile dual-desktop verification

Date: 2026-11-13. Source changes cover native Codex and Antigravity session
discovery display, source selection, observation activation and composer gates.

## Verified source behavior

- Antigravity requires native session mode, `antigravity-connect`, a nonempty
  owner generation and `local:antigravity:<64-hex>` instance namespace. Historical
  window/CLI records are excluded. Codex retains its legacy mode compatibility.
- Browser totals and rows share this boundary. Equal paths and native conversation
  IDs across apps or instances remain separate in both project rows and selectors.
- Native selection uses the existing sealed machine operation with the exact
  source key. Repeated selection does not navigate or discard the current draft.
- Antigravity submit/stop capability checks share the existing native composer
  and receipt seam. Unverified or disconnected owners cannot accept submissions.
- CodeLight hides the retained CLI-backed worktree `+`; no model runner is
  created by the native conversation selector.
- All ten supported languages identify both apps in current product copy.
  Source unavailable and unconfirmed-delivery copy refers to the selected original
  session without incorrectly naming Codex for an Antigravity conversation.

## Automated checks

Node 24.15.0 / pnpm 10.11.0; frozen workspace lockfile installation succeeded.

- Seven source/browser/selection/composer/translation test files: 58 tests passed.
- After instance-namespace hardening: five relevant test files, 45 tests passed.
- Selector/project-activity rendering regressions: three files, 40 tests passed.
- Native menu, activation and selection-journal regressions: three files,
  17 tests passed.
- `pnpm typecheck:mobile` passed. `git diff --check` passed.

These overlapping suites are reported separately; their counts are not added.

Additional native subagent and pairing-route verification:

- Subagent relationship/status/namespace/navigation and all ten language labels:
  two files, 18 tests passed.
- Pairing-route recognition plus existing v1/v2 pairing and subagent suites:
  five files, 27 tests passed.
- Latest mobile typecheck and the final incremental Release build passed.

The v2 pairing flow could leave a successfully connected device on its consumed
deep-link route after reload. The phone now returns to Sessions only for the
same stored trusted Mac key/origin and its currently connected sealed peer
authority; it does not change credentials or exchange an expired invitation.

## Observed native acceptance

- The updated Release simulator app returned to Sessions using its saved peer,
  without deleting Keychain or creating a replacement account.
- After the isolated Mac restarted with new LAN ports, the existing protected
  diagnostic bootstrap authenticated the same Mac, refreshed its channel list
  and established the sealed connection. Cached rows were not treated as live
  acceptance before that authentication.
- The current server and native viewer showed 177 supported sources: 176 Codex
  and one isolated Antigravity conversation. Application-name search found the
  Antigravity project and exact original conversation identity.
- The real selected Codex parent showed 11 native subagents with original child
  IDs and running/completed/unconfirmed states. A row navigated to its exact
  catalogued child. No child history was fetched merely to count statuses.
- The isolated Antigravity conversation loaded actual native tool cards and
  previous original assistant responses. The native model menu identified
  Antigravity 2.31.2 and its three Gateway models.
- Selecting Argon staged a next-message intent. One explicit phone submission
  received its exact bounded response. The original owner independently confirmed
  one client message ID, native model M418 and the assistant response under the
  same execution identity. No global model-setting change was claimed.
- A local draft was placed in the Codex composer without submitting it. Final
  handoff acceptance remains pending a newly found foreground-recovery issue:
  returning to an Antigravity source retained cached text while its observer was
  unavailable. The UI correctly withheld Send/handoff controls; that condition
  has not been reported as successful live control.

All native captures, complete test conversations, peer identities and device
credentials remain private outside this repository. This report records bounded
results, not those captures.

## Formal-device acceptance remains open

The user's installed physical build reported a flat Codex directory, archived
Antigravity conversations and severe interaction stalls. The QA simulator's
successful hierarchy checks do not establish that the physical installation
renders the same native viewer or has received current archive tombstones.

On the QA peer, a cold native launch with empty search showed 24 collapsed project
rows and no session rows. Expanding a project and its parent produced distinct
root/child indentation and preserved original IDs. Formal-peer metadata and the
updated physical build still require the same direct native checks after the
identity, archive and foreground fixes are packaged. No successful formal-device
acceptance is claimed here.

The latest incremental simulator bundle retained build 1302 and the saved peer.
With its gateway temporarily unreachable, the empty-search directory still
rendered collapsed projects and accepted expansion/navigation. The codelight
project displayed two roots and the selected root's 12-child branch. Its existing
local composer draft survived installation and cold launch; it was never sent.
Measured AXe action round trips were 667 ms for expansion and 548 ms for opening
the selected root. These include automation/settling overhead and are not isolated
React render measurements or connected-owner acceptance.

A metadata-only export of 1,680 stored formal bindings passed the current browser
boundary: 230 visible records, 66 collapsed project rows, zero collapsed session
rows and zero visible archived records. This is a historical metadata guard
check, not the live formal catalog or a native-device control test.

The current QA connection failure was localized to changed network interfaces:
the Mac's live Wi-Fi/VPN addresses differed from the published listeners. Native
channel diagnostics recorded one local timeout near 2.5 seconds and the other
local route returned HTTP 502. The embedded relay remained healthy. The same-peer
bootstrap did not succeed, and no replacement pairing was created. Live
foreground/handoff/slash acceptance waits for refreshed gateways and the separate
network-interface recovery fix.

Refreshing the existing QA gateways restored the same saved peer in approximately
305 ms. Native diagnostics then confirmed a catalog response in 176 ms and one
explicit repeat of the selected Codex root's recent page in 570 ms (HTTP 200,
50 rows, valid native projection). Its first read during recovery had taken
16,373 ms; that delay was not reproduced after connection recovery. The isolated
Antigravity recent page returned in 115 ms (HTTP 200, 17 rows, valid projection,
original status idle). No additional Codex history was read for these checks.

The Codex page restored its native controls, 13 evidenced subagents and local
draft. The Antigravity page still withheld control while the QA Mac package was
found to lack current foreground-presence sequencing. Its locked mobile state
and successful read-only recent page remain separate observations. The QA Mac
is being updated before another live command or handoff attempt; no automatic
message replay or temporary metadata-injection route was introduced.

Safe local-versus-network diagnosis on the updated simulator showed matching
metadata version 12, sequence 36, source namespace and owner generation. Both
mirrors reported disconnected, steering unavailable and no current RPC methods;
the recent row projection still validated. The higher-local-version rejection
branch was not observed. Backend inspection then identified that a fresh sealed
HTTP viewing heartbeat was incorrectly conditioned on a separate WebSocket.
That caused idle-source retirement despite the current approved phone view.
The targeted backend lease correction is being deployed before slash, handoff
and an idle hold longer than 30 seconds are accepted.

The existing private peer diagnostics now expose only bounded source/version,
capability and loading fields for this comparison. They also permit one full
version-2 catalog and one watermark-following read for native transport timing.
These read-only diagnostics neither hydrate the selected mirror nor change
owner controls, cache, pairing or unknown-operation receipts.

Native sealed catalog timing was measured once with the saved QA peer: a full
version-2 response contained 179 records, 261,281 logical UTF-8 bytes and took
179 ms; the immediate watermark read returned zero changed/removed records,
282 bytes and took 34 ms. Both were HTTP 200 with no further page. These are
QA-peer timings, not a physical-device performance claim.

## Subagent interaction and linked control logs

The current UI adds native lifecycle filters, exact-child navigation with an
evidenced parent return, a virtualized roster and explicit completeness from
`subagentsComplete` plus the matching aggregate scope. A changed-row regression
confirmed that one status update rerenders one row while retaining the filter.
Unknown data has no fabricated zero or completion state.

Each child Logs entry uses the same verified navigation path. The selected
session reads content-free local control traces with connection, native child,
host and dispatch-owner association. Confirmed success/failure, pre-dispatch
failure and unconfirmed delivery remain distinct. Later receipt stages retain
the dispatch owner; old-owner traces are marked historical. Prompt/answer/model
parameters are not logged, and reading the traces makes no source RPC or replay.
Messages and tools reuse the existing child message surface and its latest
viewport request; the roster does not fetch child history.

Five focused interaction/log suites passed 46 tests. Seven overlapping source,
roster, journal, placeholder and translation suites passed 99 tests. Mobile
typecheck and the Release simulator build passed. These counts are separate
overlapping gates. A broader session-presentation suite could not initialize
because its standalone Expo environment lacked `__DEV__`; its zero collected
tests were not counted as acceptance.

The updated simulator retained its saved peer and Root local draft. Live Stop,
Continue, slash and handoff checks remain pending a matching updated QA Mac
package. Only the task-owned Codex QA child is authorized for actual Stop/Continue;
no other child or Root operation has been sent by this mobile verifier.

## Draft ownership and cold parent lookup

Native simulator verification found a concrete local-draft race: an appended
cross-application quote appeared, then an obsolete composer value replaced it
after the debounce. The native draft hook now adopts external storage updates,
cancels stale pending saves, and guards old renders during adoption and route
reuse. Focused regressions cover a nonempty target at mount, a pending debounce,
unmount flushing, session switching and a subsequent deliberate user edit.
The adoption rule is limited to native sessions; a newly created non-native
session retains the pending chat input when its relay identity first arrives.

Current native catalog `isSubagent: true` plus the exact parent ID can now find
the unique same-machine/application/host parent before its history or roster has
been loaded. Archived or unavailable parent catalog entries remain excluded.
An ordinary fork without the native flag still requires original roster evidence.
Parent-owned continuation uses this same relation check without reading history.
The final 1309 rule, verified on 2026-11-14, disables input editing and Send for
every explicit native subagent. Continue stages only the exact native identity
in the parent and never reads, flushes or copies the child's retained draft.
The user writes a new instruction in the editable parent composer.

The exact integrated 1307 JS bundle was installed on the existing simulator,
retaining native modules, peer and AppData. A fresh process opened the exact QA
child directly from Home before visiting its parent. Parent return, managed-input
copy and Continue in parent were visible. A deliberate nonempty draft edit and
Continue completed within 1,874 ms, and the target initially retained its prefix
plus the new instruction. Once recent loading settled, its 827-character draft
reverted to the old 35-character prefix. Native draft retention therefore failed
on 1307; no Send or previous unknown child operation was replayed.

The reproduced cause was that the shared Rig v1 source predicate also recognizes
native CodeLight metadata. Draft synchronization followed that predicate and
accepted old remote composer metadata. The draft hook now excludes native
sources from synchronized saving, flushing and clearing. Its tests explicitly
model native metadata satisfying Rig v1 and assert that the Rig composer is not
called; non-native Rig composer behavior remains covered.

The earlier six focused draft, handoff, parent-control and roster suites passed
47 tests; the subsequent readonly/identity-only gate passed 48 tests. Typecheck
and diff validation passed. These counts overlap and are not cumulative.
The final 1309 JS ran in the existing native simulator on 2026-11-14: the child
draft remained readonly, identity staging retained prior parent text, and the
ordinary parent accepted a new local instruction. A cross-app handoff retained
the exact 2,645-character combined draft after native refresh, source navigation
and 52.6 seconds. The source draft stayed independently empty. No model message
was sent. Final physical interactions remain blocked by the iPhone lock as
recorded in [the current update](../2026-11-14/final-native-update.md). Native
Swarm body display acceptance belongs to that physical-device verifier; this
simulator's isolated source has no Swarm messages.

A later source audit on 2026-11-14 found that ordinary Markdown reply options
could bypass the child composer through a direct text send. Explicit native
child options now render as retained text, and their callback rechecks the latest
store restriction before sending. Ordinary parents and forks retain interactive
options. Structured native approval/communication controls were not changed.
Four targeted component and parent-control suites passed 30 tests, covering both
apps even when steering is available, captured older callbacks, parent behavior
and disabled option presentation. This is source verification after 1309; the
installed 1309 simulator evidence above does not validate this later option fix.

## Native build preparation

The current development toolchain has Xcode 27.2 / Swift 6.4.2. The checked-in
Podfile now handles three observed dependency compatibility failures without
changing native dependency versions:

1. Raise resource/dependency deployment targets below iOS 15.1 to 15.1.
2. Move RevenueCat's existing designated `PaywallColor` initializer into its
   struct, avoiding a synthesized memberwise initializer collision.
3. Guard Expo Router's `UIAction.subtitle` assignment with iOS 16 availability.

The CocoaPods native version list remained unchanged. Local source path metadata
was refreshed to match the fixed pnpm peer-dependency layout.

The installed Xcode bundle lacks the Simulator GUI. A checksum-verified AXe 2.0.4
helper runs privately against CoreSimulator for native accessibility and HID
interaction; it does not require window screenshots or a browser substitute.

The current Release simulator build succeeded with exit status 0 and was installed
on the existing CodeLight Native Worker QA simulator (iOS 26.5). Native
accessibility confirms the current CodeLight session browser and two-app copy;
the retained old generic/window screen is no longer displayed. The final bundle
includes source models/slash commands, provenance handoff and native subagent
status. Live pairing and dual-source native UI acceptance are in progress.
Private build logs, helper and captures stay outside the repository at
`~/.codelight-antigravity-probe/mobile-qa/`. No private conversations or pairing
credentials are included in this report.
