# Native parent tasks on the mobile wire

Status: implementation contract, 2026-11-14, extended2026-11-15 by
[selected task deltas](codelync-native-task-delta.md). Version1 below is the
full data snapshot; ongoing state now uses `nativeTaskSignal` and explicitly
removes the old full `nativeTasks` key. Original runtime/control acceptance
remain separate gates.

Claude query tasks remain parent activity. They are not directory sessions and
do not receive conversation IDs. Proven native dispatch children retain their
own collection, host and owner. Agent definitions are excluded.

The version1 full task snapshot contains one exact parent
scope, bounded task and dispatch rows, availability and completeness flags, and
a digest. The scope binds app, native collection, parent conversation, host,
session owner, desktop runtime, nullable query token and nullable CLI session ID.
The current connector independently checks host, collection, session owner,
desktop runtime and query token before publishing. Mismatched observations
cannot update the current owner. Lease loss makes retained statuses unknown.

To minimize bytes, task rows omit repeated parent scope and duplicate IDs. They
carry only native task ID, name, native type, kind, lifecycle status, background
flag and optional native event time/agent ID. Dispatch rows carry the child ID,
name, collection, host, owner and lifecycle status. Their parent and desktop
runtime come from the envelope. No transcript, output, event buffer, projection
state, tool input or task log is included in the ongoing envelope. Each list is
bounded at 128. Invalid, duplicate or overflowing rows remove completeness.
An unchanged envelope has an unchanged digest and does not force publication.
Directory descriptors omit the task envelope. They carry aggregate attention
only; the selected-session descriptor supplies the envelope. Opening the
directory cannot transfer every selected observer's task roster or logs.

Parent attention includes positive current task and dispatch activity. Pending
or running tasks make the parent active; paused tasks remain nonterminal activity
without implying a pending permission or input request. Missing
foreground lifecycle coverage or dispatch coverage prevents an idle claim.
Background completeness alone is not total task completeness. Native task status
does not create a parent turn or an operable child conversation.

`native-task-read` accepts the selected envelope's exact `scope`, optional
materialized baseline digest `since`, and reads current task metadata.
`native-task-log-read` accepts that scope, optional task
ID, optional older cursor, and a page size of 1–100 (default 12). It returns only
bounded lifecycle metadata logs. Both reads require the selected original source
and lease before and after I/O; stale owner/query results are rejected. They do
not load conversation history or create operation receipts. Logs and output are
never fetched during directory synchronization. Output and stop capabilities
remain disabled until their original native operation and readback are verified.

The bound-source wrapper forwards task reads only for its exact Claude session.
It fixes the collection host and checks both desktop and session generations
before and after the read. It cannot turn task metadata into a new source,
replace its live conversation view, or enable these APIs for another adapter.

## Scoped task output and single-task stop

`native-task-output-read` accepts only `{scope, taskId}`. It reads a task output
through the bound original Desktop API, independently of lifecycle logs. It has
no command ID, operation receipt, automatic polling, transcript read or file-path
fallback. The response carries the exact scope/task ID, an intact output string
of at most65536 UTF-8 bytes, and the original native `truncated` boolean. A null
native result remains unavailable. Source, lease, query and task membership must
match before and after I/O. The output is not written into ongoing task signals,
directory records or session message history.

`native-task-stop` accepts only `{scope, taskId, commandId}`. It is a mutation of
one proved active native task, distinct from parent cancellation. It uses the
existing durable command plan and receipt journal, including exact method,
payload/scope digest, command-ID conflict detection and restart handling. An
unknown or lost native result is never automatically replayed. A successful
reply requires exact native stopped lifecycle evidence for the target; void
acknowledgment, missing roster membership and parent shutdown are insufficient.
Failures after possible native invocation remain delivery-unknown. A readonly
owner refuses stop before native invocation.

Selected metadata may expose compact `nativeTaskControls` with version1 and
verified `outputTaskTypes`/`stopTaskTypes` arrays (at most8 unique bounded type
names each). The original backend supplies an exact scope with these controls;
the connector publishes only type arrays after matching the selected signal's
current scope. It does not repeat the scope per row. Unsupported types have no
control. Types remain empty until actual copied-owner native verification.
Code local_bash is the first verification target; local_agent, workflow, remote
agents and LAM require their own proof. An exposed method alone cannot establish
support. Hidden/background panels perform no output or stop reads.
