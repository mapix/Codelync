# Desktop source subscriptions

## Contract — 2026-11-16

The Mac offers Codex, Antigravity Desktop and Claude Desktop (Gateway) as three
independent source choices, enabled by default. Choices belong to the Codelync
profile and survive service/app restart. An explicit empty selection is valid.
Standalone CLI/TUI, other harnesses and window research remain deferred.

Turning a source off stops its Codelync discovery, status/message observation
and current native controls. It does not quit, restart, interrupt, navigate or
change the original desktop app or its sessions. Pairing, network channels,
native manifests, encrypted history, pending data and original command receipts
remain separate from these choices.

## Preference ownership

One private version-1 file stores only `enabledApps`, using the exact IDs
`codex`, `antigravity`, `claude-desktop` in stable order. A missing file uses all
three defaults without treating an unreadable file as missing. Invalid JSON,
unknown/duplicate IDs, extra fields and unreadable files fail closed. The Mac
shows the failed configuration and offers a safe reload. Restoring all defaults
is an explicit user action; no error path silently enables sources or rewrites
the original file.

Changes are serialized and made durable before the synchronous source gate
changes. A failed save retains the last verified gate and choices. A saved
choice whose reconciliation is still pending retains that saved choice and
reports a retryable switching failure. Source results have their own request ID,
busy/error state and local UI messages; they cannot overwrite connection-channel
state, Relay drafts or pairing.

## Observation and asynchronous boundaries

Discovery schedules only enabled native providers and rejects use of a disabled
provider even when given an old descriptor. Disabled providers do not supply
empty-index, archive, idle or removal evidence. Current inventory authority is
reported independently for indices actually read.

The daemon uses the same synchronous source gate for restored registrations,
preparation, native actor leases, starts and navigation. A monotonic preference
revision fences asynchronous scans/preparation across a disable/enable cycle.
Old results cannot reinsert a disabled source or revive an actor. A registration
already sent before the fence may finish, but is retained as locally disabled
and never admitted to the active catalog or observation map.

On disable, the active catalog and prepared HTTP catalog are filtered
immediately; the independent activity service closes its matching observers.
Only Codelync actors/providers are then closed. Local disabled metadata hides
the corresponding live directory descriptor and disables its current mutation
capabilities while preserving original archive/history/owner evidence.
The local disabled marker retains the previously registered catalog visibility.
Clearing that marker restores only cached descriptor visibility; current native
status/control still require their normal original-owner proof.
Only live/previously masked control descriptors need individual metadata updates.
Unviewed bindings retain their existing data; the prepared directory emits one
bounded removal delta instead of rewriting every historical descriptor.

Active-observation hints for disabled apps are removed, while their binding,
checkpoint, inbox/outbox and receipt files are retained. Re-enable recreates
only Codelync-owned provider objects, freshly discovers the native sources and
resumes bounded status observation. It does not automatically restore a full
message actor, desktop-open request or old native command merely because a
source choice was enabled. Actual selected reads remain lazy and recheck the
current enabled source and original owner.

Original backend instances are not revived after `dispose()`. Default provider
factories create new adapters on re-enable; injected providers used for isolated
testing may supply explicit recreation factories. No factory starts an original
app or model runner. Shared native IPC is disposed only by its Codelync owner.

The existing three-app `codelync.sourceApps` declaration remains the product's
support range; choosing an app off is not a change to product support. A known
empty selection keeps networking, pairing and receipt storage available, with a
known empty current directory. Old source/session status cannot borrow earlier
active or idle proof.

## Mac UI and integration

A compact Sources section has one checkbox per desktop app. Stable accessibility
IDs identify each choice. Loading, failed configuration, save failure and retry
use the section's own state. Native unknown configuration is not presented as a
confirmed all-off choice. Source choices use the existing local Mac UI pipe;
they do not create a second phone command admission or authentication path.

The service loads the preferences before constructing native providers. Local
set/reload handlers publish the effective saved choices, synchronously refresh
the prepared catalog and apply source reconciliation. The original app version,
Gateway configuration and current native session capabilities retain their
existing ownership and verification gates.

## Verification

- Missing defaults, explicit empty/subset persistence, stable ordering and
  private file permissions; invalid reads retain the exact original bytes.
- Failed persistence cannot change the effective source gate. Concurrent
  set/reload operations cannot apply an older result over a newer choice.
- Disabled providers perform no native index/history/model/window reads.
  Re-enable recreates only Codelync adapters and obtains fresh state.
- Held scan/registration/preparation/start work is fenced on disable and across
  a disable/enable cycle; disabled active hints cannot be recreated.
- Disabled metadata and prepared directory invalidation preserve original
  archive/history/pending data and unknown command IDs. No native write,
  desktop navigation or original app restart is replayed.
- Native checkbox/persistence/error/retry acceptance uses an isolated Codelync
  profile with native-shaped providers. It is separate from code/type/unit
  verification and never uses the running migration as a mutation test.
