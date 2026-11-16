# Claude common native bridge integration

2026-11-14 copied-owner checkpoint, with a 2026-11-15 original-owner readonly
update below. Writable stock installation and integrated controls remain
separate gates.

## Shared behavior

- Explicit native manifests only, with Code/Chat collection-specific host IDs.
- Durable metadata retains appMode/nativeCollection; partial or unconfigured
  inventories cannot erase previous native sources.
- Older UUID pages return data without replacing current owner/status/requests.
  Foreign, absent and changed-owner cursor boundaries are rejected.
- Native query Send/queue/cancel is independent of steering and currentTurnId.
  Admission carries an original message ID without inventing a native run.
- Claude foreground project activity shares bounded header reads; it never
  creates Codex IPC clients or reads conversation history for counts.

## Actual copied-owner reads

The same SourceImageAdapter and NativeHappyConnector used by CodeLight read
existing native sessions through the explicitly installed copied-owner manifest.
The local verification transport is isolated; it is not an installed phone or
production relay claim. No model input, cancellation or approval was submitted.

| Mode | Native headers | Recent1 | Older2 | Owner/control boundary |
| --- | ---: | ---: | ---: | --- |
| Code | 1 | 83.9ms | 15.5ms | Same owner, null currentTurnId, current metadata/agentState unchanged |
| Chat | 1 | 71.4ms | 80.0ms | Same owner, null currentTurnId, current metadata/agentState unchanged |

Both nativeQuery identities matched the returned owner. Idle Send was available
independently of unavailable steering. Published model admissions were zero.
The private sanitized proof is retained under the commercial QA directory.

## Original Antigravity project count correction

A fresh original installed Antigravity header inventory contained139sources:
5ordinary conversations and134explicit subagents. The project projection counted
4+1ordinary conversations and allocated5observers. Explicit children were excluded
from project total/unknown counters and observer allocation. Ordinary forks retain
their parentId without being treated as subagents. Parent subagent aggregate
coverage remains separate and can remain unknown.

This was an immediate read-only directory/projection gate with no transcript or
model input. The changed producer still needs a coordinated QA runtime refresh
and simulator counter-display acceptance.

## Integrated producer checkpoint

The new isolated producer started with89source/wire inputs and zero drift. Its
backend health returned200; all four configured connection entries became ready.
Only the prior owned QA service was stopped, gracefully in619ms. Original
Desktop processes were not stopped. The direct copied-Claude native manifest
registered one Code and one Chat source, both with version4.16336.0.

Mac-box and relay seed files remained byte-identical. All358durable source
bindings matched the existing account key. The owner account file changed
because startup renews its token; file-byte equality does not measure key
continuity. The existing unknown native receipt retained its key/digest/status
hash. Device presence telemetry changed during shutdown; existing-device
authenticated simulator reads are the remaining device continuity gate.

The unified JS595b…/native1310 artifact preserves59native sections and1769source
inputs with zero drift. Its installed iOS codec passed14synthetic authenticated
stress cases in2.856s: queue3→2admitted/1busy and byte budget3→1/2; auth, peer,
gzip/CRC, BOM/UTF8-only compatibility and late-context/abort failures were rejected.
No source response or model result was applied. Native Claude control/model
display and ordinary project-counter acceptance still require the simulator.

## Regression scope

131 shared bridge/source/discovery/activity/registry regressions passed before
the final stricter native-query shape guard. Follow-up query/state gates cover
null idle tokens, active queue admission, one immutable accepted receipt,
same-ID cancel deduplication and changed/foreign query rejection.
Fixtures prove protocol behavior; actual original/copy evidence is described
separately above. No CLI/TUI support is activated.

## Original-owner tail expansion repair, 2026-11-15

The exact Code session selected on the installed iPhone had valid original-owner
headers, events and an older page, but its recent snapshot failed. Both the
original native manager and existing trusted renderer API successfully returned
512 messages for a requested32-message tail. The 500-message public projector
rejected that expanded cache/window result.

The owner now validates the raw materialized window against bridge limits of
2048 messages and8MiB, then selects the newest32 whole messages before public
projection. The public500-message limit remains. Valid original UUIDs and message
bodies are retained; absent UUIDs retain the existing null projection. Omitted
whole messages force `hasMore:true`, and older navigation uses a real retained
native UUID. Header/query/request reads remain independent of message slicing.
Readonly failures carry no mutation effect and retain their fixed error code.

A fresh content-addressed CJS was installed into the same original main process
with the existing manifest path. The actual512-message/203531-byte native window
became a32-message snapshot; two subsequent bounded reads retained owner/query
identity. The update retained71 native record/query/internal-CLI references,
original window callbacks, all11 keyboard handler references and hashes, current
DOM/ProseMirror draft statistics, Gateway fingerprint and original app artifact.
The main inspector was closed after verification.

Forty targeted Claude regressions, independent whole-body/nullable-UUID/real-
cursor/metadata checks, full `pnpm typecheck:all` and `pnpm lint` passed. Physical
normal entry/re-entry and older-page verification are pending. This restores a
readonly snapshot path; the separately reported duplicate input is unresolved.

Craft evidence for the stored sanitized native verification reports:
`ev_0a130eb42d54d08ed41009d5ce02d1209673e98e69992ef8c5692b1dbc8efecd`
and `ev_4f573e6d26cf8fd16526906d77226aa80caacb8a6008ead6bf7dd71e3946ec4a`.
These records read verification reports; they do not constitute a new Craft
runtime execution or a physical phone UI observation.

## Simulator readonly and native task checkpoint, 2026-11-15

The existing simulated peer read the exact stock Code source successfully:
recent1 and older4 returned200, owner continuity and the history cursor matched.
Normal entry then exposed a genuine UI defect: an ordinary readonly parent
still had an editable native text area. The explicit original-owner
`capabilities.readOnly` policy now controls the composer independently of model
observation, temporary readiness, subagent and saved-history restrictions.

Signed simulator JSc19e37 retained62 native sections, all six existing draft
entries and the server configuration. Actual normal entry and re-entry show a
static composer,0 editable fields, disabled model/mode, noSend/Stop and visible
content. A gesture succeeded, but no meaningful visible text anchor was
captured afterward; history-anchor acceptance is still open. Physical iPhone
acceptance remains pending its developer connection.

Recorded simulator proof:
`ev_93c4cc236efabf2f03a46b27275e6f6eaeba88279e8f74d92dae3c89ca9410b6`
and `ev_5e63d1c1e93d3c3c09e6407d4c5b2c9b5ce2a0a634270e8d2d98b4111a4b5140`.

The isolated copied original Desktop was recovered under its retained private
encrypted profile, with one Code and one typed Chat record. One Code prompt
created two native local_bash tasks under the same held query. Both original
task-output APIs returned32 bytes with exact fixture markers and the native
`truncated:false` flag. One exact A stop produced the matching native stopped
notification while B and the original query survived; B was subsequently
stopped for cleanup. The two exact Bash approvals were single-use, with no
global permission change. No new session or stock model request was made.

This is a copied native operation gate. Public task-type controls remain empty
until verified activation; enabled shared RPC/UI acceptance and output from a
terminal task remain open. The stock owner remains readonly. The separately
reported input duplication is still unresolved.
