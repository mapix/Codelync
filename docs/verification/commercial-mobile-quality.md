# Commercial mobile coverage and rounds

## Baseline U00 — recorded, not a completed iteration

The existing isolated simulator has native build `2026111303` and JavaScript
SHA256 `0fa1fb38b8a48a56c5e0e6172f8591e95d7235e23c8eac3a69a160df9ade8d16`
(the verified 1309 JS checkpoint). Native modules and app/peer/draft data remain
in place. The old QA relay was closed when this baseline was inspected.

The actual native screen showed an unavailable connection, cached source and
subagent content, and an in-progress session indicator. This proves the current
offline/cache presentation only. It is not a fresh live source or three-app
integration acceptance. Private accessibility captures and screenshots remain
outside Git.

| Surface/object | State | Size/language | Verification | Result / remaining issue |
| --- | --- | --- | --- | --- |
| Selected conversation | Offline with cached content | 402×874 points, English UI | Actual accessibility capture | Readable cached content; in-progress state still visible |
| Parent local draft | Retained after prior handoff | Long multi-line draft | Existing 1309 native interaction evidence | Prior 2,645-character draft retained; no model Send |
| Codex native child | Read-only, parent managed | Existing isolated QA child | Existing 1309 screenshot and action evidence | Static draft/locked Send and identity-only parent stage passed |
| Antigravity source | Ordinary session, handoff | Existing isolated native source | Existing 1309 interaction evidence | Cross-app local handoff passed after fresh source verification |
| Claude source/modes | Not in this simulator's verified catalog | None | Static scope review only | Fresh real integration evidence pending integration lane |
| Source read banner | Failed attempt with socket offline | Narrow phone | Source review | Current loading expression can mask a terminal read error |
| Handoff target picker | Native child included | Real 1309 picker | Prior actual native capture + current helper review | Read-only target can receive a stranded quote draft |
| Child roster actions | Dense rows / long labels | Narrow phone, translated strings | Source review | Parent/filter/log touch targets below 44 points |
| Models / slash / native approvals | Current-owner controls | Narrow phone | Existing bounded evidence only | Fresh commercial run pending coordinated artifact/service |
| Activity panel | Local traces / loading / failure | Long IDs, short viewport | Source review + prior targeted gates | Live failure/close/re-entry/light-dark coverage open |
| Large source/project list | Partial status and search | Real directory when service restored | Existing projection design reviewed | Fresh paging, accessibility and repeated navigation open |

## Round ledger

| ID | Observed gap / intended change | Source gate | Native gate | Status |
| --- | --- | --- | --- | --- |
| U01 | Terminal source-read failure survives an offline socket and offers explicit read retry | Focused banner regression passed | Pending matching JS/service | Implemented, native open |
| U02 | Restrict handoff targets to editable ordinary conversations; recheck at selection | Ordinary/fork/child target and captured-row regressions passed | Real original Antigravity reply picker offered ordinary Codex targets; Root retained exact staged quote after return | Verified on real cross-app path |
| U03 | 44-point roster/parent/log actions and resilient long-label/accessibility layout | Full translated identity/disabled-state regression; existing changed-row gate passed | Actual 44-point filter/log targets; dark accessibility-extra-large roster retained names/status and Finished selected real completed child | Native subset verified; full scroll/parent coverage open |
| U04 | Scope-stamp receipt snapshots and add explicit failed local-read retry | Owner-transition render history and local-read retry regressions passed | Actual scoped owner/read receipts; changing selected native child closed old logs | Native subset verified; read-error Retry open |
| U05 | Partial observed roster count does not imply an extra child exists | Partial count regression passed | Pending matching JS/service | Implemented, native open |
| U06 | Handoff follows current owner/header when an unchanged row has old metadata props | Current-owner ready transition regression passed; catalog subscription remains closed until picker | Handoff appeared after current original Antigravity source read, selected ordinary Root and retained draft after refocus | Verified on real owner-ready path |
| U07 | Preserve simulator identity and access to retained Keychain/data during an in-place update | Five CLI identity/platform/section gates passed; correct Xcode signing recipe documented | Original peer restored without pairing and prior 2,645-character draft matched exactly | Verified |
| U08 | Missing/retired native source is unavailable, with known local content and read-only recovery; legacy deletion remains separate | Availability/local-retention/singleflight Retry component gates passed | Real retired route showed unavailable, Retry checked catalog and retained unavailable state, Back returned directory | Verified for retired route; cached-content branch source covered |
| U09 | Secure read unavailable is distinct from no stored account; startup recovery leaves splash and retries retained connection | Typed storage result, missing/read-error distinction and singleflight startup gates passed | Real retained-profile startup passed; controlled storage-read failure not induced | Implemented; error native gate open |
| U10 | Native finished-child history readability | Bound saved-history schema/banner gate passed; readonly composer and permission/model/effort/goal/question/Stop/Send boundaries added | Fresh real Fermat recent/older reads 200, cursor advanced; native original history, older scrolling, Latest and parent return passed with exact 4,129-character draft retained | Verified on real saved-history path |
| U11 | Correct locked action accessibility name, explicit Latest action and 44-point older-history slot/control | 59 tests across primary-action and ChatList suites; typecheck/diff passed | Actual Latest labeled native button measured 44×44, newest/parent return, readonly no Send action and exact 4,129-character draft passed; Retry error state not induced | Native subset verified; Retry source/component gate only |
| U12 | Claude exact collection/native-source directory identity and mode labels | Source/collection/host/protocol/owner and directory-authority regressions passed | Actual isolated Code/Chat owner identities, headers and directory groups matched | Readonly native identity verified |
| U13 | Claude Send and history-read readiness independent of steering; verified Code queue versus active Chat refusal | Native query/bridge state and readonly-priority gates passed | Recent/older Code and Chat reads passed with unsupported steering; model Send not invoked | Readonly native subset verified; Send open |
| U14 | Cancel exact native query without a turn ID, preserving blocked-send drafts and rejecting token/owner races | Query helper, RPC payload and primary-action regressions passed | Unified JS/producer acceptance pending | Implemented; native open |
| U15 | Nullable-run native admission settles Sending with explicit Queued; original UUID replacement clears hint | Receipt-before/after echo, duplicate/late receipt, no-turn and explicit UUID replacement gates passed | Unified JS/producer acceptance pending | Implemented; native open |
| U16 | Original Claude model/effort displayed through readonly exact owner observation; no Codex default or model RPC | Observation provenance/unknown-value and hook no-RPC regressions passed | Owner-read full model/effort matched the readonly native footer; no picker or model RPC | Readonly native observation verified |
| U17 | Claude SDK task display and dispatch-child/aggregate support were omitted by mobile types | Compact schema, task kind/unknown coverage, own-child identity, readonly composer, lazy metadata log/12-row limits and peer/query/owner race gates passed | Current iPhone readonly baseline checked; changed JS not installed | Implemented; task UI native gate open |
| U18 | Lightweight directory descriptors could erase selected task rows | Same source/owner/query omission retains envelope; scope changes and explicit invalid/clear fields do not restore it | Current iPhone remains on reviewed 2026111401 without mutation | Source/state verified; updated native JS gate open |
| U19 | Ongoing full task lists and mounted hidden panels caused unnecessary task reads | Signal/full/delta/unchanged validation, native SHA256, eight-entry/512-KiB ephemeral cache, screen/foreground leases, LRU and late-demand gates passed | No native UI, install, keyboard or model operation in this round | Source/component/state verified; native gate open |
| U20 | A durable machine observation or desktop navigation failure blocks or mislabels a successful peer message read | Real Sync entry and banner regressions passed, including failed/pending navigation, unknown observation and websocket recovery; full typecheck/lint passed | Physical 1502 Claude recent/history HTTP reads passed; updated normal viewport acceptance pending | Implemented; updated native gate open |

The latest five focused UI/helper suites passed 52 tests. This overlaps the
first 48-test gate and does not establish visual/native interaction acceptance.

## Fresh communication baseline before the UI build

The existing 1309 native JS read the healthy isolated peer's real catalog once.
No native session state was applied and no conversation/model request was made.
The built-in diagnostic also repeated local decoding of the same response ten
times; those repeats were not additional catalog reads.

| Response | Directory rows | Response body bytes | Native decode | Repeated decode mean | Network/body read |
| --- | ---: | ---: | ---: | ---: | ---: |
| Full v3 | 280 | 71,533 | 180.5 ms | 181.6 ms | 36.7 ms |
| Unchanged v3 delta | 0 | 241 | 0.089 ms | 0.056 ms | 49.9 ms |
| Unchanged v2 compatibility delta | 0 | 587 | 0.177 ms | 0.135 ms | 32.1 ms |

The full authenticated frame was 53,603 bytes and decoded JSON was 458,723 bytes.
These numbers cover authenticated response content only, excluding HTTP/TLS/TCP
overhead. This is one real directory/unchanged-delta sample, not a percentile or
a proof of long-run stability. Phase profiling and comparison after a concrete
codec change belong to the integration lane.

## First commercial artifact and native observations

Release native build `2026111310`, JavaScript SHA256
`ccdd200e14a1b6b1b2bfdd943cc9ddcc0a4809ce6a39c26d87a1eb823f212401`,
ran on the existing isolated simulator. Mobile/wire/native input hashing found
no drift (1,735 inputs, including simulator entitlements).

The first unsigned validation artifact lacked Xcode's simulated entitlements
section. Retained AppData had migrated and the simulator Keychain items remained,
but the app presented pairing. Adding SIMULATOR entitlements as real code-signing
entitlements was rejected at native launch. The corrected Xcode/link recipe
restored `__TEXT,__entitlements` and used empty real signing entitlements, with
the expected signed identifier and bound Info.plist. The same peer and exact
prior draft then restored automatically. No pairing reset, uninstall, credential
read/output or user/default macOS Keychain change was used.

Native observations after that repair:

- U03: real roster filtering selected Finished and showed only an observed
  completed child. The filter measured 44×72.3 points and a row Logs action
  measured 44×44 points. Parent return/large-text/light-dark gates remain open.
- U04: actual local receipt logs showed the original scoped owner and confirmed
  read operations. Navigating to a different native child closed the old panel;
  no previous-scope log was shown there. Native read-error retry remains open.
- U01: the real dedicated Codex child encountered a fresh read failure while
  the peer was reachable. The native screen showed failure and Retry while
  retaining its readonly draft. A single diagnostic read returned HTTP 504 in
  9,764 ms, with no returned session/owner. This does not prove an owner mismatch.
  Successful read recovery remains open for the integration lane's fix.
- U02/U06: the old isolated Antigravity source was unavailable in the new original
  source catalog; its deep link displayed a permanent-deletion message. No source
  was deleted by this lane. Handoff acceptance must use a currently verified
  native source, and permanent-deletion wording requires an authority audit.
- U05: the observed current parent roster was complete. The partial count rule
  has source regression coverage; a real partial-state display remains open.

Fresh phase measurement on the repaired artifact read 296 real directory rows:
74,615 response bytes / 488,031 decoded JSON bytes, first decode 201.8 ms and
ten local-repeat mean 190.4 ms. UTF-8 took 135.8 ms, checksum 45.9 ms, inflate
17.3 ms, JSON 1.8 ms, authentication 0.13 ms and Base64 0.39 ms. Unchanged v3
delta was 243 bytes with zero changes/removals and 0.097 ms decode. No native
state was applied by that diagnostic. These are measured remaining costs, not
a performance pass or a percentile claim.

## U08/U09 and fast decoder artifact

The coordinated signed/link Release build completed in 61.7 seconds with zero
drift across 1,746 inputs. Native build remained `2026111310`; JavaScript SHA256
was `a349f4feddf99871d878aca86675031776bdf36213cefee5a001a3755ef1f5ea`.
The same simulator peer restored without pairing. The retired isolated source
route displayed unavailable rather than permanent deletion, performed one read
Retry, and returned to the real 119-conversation directory. The unavailable
storage pane has component/flow gates; no Keychain fault was deliberately induced
for native acceptance. This is separate from the earlier signing repair.

The real original Antigravity project expanded to its current ordinary
conversations. Opening Swarm Architecture Iteration Review loaded retained native
content and showed Handoff after the current source read. A current original
Antigravity Multi-Agent Architecture Guide reply was then staged through the
ordinary Codex picker into Root. The resulting 4,129-character draft matched the
private backup and preserved the exact 2,645-character prefix. Returning through
the actual directory and reopening Root retained all 4,129 characters after its
fresh selected-session read completed. No model Send occurred.

U10 source freeze passed three focused saved-history/banner suites (14 tests)
and diff checks. These cover bound provenance and hint behavior; the fresh real
Fermat history-only surface still requires the coordinated build and producer.

## Unified U10 and native codec artifact

The coordinated Release build completed in 108.7 seconds, with no drift across
1,760 mobile/wire/native inputs. The artifact included the React-exported
CodelyncCodec native symbols and system zlib. Its signed identifier, bound
Info.plist, Xcode simulated entitlements group and empty real signing entitlements
passed the existing simulator identity checks. Signing preserved the JavaScript
payload, SHA256 `55cd604552936652065912c93acf9817a6f41e08bca8ccaa307f6d49b2979a4f`.

The same simulator installed this artifact in place and restored its existing
118-conversation directory without pairing. AppData and the previous installed
artifact were backed up privately. After the coordinated producer refresh,
the original local channel and exact 4,129-character draft restored, including
the exact prior 2,645-character prefix. The actual Fermat parent link returned to
Root without staging or sending an instruction.

The installed React Native module executed on a real 311-row directory response:
83,967 response bytes / 535,833 JSON bytes. First decode was 9.96 ms, ten local
repeats averaged 8.60 ms. Native-body bridging took 4.98 ms; worker inflate was
0.30 ms, UTF-8 1.38 ms and total work 1.68 ms, with one admitted request and
0.007 ms queue time. The unchanged v3 delta was 241 bytes / zero rows / 0.114 ms
decode, and v2 fallback was 587 bytes / 0.098 ms. This diagnostic applied no
native session state and sent no model request. The changing directory data
prevents an identical-payload comparison with the earlier 69.9 ms result.
At that artifact, installed iOS queue/tamper/late-context stress had no diagnostic
entry point; the later explicitly synthetic stress entry is recorded below.

Fermat native displayed the verified saved-history hint, original parent link
and readonly draft, with no editable field or model/effort/Stop/goal/question
controls. A fresh data-only read returned HTTP 200 in 35.3 ms with one historical
row, no runtime generation or current turn, and more history available. Following
its returned cursor produced HTTP 400 in 33.6 ms. The older-history Retry remained
visible and only the cached Sleep tool was readable. The owning numeric query
limit and GET body boundary regressions were then fixed. A fresh read returned
recent HTTP 200 in 38.4 ms and older HTTP 200 in 35.65 ms with four rows, matching null
historical owner and an advanced cursor. Native swipes exposed original saved
assistant/tool text without Retry; Latest returned the newest viewport and the
actual parent link returned Root. Its 4,129-character draft and exact 2,645-character
prefix remained unchanged after the selected read settled. U10 passed this real
path; no current native owner/turn or model action was created.

## U11 final native-preserving refresh

The existing native codec app was copied and only its embedded JavaScript/assets
were refreshed. The final JS SHA256 is
`fba04558417c605e909a2ed99eef36aae3e5e29119d1d1ac49621a08ba4bf90d`.
All 59 native text/data section hashes remained unchanged; signing verified the
same simulated identity, and 1,761 source inputs had no drift. Native Latest was
an actual accessible button with 44×44-point bounds and returned the newest
viewport. Readonly saved history exposed no navigable Send action or editable
field; its readable readonly hint remained. AXe omits disabled controls, so the
new disabled primary label itself was not directly returned by that snapshot.
Parent navigation and the exact 4,129-character draft/2,645-character prefix
retained, with actual parent Send/model/effort labels. No model input was sent.
The healthy current source did not expose Retry; its 44-point source/component
gate is distinct from a native fault/retry pass. No fault was injected.

The final installed app still executed the native codec: 318 rows/547,659 JSON
bytes, first decode 9.35 ms, ten-repeat mean 12.83 ms and native worker 1.61 ms. V3 delta
was 243 bytes/zero rows/0.114 ms, v2 fallback 590 bytes/0.102 ms. Native state was not
applied. These are bounded samples, not an identical-payload percentile claim.

## Claude mobile source freeze

The Claude changes have source/helper/component gates, with the final
10 focused suites passing 110 tests and mobile typecheck/diff passing. This
overlaps earlier 187/91-test gates and must not be summed as distinct coverage.
The coordinated simulator/producer readonly acceptance is recorded below. Query
controls and queued receipt display still require an authorized native Send and
cancel observation. No native control pass is claimed from these fixtures.

## Actual Claude readonly native acceptance

On the coordinated producer, the retained simulator peer performed authenticated
Code and Chat reads without pairing. Actual UI headers and directory groups
distinguished Claude Desktop · Code and Claude Desktop · Chat from the reported
native record modes. The Chat UI's underlying `/cowork/` storage path did not
change its Chat classification. Native source/protocol/host identities matched
the explicit isolated owner scopes.

| Mode | Recent | Explicit older page | Boundary |
| --- | --- | --- | --- |
| Code | HTTP 200, 44.3 ms, 1 row | HTTP 200, 36.3 ms, 4 rows | Current owner matched; UUID cursor advanced |
| Chat | HTTP 200, 32.6 ms, 1 row | HTTP 200, 39.5 ms, 4 rows | Current owner matched; UUID cursor advanced |

These diagnostic reads applied no native session state and invoked no model
command. Actual UI loaded original reply markers and transcript text separately.
Both source snapshots had no current native turn and unsupported steering. The
original owner readonly observation reported
`dxeepseek-v4.1-flash-claude[1m]` / `max` for both modes; actual native footer
rendered its truncated model prefix and `max`, with no operable model/effort
picker and no Stop while idle. The full model value is owner-read evidence;
AXe omits disabled controls and the screenshot ellipsises the long label.

Actual directory counters showed Antigravity's ordinary project badge 4 beside
Unconfirmed 4, and each Claude mode badge 1 beside Unconfirmed 1 during retained
refreshing projection. Root's prior 3+99 observation is historical, not substituted
as this current UI count. Actual parent navigation again restored the exact
4,129-character Codex draft and original 2,645-character prefix after its selected
read settled.

The two exact, dedicated copy-source phone input probes were then authorized.
Neither Send was invoked. Code's field remained empty with a visible caret;
AXe refused typing before input because the software keyboard was hidden.
Trying native Simulator keyboard controls through CUA reported a locked Mac
and failed automatic unlock. Root asked the user for manual unlock. No lock was
bypassed, SDK/native data input substituted, unknown operation replayed, model
changed or original desktop application modified. Actual one-send/receipt/UI
Sending clearance gates remain open. Following the user's report of duplicated
typing in original Claude Desktop, every keyboard/HID/model Send operation was
paused. The Code field remained empty and both dedicated Send counts remain
zero. No further keyboard or model action follows from the manual unlock.

## Unified Claude source and installed codec stress artifact

The coordinated JS-only artifact installed with SHA256
`595b1af0d9e7c4e1c6d3d1456ae3552cdd7de849164d15dc90d4de7227832860`.
The native build stayed `2026111310`; all 59 native text/data sections remained
unchanged, the simulated signing identity passed, and 1,769 inputs had no source
drift. AppData was backed up privately before the in-place install.

The explicit `codec=stress-v1` route ran once on the installed simulator and
passed all 14 synthetic data cases in 2.856 seconds. The native module was
available. Queue stress admitted two of three concurrent requests and refused
one as busy, with a maximum of two pending; byte-budget stress admitted one of
three and refused two. Authentication/foreign-peer failures, UTF-8 compatibility,
BOM boundaries, gzip CRC/truncation/trailing/member errors and late-context/abort
result rejection passed. Published results were zero and payloads/keys were not
persisted. This is actual installed native execution of explicitly synthetic
data; it does not prove a live source or model action. The separate readonly
Claude UI observations above establish only their stated native scope; dedicated
Send/cancel gates remain open.

Fast decoder phase comparison (one live snapshot per artifact; datasets changed):

| Artifact | Rows | Body / JSON bytes | First decode | Repeat mean | UTF-8 | CRC |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| Earlier signed commercial | 296 | 74,615 / 488,031 | 201.8 ms | 190.4 ms | 135.8 ms | 45.9 ms |
| U08/U09 + fast decoder | 283 | 77,393 / 475,932 | 69.9 ms | 70.4 ms | 31.2 ms | 18.8 ms |

The later unchanged v3 delta remained 243 bytes with zero changes/removals and
0.083 ms decode; v2 fallback was 590 bytes / 0.105 ms. These are actual measured
improvements under slightly different data, not an identical-payload benchmark.

## Authorized physical iPhone installation — 2026-11-14

The user connected the iPhone and authorized installing the current Codelync
for real-device use. The coordinating owner reviewed build `2026111401`. A
generic iPhoneOS Release build completed in 239.8 seconds with 1,769 source input
hashes unchanged. The installed artifact is `com.learnings.codelync`, version
`1.8.0`, build `2026111401`, arm64, JavaScript SHA256
`5c8a08c498819f6140abdf7395d7900bf1f25f5c769448081f563de2f741ca57`.
Its actual Apple Development signature, device-bound provisioning profile and
strict signature verification passed. The React-exported `CodelyncCodec` and
system zlib linkage were present. No simulator entitlements were used.

The iPhone 14 / iOS 26.5 was updated in place from build `2026111309`, with
AppData backed up privately before installation and again after launch. Device
inventory confirmed `2026111401`; launch succeeded and the actual first screen
restored Sessions without pairing. The installed phone retains its existing
production Mac peer. Its first directory displayed 116 retained conversations;
this observation does not establish a fresh connection to the isolated QA
producer or formal Claude deployment.

| Preserved data | Before/after check | Result |
| --- | --- | --- |
| Connection configuration | `server-config` and its CRC | Exact bytes |
| AsyncStorage | 48 keys and every external value file | No missing/added keys; only presence sequence advanced; all external value files exact |
| MMKV logical records | Valid CRC/metadata, 10 live keys | No missing/added keys; only `profile.timestamp` changed |
| Profile | Same nonempty ID and other fields | Exact except refreshed timestamp |
| Phone session draft | One draft, 648 UTF-16 units | Same session identity and exact text/payload |
| Settings and new-session draft | Settings, pending/local settings, new-session draft | Exact stored bytes |

The data container UUID changed, while these logical records remained intact.
Old SplashBoard snapshots were replaced; logging, HTTP journals and ciphertext
cache changed on startup. Those mutable files are not treated as missing user
data. The simulator's 4,129-character draft was never written to this phone.
No pairing reset, uninstall, credential rotation, keyboard/HID input or model
Send was performed in this physical installation phase. Private AppData,
provisioning/signing evidence and device identifiers remain outside Git.

## Claude task mobile implementation — U17/U18

The mobile parser accepts the compact parent `nativeTasks` envelope. SDK task
rows carry only native task identity and bounded kind/lifecycle metadata. They
have a separate Tasks panel and cannot become conversation targets. The
Subagents panel expands proven dispatch rows using the child's own collection,
host and owner; the envelope supplies the exact parent scope. A cross-collection
parent return requires that dispatch proof, and a missing or ambiguous catalog
record leaves child navigation unavailable. Existing SessionView composer
guards keep every Claude native child read-only.

Claude aggregate attention is now accepted only under the original native
session/protocol/collection/current-owner proof. Optional task counts remain
distinct from dispatch-child counts. Missing or partial lifecycle coverage is
unconfirmed; a complete background level cannot establish an empty total.

The Tasks panel performs no read while collapsed. Selected foreground expansion
uses `native-task-read`; an explicit task-log action uses `native-task-log-read`, with
12 metadata rows initially and explicit older-page controls. The returned scope
must match every captured field, and current peer/query/owner are checked again
after the response. Oversized replies, wrong task IDs, foreign scope and invalid
pagination are refused. Reading and Retry use no command ID, journal recovery,
task output, stop, continuation, model send or polling timer. Logs are not
persisted into the catalog or global task state.

Directory merges preserve deliberately omitted selected legacy envelopes and signals only for
the same source/owner/query. Source, host, collection, machine, owner or query
changes clear inherited task rows. A full selected snapshot or an explicit
cleared/invalid field never revives a prior envelope.

An expanded task-read snapshot yields to newer metadata in the same query;
one explicit read cannot freeze later native lifecycle updates.

The preceding combined gate passed 80 tests in 11 suites, mobile typecheck and diff
checks. This includes earlier coverage and is not added to prior test totals.
Native readonly device inventory reconfirmed build `2026111401`. A passive
physical accessibility read showed Codelync in the foreground with Sessions
and its search field, and no pairing page. No phone navigation, input, Send,
reinstall, pairing change or draft mutation followed. The changed task UI has
not been installed on this phone; its actual native task/log interaction gate
remains open. Private captures remain outside Git.

### Task-log truncation and event labels

The task log now displays a short localized earlier-activity truncation notice
when the native page is truncated or the mobile retention cap omits earlier
rows. It preserves at most 512 rows and removes the older action at that cap.
A retained callback from an older button also refuses further older reads.
Known native truncation may still permit paging within the retained window;
complete finite pages do not fabricate truncation.

Started, Progress, Status updated and Result replace SDK subtype strings in all
10 supported languages; future event types use Activity. No internal event name
is rendered in the log flow. Two focused suites passed 25 tests, including native
truncation, a 43-page synthetic cap exercise, stale-button refusal and all event
labels. Mobile typecheck and diff checks passed. These are source/component
tests, with no native UI operation, installation, keyboard or model Send.

### Incremental selected-task synchronization — U19, 2026-11-15

Ongoing task state is a bounded `nativeTaskSignal` with current scope, digest,
counts and coverage flags. It contains no rows. `nativeTasks` v1 remains the
legacy/full read form. An expanded, active navigation screen in the foreground
requests a full baseline, then sends its accepted digest for delta or unchanged
reads. The shared wire materializer validates IDs, removals, complete optional
order, counts, coverage and scope before mobile SHA256 verifies the canonical
result. Only a completely verified v1 projection is committed to memory.

The cache contains at most eight peer/session/scope entries and 512 KiB of exact
UTF-8 context/snapshot bytes. It writes no MMKV, drafts, keys, conversation state,
nativeQuery, turn or model controls. Task and subagent panels have separate
consumer leases and coalesce a shared scope read. Collapsed/inactive/background
views start no reads; missing collapsed entries are not allocated and existing
disabled entries are not promoted in LRU order. Evicted or stale responses
cannot revive cache data.

A verified target ahead of its realtime signal is retained only as a baseline
until that signal matches. In the D0 request → D2 signal → late D1 reply race, D1
cannot appear as live data or block the next D2 read. Peer/scope checks run again
after asynchronous SHA verification. Cached child rows support only readonly
navigation to their exact original child identity; passive parent lookup never
starts a parent read and never confirms models or turn status.

The final combined mobile gate passed 110 tests in 14 suites, mobile typecheck
and diff checks. Joint component tests covered Tasks collapsed with Subagents
expanded, full→delta, readonly parent cache lookup, foreground resumption from
the last digest, and expanded hidden-screen suppression. Directory omission
preserves a same-scope signal; explicit null, a new main runtime or a new query
invalidates it. An inactive navigation screen also closes its task log panel.
This overlaps earlier gates and is not summed with them. No
native UI operation, install, keyboard input or model Send was performed during
that source round. The later physical installation is recorded below.

## Latest physical and simulator artifacts — 2026-11-15

The user authorized the connected phone's in-place update and readonly trial.
Release build `2026111501` completed in 234.567 seconds, with all 1,793 recorded
source inputs unchanged. The physical artifact is `com.learnings.codelync`,
version `1.8.0`, arm64/iPhoneOS, JavaScript SHA256
`4ef56d022df496f5c710c9c865fe7134b95e5da4bd6d0628e770613a4c404393`.
Its actual Apple Development app identity/team, registered-device provisioning,
strict signature, `CodelyncCodec` linked symbols and system zlib passed.
Simulator entitlements were absent. Device inventory confirmed the update from
`2026111401` to `2026111501`, and launch succeeded.

Private pre/post AppData comparison retained the phone's exact 648-character
draft and session identity, profile ID and connection configuration. Only the
profile timestamp and presence sequence changed logically. All 48 AsyncStorage
keys remained; all 30 operation-journal values were exact. No re-pair, uninstall,
key change or simulator-draft restoration occurred. Actual first launch showed
Codelync/Sessions without pairing, using the existing production peer.

The simulator used an in-place JS/assets update with SHA256
`372ec0a1cd5edfd737d8940bd5a1bd2b592d60701274ae2cc05eabf46e15654d`.
Native build stayed `2026111310`; all 62 Mach-O sections matched before/after.
The exact 4,129-character draft, its 2,645-character prefix, the other 139-character
local draft, profile and connection configuration were retained. AppData and
simulator Keychain were backed up privately. The earlier JS input subset of
1,649 files had zero drift; physical compilation used the expanded 1,793-file
source/native input manifest.

The corrective physical build `2026111502` was subsequently installed and
launched in place. Compilation completed in 273.973 seconds with the same 1,793
recorded inputs and zero drift. Its JavaScript SHA256 is
`42d28b863fc4fc7666fc2d863f1de341db031d0094846b215ab07069a3a17441`.
The Apple Development signature, registered-device profile, native codec and
absence of simulator entitlements passed. The phone retained the exact
648-character draft and session, profile ID, connection configuration, all live
MMKV keys and all 30 original operation-journal values. No AsyncStorage key was
removed; a diagnostic record was added. The phone kept its original production
peer.

### Reported activity and worktree display gaps

The phone displayed mo-agent-swarm as unconfirmed while the original
Antigravity had active conversations. Native/service review found the reduced
observer's 5-second freshness window and the phone's 10-second sampling cadence
could return a stale summary before scheduling its refresh. The integration
owner repaired proactive refresh, bounded concurrency and the separation between
foreground activity completeness and catalog removal authority. Two actual
phone project replies sampled 10 seconds apart parsed as total 7, active 1,
waiting 0, unknown 0 and ready. One bounded native element read showed
mo-agent-swarm, Active and a directory badge of 7, without Unconfirmed. A second
native element read failed through CoreDevice, so continuous UI stability is
still unverified.

Canonical project display previously required live source ownership. The mobile
selector now uses strict original-source identity for existing canonical project
metadata, preserving grouping when the owner is unavailable. Invalid native
identity still falls back to ordinary paths; control readiness remains unchanged.
Three targeted suites passed 39 tests and mobile typecheck. This corrective
selector change is included in installed build 1502.
The native directory helper already uses canonical metadata independent
of owner readiness; its actual descriptor/host/project scope still requires
comparison against the original source.

Physical full accessibility and screenshot requests intermittently failed with
CoreDevice service timeout/directory-port errors. Device/lock reads remained
available and bounded element reads observed the project and a real session row.
These captures and all device/private data remain outside Git. Actual Claude
task/control acceptance remains a separate open gate. No phone or simulator
model Send or keyboard input was performed.

The installed phone's exact production Antigravity source then completed an
authenticated diagnostic recent read (one row, HTTP 200) and explicit older
history read (four rows, HTTP 200). Owner identity matched across both reads and
the history cursor advanced. Recent request/body time was 5,035.8 ms, with 11,569
response-body UTF-8 bytes / 21,821 decoded JSON bytes and 10.81 ms native decode;
older request/body time was 46.48 ms, 7,289 / 14,808 bytes and 5.73 ms decode.
The current bridge snapshot was connected/ready and an ordinary idle source.
These timings measure the authenticated body path; they exclude HTTP/TLS/TCP
headers and do not equate decode time with total native-read latency. No measured
session state was applied. The two observed project-activity replies were
accepted by the mobile parser as total 5, unknown 5, unavailable; the status gap
therefore remained in the upstream projection rather than a rejected phone
schema. The later production refresh repair and bounded native phone observation
are recorded above.

The phone also read the exact saved Codex Root mapping through current native
IPC: recent/older HTTP 200, current owner matched, cursor advanced, and the
returned original snapshot was connected/ready with a current turn. This is
readback evidence, not an inference from a cached app label. Recent/older
request/body times were 530.3 / 43.6 ms; native decode was 4.84 / 6.31 ms.

The real finished Fermat child used its verified saved-history boundary:
recent/older HTTP 200, source ID matched, cursor advanced, history-only/ready,
no current turn and no runtime owner. Request/body times were 152.4 / 51.0 ms;
native decode was 6.56 / 3.28 ms. A null-owner comparison is not live ownership
proof. Actual phone UI displayed `Saved native history · Read only`, a real
parent return control and copyable content. Input was static placeholder text,
MODEL/read-only buttons were disabled, and no editable field, Send or Stop was
present. No measured source state was applied and the phone returned to its
normal entry. No original desktop navigation or model operation occurred.

### Claude recent-read failure and repair gate

The installed phone's full production catalog returned HTTP 200, version 2,
348 rows and no additional page, including the exact stock Claude Code source.
The subsequent recent read returned HTTP 400 in 182.5 ms with a 40-byte body and
no native projection. Exact source observation had already confirmed completion,
so this failure was in the recent-read path. Diagnostic native state was not
applied.

The native integration lane repaired rejection of a 512-row native tail and
installed the bounded complete-message serializer in its readonly bridge. Its
fresh exact-source recent and older native RPCs passed with stable source scope.
The first phone post-repair storage copy still contained the older diagnostic
timestamp and is excluded from post-repair acceptance. After normal entry and
diagnostic re-entry, the next narrow storage copy failed because the CoreDevice
remote connection was no longer valid. Device inventory retained pairing but
reported a disconnected tunnel; the native UI read also failed. Fresh production
phone recent/older readback and normal-entry readonly UI remain open until the
device connection is available. These failures do not establish a post-repair
HTTP result or a visible application alert.

### Stock Claude simulator readback and readonly composer correction

The existing Native Worker QA simulator retained its original QA peer. The
refreshed producer reused that QA state and paired devices. A fresh exact stock
Claude Code source and native-host read completed on this peer: full v2 catalog
HTTP 200 with 354 ordinary rows and no further page; recent HTTP 200 with one
row and older HTTP 200 with four rows. Both had additional history, owner
generations matched and the older cursor advanced. Recent/older authenticated
body times were 747.9 / 83.75 ms, native decode 4.14 / 1.57 ms, body bytes
4,111 / 3,389 and decoded JSON bytes 6,652 / 7,759. Diagnostic native state was
not applied. This simulator readback is separate from the disconnected phone's
post-repair gate and from normal UI hydration.

Normal entry confirmed observation of this exact original source, but the prior
simulator JS rendered an enabled AXTextArea for the readonly ordinary parent.
MODEL was disabled. This exposed a parent-composer gap: the existing static
input guard covered saved history and native children, while the publisher had
not carried the backend's explicit whole-source readonly policy.

The mobile correction accepts only an explicit boolean owner readonly capability
under verified native source identity. One shared predicate controls the static
input, composer modes, Send and Stop; click handlers recheck current state. An
absent/false marker, temporary unavailability and readonly model observation do
not lock a writable parent. Independent native-child and saved-history guards
remain. Five targeted suites passed 46 tests, mobile typecheck and diff checks.
The optional version-1 task-control capability parser is bounded; it introduces
no task output or Stop action.

The simulator JS-only update was signed and installed in place with SHA256
`c19e37ffa9b5b4b176db30f4703aa0b11db7437fe559cf385816f4f5c55fd554`.
All 1,795 source inputs had zero drift and all 62 native Mach-O sections matched.
Native build stayed `2026111310`. Private AppData and consistent Keychain backups
preceded installation. All six existing draft session/text/hash tuples were
exact afterward, including the 4,129- and 139-character drafts. Every live MMKV
key remained; only profile data changed. Connection configuration was exact.
With the QA publisher's explicit readonly marker, actual normal entry and
re-entry both rendered the placeholder as AXStaticText, with no AXTextArea or
AXTextField. MODEL and read-only controls were disabled; Send and Stop were
absent. Real copyable source content was visible on both normal entry and
re-entry. This is actual normal UI hydration, separate from the diagnostics'
unapplied state. All six draft tuples were still exact after these actions.

A stale scroll reference was rejected before input. One fresh unique scroll
target then accepted a native older-direction gesture. The two resulting
settled accessibility captures had no visible private content anchor, so an
empty anchor set is not treated as preserved scroll position. This stock-source
anchor gate remains open; the readonly-entry gate is complete. Stock simulator
probing stopped before a subsequent isolated-source QA configuration. No model
Send or keyboard input occurred.

### Task action source and isolated-source simulator gates

Output and Stop now use separate per-task controls. Output is an explicit
readonly read with an exact task/scope response and a 65,536 UTF-8 byte limit;
readonly source policy permits verified output. Stop alone requires an explicit
writable owner policy, supported task type, current scope and nonterminal state.
It confirms the task name/ID and uses the existing durable task/query operation
journal. Tests cover late peer/owner/foreground changes, unknown command receipt
recovery without replay, pending press coalescing, missing capabilities, readonly
output, readonly Stop refusal and output-panel dismissal. Six targeted suites
passed 75 tests; mobile typecheck and diff checks passed.

The source-frozen simulator update has JavaScript SHA256
`92a17456cf371cacb611182466aa094d55b1fb06c6923ab2762b2b571dbdd97c`.
All 1,800 inputs had zero drift and all 62 native sections remained unchanged;
signature and preserved simulator identity passed. Native build is still
`2026111310`. Private AppData and consistent Keychain backups preceded its
in-place installation. No phone artifact was built in this round.

The existing QA peer was then configured for the restored isolated Claude copy.
A fresh exact Code source/native-host diagnostic returned recent/older HTTP 200,
one/four rows, matching owner generations and an advancing cursor. Native state
was not applied by diagnostics. Actual normal entry exposed Message Copy as an
enabled 44-by-44-point AXButton, replacing its former 16-by-36-point bounds.
No clipboard action was performed to verify this geometry.

Actual Tasks and Subagents expanded with two native task status rows and no
dispatch-child rows. Both observed task statuses were Stopped. Their association
with the actual A/B probe was subsequently confirmed by exact native task-ID
hashes from the native integration lane; two tasks came from one prompt. Log controls were enabled
at 44-point native bounds; Output and Stop remained disabled under empty task
capability lists. Explicit activity-log open/close exposed the real native log
panel/list and human lifecycle labels Started, Status updated and Result, with
Shell/Stopped status. No older-log entry was present. This establishes nonempty
metadata-log rendering; enabled task output/Stop and preserved history scroll
anchor remain separate native gates.

### Nonempty native history anchor — isolated Code source

The remaining anchor check used the same paired simulator and `92a174…97c` JS.
Three private latest-message text segments were recorded with hashes and native
geometry. AXe selected-input swipes returned success without measurable movement
in this run; they were excluded as scroll evidence. A simulator swipe within the
observed chat area actually entered older history and exposed Latest. No product
change was made based on the unsuccessful input route.

Two settled native captures retained three nonempty older-message segments of
204, 65 and 65 characters at identical positions. Whole-row hashes initially
did not match because the UI renders Markdown segments. The owning native lane
then used the mobile Markdown parser on the exact source's normalized native
rows to provide segment hashes and native row IDs, without text bodies. All
three visible segment hashes matched that native evidence and were associated
with their real native row ID. Thus this check uses a nonempty native message
anchor, not an empty set or a Copy-button count.

An explicit native Latest press returned all three original recent-message
segments and hid Latest. The source returned to the normal parent surface and
was re-entered. This completes the isolated Code source's native older-history
anchor gate; the earlier stock-source failure is not retroactively relabelled.
No clipboard, typing or model operation occurred.

### Terminal task Output and uncompleted Stop window

With the copy owner's new verified local-bash capability, native Output A2 was
pressed and the output modal appeared. Its two AXStaticText nodes contained the
same 57-byte complete output as the independent native backend, with matching
full-body hash and no truncation. Initial inspection compared the marker's hash
to the whole multi-line output and incorrectly reported no match. Matching the
marker line and the complete native output corrected that evidence. This is a
real terminal-output native UI read; it is not active-output evidence.

A2 and B2 reached their 120-second natural completion while that output evidence
was inspected. The attempted A2 Stop-button touch did not progress to the
specific native confirmation, and local operation diagnostics contained no
native-task-stop dispatch. The native integration lane independently confirmed
natural completion with no UI/native Stop. No Stop success is claimed, and
completed controls were not used to substitute for an active Stop. The modal
was closed; a more usable active task window remains necessary for native Stop
and sibling-survival acceptance. No model request was issued by the mobile lane.

### Native task Stop confirmation and sibling survival

A later authorized A3/B3 window used two real background tasks under the held
copy source scope. The simulator pressed task A3's Stop control. Accessibility
confirmed the specific task ID in the native confirmation and exactly one
enabled Stop confirmation button; that button was pressed once. No direct RPC
was substituted for the UI action.

The durable operation journal recorded one command identity: dispatch at
`1794692501424`, confirmed/complete at `1794692501505`, with identical command-ID
hash in both records. Actual UI subsequently displayed A3 Stopped and B3 Running.
The native integration lane independently observed A3's real stopped event at
sequence 440 and B3 still in active membership, under the same complete source
scope and query. In that same native capture foreground/turn activity was false,
background activity true and the aggregate activity was known/active. This
establishes task-specific UI Stop and sibling survival, without parent Cancel or
a fabricated active foreground turn.

Stopped A3 Output was then opened through the native button and matched its
marker line in a 45-byte readonly output, with no truncation label. B3 Output
also opened through its native button and matched the marker, but its complete
57-byte output included terminal data. Current UI displayed B3 Completed with
Stop disabled, so no B3 UI Stop was attempted. B3 reached its natural deadline;
active-B3 Output and B3 UI cleanup are not claimed. No extra model prompt was
sent by the mobile lane, and unknown-operation replay was not used.

### Native model interface source preparation

The mobile model controls now distinguish native catalog reads from setting
writes. Claude controls require an exact Code/Chat scope, nonempty query and CLI
identities, independent published main-runtime generation and a settings digest.
Per-model native flags govern unset/default effort; native aliases can associate
the effective model with an option label without changing the raw CAS state.
Unconfirmed current settings and unavailable model-write capability do not
enable selection. Native observed-model data remains the bound display fallback.

Setting results require both native acknowledgements and effective-setting
readback under matching expected/confirmed scopes. Detailed receipt-only recovery
preserves unknown state when there is no original pending result or no valid
native evidence. Ordinary headers and catalog reads do not confirm a setting.

A separate readonly-catalog callback and modal were prepared. Verified current
catalogs can be viewed without a setter; all option rows are disabled, scope or
foreground/navigation changes close the modal, and the operable viewer trigger
has a 44-point source layout. This round changed source/schema/tests only. No
new simulator or phone artifact was built, and no native model/effort selection
or slash command was executed. Native catalog/write acceptance remains pending
the owning integration lane; generic write availability stays disabled until its
native proofs are complete.

## Claude session entry regression — 2026-11-15

The physical 2026111502 diagnostic read the current original Claude through its
retained authenticated peer: recent HTTP 200 returned one row in 232.9 ms;
history HTTP 200 returned four rows in 113.7 ms. Both owners matched and the
history cursor advanced. These diagnostic rows were not applied to the viewport.
This verifies the phone's native read path separately from ordinary page entry.

Ordinary peer entry still awaited a durable machine observation before that
combined HTTP read. It now delegates preparation directly to the combined read.
Desktop navigation proceeds independently, and its failed or pending receipt
cannot retain a synchronization error after fresh messages have loaded. Message
Retry does not repeat desktop navigation or an unknown observation command.
The current Sync entry and banner suites passed 48 tests; bridge, mobile and
production relay typechecks and bridge lint passed. The updated signed artifact
and its normal physical viewport remain separate acceptance gates.

## Acceptance boundary

Fresh live source/owner/protocol checks must use the real native integration.
Synthetic layout fixtures, if used later, are identified separately. No source is
invented for a screenshot and no old unknown command is replayed. The physical
installation above is the explicitly authorized exception to the prior
simulator-only boundary. Original desktop applications remain untouched by this
lane. The active keyboard/HID/model Send pause remains in force.
