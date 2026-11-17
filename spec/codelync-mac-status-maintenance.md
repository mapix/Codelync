# Mac-owned status maintenance

The Mac maintains source descriptors and a bounded native activity replica while
the phone is disconnected. This service owns status observation only. Original
desktops remain the session owners; it starts no runner, selects no conversation,
changes no model/effort and loads no complete history.

## Independent lifetimes

- The existing daemon discovery scan runs independently of phone requests.
  Registered descriptors remain distinct from per-app native inventory and
  removal authority.
- `NativeProjectActivityService.intrinsicRefresh()` reconciles the Mac's status
  interests immediately and queues native work without awaiting it. The daemon
  invokes it after discovery. A separate five-second maintenance timer sustains
  this replica without renewing any phone interest lease.
- Phone polls keep their ordering, release tombstones and immediate v1 response.
  They consume the same replica and share observers with the Mac. An expired or
  released phone interest does not release the Mac's admitted status observers.
- Status maintenance never creates a message actor or calls selected
  `readRecent`, `snapshot`, complete-history or native control operations.

## Admission and authority

The default Mac background budget is sixteen ordinary native sessions, within
the existing total budget of 128 observers and four simultaneous native reads.
Explicit subagents remain outside ordinary project totals and the background
directory pool; the parent's verified aggregate retains their activity.

Exact visible phone rows receive priority. Each eligible app receives at least
one slot when the budget permits. Remaining foreground project members and
background candidates use the shared budget. Background candidates are ranked
by native directory recency with a deterministic identity tie-break. Recency
chooses observation targets; it never determines active, waiting or idle status.
Excess membership remains unknown, including members outside the observer budget.

Existing message actors, at most sixteen, also contribute Mac-owned status
interests within that total budget. Admission order is exact visible phone rows,
existing actors, minimum app coverage, foreground project members and the
sixteen background directory candidates. This keeps a visited busy actor's
status observer from being displaced by unrelated directory recency. These
interests cannot create message actors. With no phone interest, at most sixteen
actor interests plus sixteen directory interests can be observed.
An already visited explicit child can contribute an actor status interest for
retention; it still does not enter ordinary project totals or the background
directory pool.

Already admitted background observers can survive a temporary app-index failure
while their eligible registered identity remains present. No new observer starts
from a failed index. Existing public inventory guards still make incomplete
groups and rows unavailable/unknown. Removal, archive, scope replacement, loss
of the Mac lease, and service closure revoke the corresponding observation.
Native owner/generation, revision, disconnect and timestamp validation remain
the existing observers' responsibility. A lost lease reconciles immediately;
timer and late native completions cannot restore authority.
An ahead-of-expiry refresh deadline is requested once per native capture value.
If a refresh returns the same capture time, it does not create a zero-delay
retry loop. Unknown recovery remains bounded by maintenance/phone events.

Antigravity observers reuse the shared resident summary replica where its current
owner proof permits it. Codex activity subscriptions receive the original owner's
currently loaded native snapshot before reducing it to bounded status data.
This is not a header-only wire protocol: measure initial native snapshot bytes
and retained replica bytes separately. No complete-history request is allowed.
Where the source backend already exposes an IPC for the same host, activity
observers borrow it and release only their own subscriptions. They never dispose
an IPC owned by a message/backend consumer. The current public subscribe API can
still request an additional loaded snapshot for the same native ID; borrowing
the IPC does not imply a zero-byte initial read.

## Selected message actors

An actor created by an actual selected read/control admission may remain warm
for five minutes after its last use, within the existing maximum of sixteen.
Capacity can retire the least recently used eligible actor earlier. Actual
foreground presence, source pins, preparation/start work, pending operations,
inbox and outbox retain their existing protection. Unknown command IDs and
durable history remain unchanged and are not replayed.

After that grace, an already observed actor remains alive while its exact
same-source, current-owner status replica is known active or waiting. No native
history read is made to decide retirement. Idle or unknown actors follow the
ordinary grace and capacity policy; stale generation, inventory or lease facts
cannot borrow an old busy summary. Capacity continues to prioritize the current
user and may reclaim an otherwise eligible actor without stopping its native
session.
Within eligible unviewed/unpinned actors, capacity first reclaims an idle or
unknown source using the same guarded cached status, ordered by last use. Only
when those candidates cannot be retired does it reclaim a known busy actor by
last use. The sixteen-actor cap and current-user priority remain; all active
actors are not promised permanent retention.

The Mac does not create message actors to satisfy status interests. Fresh
selected reads still confirm the original owner and fetch their existing bounded
latest window; keeping an actor warm reduces setup work but does not remove that
freshness requirement or change selected read/control semantics.

## Verification

Use isolated native-shaped fixtures to prove maintenance before any phone poll,
continuing activity patches after phone release, per-app minimum coverage,
visible-row priority, unknown overflow, and removal/owner/lease/close fencing.
Check timer closure and late completions. Demonstrate that status-only work
starts zero message actors and zero complete-history/control calls. Measure
Codex initial loaded-snapshot JSON bytes and retained status bytes; ready steady
state must not request additional native snapshots. Verify five-minute idle
retention and earlier capacity reclamation with a controlled clock.
