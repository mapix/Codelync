# Mobile native read recovery

## Paired activity transport

Project/session activity is a small authenticated HTTP read on a paired Mac.
`POST /api/peer/activity` does not await WebSocket connection or original Desktop
history. Its existing client/sequence/groups interest contract remains available
for older callers. The phone's activity scope is the authenticated peer/account,
so switching channels of the same Mac does not reset status to an empty store.
Different-peer/account results are rejected. Legacy unpaired clients retain
their existing machine RPC boundary.

New activity clients seal the HTTP request body with the existing pinned Mac
public key and device secret key. The carrier is `[2, nonceBase64url,
ciphertextBase64url]`; decrypted JSON is `[peerId, 'POST', '/api/peer/activity',
payload]`. Every request uses a fresh native 24-byte nonce. Project paths, group
and native IDs do not enter the plaintext LAN carrier. The Mac opens this body
only after its existing device proof succeeds and verifies peer/method/path.
Decoded plaintext is capped at 256 KiB and the carrier at 360 KiB. Other routes
retain their existing request format; older object activity bodies remain a
server compatibility path, not the new phone's outgoing format.

A selected ordinary parent may register one independently scoped session row.
The phone derives its local status key from machine, app, host and native ID;
no extra identity field is sent. A ready same-peer/same-source row may supply
only the status label/color/pulse. It cannot change controller connectivity,
input/stop/approval rights or parent-owned execution identity. Explicit child
sessions retain their separate fresh-child status contract.

The phone opts into `activityProtocol: 2`. The first request supplies bounded
groups. A device/client-bound interest token and watermark then replace repeated
group descriptors. `full`, `delta` and `unchanged` replies reconstruct the same
small group/session projection under the exact machine, epoch and base watermark.
An expired token gets one full-interest retry. An unchanged reply renews receipt
time without notifying every unchanged project/session subscriber. It cannot
manufacture native activity, idle proof or a missing zero counter. Interests,
tokens and baselines remain bounded and in memory, outside conversation history.

Foreground polls stay serialized. A response from an older request, disabled
screen, replaced peer/account or superseded interest cannot renew the current
projection. A same-peer endpoint replacement may repeat the read once on the new
authenticated route. No mutation, message, model, approval or command is replayed.

## Cached first viewport and fresh confirmation

The phone's initial selected recent request opts into `readPolicy: 'cache-first'`.
A warm same-owner native cache may return an explicitly versioned `freshness`
projection with `mode: 'cached'`, `currentControlAuthority: false` and
`revalidationPending: true`. The phone validates session, native source namespace,
owner and row identities before applying this retained body. Cached descriptors
remain read only and cannot authorize live input, stop, model or approval actions.

The body becomes visible immediately. One coalesced background default-fresh read
confirms original-owner data and controls; the phone does not restart the blocking
spinner or delete expanded/retained rows. The server shares this fresh read with
its existing revalidation flight. Equal descriptor versions still restore fresh
controls, because the cached read-only descriptor is only a response projection.
Current-run accepted fresh/WS metadata has separate provenance keyed by peer,
native namespace, mode/collection, owner and any original main-runtime identity.
A later cached body cannot downgrade that newer live header. A disk-restored
header never counts as this provenance, and its higher old version cannot be
attached to response-only readonly controls to suppress a real fresh header.
An explicitly control-authoritative fresh response must match its full descriptor's
runtime owner as well as every row's owner. A reply cannot pair old retained rows
with a newer control header under one apparent fresh owner.
Connection loss, reinitialization and unavailable owners revoke live provenance;
a same-peer read-route replacement preserves a still-live source identity.

Cached windows do not install or advance native history cursors. Fresh confirmation
alone updates cursor/pagination ownership. Old valid cursors and local drafts stay
retained during revalidation. Failed confirmation keeps the visible cached body
and disabled current controls, with a separate retry state from an initial failed
read. Re-entry/focus and transport-gap reconciliation share the current in-flight
read instead of queuing duplicate native recent snapshots.

## Recovery ownership and verification

The Sync runtime keeps one reconnect subscription across repeated initialization.
Activity, catalog and selected-body reads stay independent. A directory or status
failure cannot block a selected cached viewport, and selected message loading does
not walk other conversation histories for counts. A message watermark never moves
backward when live updates arrive during key initialization or response decoding.

Targeted verification injects delayed replies, packet loss, same-peer channel
replacement, different-peer results, obsolete interests, background release,
cached-first/fresh failure, equal-version control restoration and live-message
races. It asserts request counts, narrow payloads, retained body/draft/cursors and
no native write replay. Native device acceptance remains a separate final gate.
Controller connectivity alone is not execution-idle proof. A connected native
session without confirmed aggregate, query or scoped activity evidence retains
an Unconfirmed execution label. Independent ready activity may replace that
label; it never changes controller connectivity or write capabilities.

## HTTP route continuity during WebSocket recovery

### One-shot private USB locator

On iOS Codelync startup, an already paired phone may consume the optional
device-private `Documents/codelync-mac-locator.json`. Version 1 carries only the
expected `peerId`, at most eight bounded locator origins and an `expiresAt` no
more than five minutes ahead. It carries no new account, device key or pairing
authority. Absent, expired, malformed or wrong-peer files introduce no behavior.

The startup owner reads the file once, authenticates the current Mac through the
existing bootstrap diagnostic and existing pinned keys, then uses the same
automatic selection owner. Success removes the file. Failure preserves the file,
credentials, local cache/drafts and uncertain command IDs and cannot fail startup.
The bounded startup attempt is serialized before ordinary automatic recovery;
no file polling or competing automatic selector is created. Locator contents,
URLs and credential values never enter errors, logs or public artifacts.

An authenticated working HTTP route of the current paired Mac remains selected
while its WebSocket reconnects. It is labelled as realtime recovery, not a live
write connection. Selection does not wait ten seconds for a socket or roll back
a readable route solely because its socket is delayed. Automatic recovery first
retains or proves that current route; only actual HTTP failure scans alternatives.
Recent sealed peer responses renew a network-only proof so socket retry events
do not add probes or repeatedly abort useful HTTP reads. This proof does not
renew native state, authenticate another Mac or grant native write admission.
Different-peer/account transitions still cancel obsolete read/probe contexts.
