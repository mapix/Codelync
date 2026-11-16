# Selected native task deltas

Status: implementation contract,2026-11-15. Native runtime/UI acceptance remains
separate. This extends [native tasks](codelight-native-tasks.md).

Ongoing Claude agent state carries `nativeTaskSignal`: one scope, content digest,
task/dispatch counts and current coverage flags. It contains no names, IDs, task
arrays, logs or output. The old `nativeTasks` key is explicitly removed during
publication, including restored transport state. Directories omit both task
data and this selected-only signal; aggregate attention stays independent.

The selected native backend publishes an internal capture epoch and monotonically
increasing sequence per parent, across queries. These fields order observations
within that backend lifetime and never identify a native task/turn. They are
excluded from wire digests. A late older successful view cannot replace newer
task data or its source/query. Disconnected observations still withdraw current
availability. Withdrawal may reuse the previous successful capture; a delayed
success with that same or older capture cannot restore availability. A strictly
newer validated capture is required to restore the withdrawn task/dispatch proof.
Progress timestamps live in on-demand logs, not ongoing task rows or semantic
message-history stamps.

`native-task-read` accepts exact `scope` and optional `since` (a previously
materialized full snapshot's digest). Without an exact cached baseline it returns
the version1 full snapshot. A known same baseline returns
`kind:native-task-unchanged`; changes return `kind:native-task-delta` with exact
scope, base/target digest, task upserts/removals, dispatch upserts/removal keys,
current counts/flags and optional complete task/dispatch order arrays. Dispatch
keys are canonical JSON tuples `[nativeCollection,hostId,nativeConversationId]`.
Reorders are explicit. Duplicate/conflicting/missing IDs, incomplete orders and
inconsistent coverage/counts fail before atomic materialization. A delta larger
than the full snapshot falls back to full.

Digests cover canonical JSON with sorted object keys and preserved array order,
excluding the digest itself and internal capture metadata. Clients verify the
materialized content hash after existing authenticated transport validation.
Each snapshot is bounded at128 tasks/128 children/512KiB UTF8. Server retention
is at most8 snapshots and512KiB per selected source; oversize data fails without
trimming or claiming completeness. Scope changes invalidate retained baselines.

Fresh task reads retain native owner/query fences and publish the matching latest
signal before returning data. Internal capture ordering suppresses delayed older
projections. Clients may retain a validated response ahead of signal delivery but
promote it only when its target matches the latest signal. A signal is not a
materialized baseline. A peer/source/query change or newer target prevents an old
full/delta/unchanged response from becoming current.

Mobile caches are ephemeral, at most8 selected sessions/512KiB, and do not write
MMKV, drafts, keys, native queries, controls or model state. Expanded foreground
task/subagent consumers share a read; collapsing one does not cancel another.
Collapsed/background panels do not read. Signal changes trigger only an active
read intent; there is no polling. Native logs remain separate12-row gesture reads.
Missing client baseline requests full; it never becomes a successful empty roster.
