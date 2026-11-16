# Native source entry and foreground observation

2026-11-13. A connected CodeLight peer is a network fact, not evidence that a
selected Codex or Antigravity observer is still attached.

Every actual session entry, back/focus return and authenticated connection
recovery requests noninvasive `codelight-observe-source` for the exact source
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

A pinned CodeLight peer always supplies its sealed device proof on WebSocket
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

