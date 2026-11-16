# Claude native task and dispatch-child projection

Status: pure projection contract, 2026-11-14. Native runtime acceptance and
stock bridge installation are separate gates.

## Evidence and identity

Claude Desktop 4.16336.0 distinguishes named agent definitions, SDK tasks in an
existing query, and native dispatch-child session records. `getAgents` and
`createAgent` manage definitions; they never populate the running roster.
`getAgents` can fall back to a temporary query and must not be called for status.

SDK tasks use `task_id` in `task_started`, `task_progress`, `task_updated`,
`task_notification` and `background_tasks_changed`. The original parent holds
foreground/background task maps. Task type remains distinct: `local_agent`,
`local_bash`, `local_workflow`, `remote_agent`, and unknown future types are not
interchangeable. An SDK task is parent activity and has no fabricated native
conversation ID or standalone source.

Code dispatch records use `dispatchParentId`. LAM dispatch records use
`parentSessionId` and `sessionType: dispatch_child`. A matching parent string,
ordinary fork, tool result, agent definition or task ID alone never proves
native collection membership. A child source requires the exact original
collection record, original child ID, child host/owner identity, exact parent
scope and matching desktop runtime. Cross-collection children retain their own
host and collection; they must not inherit the parent's source identity.

Every task observation binds app `claude-desktop`, native collection
(`claude-code-sessions` or `local-agent-mode-sessions`), collection host,
parent Desktop ID, original desktop runtime generation, parent owner generation,
nullable original query token and nullable CLI session ID. Captured scope must
equal current scope before events or levels can update current status. CLI
`session_id`, task ID, agent ID, tool-use ID and Desktop ID remain separate.
The shipped `subagent:<agentId>` normalization is a display grouping key.

## Pure projection

`projectClaudeTasks(input, previousState)` performs no I/O, model execution,
clock read, history fetch, operation admission or source discovery. Inputs are
already captured native observations. It returns bounded parent `tasks`, proven
`dispatchChildren`, availability/coverage flags, content-free lifecycle logs and
the next immutable-by-convention state. `claudeTaskKind` classifies task types;
`readClaudeTaskLogPage` selects a bounded window from that state.

Current scope and captured `observedScope` are both required. `connected` and
`fresh` must be explicit. Stale/disconnected/mismatched observations cannot
publish current execution status; retained identities become unknown. A query
or owner change resets query-scoped task state. A monotonically increasing
`observationSequence`, when supplied by the original event bridge, prevents old
batches from reversing newer lifecycle state. An equal sequence is a harmless
duplicate; a lower sequence is rejected. A conflicting reused native event UUID
removes that task's current status proof. The sequence is never a native task ID.

`task_started` proves running. Progress/tool completion does not prove child
completion. `task_updated.patch.status` preserves known pending/running/paused
states and explicit terminal state; unknown states remain unknown.
`task_notification` confirms completed/failed/stopped. A stopped task can only
be reported from native lifecycle readback, never a stop request receipt.
Background levels prove membership in the background task set and can prove
running activity; disappearance alone does not prove completed or stopped.
Current status derived only from a previous level requires a new current level
read. An unavailable or partial replacement retains the identity as unknown;
valid rows in the new level retain their positive activity evidence.
Ambient and dream tasks are excluded from this foreground product projection.

`backgroundTasksComplete` concerns the explicit background level only.
It never proves foreground coverage or an empty total roster. `tasksComplete`
requires separately explicit complete current-query lifecycle coverage or both
original current foreground/background maps with proved query ownership, current
source proof and no malformed, dropped or overflowing data. Foreground maps are
read as levels, never converted into fabricated `task_started` messages.
Bounded transcript history is not automatically complete lifecycle coverage. Native missing,
unavailable or partial data never becomes a successful empty roster.

Maximum retained tasks and children are 128 each; one observation processes at
most 512 events and retains at most 512 log rows. Overflow keeps positive known
activity but removes completeness. Logs use bounded native event/task IDs,
status/type/background metadata and optional native timestamp. They contain no
prompt, task output, tool input, answer, file path, credentials or source object.
Cursor strings bind the exact task/source/query state and log revision; foreign,
malformed or evicted cursors fail explicitly. Pages never carry operable controls.

## Original operations and integration

Code's `LocalSessions.getTaskOutput(parentSessionId, taskId)` forwards
`get_task_output` through the existing original query and returns nullable
`{output,truncated}`. `LocalSessions.stopTask` and LAM `stopTask` forward
`stop_task`; their void result does not establish termination. LAM has no matching
task-output method in the inspected public API table. Task read/stop availability,
fencing and terminal readback require separate native runtime verification.

No direct task-ID continuation interface was established. The pure module
publishes no continuation or stop capability. Native dispatch continuation is
an original child-session operation and remains unavailable until separately
verified under the actual Gateway mode. Unknown operation IDs are retained and
never replayed by roster refresh, log reads or lifecycle changes.

The history/owner projector must preserve bounded task lifecycle IDs/types,
task patch/status/background fields, native event UUID, agent/tool-use IDs and
level rows. Runtime scope and coverage are captured separately from message
loading. The backend may integrate this module without loading unrelated
histories, invoking definition enumeration or creating a model runner.

Version-bound static authority is the installed ASAR SHA256
`cdfee9476e3d17df5aa869ab4d84010eecfd8de5cf8656c641dd1edd950cd9af`.
Safe static excerpts have exact member hashes and character/UTF-8 offsets,
Craft evidence `ev_45d5775a2cfa09d9f4cb60290060ca3114f426f6cc58342aeb4a005ca8ea594c`.
Pure behavior tests verify identity, scope changes, lifecycle/levels, uncertainty,
collection proof, replay, bounds and cursor isolation. They do not establish
stock/native runtime acceptance.

## Backend and fixed owner feed

The owner exposes only `code.taskFeed` / `cowork.taskFeed`, read-only
`code.taskOutput`, and separately gated `code.stopTask` / `cowork.stopTask`.
Task continuation, arbitrary query control and definition enumeration are not
part of this allowlist. Feed arguments are `sessionId`, original bridge `cursor`,
`limit` (at most 128), optional expected owner and expected execution token.
Output/stop require the exact task, owner and non-null original query token.

Feed results carry version1, the exact `scope`, `sessionId`, owner/execution/main
runtime generations, nullable CLI session ID, `queryPresent`, cursor and reset
flag, at most 128 task-only original lifecycle events, optional original background
level and foreground map, coverage flags, and bounded native dispatch proofs.
An installed observer records the owner/query/CLI identity of native task events;
existing fields from before observation or another query cannot acquire current
scope merely by being read. Background/foreground level completeness requires
that provenance and current original query/record references. Gaps, resets,
unknown map ownership and failed inventories remain partial.

`ClaudeDesktopBackend.taskSnapshot` consumes this feed without transcript reads.
Selected snapshots/subscriptions attach its bounded projection as `nativeTasks`,
plus `nativeDesktopRuntimeGeneration` independently of the session owner epoch.
`nativeTasks` carries scope, tasks, dispatch children and coverage only; log/state
buffers stay on the Mac. Task changes participate in the selected view digest.
Catalog listing never fetches tasks or histories per session. Failure of the task
feed does not discard the parent's native conversation or input proof.
Unsupported feeds have a source/main-bound short negative cache (two seconds by
default); successful direct metadata reads clear it, so a same-main bridge update
can recover without repeated polling errors. Native task reads expire five seconds
after their capture begins. Equal event cursors still refresh current level and
dispatch-header snapshots; they do not freeze task metadata.
Task metadata reads are serialized per selected parent. A poll and an explicit
read cannot let an older same-cursor child/header capture overwrite a newer
observation. Exact-context concurrent reads share one flight, and at most one
different-context read waits behind the active read. Additional reads fail with
`native-task-read-busy`; no unbounded native-timeout queue or automatic operation
retry is created. Every queued read rechecks its owner/query context when it runs.
Event cursors are reused only under the same desktop main, collection host and
expected parent owner/query. A recovered owner with the same session ID starts
at cursor zero; an old cursor cannot permanently disable its new task feed.

Each successful native metadata capture has an internal backend epoch (16 random
bytes encoded as hex) and a monotonically increasing sequence. The bounded scalar
sequence advances across all parents, so each parent's subsequence never resets
on query changes or cache eviction. Coalesced calls share one capture. Source
views carry `nativeTaskCapture`, and `nativeTasks.capture` carries the same value
for explicit reads. Failed/unavailable reads may retain the preceding capture
as historical data only; they never mint fresh capture proof. Capture fields are
excluded from semantic digests and resident transport payloads. They exist only
to prevent late old source views from overwriting a fresher explicit native read.

The selected source's task signature is the sanitized compact semantic digest.
Native lifecycle event IDs, progress timestamps and log-only changes do not
change message/history stamps or notify an unchanged task roster. Task-only
frames in the ordinary event stream do not trigger transcript tail reads; the
separate bounded task feed owns their lifecycle/log metadata. Semantic identity,
status, coverage, type, name and child changes still update the task signature.

`taskLogPage` refreshes native metadata and rechecks the requested full scope
before reading bounded content-free lifecycle metadata; it returns that same
scope and defaults to 12 rows. Scope changes reject the old cursor. No task output
or message body is resident in the roster or log pages. Output/stop methods are
unavailable until separately verified original-owner capabilities and readback
are supplied; a stop request alone never confirms success. These methods are
excluded from the backend's generic supported action list.

### Code task output and single-task stop

Only the original Code `local_bash` task type is an initial control candidate.
Typed Chat/LAM, workflow, remote-agent and other task types retain empty control
type lists. Owner installation takes independent verified output/stop type lists;
both default to empty and may contain only `local_bash`. Native method presence
does not set these lists. Copied A/B native acceptance must precede enablement.
Readonly owners always publish an empty stop list and reject stop before receipts
admission. The selected metadata carries one
`nativeTaskControls:{version:1,scope,outputTaskTypes,stopTaskTypes}` object from
the same current native task feed; it is not repeated on every task row.

`code.taskOutput` calls the existing trusted renderer's
`LocalSessions.getTaskOutput(sessionId,taskId)`. It never reads an output path.
An observed current-query task birth and current native membership are required.
For output only, an explicit native terminal notification may replace active
membership when it retains that exact birth, owner, query and CLI identity.
Stopped/completed/failed tasks remain readable while that original query is
held. A foreign notification, reused task ID, new query or unknown terminal
status cannot loan old output ownership. Stop still requires active membership.
Record, held/getSession lookup, owner, query, CLI and birth identities are checked
again at the original manager method's invocation boundary and after the read.
A null result is unavailable. Output must be a whole string of at most 65536
UTF-8 bytes with the original native `truncated` boolean; CodeLight does not cut
the body or manufacture truncation.

`code.stopTask` is a mutation with an owner receipt and a stable command ID.
It calls only the existing native `LocalSessions.stopTask`, with the same
pre-invocation task/query fences. Temporary guards apply only to the requested
session/task pair and restore the exact original method descriptor/reference in
`finally`; overlapping guards of that method are refused. The original native
renderer, API factories, windows, keyboard handlers and ASAR are unchanged.

A void reply never confirms termination. A bounded wait (at most three seconds)
accepts only a later original `task_notification` for the same task birth,
native session/query/CLI and owner scope, retaining its native status and event
identity. A stopped result requires explicit native `stopped` status; completed
or failed status is preserved. No exact terminal event leaves the operation
unconfirmed, and its command receipt is retained without automatic replay.

### Remaining native child read gate

A dispatch-child metadata proof does not establish a readable child conversation.
The current Chat backend catalog admits `sessionType: chat` only, and the owner
LAM session guard also excludes `dispatch_child`. Such LAM dispatch rows may
describe original collection membership/activity, but cannot be advertised as a
supported Chat conversation or assumed to have a catalog/navigation target.
Code and LAM child reads require independent original owner/record/query proof,
bounded transcript coverage and a dedicated verified mode path. Do not broaden
the Chat guard to arbitrary LAM records. Native stop/output controls and
stock/copy task-feed acceptance remain separate unverified gates.
