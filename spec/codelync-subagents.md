# Native subagent list and execution status

Phone message-delivery logs retain content-free dispatch context inside the
encrypted original message metadata: app, native conversation, host, machine
and owner generation. The context is captured before encryption and rechecked
before outbox admission. An owner change during that await rejects an unissued
send; older logs never inherit the current owner's identity.

## Parent aggregate activity

### Antigravity live summary state — 2026-11-16

Antigravity's ordinary trajectory index omits some current background activity.
An idle Cascade invocation cannot prove the whole Swarm idle. Current execution
uses the original owner's local `JetboxSubscribeToSummaries` stream, including
`notFullyIdle`, `hasRunningSubagents`, pending waiting steps and background task
count. One bounded, scope-validated stream is shared by the backend; status
reads never start a stream per conversation or load conversation history.
Per-row fresh native headers can establish positive activity. Missing headers,
stream failure or a changed owner retain unknown execution state rather than
confirmed idle. Reconnect replaces stale header evidence under the new stream
generation; neither a read retry nor reconnection dispatches a native mutation.

The original UI includes recursively evidenced subagent descendants. A bounded
Antigravity roster may include those descendants only through native subagent
parent edges under the same selected ancestor, host and owner. Ordinary forks,
cycles and foreign roots do not establish membership. A descendant retains
`nativeParentConversationId` and `depth`; `parentConversationId` identifies the
selected roster's ancestor. These optional display fields do not change the
child source's actual parent metadata, navigation ownership or control target.
An incomplete or truncated native tree read cannot prove an empty or complete
roster. Limiting displayed rows is separate from state coverage: a complete,
same-owner native state projection may retain its full count and aggregate while
transmitting only the bounded active-first display roster. That display remains
explicitly partial. Missing state evidence still prevents confirmed idle or zero.
Existing Codex and Claude relationship rules keep their source-specific scope.

The phone keeps its input restriction for native child sessions and uses the
original actual parent for return/continuation. A hierarchy display does not
grant direct input or a new child control capability. Frozen source tests and
native simulator verification must reproduce idle foreground work with active
subagents before the next release.

Opening a native child row or its logs enters an observation route. It reads
that exact child through the authenticated peer recent endpoint without a
Desktop selection command. Foreground observation may initialize a missing
local descriptor from the same bounded response; it does not rely on an old
binding status or add descendants to ordinary conversation counts.

The parent retains its own native status and foreground turn identity. A separate
versioned `aggregateActivity` combines it with explicit same-parent,
same-app/namespace/owner subagent activity. An observed running or waiting child
makes the parent aggregate busy even when its own invocation is idle. Missing,
truncated or unknown native state coverage prevents aggregate idle/completed claims;
positive known busy evidence remains visible with the completeness flag.

This calculation reuses native lifecycle items and the shared resident index;
it does not open child conversation histories. Roster completeness is explicit,
separate from availability. Child-only changes affect the aggregate digest and
native metadata stamp, and the catalog delta compares that digest. Unchanged
metadata does not rewrite the full observer checkpoint or phone directory.

Project totals deduplicate source namespace/native session identity. Parent
roster entries are not added again as separate project sessions. Aggregate state
is attention/display state, not a child-derived parent stop/steering target.

The parent's native active and waiting signals remain independent: a waiting
parent can be inactive while attention is still required. A running native child
contributes activity; a waiting native child contributes activity and attention.
Codex idle proof requires explicit complete native turn-history coverage.
Antigravity roster completeness requires a successful bounded resident index
containing the parent and consistency with native child-activity flags; failed,
stale or overflowing reads cannot prove an empty or complete roster.

Date: 2026-11-13. This extends the current Codex and Antigravity native-source
integration. A normal fork or a conversation with a parent ID is not a subagent.

## Original evidence

### Mobile descendant projection

Antigravity `subagentsTotal` is optional and nullable, bounded to 20,000 native
descendants. A missing, null or malformed total is unknown. A current available
roster may use a total only when it is at least the validated displayed row
count. A complete counter additionally requires a full aggregate with the same
application, selected ancestor, host and owner generation and an identical
`childCount`. Counter completeness is independent from display completeness;
128 displayed rows may be partial while the full 137-descendant count is proven.
The phone must not replace an unknown total with zero or a display-row count.

Optional Antigravity ancestry arrives as a pair: `nativeParentConversationId`
and integer `depth` from 1 through 128. A direct child has depth 1 and the
selected ancestor as its native parent. Deeper descendants keep their actual
immediate native parent, which may be outside the bounded display roster.
Self-parenting and mismatched pairs are unavailable. Rows use a small bounded
indent from this native depth; their original identity and execution status
remain visible. These fields never infer membership or alter native controls.

The selected parent owner's native projection supplies `agentState.subagents`.
Each entry includes `id`, `name`, `app`, `nativeConversationId`,
`parentConversationId`, `hostId`, `ownerGeneration`,
`relationship: 'native-subagent'` and an execution `status`.
`subagentsAvailable` distinguishes a supported current read from unavailable
data. Missing or unsupported data cannot be shown as zero subagents.

For Codex, original `subAgentActivity` records establish child identity and
membership. `kind: 'started'` establishes running; `kind: 'completed'` establishes
completion. `interacted` only records an interaction and does not change the
lifecycle. A tool's `completedAtMs` or tool-call status is not the child's
completion. Waiting or failure requires an explicit original child status.

For Antigravity, only original subagent-spec/source evidence with the exact
parent establishes membership. Native IDLE is idle, not completed; an explicit
killed/interrupted state may be stopped. Ordinary forks are excluded.

## Phone projection

The selected parent shows a compact, expandable subagent list with name,
application, original child conversation ID and execution status. Supported
statuses are running, waiting, idle, stopped, completed, failed and unknown.
Owner-generation mismatch, unavailable projection or disconnected parent makes
current execution status unknown while retaining previously proven identities.
Ordering follows the original list; message recency never supplies execution
status or membership.

The panel does not make RPCs, fetch child histories or run model requests.
Only expanding it subscribes to the existing session catalog for navigation.
Clicking a row uses a catalogued, verified native child with the same machine,
application, host namespace and exact native conversation ID. Ambiguous or
missing catalog matches are not navigable. The existing selection route owns
activation; drafts remain isolated under their original relay session IDs.

The empty state says that no native subagent activity has been observed. It does
not infer that the parent has no agents. Unavailable data is explicitly labelled.
The panel offers All, In progress, Finished and Unconfirmed filters. In progress
includes native running, waiting and idle; Finished includes stopped, completed
and failed. Filtering never changes execution state or converts unknown into
idle. The original unfiltered roster is retained, and an incomplete roster is
marked partial using the scoped native aggregate's completeness evidence.

A child can return to its exact parent using current native catalog evidence
(`isSubagent: true` and `parentId`) even if the parent has never been opened and
its roster has not been loaded. A parent ID without the native subagent flag
still requires the parent's explicit native-subagent roster relationship.
Both routes require one unambiguous, non-archived, available catalog parent in
the same machine/application/host scope, and recheck that catalog at tap time.
This relation check never reads parent conversation history. Parent-owned
continuation staging uses the same validated parent relation.

Phone input editing and Send are disabled for every verified native session
whose current native catalog metadata explicitly says `isSubagent: true`.
This applies to Codex and Antigravity independently of native steering capability.
Ordinary parents and forks without that flag retain their normal input behavior.
The restriction changes the phone composer only; existing draft data and native
server capabilities remain intact. The send callback rechecks the same boundary
at tap time. Stop and supported structured native answers retain their independent
original-owner contracts. Filtering, status refresh and parent navigation never
replay native mutations or introduce a runner, window or workspace control.
Ordinary Markdown option replies use that same phone input restriction. On an
explicit native child page they appear as text instead of clickable reply buttons,
and a captured older callback rechecks the current store before sending. Native
structured approval and communication controls remain governed by their separate
original-owner capability checks.

## Child activity and operation logs

Each evidenced child row has a Logs entry that opens the exact child session.
Recent native messages and tool executions remain the existing child ChatList,
starting at the latest viewport and loading older content only on the established
scroll boundary. Opening a roster or filter never loads child conversation text.

The selected native session's activity panel reads this device's existing
content-free operation traces. Each new trace records its pinned connection,
relay/native child identity, application, host and observed owner generation at
dispatch; subsequent receipt stages retain that original context. The panel
distinguishes confirmed success, confirmed failure, failure before dispatch and
unconfirmed delivery. It does not log prompt bodies, answers, model arguments,
credentials or pairing data. Legacy traces without a matching child context are
not attributed to the current child. Prior-owner traces remain historical and
cannot authorize an operation on the current owner.

Message-delivery entries consume the existing user-message receipt state without
copying prompt text. New messages carry bounded immutable native dispatch
context; an older message without that context shows its owner as unconfirmed.
A local message ID is labelled as local and is not presented as a native command
ID. Native accepted, pre-turn refusal and delivery-unknown states remain distinct.

Reading logs performs no source RPC, receipt replay, model request or mutation.
The messages/tools entry returns to the already selected child's existing lazy
message surface. Continue/Stop and any explicit receipt recovery continue to use
their existing source-owned controls and journals.

## Parent-owned Codex input

Original Codex v2 agent threads may explicitly reject direct app-server input.
The scoped nativeInput projection marks these as parent-owned; this is a read-only
input relation, not a synchronization failure. Stop, logs and approved structured
answers keep their independently verified native capabilities.

Continue prepares only the bound identity in the exact evidenced parent. It
records the native child, agent path, original owner, host and machine and
preserves the parent's existing draft. It never reads, flushes or copies the
child's persisted draft. The user writes a new instruction in the parent's
editable composer before explicitly submitting through its original followup_task
capability. An old delivery-unknown message is never copied or retried; no new
runner or fictional direct-child Continue RPC is introduced.
Parent continuation staging uses the same external-draft baseline rule as
cross-application handoff: adopted text cancels an obsolete composer save and
remains present after route reuse, focus return and app backgrounding.
Native Codelync drafts are device-local even when their bridge metadata also
satisfies the shared Rig v1 source predicate. Saving, flushing and clearing these
drafts must not invoke the Rig remote composer or accept its old draft metadata.
Other Rig sessions retain their existing synchronized composer behavior.

## Verification

Targeted tests cover native relationship evidence, ordinary-fork exclusion,
application/instance isolation, running versus tool completion, all lifecycle
labels, generation/disconnection uncertainty and exact child navigation.
Mobile Antigravity verification also passes a mixed 128-descendant roster
through the real agent-state parser and selected-parent hook. An idle parent
with running descendants must retain every validated displayed identity under
the default All filter, including descendants whose immediate parent is outside
the display bound. Full-state count and busy proof remain independent from
display truncation. These checks use no native mutation or child-history read.
Malformed-row rejection must be reported separately from a verified empty
roster; current parsed-state and raw-source projections are compared when
investigating missing rows.
Native acceptance uses a real parent with original subagent activity and checks
status, source identity and selection without sending a model prompt.
