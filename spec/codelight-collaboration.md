# CodeLight cross-application handoff

Status: implementation, 2026-11-13.

The message action **Send to…** prepares selected assistant text as context in an
existing conversation owned by the other supported desktop application. It does
not send a model request. The user reviews the destination composer and submits
through the normal source-bound CodeLight send/admission/receipt path.

## Scope

- The selected sender must be a connected Codex or Antigravity native session
  with established protocol, namespace and current owner generation.
- A destination is an existing verified native catalog binding on the same Mac,
  owned by the other application and neither archived nor catalog-unavailable.
  Its observer may be idle or disconnected: selecting it appends only a local
  draft. Actual Send still requires fresh destination owner/admission checks.
- The source and destination must belong to the same CodeLight Mac machine.
  Historical harness/window records, unavailable catalogs and disconnected Macs
  are excluded. Equal paths or native conversation IDs never identify a target.
- Only non-thinking assistant messages carrying an original `nativeRow` identity
  are eligible. The selected text is a snapshot; later native edits do not silently
  replace it while the target picker is open.
- Recent snapshots and native text replacements retain the original row ID in
  display metadata. Their complete text starts at offset zero, with the matching
  projection revision; this is not a claim of a vendor-native revision counter.

## Draft ownership

At target selection, recheck the sender owner/provenance and exact destination
catalog identity. Do not require a destination observer to stay attached merely
to preserve a device-local draft.
Append the handoff to the destination's latest device-local draft, preserving its
existing text verbatim. Do not clear or alter the source draft, start an agent,
change a model, or send a native mutation as a side effect. Repeating the same
selection does not append an identical handoff block twice.

External draft staging becomes the local composer's baseline, including when
the destination already has nonempty text or the singular session route reuses
its renderer. A stale debounce, focus render or unmount flush cannot overwrite
that newer staged value. Source and destination retain separate draft ownership.

Native CodeLight conversations use the compatible Rig presentation and controls,
but their drafts remain device-local. They do not adopt or write the Rig daemon's
metadata `draft`/`draftUpdatedAt` tuple. A recent response, metadata conflict or
reconnect cannot restore an older remote draft over a local handoff/continuation,
and a deliberately cleared local draft stays cleared. Native draft edits and
flush/clear actions perform no metadata-write RPC.

The quoted handoff contains the source application, machine ID, original host
namespace, original conversation ID, original row ID, revision and fragment
offset. The visible target list uses application and conversation title; protocol
identifiers are context provenance, not secondary UI labels. Text is quoted as
context for the user's next instruction and is not treated as a forwarding rule.

## Verification

Verify application/machine/namespace isolation; stale owner and missing original
message identity rejection; existing draft retention; idempotent preparation;
no model dispatch until explicit send; and native target navigation/composer
hydration. Native rendering and interaction acceptance is recorded separately
from helper and component tests.
