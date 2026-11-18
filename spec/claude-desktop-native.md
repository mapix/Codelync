# Claude Desktop native owner adapter

Status: implementation and isolated-owner verification, 2026-11-14.

## Runtime and source boundary

The commercial scope is Desktop-only: original Codex, Claude Gateway Desktop
and Antigravity. Standalone Claude/Codex CLI, apy and the TUI family are deferred.
A desktop-owned internal SDK process is part of the original desktop runtime;
an independently started CLI/SDK is not an adapter substitute.

Claude Desktop owns its original sessions, native processes, permission brokers,
transcripts and Gateway settings. Codelync is an observer and command forwarder.
It never substitutes a newly launched CLI/SDK process for a desktop-owned session.
Probe changes run only in a copied app with isolated user data, HOME and workspace;
original Claude, Codex and Antigravity are not modified or restarted.

Only the dedicated probe workspace may receive native trust approval in the
isolated profile. The approval uses Desktop's `saveTrust` and `checkStoredTrust`
routes, and is recorded separately from session creation. It never grants trust
to the user's original projects or changes the original app's trust records.

The shipped 4.16336.0 main process exposes trusted-renderer LocalSessions APIs
and an existing-query Remote Control transition. These facts do not establish an
external follower endpoint. Native support requires a verified bridge into that
same desktop owner, with explicit session identity and process/storage namespace.
Window IDs, screenshots, file-only history or a successful model response cannot
establish native session support.

Sources use `app: claude-desktop`, `kind: session`,
`protocol: claude-desktop-native`, original native session ID and a host identity
derived from the owner's storage namespace and native record collection. Code
uses `claude-code-sessions`; Chat and Cowork share `local-agent-mode-sessions`.
Mode metadata never changes a LAM source's identity. Owner generation binds executable,
PID, parent, process start time, profile/account scope and original record lifetime.
The query execution token is separate: query startup/stop does not replace the
desktop owner. `runtimeGeneration`, `generation(id)` and view `ownerGeneration`
agree; `nativeCancel` carries `scope:session-query` and an explicit query token,
with no fabricated native Turn ID. Code, Cowork/local-agent and ordinary Chat
capabilities are reported independently. Unsupported or unverified modes remain
explicitly unavailable instead of falling back to window control or another runner. Task feed requests validate any supplied
`expectedOwnerGeneration` (nonempty bounded non-control string) and optional
nullable `expectedExecutionToken` before RPC dispatch, and verified ASAR digest
caches remain LRU-bounded. Event ring reads (`code.events`, `cowork.events`)
validate cursor bounds (`invalid-event-cursor` on negative/non-integer/future
cursors), report `resetRequired` when truncated below the oldest retained
sequence, enforce any supplied `expectedExecutionToken` fence and exact session
identity before pagination, and concurrent `sendMessage` / `interrupt` paths
preserve ref-counted manager wrappers and post-await owner/query fences across
completion and bridge deactivation.

## Bridge contract

A private runtime manifest identifies the verified desktop process, exact bridge
origin/socket, storage namespace and protocol version. It contains no conversation
body and stays outside Git. Any bridge credential stays on the Mac and behind
Codelync's existing paired/sealed transport. Discovery does not create a session,
enable a remote model execution, navigate the desktop or change account settings.

The adapter provides `status`, `list`, `snapshot`, `freshSnapshot`,
`completeSnapshot`, `subscribe` and `command`. Directory and roster reads use
native headers only. Message pages retain original IDs/order and an honest
coverage boundary; streams and fresh pages converge on one source row. Native
owner/process changes fence stale results and in-flight operations.

Code snapshots request 32 messages from the original native transcript tail.
The shipped reader clamps the requested count to 500, but its reconstructed
cache/window result may contain more messages than requested (512 were observed
in a stock native read). The bridge validates this materialized window against
its own 2048-message/8 MiB envelope, then returns the latest 32 complete messages.
It preserves original UUIDs, order and whole bodies, and sets `hasMore:true` when
messages were omitted. The first retained UUID remains a real older-page boundary;
no cursor is fabricated. The public transcript projection retains its 500-row
bound. Native header, query and request metadata are read independently of this
message window. Projection failures retain a fixed public error code, with no
raw native error text and no implied mutation for a readonly operation. Newest-page
requests try the native window read and refuse unavailable windows without a
full-read fallback. Explicit older-page navigation uses Desktop's native UUID
cursor API; replies retain `source` and `windowFallback` because the owner can
load its own transcript/cache internally. No page is loaded for catalogs or
status counts. The native `h1:` audit-history window omits ordinary conversation
text and must not be used as message history.

`historyPage` returns rows, coverage and UUID cursor data only; no live status,
input, model, permission or cancel controls are copied from an old page.
Verified Code idle input is accepted directly; input during a running native
query is queued by the original manager. `nativeInput` reports send support and
queue behavior independently of unsupported explicit steering. Chat idle input
is verified; active Chat delivery disposition remains unavailable until probed.

Supported commands retain their original operation IDs. The native owner's
admission or exact response confirms success. Missing or uncertain responses stay
unknown and cannot be replayed automatically. Input, interrupt, approval, model
and effort actions are enabled separately only after the native route is verified.
An inactive query or a policy denial is unavailable capability, not permission to
silently create a replacement process. Remote Control folder serving, which can
start new sessions, is distinct from observing an existing desktop session.

The probe reply projector is loaded freshly for each invocation. Projection
failure after native admission does not imply that a command had no effect.
Only a rejection proven before invocation may carry `effectMayHaveOccurred:false`;
timeouts, crashes and post-invocation failures keep the original command ID and
remain unknown. Duplicate IDs return their existing admission/receipt rather than
starting a second operation.

The isolated Code lane has verified native `Write` permission requests and
single-use approval through `respondToToolPermission`. Requests bind the exact
native request ID, session and query generation. Codelync offers `accept`/`decline`
for verified, in-turn requests that the native owner allows on that surface.
Other tools, out-of-turn requests and card-only policies remain explicit
unavailable controls until separately verified. Old history never carries
operable requests.

## Gateway and mode capability

The current adapter accepts only verified Gateway mode. Ordinary official-login
and other non-Gateway Claude Desktop modes are not supported. The owner bridge
checks the effective native provider and applied Gateway profile before publishing
its runtime manifest; an absent, unverified or changed Gateway route makes this
source unavailable. Gateway verification is separate from the production
installation and per-mode native-control acceptance gates, which remain required.
Codex and Antigravity do not share this Gateway prerequisite; see the
[current product scope](codelync-product.md#模型-gateway-与原生会话接入).

Isolated probes must never reset or change the user's login/default keychain.
The copied app uses a separate private-file encryption backend, with a 0600 key
under its 0700 probe directory, and has no fallback to OS keychain writes. Its
temporary browser profile contains no official OAuth/cookie credentials. Native
Gateway settings remain copied privately from the applied config-library profile;
production owner security is not weakened by these probe-only storage changes.

The user confirmed that both Claude Desktop and Claude CLI use Gateway. This
adapter is Gateway-local-only: it must not depend on `claude.ai/code` Remote
Control, official OAuth/account/token state or vendor cloud APIs. Historical
official Remote Control findings are reference only. The copied owner fails
closed before model execution when the effective local Gateway route cannot be
proved; it never silently substitutes plain cloud Chat or SDK resume mode.

Use the existing owner's authorized native Gateway configuration. The isolated
profile sets the native `CLAUDE_USER_DATA_DIR` contract explicitly;
without it the shipped loader appends `-3p` to its config-library directory.
Raw config presence alone cannot prove the resolved native provider/credential.
Copies needed for isolation are private; tokens, secure-storage material, provisioning data and
personal conversations are never printed or committed. No new authentication
project is created. A staged model selection is not an applied owner setting.
Account/provider/process changes invalidate previous capability and model proof.

Code and Cowork/local-agent routes must prove native IDs, current owner,
transcript/stream, input, stop and permission semantics independently. Ordinary
Chat is not inferred from the presence of Code APIs. Third-party/Gateway policy
denials remain visible and are not bypassed by starting another harness.

## Required evidence

### Shared bridge integration

Claude discovery requires an explicitly supplied owner runtime manifest or an
explicit native backend. It never searches windows, enables vendor Remote
Control or starts a renderer/runner. Code and Chat adapters remain separate and
bind `appMode` and `nativeCollection` in durable source metadata. Both collection
inventories must succeed before their application has removal authority; a
partial mode failure retains its previous directory rather than claiming an
empty application. An unconfigured Claude source has no removal authority.
Cold saved-binding reconciliation records authority per application, so a later
first successful Claude inventory can reconcile only its own stale mirrors.
A failed persistence attempt keeps that application eligible for retry.

The bound adapter forwards the expected collection host on every read, stream
and command, then checks that host before publishing. Selected-session `subscribe`
pollers are keyed by `(expectedHostId, sessionId)` so differing host scopes never
collide, and every subscriber receives the current cached view (or unavailable state)
even when joining while a poll is in flight or when no new content stamp changed.
Older native UUID pages
are data only: they cannot replace the current status, owner, model, requests or
input controls. The shared connector requires the returned page owner to match
the current owner before and after the read. Cursor scope carries that owner,
preserves the oldest selected row even when a recent viewport trims a native
tail, and rejects a foreign or changed owner before reading another page.
An explicit page cursor may refer to the prior boundary that is absent from
the returned older page; it must not be mistaken for a missing live row.

`agentState.nativeQuery` is independent of parent-owned child input. It has
version1, application, native conversation, collection host, owner generation,
nullable original query token, observed status, canSend, activeSendMode and
canCancel. Controls require all identities to match the current connected source.
Send availability is separate from steering; active Code sends enter the
original queue, while unverified active Chat input stays unavailable. The
captured query token is rechecked before dispatch, including null idle tokens.
Cancel carries the exact original query token and no fabricated turn ID.
Permission forwarding preserves the original request and once/deny semantics.

An exact native input admission can exist before a native execution/turn ID.
The correlated accepted receipt may carry `runId:null`, the original native
message ID and `disposition:queued|admitted`; it clears Sending without assigning
a fabricated execution. A queued admission stays queued until original message
observation confirms execution. Display grouping from a user UUID is never
reported as a native Claude turn. Stable receipt IDs prevent duplicate admissions,
and later observation must not rewrite their previously published payload.
Restart validation retains an admitted Claude receipt by its exact native
message identity even with `turnId:null`; it must not apply a Codex placeholder
repair that requires a native turn. Unknown commands are never redispatched.

Claude project activity reads native session headers independently of selected
messages. Foreground observers share one bounded, expiring header read per
collection and never create Codex IPC clients for Claude IDs. Native header
status is authoritative only under the same host and owner generation; missing,
expired, unreadable or changed-owner state remains unknown. No transcript is
opened to calculate counts. Code/Chat inventory failures retain partial coverage.
Header observation age starts when the bounded native read begins. Late arrivals
and cache reuse preserve that capture time; they cannot renew old running state.
Code directory headers retain native `turnRunning`, `hasBackgroundActivity` and
`hasBackgroundWork` booleans. A verified positive own/background flag establishes
activity even when the own turn is idle. Missing flags, pending collection data
or changed record/query/CLI references cannot establish idle. This projection
describes the session's own/background work; it does not claim a complete dispatch
tree or infer activity from an unfiltered LAM resident map. Selected Code
conversation status/input/cancel derives from the verified native `turnRunning`
field; missing turn evidence stays unknown. Native `isRunning` can include
workflow activity, so it must not promote a background workflow into an own turn.
Header capture records start time and native record/query/CLI/owner references
before awaited reads and verifies them afterward. Header caches bind desktop
runtime generation together with collection host, and refresh the native runtime
before using cached rows. A cache reuse never renews the capture age.

The current original header model/effort can be shown through
`metadata.nativeObservedModel`: version1, app, nativeConversationId, hostId,
ownerGeneration, readOnly:true, nullable model (max512 characters) and effort
(max128). This observation must match the connected source and current owner.
Null remains unknown; it never falls back to a Codex/default model, proves a
Gateway execution or enables a model catalog/mutation. Native model controls
require their separate verified contract. App-version metadata is informational
and does not change the durable session identity.

### Native model, effort and slash catalogue

The backend advertises model catalogue reads only after the current owner's
`owner.status` explicitly declares `code.controls` or `cowork.controls` in
`nativeSettingsReadMethods`, bound to that owner runtime generation and host.
An older owner without this declaration retains native tail/history support
and never receives optional controls reads from ordinary session loading.
Owner epoch/host changes or a failed handshake withdraw the read capability;
application version and method presence do not substitute for the handshake.

The isolated 4.16336.0 copied owner passed the native read handshake with the
reviewed catalogue bridge: the status declares both read namespaces, the Code
catalogue retains three native choices and their resolved aliases, and the
existing Query confirms its actual `[1m]` route and `max` effort. Same-process
installation retained the native record/Query/CLI/model references, copied
Gateway, window callbacks, ten keyboard handlers and DOM/editor/view draft
references. Code/typed Chat tails and a real-UUID older Code page were read;
the owned inspector was closed. Generic settings and private effort-probe
gates remain disabled. This is native read acceptance, not model/effort setter,
slash execution, file/video access or original stock input-repair acceptance.

Every later owner replacement must repeat a synchronous admission check in the
original main process immediately before deactivation: exact captured bridge
SLOT reference, PID/executable, runtime epoch and private manifest identity,
profile namespace/canonical user-data path, actual ASAR fingerprint, native
record/Query/CLI references, callbacks, keyboard handlers and Gateway. A debugger
attestation completed before awaited renderer reads cannot substitute for this
last check. Changed identity rejects without deactivating any bridge. Draft
checks compare composition state as well as DOM/editor/view references,
document/text hashes and plugin keys. Failed pre-admission never starts rollback.

`read-controls` reads only the selected Desktop-owned record and its existing
Query. Model/command initialization and current Query reads are fenced against
the native record, owner, runtime, Query and CLI identities before and after the
await. Code's broad `getSupportedCommands` facade is excluded because a failed
live read can start `withTemporaryQuery`. Missing or failed native catalogue reads
stay unavailable. No catalogue Query, replacement runner, discovery retry,
per-message model override or session restart is created.

Catalogue availability/completeness is separate from write availability. The
original readonly owner can report bounded native catalogues and actual Query
settings, but `model.available` is false. Header/record model and effort alone
are observations; an initial `current` requires the existing Query's actual model
and applied effort readback. Unknown or partial current readback never supplies a
default choice or a write capability. Native Gateway IDs, aliases, labels and
context suffixes retain their native relationship. Effort choices and defaults
come from that owner's current native model policy, including its actual clamp.

`nativeControls.scope` has exactly `app`, `appMode`, `nativeCollection`,
`nativeConversationId`, `hostId`, `ownerGeneration`, `runtimeGeneration`,
`queryToken`, `cliSessionId` and `settingsToken`. `settingsToken` is a bridge
snapshot digest over the bounded native catalogues, allowed effort limits,
actual current confirmation and native model record/change sequences; it is not
a native sequence. Query, policy, catalogue or record changes invalidate it.

Settings writes are gated separately and default off. The initial copied gate
is an idle held Code Query with no background/workflow/handoff/start activity.
The update carries the exact displayed scope and actual current model/effort.
It uses the already initialized native manager delegates behind the verified
`LocalSessions.setModel` and `setEffort` facades. These facades only log and await
those delegates in this shipped version. Direct owner entry avoids a renderer
IPC request arriving after guard expiry. The current scope and admitted native
record snapshot are checked synchronously before the delegate's side effects.
The existing Query control calls are fenced separately. Model and effort setters have separate ACKs; model policy
can clamp effort. A successful void facade response or optimistic native header
is not an ACK, and an unchanged field inherits confirmation only from explicit
same-Query native readback. Native related side Query updates remain the owner's
policy and are never described as an atomic settings bundle.

Only complete, unsuperseded ACKs and actual effective readback produce
`nativeSettingsEvidence`: version1, `expectedScope`, `confirmedScope`,
`modelAckConfirmed:true`, `effortAckConfirmed:true`, `effectiveModel`, and nullable
`effectiveReasoningEffort`. The expected scope equals the submitted payload;
the confirmed scope retains every identity and has the new snapshot digest.
Result controls use that confirmed scope and actual effective values. Partial,
missing or superseded ACKs after possible dispatch remain unknown and cannot
automatically replay the command. The stable Codelync command ID is admitted
before invoking the native setters. Original readonly writes remain refused.

Receipt-query and ordinary catalogue-refresh recovery retain the same validated
`nativeSettingsEvidence` in the public completed result. A matching current
header cannot replace it. The phone removes a pending settings operation only
after validating that evidence against its original scope and the returned
effective values; missing or invalid evidence keeps the original operation ID.

The guard follows only the admitted manager call's asynchronous lineage into
the original Query. Other native/UI calls, including a superseding choice for
the same record, execute unchanged. An owned model sequence superseded after
its ACK stops the operation before the effort setter. ACK guards expire within
three seconds and owner deactivation restores owned references synchronously;
late replies cannot restore busy state or publish confirmation. Expiry does not
prove cancellation of an already dispatched native control and remains unknown.

Effort writes require explicit native `supportsEffort:true`, a nonempty complete
intersection of Query levels with current native policy, and the actual clamped
request in that intersection. A native default outside the intersection is not
shown as a selectable default. Policy is checked again against the post-model
record before effort dispatch, and the actual native control value must match.

Active/deferred Code updates and typed Chat updates require independent copied
native gates. Chat's native effort IPC is string-only; Code can request null and
must report the actual native effective default. Catalogue presence does not
prove slash execution. Slash items are bounded native names/descriptions only;
execution uses the original sendMessage route and needs a separate actual native
admission/result gate. No generic execute-slash route is invented.

The copied effort probe can be enabled separately for the exact attested copied
ASAR/profile. This private gate permits only an unchanged actually confirmed
model and an idle held Query; public `model.available` remains false. Effort ACK
and restore evidence from this probe cannot enable model alias writes, another
provider, active/deferred controls, Chat controls or slash execution.

Gateway's main Chat surface creates a native LAM record with
`sessionType:chat`; its `/cowork/` UI URL does not change that classification.
The initial native Chat history uses `getTranscript(id,{limit,maxScan})`, which
calls Desktop's bounded transcript tail reader. It must not call
`getTranscriptRead` for first entry or status. Explicit older history can use the
original bounded full-cache read and return a UUID-bounded page with data only.
Code and Chat manager/action paths are separate, with exact mode checks before
commands. Native UI routing is an additional acceptance gate; manager execution
does not prove that the stock desktop viewport opens correctly.

Version-bound shipped source plus actual isolated desktop-owner probes must
establish namespace/lifetime, existing-session directory, bounded history/stream,
original admission, interrupt/approval, Gateway model use and unavailable modes.
Targeted protocol/state regressions cover stale ownership, malformed frames,
duplicate operations and unknown receipts. Native UI/runtime acceptance is
separate from fixtures. Commercial iteration counts include substantive behavior
and its evidence, not duplicated documentation or identical test reruns.
