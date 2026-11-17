# Native source entry and foreground observation

2026-11-13. A connected Codelync peer is a network fact, not evidence that a
selected Codex or Antigravity observer is still attached.

Every actual session entry, back/focus return and authenticated connection
recovery requests noninvasive `codelync-observe-source` for the exact source
before its fresh selected-session read. A cached connected descriptor cannot
skip this step. Desktop navigation remains the separate explicit-tap action.
Concurrent entry/focus calls share their in-flight observation, but success is
not cached for the process lifetime: an idle observer may legitimately retire
without changing the original native owner's generation.

The activation request is bound to the calling account/peer and source key.
A different authenticated peer during an await prevents it from being sent or
accepted as a current entry. This resumes observation only; old native input,
model, command and permission mutations retain their original receipts and are
never replayed by entry or reconnect.

A pinned Codelync peer always supplies its sealed device proof on WebSocket
entry and reconnect, independently of optional distribution manifest flags.
Changing channels preserves the existing socket configuration and peer identity;
it does not create a new account or replay an offline RPC.

Foreground presence belongs to the current authenticated peer and the current
primary visible session. Entry renews that interest immediately. Presence sends
are serialized and coalesced from the latest viewer/app state; replacing the
presence owner cancels its old pending request. A covered session may retain its
existing viewer lease, but an old screen's cleanup cannot clear a newer viewer.
Presence carries a device-local, persisted monotonic `sequence` scoped to the
authenticated peer. The Mac ignores duplicate/older sequences even when HTTP
arrivals are reordered. Older callers without a sequence remain accepted when
there is no current sequenced foreground lease; they cannot replace a newer
sequenced viewer while that lease is fresh. No credentials are stored in the
sequence counter and sequence ordering never supplies native execution status.
The Mac keeps current foreground interests separate from native running/waiting
state and history loading. Unknown or disconnected native state is not zero.

A fresh approved-device foreground heartbeat received through the sealed HTTP
presence endpoint is itself a bounded viewer lease. It remains valid for at most
45 seconds while the WebSocket disconnects, reconnects or changes channels; a
live WebSocket is not an additional condition for retaining the selected native
observer. Only an accepted newer heartbeat can renew or release that interest.
Expired, future-dated, revoked or background presence cannot retain an observer,
and duplicate/older sequences do not extend its lease. Socket connection state
continues to describe network connectivity separately. This protects observation
and RPC attachment without claiming that the original agent is running or waiting.

Each new native observation attachment republishes its current owner/lease and
control metadata before unchanged-content suppression can apply. Retirement may
have marked the transport disconnected while the original owner, conversation and
content stamp stayed unchanged. Restoring a content checkpoint is not proof that
the new attachment has completed that metadata handshake. The handshake remains
retryable after a publication failure, and a changed lease is rechecked even when
native content is identical. It does not rewrite identical content journals,
duplicate historical events, rotate command IDs or replay native mutations.

Acceptance includes cached re-entry after observer retirement, same-generation
reattachment, concurrent focus/tap, same-peer channel changes, different-peer
fences, immediately renewed foreground presence and old owner/old screen races.
It also covers a selected idle Antigravity observer across a dropped WebSocket
with continuing authenticated HTTP presence, followed by lease expiry/release
and normal retirement without replaying any native command.

## Completed source-unavailable feedback

A completed selected-session read whose source remains disconnected,
owner-unavailable, locked or permission-required shows an unavailable state and
an explicit Retry instead of an indefinite synchronization spinner. A current
read or selection still in flight continues to show synchronization. Retrying a
settled source-read failure resumes observation only; it does not repeat desktop
navigation or replay a native message, model, command or permission mutation.
Existing explicit selection-failure recovery keeps its original receipt rules.

The native empty-history placeholder requires a completed current native read
and an available original source; a cached `isLoaded` flag alone cannot prove
that no messages exist. Until then, the placeholder and its automatic invisible
history paging are withheld. An unknown, zero, negative or nonfinite creation
timestamp never renders an age from the Unix epoch. Previously loaded message
content and device-local drafts remain visible during recovery.

## Read-only native diagnosis

The existing private peer diagnostics may compare the selected phone mirror
with its sealed native recent descriptor. The report is restricted to source
namespace/owner generation, metadata version and sequence, source/projection
status, capability availability and current-view/loading state. It contains no
message bodies, session encryption keys, device credentials or pairing material.
Reading these fields does not hydrate the phone mirror, change source gates,
dispatch an original-owner command or replay an unknown operation. A valid
recent-row projection alone does not establish that the normal foreground entry
has applied its descriptor or unlocked the source.

The same trusted diagnostic connection may measure one version-2 full catalog
followed by one request using the returned watermark. Only response version,
mode, row/removal counts, pagination, logical UTF-8 bytes and elapsed time are
reported. The diagnostic does not apply those descriptors, save a watermark,
change the owner to force a delta or create another pairing.
# Foreground header freshness (2026-11-15)

While a project has a foreground interest lease, native header observers may
declare `refreshDueAt()` before their five-second freshness bound. The shared
service refreshes them at that deadline even when their previous state is still
known. Native reads share the existing global concurrency bound and application
index cache. Phone polling stays independent and does not have to coincide with
the native capture window. Expired/released interests perform no refresh. Missing
or failed native reads remain unknown; neither TTL extension nor message recency
may manufacture a running state. Push-based Codex observers do not need periodic
header reads unless they explicitly declare a deadline.

Activity inventory readiness is separate from full historical catalog removal
authority. A complete current native resident index may provide scoped current
activity while historical catalog enrichment is partial. This cannot remove
historical sources or claim the full catalog is complete. A failed current native
index still makes activity unavailable; stale historical descriptors do not
manufacture an idle or active state.

## Mac-owned activity and unreliable public delivery — 2026-11-16

The Mac maintains a bounded pool of native activity observations independently
of phone interest. Phone visibility prioritizes that pool and chooses the small
projection to return; it is not the only trigger for native state maintenance.
Activity never starts message actors or loads older histories. Unobserved,
expired or unavailable owners remain unknown, and coverage stays explicit.

Paired phones may POST `/api/peer/activity` through sealed HTTP while the
WebSocket reconnects. This reads the same Mac activity replica and never waits
for a native snapshot or a socket RPC. Client ordering is isolated by approved
device plus client identity. Existing version-1 request/response fields remain
available. `activityProtocol: 2` adds device-scoped, expiring `interestToken`
and `since` watermarks. Initial/changed interest sends `groups`; stable interest
sends only its token and sequence. A missing/expired token returns 409 and the
phone resends its bounded descriptors once. A token is routing state and never
native activity or control authority.

Version-2 responses include `mode`, `watermark`, `baseWatermark`, `interestToken`
and the original activity epoch/sequence/capture fields. Full replies establish
the requested groups; delta replies replace only changed groups and remove
explicit IDs; unchanged replies carry no group data. Semantic comparison omits
delivery timestamps, preserving native unknown/ready state changes. The phone
keeps its store across same-peer channel changes and fences different peers,
epochs, interests and late replies. Reconnect does not repeat native mutations.


## Claude header renewal deadline — 2026-11-16

A current Claude header observer declares `refreshDueAt()` at its original
native read-start capture time plus three seconds, while its five-second proof
is still valid. This applies to an admitted foreground or Mac intrinsic pool
observer, so a header first received one second after the five-second maintenance
timer began is refreshed before it expires at second six. The existing shared
queue and concurrency budget own the refresh; no per-row timer is created.

Closed, already refreshing, unknown, expired or changed host/session/runtime
owners have no renewal deadline. Reading or scheduling a deadline never renews
the capture time. A failed or late read remains unknown; a runtime change cannot
borrow a prior header proof even if the session owner ID and host remain equal.

## Codex observation health and coverage — 2026-11-16

A live Codex reduced baseline and complete aggregate coverage are separate
facts. `observationReady()` means a validated native baseline is held for the
current source owner, IPC socket and follower client. `needsRefresh()` reports
whether that baseline needs read-only recovery. Missing subagent coverage in a
partial already-loaded window keeps aggregate activity unknown; it does not
turn a healthy subscription into a refresh request.

The shared maintenance queue skips repeated full loaded snapshots when only
aggregate coverage is unknown. It preserves native capture time, unknown counts
and supported lifecycle states. Native patches can complete or change coverage
later. This never requests full history, infers idle from message recency,
creates a runner, or replays a message/model/permission operation.

A connection/owner change, invalid frame or patch gap removes baseline health
and uses the existing bounded recovery queue. A missing owner is rediscovered
only for an already-registered read-only subscription; a refresh cannot create
an unsubscribed source or claim native ownership. Concurrent subscription,
reconnect and refresh recovery share one attachment attempt for that source.

Cold recovery attempts within the same visibility priority use attempt ordering:
never-attempted sources precede retries, and retries rotate rather than repeatedly
occupying the front of the shared budget. Explicit visible rows keep priority.
A failed Codex baseline recovery has a five-second local retry cooldown; this is
request scheduling only, not a native capture or status TTL extension. Native
pushes remain accepted during cooldown and can restore valid proof immediately.

A later validated push baseline clears only the local failed-read cooldown,
even if the fire-and-forget follow request completed before that frame arrived.
It does not change native capture age, aggregate coverage or command receipts.
