# Codex v2 child input ownership

Investigated against original Codex Desktop 26.1103.60933 and its bundled
0.167.0-alpha.3.2 core on 2026-11-13.

The native core rejects direct app-server input for multi-agent v2 sub-agents.
The ordinary `thread-follower-start-turn` route forwards to that `turn/start`
operation and has no child follow-up branch. Owner discovery's
`supportsUntrustedAppInput` proves follower reachability, not a child's direct
input capability. The shipped v2 child view defaults to `canInteract: false`.
Continuation belongs to the existing parent's model-side `followup_task` control.

CodeLight recognizes the original child provenance from
`source.subAgent.thread_spawn.agent_path` and its recorded parent, with
`threadSource: subagent`. It publishes a source/owner-bound `nativeInput` record
with `available: false`, `reason: parent-owned-subagent`, the original parent ID
and agent path. Send/steer are rejected before dispatch when that verified state
is current. Observation, native stop, pending native approval replies and logs
remain available. Other original Codex conversations retain ordinary input.
Message-style asynchronous questions that reuse send/steer also require the
parent path; genuine native pending user-input/approval response methods remain.

Parent-owned Continue must be explicit: navigate to the verified original parent
and stage only the child-bound identity for the user to review. The phone's
explicit native subagent composer is read-only; its stored draft remains intact
and is never read or copied by Continue. The user writes the new request in the
editable parent composer before submitting. It never
silently routes an ordinary child input to the parent, starts another runner or
reuses the original unknown input's operation ID/text. Only a subsequent original
parent/control observation can confirm that the child actually resumed.

The existing failed Continue retains its original unknown ledger entry. Absence
of a native user row alone does not prove non-dispatch. A native rejection cause
may be retained as bounded diagnostic data without replaying or reclassifying
that old operation. Newly observed native request rejections retain their code
as `nativeCause`; unconfirmed effects remain unknown.
