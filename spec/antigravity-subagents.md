# Antigravity native subagents

Directory descriptors mark verified `subagentSpec` or SUBAGENT-source records
as `isSubagent`, retaining the original parent and native role/name. Internally
they remain controllable native child conversations; ordinary conversation
counts and pickers exclude them, and the parent tree/subagent list provides
entry. Missing annotations use the native role/type before a generic title.

Status: native summary projection implemented, 2026-11-13; native phone acceptance
belongs to the integration task.

The phone's selected parent conversation may show native Antigravity subagents.
Relationships use the original owner's resident `GetAllCascadeTrajectories`
index. Current activity comes from one backend-owned, scoped native
`JetboxSubscribeToSummaries` stream. Neither activity nor roster counting reads
child conversation steps or infers activity from message recency.

## Native summary activity — 2026-11-16

The original owner was observed returning `CASCADE_RUN_STATUS_IDLE` while its
current streamed summary had `notFullyIdle: true` and
`hasRunningSubagents: true`. A direct child also had those flags and
`backgroundTaskCount: 2`. Cascade IDLE is therefore a foreground invocation
state, not proof that the conversation and its background/subagent work are
fully idle. The old unary index can omit these richer flags.

Each backend owns one shared SummaryStream across directory, project activity
and selected-session readers. A read selects bounded headers from its replica;
it does not create a subscription per session. Headers and changes carry their
actual host/generation, revision and observation time. Reject foreign or old
owner evidence, invalidate current proof on stream failure/disconnection or
native deletion, and keep the last conversation body as retained data.

Merge current same-scope rich headers into the resident index before projecting
activity. Native `notFullyIdle`, running-subagent or positive background-task
evidence establishes activity even when the cascade is IDLE. Missing rich
proof cannot turn an IDLE cascade into confirmed full idle. Positive native
RUNNING/BUSY/CANCELING evidence remains distinct from absence; stale cached
flags are not current evidence. Preserve the original foreground turn,
requests and control identities: background activity never grants a write,
stop, model, effort or approval target.
Because validated streamed messages are full protobuf replacements, omitted
`killed`, `interrupted`, termination and waiting markers use their native
defaults rather than inheriting older unary stopped/waiting values. Reduced
status headers retain the unary index's complete native relationship metadata;
private prompts and step bodies never enter status replicas.

A summary-only change updates reduced activity and a selected cached view even
when content time/count and messages are unchanged. This path must not call
history APIs. Failure and owner changes also publish status-only unavailability
without discarding retained rows or creating an empty successful child list.
Observation time is the native capture time, never the time a cached replica is
read. A row received under a matching, still-active continuous stream/proof
epoch remains current without a five-second polling expiry. Disconnect or
reconnect clears prior proof; a new stream epoch cannot reuse authority for a
row it has not received. Do not keep status fresh by reopening streams or
repeating bulk index reads. The stream is disposed with its backend.

## Identity

A row qualifies only when its native `trajectoryMetadata.parentConversationId`
matches the selected parent and it has a native `subagentSpec`, or the explicit
`CORTEX_TRAJECTORY_SOURCE_SUBAGENT` source. An ordinary fork, shared workspace,
matching title, or `forkParentConversationId` alone does not qualify.

Every row carries the original native conversation ID, exact parent ID, source
application, stable storage namespace (`hostId`) and current owner generation.
The list follows actual native parent links recursively from the selected
ancestor. Each row keeps `parentConversationId` as that selected ancestor for
routing, plus `nativeParentConversationId` as its real immediate parent and
`depth` from that selected ancestor. Directory descriptors keep their actual
native `parentId`. Each intervening link must qualify as an explicit native
subagent relationship; ordinary forks and unrelated roots are excluded.

At most 128 descendants enter a projection. Current running/waiting and positive
rich activity take priority over historical idle rows. A larger valid tree does
not become entirely unavailable or silently discard active work. Bounded
output exposes `subagentsTruncated: true`, the native descendant total, and
`subagentsComplete: false`. Descendants never become extra ordinary project
conversations. Malformed identities/ancestry remain unavailable rather than
manufactured as empty. Native metadata such as
`initialPrompt`, signatures and raw trajectory bodies never enter these rows.

Bounded display is separate from activity authority. When the complete native
tree (including all 136 observed descendants) has current scoped stream proof,
aggregate all of its statuses/counts even though only 128 rows are displayed.
The aggregate can have `rosterComplete: true` while display
`subagentsComplete` is false. UI truncation alone must not keep that conversation
permanently unknown. If complete current native tree proof is missing, preserve
unknown; positive native background work still proves busy. No-tool-call parked
workers remain in the native roster and are never deleted or marked completed
to fit the display bound.

## Execution states

- `RUNNING` and `BUSY` mean running, or waiting when the original owner supplies
  pending `waitingSteps`. `CANCELING` remains running until a terminal observation.
- `IDLE` is fully idle only with current same-scope rich idle proof. A current
  positive `notFullyIdle`, `hasRunningSubagents` or background-task count takes
  precedence over old termination/hook metadata. Missing rich idle proof stays
  unknown. Swarm workers can park after an invocation; idle is not completed.
- An idle native user cancellation, killed flag or interrupted flag means stopped.
- An idle `EXECUTOR_TERMINATION_REASON_ERROR` means failed.
- Missing or future status values remain unknown. A native killed flag can mark
  stopped even when run status is omitted; it does not manufacture completion.
- Parent disconnection or namespace/owner mismatch makes the list unavailable;
  the UI must not display a stale execution state as currently verified.

## Synchronization

The backend shares the existing resident-summary flight/cache for selected
conversation and lightweight activity reads. History search is not needed for
this projection. A successful empty native list means only that no direct native
subagent was observed, not that a persistent disk directory has no child history.

Foreground activity samples retain the time the bounded native index read
began. Cache reuse, project resolution and late response completion never renew
that capture time. A separate cache-completion timestamp may share the native
flight without causing readers to repeat an index whose request exceeded the
one-second cache interval. Poll-only execution proof expires after five seconds;
a matching active summary-stream epoch supplies continuous current authority
without changing that capture timestamp.

An activity observer reads the shared current same-host/same-owner reduced
replica without conversation or network reads. While its project interest lease
is active, it reports `refreshDueAt` at capture time plus three seconds. The
shared activity service schedules that deadline under its existing concurrency
budget, refreshing before expiry rather than waiting for the phone's ten-second
poll. Closing an observer removes the deadline. No timer or per-row RPC is
started by the observer itself; unavailable and changed-owner samples remain
unknown, and an idle parent with an explicitly active child remains known busy.

Activity inventory authority is independent of the durable history catalogue.
`activityInventoryComplete` requires a successful resident index under the
current native host and owner. A partial or failed history search cannot revoke
that resident status authority. A failed resident read, changed owner or changed
host removes it. This property is never catalogue-removal authority, and does not
mark old conversations absent from an incomplete history catalogue.

Resident and durable catalogue reads use separate flights. `history:false`,
activity and selected-session header reads share only the bounded resident
flight/cache; they never wait for `SearchConversations` or durable catalogue
merging. Durable listing keeps its own flight and removal-authority checks. If
resident metadata changes during a durable merge, rebase against the existing
bounded catalogue cache and current resident snapshot once; a changed owner or
another intervening index change rejects that catalogue publication.

An idle selected parent's cached body can receive changed subagent metadata
without reading its full trajectory again. Its original content stamp remains a
stable base, so unchanged summaries do not create repeated revisions.

The phone may navigate to a child only through an already verified source binding
with the same Mac, application, namespace and native child ID. The panel adds no
agent creation, model runner, automatic input or replay path.

## Evidence

The 2.31.2 descriptors include `CortexTrajectoryMetadata.subagentSpec` and
`parentConversationId`, and summary status/interaction/termination fields.
The captured native index has 84 summaries, 66 explicit subagent-parent relations,
and a largest direct group of 18. This is a captured read-only observation, not a
claim that the current index or persistent history count is fixed.

Derived evidence: `ev_754829749ac77b1cddfa44a4834dc77eaead6093210eafb503e0a698e4bc4438`.
The sanitized evidence file is private and is not included in source distribution.

A subsequent single native index read contained 85 summaries. Its 66 explicit
subagents across 18 parents projected to 48 idle and 18 stopped rows (from native
killed flags), with exact source stamps and zero child trajectory reads.
Live projection evidence: `ev_40dbf7cf43c00d418166339c8e776c24a697f257aabdae20c75dedc49a82a364`.
