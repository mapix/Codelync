# Antigravity remote control integration

Status: implementation and isolated protocol investigation, 2026-11-13.

The user has authorized extending Codelync from Codex to Codex plus Antigravity
Desktop. Other historical harnesses and window/AX adapters remain deferred.

## Owners and isolation

- Codex continues using its existing desktop IPC owner. Never launch a substitute
  Codex runner or restart the original desktop.
- Antigravity controls address the existing language-server owner and its native
  conversation identity through its remote control service protocol.
- Initial probes use a copied Antigravity application, separate HOME, config,
  application data and workspace. Credentials are copied privately only as needed;
  conversation history and active original tasks are not copied into probes.
- Native Codelync QA can set `CODELYNC_STATE_DIR` to a separate private Mac
  application state directory and `CODELYNC_ANTIGRAVITY_RUNTIME` to the probe
  endpoint manifest. Normal launches retain their existing application state.
- With that explicit isolated state, `CODELYNC_PAIRING_EXPORT=1` writes the
  current v2 invitation to private `qa-pairing.json` for native simulator QA.
  This is opt-in, never a public API or an ordinary log, and is excluded from Git.
- Mac QA builds can set `CODELYNC_MAC_BUNDLE_ID` to a separate bundle identity,
  `CODELYNC_BACKEND_PORT` to a separate loopback port and `CODELYNC_LEASE_DIR`
  to private observer leases. Default distribution values remain unchanged.
- A configured endpoint must prove its owner identity before discovery advertises
  Antigravity. Missing, stale or unverified owners produce unavailable state.
- Original desktop `language_server` discovery ignores `language_server multicall ...`
  CLI helper subprocesses while preserving strict single-owner `--csrf_token`
  and parent-app verification.

## Transport and control

### Connector source contract

Antigravity descriptors use `app: antigravity`, `kind: session`, and
`protocol: antigravity-connect`, with a nonempty `runtimeGeneration` supplied by
the verified local owner. Registered `bridge.source` retains the protocol and
generation, and `bridge.controlMode` is explicitly `session`. Its `hostId` is
`local:antigravity:` plus a hash of the verified executable, HOME and app-data
namespace. This survives process restarts and isolates equal conversation IDs
in the original app and a probe copy. Antigravity has no
legacy fallback from missing mode or protocol. Historical window records remain
excluded. The source key includes application, host and native conversation ID.

The adapter shares the existing connector view contract (`rows`, `requests`,
`status`, `currentTurnId`, `ownerGeneration`, `historyComplete`). Native capabilities
are enabled only for actions the adapter explicitly supports. Project activity
uses a reduced status response from the Antigravity owner; full conversation rows
are never loaded to calculate foreground counts.

Antigravity session integration does not require model Gateway mode. Gateway
and non-Gateway model routing are independent of the native Language Server
connection; native owner/session/protocol verification remains required.
Antigravity model Gateway authentication is independent of remote control
authentication. The shipped `proxy_server_url` parameter and remote control gates
require runtime verification; a successful model request does not prove remote
control support. Protocol findings must distinguish the local native service from
the official WebChannel relay and document which path Codelync actually uses.

Phone traffic uses the existing sealed Codelync transport. Local Antigravity
credentials stay on the Mac. No unauthenticated native service is exposed publicly.
Registration, selected-conversation snapshots, tool/status streaming and commands
must retain the source application, host, owner generation and conversation ID.
Concurrent runtime discovery probes coalesce into one active check, and
disposing the RPC client fails closed and aborts/cancels all pending or active
summary streams.

Each mutation is journaled under its original command ID before native dispatch.
Unknown outcomes are queried, never automatically replayed. If the native service
does not provide durable command correlation, the adapter must report that limit
and retain Codelync's dispatch record across reconnects. Unsupported actions stay
unavailable; no guessed approval or model-setting payloads.

`SendUserCascadeMessage.clientMessageId` is carried into the original native
`userInput.clientMessageId`; this exact identity establishes input admission,
including an acknowledged native queue entry. A successful empty JSON response
alone does not establish admission.

`CancelCascadeInvocation` accepts a conversation ID but has no native
expected-turn or execution CAS field. Codelync checks the displayed invocation
immediately before dispatch and reads owner state afterwards. Its receipt says
`cancelRequested`, not that an empty response proved a turn stopped. The native
stop remains scoped to the current invocation of that exact conversation; a
concurrent desktop invocation transition cannot be atomically excluded by this
API. Live owner state establishes whether the conversation is still active.

## Shared experience and collaboration

### Default directory and archive boundary

The default phone directory excludes native archived conversations and their
descendants under an archived parent. Archive state comes from the original
owner's annotations/search result flags; `archivedOnly:false` is not treated as
an exclusion predicate. Archived IDs may be read as metadata-only exclusion
evidence, but their bodies are never loaded or registered merely for discovery.

Previously registered archived mirrors become `catalogueAvailable:false` and
retain keys, history and unknown operation receipts. Confirmed archive evidence
is applied even when another native index is incomplete. An unarchive restores
the existing binding only after current native metadata/index evidence verifies
it. Default catalog and restored observers share this visibility boundary.

Resident status and directory snapshots have separate freshness clocks. A fresh
resident snapshot invalidates an older directory snapshot when its native header
changes, even if message timestamps do not change. Directory stamps include
native subagent identity/spec fields, parent and fork IDs, archive annotations,
pin flags and workspace identity. A concurrent status read cannot renew an older
directory snapshot. Hidden mirrors receive the current scoped native header along
with the archive boundary; a previous archive acknowledgement cannot skip later
verification of an existing mirror. These updates preserve keys, messages and
unknown operation receipts and never load conversation steps.

Selected large trajectories start with a native suffix of at most 16 steps using
`GetCascadeTrajectorySteps.stepOffset` and the original index's absolute count.
The request never invents an end/count field. Earlier history extends that native
offset backwards in small batches; a partial suffix is never reported as complete
history. Resident summary merging preserves monotonic `max(base.stepCount, streamHeader.stepCount)`
within the same `trajectoryId` when the reactive summary stream lags behind
unary `GetAllCascadeTrajectories`, and `snapshot()` performs one post-flight
fresh resident read if its initial post-step `list({ history: false, fresh: true })`
coalesced onto an earlier in-flight resident read. Row IDs and orders retain absolute native step indexes. A prefix whose
user turn is outside the loaded suffix has an observation grouping ID but no
inferred current control turn or cancel permission. Native roster/run status remain
independent index observations. Oversized suffixes can reduce the requested suffix;
a single oversized step fails explicitly rather than becoming an empty history.
Existing native/peer byte bounds stay unchanged. History cursors retain the real
loaded offset even when a prefix contains no renderable rows.

Latest reads and earlier-history intent are separate. A plain snapshot, fresh
entry or live refresh reads the small latest suffix; an earlier-history gesture
uses its already observed cursor boundary. Releasing the last subscriber clears
the expanded native-read offset, so re-entry cannot inherit a whole-history read.
Already materialized, same-owner/trajectory snapshots remain available for bounded
cursor pages. A cached history page does not replace live control/request state.
Only reaching its actual loaded beginning requests another small native expansion;
fresh entry cannot reset or rebase an existing historical cursor. Owner changes
exclude old snapshots without deleting retained rows or command receipts.
A proven absolute start of zero ends earlier-history paging even when a newer
unloaded suffix keeps whole-view completeness false; it never implies the run
completed. Display grouping for a missing user-turn prefix stays stable and
does not supply a new current control/cancel identity.

Discovery reads native indexes and metadata only. A fresh resident status read
does not force the durable search index cache to refresh; current foreground
status stays separate from loading conversation histories. Codex source rows
project their verified workspace as a project descriptor so mobile grouping
does not depend on selected-message hydration.

Antigravity project grouping uses the original native runtime's home and only
its indexed workspace roots. Its managed worktrees use
`<native-home>/.gemini/antigravity/worktrees/<repository>/<worktree>`. A retained
Git pointer to a pruned administrative leaf can still identify the common
repository when its explicit target traces to a main repository with verified
`HEAD` and `config`. Without that pointer, a managed historical folder maps to
a main repository only when the native workspace set contains one unique,
Git-verified repository alias. Equal basenames from independent repositories
remain separate. This grouping does not add discovery of other CLI sessions or
search unrelated computer directories.

Codelync offers both proven session sources, identifies each application in the
conversation picker, and preserves drafts independently. Foreground status
synchronization stays separate from selected conversation history loading.
Live stream deletions confirmed by a matching owner proof remove cached base
headers so reconnects cannot resurrect deleted conversations or subagents, and
idle selected-session poll hints include own-trajectory status/waiting/termination
markers while still skipping history reloads when only child/aggregate status changes.
Tool activity, terminal errors and pending requests are projected from native state.

Each selected parent conversation provides a subagent list from the original
application's actual agent relationships and status signals. Display names,
source application, parent/child native identity and running/waiting/completed/
failed states remain source-bound. Unknown or disconnected state is explicit;
message recency, ordinary conversation forks and a shared workspace cannot prove
subagent execution. Subagent status synchronization stays separate from loading
their full conversation histories. A known native child can be selected using its
existing verified session binding.

### Source-specific versions, models and slash commands

The phone clearly distinguishes the source application and native session.
Compatibility records include the running application's version and the actual
native protocol/capability contract; an app version alone cannot enable controls.
Unknown contracts remain visible as unsupported without a fallback runner.

Each source owns its model catalogue and current conversation configuration.
Antigravity models come from its original desktop catalogue via
`GetCascadeModelConfigData` and retain their native model identities. This
catalogue read does not require Gateway model routing. Codex models/effort retain
the existing original-owner CAS controls. Selecting an Antigravity model must be confirmed by its original owner,
or be clearly staged for the next explicit message if its protocol only supports
per-message configuration. A local preference is never labelled as an applied
native model update. No test prompt is sent merely to change a setting.

Slash command menus are queried from the corresponding original app and bound to
the selected source/version. Custom skills, native commands and UI-only actions
retain their different execution contracts. A desktop UI-only command without a
verified remote action is shown unavailable or omitted; it is not sent as ordinary
model text and claimed to have executed. Choosing a textual native command stages
its source-specific draft and uses the original command parser/admission on submit.

Collaboration passes explicitly selected text/artifact references between exact
source identities, preserving provenance and stable operation IDs. It must not
silently route a user's input to the other application or create recursive forwarding.
Shared-workspace edits require clear ownership; concurrent writes to the same files
are not evidence of successful collaboration.

## Acceptance

The user additionally authorized installing the verified update on the iPhone
connected to this Mac. The device update keeps `com.learnings.codelync`, the
existing signing team, app data, secure-store credentials and paired Mac identity.
It must not uninstall the app or reset the user's phone. Native simulator
acceptance precedes the physical install; the installed build number, signed
artifact and post-install connected source/session checks are recorded separately.

1. Reproducible isolated app setup, recorded version/checksums and protocol evidence.
2. Real Antigravity conversation discover/read/send/stop and tool/state updates.
3. Existing Codex discovery, state, native controls and receipt regression gates.
4. Both source applications in the native Codelync UI with correct selection,
   input, stop, pending request, reconnection and unavailable behavior.
5. A bounded real cross-application task with observable artifact/result handoff.
6. Typecheck, lint, targeted protocol tests and native builds. Fixture verification
   and live acceptance are reported separately. No public release is implied.
