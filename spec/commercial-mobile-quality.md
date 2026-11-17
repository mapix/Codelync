# Commercial mobile quality

## Scope and ownership

The mobile surface presents verified original Codex, Antigravity and Claude
Desktop Gateway sources through Codelync's existing paired peer and gateways.
CLI/TUI sources and official Claude cloud/onboarding routes are deferred. A
Gateway variant label uses original-owner evidence rather than a guessed route.
A source is listed
only when its native catalog identity is available. An unimplemented, unreachable
or unverified source is not a fabricated connected source or an empty catalog.
Gateway routes describe transport; they are separate from native application,
project, conversation and subagent identities.

Claude Desktop native sources require exact native protocol, owner namespace host,
native conversation ID, mode and record collection. Code uses
`claude-code-sessions`; Chat and Cowork use `local-agent-mode-sessions`. The source
label names Claude Desktop and its reported mode. Mode does not replace a LAM
record's identity. Unsupported modes and failed collection inventories do not
invent a connected source or removal authority.

The mobile lane owns the session browser, subagent roster, local activity panel,
parent identity staging, handoff picker, source banner, Markdown reply controls,
localized surface labels and associated interaction helpers. The integration lane
owns sync, peer routing, wire schemas and SessionView wiring. Shared changes and
build/install operations are coordinated before mutation.

## Simulator artifact identity and updates

An unsigned validation build is not an install-ready replacement for the paired
simulator app. Before installation the artifact uses Xcode's simulated Mach-O
entitlements section for the existing Codelync application identifier and group:
`SIMULATOR.com.learnings.codelync`. Its signed identifier is
`com.learnings.codelync`; Info.plist binding and the `__TEXT,__entitlements`
section are verified against `native/codelync-simulator.entitlements`. The
SIMULATOR identity is not written as physical code-signing entitlements.

The reusable simulator signing step rejects physical-device and unrelated app
artifacts before signing. It preserves the compiled JavaScript bytes and checks
the resulting signature before `simctl install`. AppData and simulator Keychain
are backed up before a repair. A container path change alone is not a wipe;
retained data, original peer and draft restoration are checked separately.
Failure to read retained secure credentials is not treated as a new pairing.
Startup distinguishes absent stored credentials from unavailable secure storage.
The unavailable state hides the splash and offers a singleflight retry of the
existing saved connection. It does not clear keys/cache, enter login/onboarding,
rotate keys or initialize duplicate network owners. Legacy nullable credential
read callers continue to fail closed as read errors.

Build recipe: compile Release with `CODE_SIGN_ENTITLEMENTS` pointing to the
simulator file, `CODE_SIGN_STYLE=Automatic`, `CODE_SIGN_IDENTITY=-` and
`ONLY_ACTIVE_ARCH=YES`; this supplies the simulated linker section. Then run
`node scripts/sign-codelync-simulator.mjs /absolute/path/Codelync.app`, then
install only a verified result. This step never signs an original desktop app or
a physical iPhone artifact and never reads credential values.

## Authorized physical iPhone updates

An explicitly authorized physical update uses the device build and its actual
Apple Development or distribution signature. Simulator entitlements and the
simulator signing helper do not apply. The coordinating owner reviews the exact
artifact, bundle identifier, build, profile/device binding and source inputs
before one mobile owner installs it in place.

Back up existing AppData before installation. Verify the installed version and
first launch, then check logical profile, connection configuration and each
device-local draft against the backup. A data container UUID change alone does
not establish loss. Startup writes and refreshed cache are distinguished from
missing records. A simulator draft is never restored onto the physical phone.
Retaining a paired profile does not establish that its existing Mac peer runs
the new isolated producer. Source and command acceptance require that separate
peer/owner check; model probes retain their own authorization boundary.

## Objects and hierarchy

Claude SDK tasks are bounded parent activity in the compact `nativeTasks`
envelope, separate from native dispatch-child conversations. Its scope binds
application, collection, host, parent Desktop ID, current owner/runtime, query
token and CLI session ID. Task rows carry no conversation ID or source target.
The full task envelope is selected-parent data. Lightweight catalog descriptors
omit its lists and retain only aggregate attention. The mobile merge preserves
an omitted legacy envelope for the same source/owner/query, clears it on scope
changes, and does not restore an explicitly cleared or invalid envelope.
New task synchronization separates a lightweight current task signal from a
read snapshot. The selected signal contains scope, digest, counts and coverage
flags, never task or dispatch rows. An expanded panel reads a full baseline once
and requests only changes from its cached digest thereafter. Unchanged replies
carry no rows. Every delta is completely validated before atomically replacing
the in-memory full projection; removals and order are explicit original IDs.

The task cache holds at most eight selected peer/session/scope entries in memory
and at most 512 KiB of exact UTF-8 encoded context/snapshot data in total.
It never writes MMKV, Keychain, drafts, conversation state or live control fields.
The desired signal and accepted snapshot remain separate. Peer, scope, owner,
query or desired-digest changes fence late responses. A verified target that
arrives before its matching signal may be cached as a baseline; it is promoted
only after that signal matches. A late intermediate target must not block a
newer signal already requested by an active consumer. An old full snapshot is
only a delta baseline while its digest differs from the current signal; it is
not current execution or child-navigation proof.

Tasks and Claude subagents share one in-flight read per scope and have separate
read-intent leases. Signal changes fetch deltas only while a panel is expanded,
its navigation screen is active, and the app is in the foreground. Inactive
mounted screens are not read intents. Collapsed/background signals do not create
cache entries or promote them in LRU order. Collapsed or background panels start no read;
they do not poll. Eviction or a missing baseline causes the next authorized read
to request a full snapshot. A failed read needs an explicit Retry or a new
signal, and never replays a mutation.
Missing, stale or partial coverage stays unconfirmed; background completeness
does not establish a complete task roster. Agent, shell, workflow, remote-agent
and unknown task types have distinct labels. Task lifecycle metadata logs load
only after an explicit log action through read-only, current-scope RPC. Initial
pages contain at most 12 rows; the client rejects responses above the requested
limit and rejects late peer, source, owner or query changes. No output
body, stop, continuation, replay journal or model operation is exposed there.
Task-log events use localized Started, Progress, Status updated and Result
labels; future event types use Activity. Internal SDK subtype strings are not
shown in the user flow. A native truncated page displays one short earlier-log
truncation notice. The mobile panel retains at most 512 log rows and removes
older-page reads at that boundary; retained rows are not presented as a complete
history when native or local truncation occurred.

Claude dispatch rows retain the child's collection, host and owner. The parent
scope comes from the envelope and is never copied over the child identity. A
catalog match requires the same machine and exact original child tuple; no
catalog match leaves navigation unavailable. Cross-collection parent return
requires this explicit dispatch proof. Every native subagent composer remains
read-only, including Claude; task progress never makes it editable.

An original native source with an explicit owner capability
`capabilities.readOnly: true` also has a static composer, including an ordinary
Claude parent. This capability is accepted only with verified original native
source identity and the Codelync bridge client. The composer preserves any
existing local draft, disables editing and exposes no Send or Stop action.
An absent or false marker does not make a parent read-only. Temporary send/cancel
unavailability, a disconnected owner and readonly model observation do not
substitute for the explicit source policy. A refreshed explicit false marker
restores the ordinary parent composer subject to existing live control checks.
Saved-history and native-subagent restrictions continue to apply independently.

Message Copy exposes its actual native accessibility button at a minimum 44 by
44 points. Hit slop alone does not satisfy this target-size gate. The existing
copy action and accessible label remain; native verification reads its geometry
without copying private content into the clipboard.

Optional native task controls use a version-1 owner capability with bounded
`outputTaskTypes` and `stopTaskTypes` arrays of at most eight strings each. This
metadata alone does not expose task output or Stop; those actions require their
separate native acceptance and exact task/query operation boundary.

Task Output and Stop controls are scoped to one current native task type and
the current original source, owner and query. Version-1 owner capabilities
explicitly list each supported task type; an empty/missing capability,
unavailable snapshot or inactive screen disables the controls. Readonly policy
disables Stop; verified output is readonly data and remains readable. Logs
remain metadata-only. Output opens a separate readonly panel on an explicit
press and reads at most 65,536 UTF-8 bytes, with a visible truncation state. It
does not write an operation journal or poll output.

Stop confirms the specific task name and ID and uses the existing durable
operation journal for its task/query target. Duplicate pending presses are
blocked. Unknown outcomes retain the original command ID and are not replayed;
they do not fall back to parent cancellation or stopping all tasks. Terminal or
unknown task status does not expose Stop. All action icons expose 44-point
native targets. These controls remain disabled until original native acceptance
publishes the corresponding task types.

The visible hierarchy is application/source → project → ordinary conversation →
explicit native subagent. Stable scope includes machine, application and native
host namespace. Project keys and native conversation IDs are never replaced by
display names. A fork's parent ID alone does not classify it as a native agent.
Display grouping trusts existing canonical native project metadata under the
strict native source identity, independently of the current control owner. A
missing runtime or disconnected owner cannot split a proven linked Git worktree
into a separate project. Invalid app/kind/host/protocol/collection identity still
uses only the ordinary path fallback. This rule does not change source control
readiness, native query validation, Send, Stop or model permissions.
Collapsed source/project views retain their labels and catalog completeness.
Unknown totals remain unknown instead of becoming zero.
Project activity counters describe the same ordinary conversations as the
directory badge. Explicit children stay in their parent-bound aggregate and
roster scopes; they do not inflate the ordinary project session count.
An observed partial roster count is not rendered with a `+` that implies an
additional agent exists. Its completeness is labelled as partial independently.

Claude mode labels use native source evidence for Code, local Chat, local Cowork
or remote/cloud relationships. The UI does not infer those modes from a title.

## State and actions

- Cached content remains readable while transport or original-owner reads fail.
  Current status is shown separately from the retained catalog/history.
- A current terminal read error remains visible when the socket is offline.
  It offers an explicit read retry. A connection outage does not turn a finished
  failed attempt into an endless spinner.
- Connecting/loading is tied to a bounded active attempt. A completed read from
  an unavailable source shows unavailable; it does not imply empty history.
- A missing Codelync native catalog entry or retired namespace does not prove
  permanent deletion. The view says unavailable (or loading during discovery),
  retains known source context and local content, and offers read retry / return
  to the directory. No synthetic live session or control owner is created.
  Legacy harness deletion presentation keeps its existing semantics.
- Explicit native subagent composers and ordinary Markdown reply options are
  read-only. Existing drafts remain intact. Parent continuation stages only the
  validated identity; the user writes an instruction in the editable parent.
- Handoff targets are ordinary native conversations in another application on
  the same machine. Read-only native subagents are not draft handoff targets.
  The current source identity and target eligibility are rechecked at selection.
  Handoff availability follows current store source metadata, including owner
  and catalog changes, when an unchanged message row was rendered earlier.
- Native models, effort, slash commands, approvals and Stop retain independent
  current-owner capability checks. Unknown delivery is not a retry instruction.
  Opening, closing, filtering and reconnecting never replay native mutations.
- Local staging and copying never dispatch a model message. Saved input,
  operations and receipts remain bound to their original relay/native identities.

Claude Desktop query input and cancel do not use a fabricated native turn ID.
The typed `agentState.nativeQuery` binds application, native conversation, host
and owner generation to the current bridge source, whose `currentTurnId` is null.
Send requires explicit native `capabilities.send` and validated `canSend`.
Verified Code input during an active query queues through the original owner;
active Chat input remains disabled until its disposition is verified. Idle input
and query cancel are independent. Cancel requires the current nonempty query
token, explicit native cancel capability and an active query; a captured token
that changes before dispatch is rejected. Child and saved-history readonly
restrictions take priority, and local drafts remain intact. Source/history read
readiness does not depend on Send or explicit steering availability. Unverified
Claude model, effort and slash controls remain disabled. A source/owner-bound
readonly native model observation may display the original app's current model
and effort. Unknown values remain unknown, with no Codex/default model fallback,
model catalog or setting RPC invented for that display.

Verified Claude native model controls reuse the compatible controls RPC names
only when advertised by the current source. Their complete scope contains app,
mode, native collection/conversation, host, owner/runtime generation, query and
CLI session identities, plus a settings token from the bridge snapshot digest.
This token is not presented as a native sequence number. Catalog availability
and completeness are independent of setting-write availability. Readonly
sources may show a verified native catalog and current/effective settings;
native observed-model metadata remains a fallback display.

The verified scope currently admits only Code and Chat with nonempty query/CLI
identities and a 64-character hexadecimal settings digest. Cowork and absent
query contexts do not inherit setting writes. Native `currentConfirmed` is
required before settings are used as the write compare state.

Model and effort changes require the current verified scope, explicit writable
source policy, supported owner compatibility and an advertised update RPC. The
request includes the exact expected scope and settings the user saw. Each model
declares its native effort set and whether unset/default effort is permitted;
missing unset support defaults only for legacy Codex/Antigravity, never Claude.
A model switch clamps effort to that model's verified allowed/default values.
An unknown setting operation is not cleared by a fresh header or ordinary
controls read. Only receipt recovery of the same original operation and scope
can confirm it. Native slash execution remains gated by its separate verified
catalog contract.

The mobile native-settings journal validates the complete receipt's original
ten-field scope, both native acknowledgements and confirmed effective readback
before removing its durable command ID. Missing or invalid evidence remains
unknown, retains that ID and permits only original receipt queries, including
after remount/reconnect. Explicit failed receipts retain their existing terminal
rejection behavior; legacy Codex/Antigravity confirmation is unchanged.

Readonly native catalogs have an independent view callback. A verified current
scope, main runtime, query and nonempty available catalog may open a readonly
model list without providing a setting setter. Its rows are disabled and have
no selection-write callback. Scope, settings token or foreground/navigation
changes close the list. Missing query/catalog proof keeps the observed-model
fallback and disabled trigger; the app does not create a temporary query.
The operable catalog trigger has a 44-point native target.
Confirmed current effort remains visible when the native model catalog is
readonly or setting writes are unavailable. This display has no effort setter;
an unknown effort is not replaced by a default value.

Native model options may carry `nativeResolvedModel` aliases from the original
owner. They can associate an effective current model with an option label when
the option ID differs. The effective current model remains unchanged for CAS
and readback; aliases are not advertised as separate Gateway models.

Native admission may acknowledge a message with `runId:null`, an original native
message ID and `queued`/`admitted` disposition. That content-free receipt settles
the existing Sending state without creating a run or turn. Its native identity
and disposition survive normalization; later UUID-bound rows use the existing
explicit replacement path. Opening, reconnecting or repeating an admission
receipt never dispatches the message again.

## On-demand behavior

Verified native saved-history reads use a history-only hint, not a live/idle
owner or network failure. They retain original data/provenance and parent index
navigation, with no editable composer, Send, Stop, model changes or approvals.
Availability is checked through the bounded nativeSavedHistory schema and exact
source binding; no controller generation is invented for saved data.
Historical goals and question forms do not offer current-owner actions. Permission
selection, goal actions and question response controls are absent in this mode.

The browser loads directory/status projections without conversation bodies.
Only visible scopes participate in foreground status reads. Expanding a roster
subscribes to catalog identity for navigation; it does not open all child history.
Logs consume local scoped traces. Messages/tools use the existing selected lazy
viewport. Closing a surface releases its local subscription/read intent.
Log snapshots retain their source/owner key and cannot be rendered under another
scope during a session/owner transition. A local read failure offers an explicit
receipt-read retry and does not replay the operation whose receipt is displayed.
Errors and partial histories remain explicit, with no automatic replay of an
unknown command and no forced full-history read for a count or label.

## Presentation and accessibility

Use existing theme and typography tokens. Essential actions have at least a
44-point touch target, with readable selected, disabled and unavailable states.
Long project paths, session titles, agent names and translated statuses retain
their identity through wrapping/truncation and an exact scoped accessible label.
Controls remain reachable with a keyboard, short viewport, large text and light
or dark appearance. Secondary technical metadata does not compete with the
object name or current action.
Older-history Retry and Load more use a 44-point fixed slot and control. A locked
composer action is announced as read-only or unavailable, with its disabled
state, while actionable Send, Stop and Voice retain their actual action names.
The existing return-to-newest viewport control uses a 44-point target and exposes
its Latest button name to accessibility without adding a visible caption.

## Verification and iteration accounting

The existing native peer diagnostic may inspect the exact selected native ID
and optional host namespace without applying the received rows. Its resident
message report contains counts, loaded/pagination flags, kinds, bounded row-ID
hashes, text lengths, thinking flags and reducer snapshot/stream watermarks.
At most 64 resident row summaries are recorded. The corresponding one-row HTTP
recent report contains only row-ID hashes, roles, lengths, order and revision
metadata. Diagnostic reads do not change conversation state, control settings,
drafts, credentials or operation receipts, and contain no message bodies or
credential values. A simulator-only diagnostic JavaScript update is separate
from physical-device acceptance and cannot establish normal viewport hydration.

Each substantive UI round records: observed gap, owning source change, meaningful
state/interaction gate, native observation and remaining limitation. U01–U19 are
reserved for this lane. A planned change, screenshot count, cosmetic restatement
or repeated identical gate is not a completed quality iteration.

The coverage table distinguishes source review, rendered review and real native
interaction. Fixtures may stress long labels/layout only when identified as
synthetic. They cannot prove a live native source, owner, command or lifecycle.
The existing isolated simulator preserves its native modules, app data, peer,
drafts and receipts. Original desktop applications remain outside this lane's
mutation boundary. A physical iPhone update requires explicit user authorization
and the coordinating owner's artifact review. Source/model probes require the
integration owner's review. One owner builds and installs a known artifact at a
time.
