# CodeLight project browser performance and hierarchy safety

## Native peer catalog deltas — 2026-11-13

New phones request `catalogVersion=2` on `/api/peer/catalog`. The Mac returns an
opaque source/version watermark, `mode: full|delta`, changed descriptors and
explicit `removedIds`. A known prior watermark sends only changed source/index
versions. An unchanged catalog returns no rows; the phone neither rehydrates nor
rewrites unchanged descriptors. Runtime status synchronization remains separate.

Each paginated response is a materialized metadata-only snapshot. Its cursor
continues that same snapshot even when source metadata changes during the scan.
The watermark advances only after all pages are validated and cached. Missing,
expired or another service epoch's watermarks reset to a full catalog; stale
pagination restarts a full scan. A changed peer/account cancels late results.

Removals and archives hide only catalog entries. Phone history, drafts, session
keys and unknown command receipts are retained. Full scans reconcile cached IDs
that are no longer visible. The Mac does not read conversation bodies to compute
deltas. Old phones keep the version-1 full catalog response; new phones can fall
back to that response when an older Mac rejects the new query contract.

## Existing API and state ownership

`buildCodeLightBrowserRows(sessions, query, projects, parents)` remains a pure
projection of the session catalog. The catalog owns session identity and parent
facts; this projection does not navigate, read history, update sessions or infer
runtime activity. The existing project/session row fields remain unchanged.

## Native desktop viewer boundary — 2026-11-13

The user-authorized Antigravity integration extends this viewer to Codex and
Antigravity native conversations; see [remote control integration](antigravity-remote-control.md).
`isCodeLightNativeSession(session)` is the catalog and total predicate. Codex
retains the legacy mode compatibility below. Antigravity requires explicit
`source.kind: 'session'`, `source.protocol: 'antigravity-connect'`,
`controlMode: 'session'` and a nonempty verified `runtimeGeneration`.
Antigravity `hostId` has the verified runtime namespace
`local:antigravity:<64-hex digest>`; equal conversation UUIDs from separate copied
apps or data directories remain separate. An unscoped local host ID is rejected.
Historical Antigravity window/CLI records and every other harness remain excluded.

The project heading, selected-chat header and native conversation selector identify the source app.
Equal paths and native IDs across apps, hosts or machines remain separate, both
in the browser and in the session selector. A selection starts observation of
that exact source; it does not launch either desktop or a model runner. Drafts
remain keyed by their relay session identity.

An unavailable native session displays an unconfirmed status. Its default
`activeAt: 0` is not a last-seen timestamp and must not render as January 1970.

The retained generic worktree `+` creates CLI-backed sessions. CodeLight native
sources do not expose this operation; creating a native conversation requires a
separately verified owner capability. Repeatedly selecting the current session
does not dispatch, navigate or clear its draft.

Foreground project activity requests include the source app. Old requests with
no app mean Codex only. Unavailable Antigravity activity must display unknown or
unavailable; the phone must not fill unobserved counters with zero.

`isCodeLightCodexSession(session)` remains the Codex-only compatibility predicate.
Only records whose `metadata.bridge.source.app` is `codex` are candidates.
`controlMode: 'session'` and legacy records with no `controlMode` are accepted;
explicit window mode or an unknown mode is excluded. Missing/unverified source
identity and other harness records are excluded even when their flavor/title
mentions Codex. A Codex conversation in a project named ZCode remains visible.

The browser applies this predicate before search or grouping; the phone total
uses the same predicate. Cached/database records are retained and metadata is
never changed by the predicate. Owner availability and activity are separate
facts: a verified Codex session may remain in the catalog while offline.

`codeLightProjectKey(session)` exposes the original complete project-row key:
`project:${JSON.stringify([machineId, source.hostId, source.app])}:${projectKey || path || '/'}`.
It is shared with project status consumers. Native project identity continues to
fold the main checkout, worktrees and nested directories together; equal paths
on different machines, hosts or source apps remain isolated.
An explicit subagent may have a distinct native worktree project. Its browser
display project follows a uniquely proven native parent in the same machine,
application, host, protocol and collection namespace. Parent chains terminate
at the ordinary conversation's display project. This does not overwrite the
child's native project, cwd or parent facts. Visible-row activity interests use
the display project; project descriptors and totals still use ordinary native
conversations only.

## Projection rules

- A project is ordered by the greatest original native recency among its matched
  sessions. Compute this maximum during grouping, without spreading a whole
  group into `Math.max` or rescanning members in the project comparator.
- Cache the original recency and visible/search title per matched session during
  one projection. Build hierarchy indices only for expanded projects or search
  results; a folded project does not build or sort its child lists.
- Ordinary forks retain their native project and existing within-project parent
  hierarchy. Only `isSubagent === true` permits the proven cross-project parent
  display projection. A globally duplicated native parent in the same source
  namespace cannot establish that cross-project link; foreign namespaces cannot
  steal it. Project heading path/label come from the resolved parent project,
  even when a newer child is the first catalog entry.
- Ordinary roots keep the existing pinned-first, recency-descending order.
  Children keep the existing recency-descending order. Stable input order breaks
  ties; the source catalog is not mutated by sorting.
- Hierarchy traversal uses an explicit stack, so a deep but valid parent chain
  cannot overflow the JavaScript call stack.
- If malformed parent facts form a cycle, sever one display edge at the smallest
  stable relay ID in that cycle. This creates a deterministic visible root while
  preserving every session and normal fold behavior. Self-parent facts become a
  root. The underlying parent facts remain unchanged.
- Search exposes matching child sessions even when project/parent folds are
  closed, with the same search fields and case normalization as before.

## Regression evidence

Targeted tests cover normal ordering and folds, canonical cross-worktree parents,
machine/host/source isolation, repeated native IDs in different projects,
ambiguous/missing native identities, self/cyclic parents, a deep chain and a
minimal large folded catalog exceeding normal JavaScript argument limits.
They also cover foreign/window/missing-source caches, the legacy Codex mode
fallback and retention of the input records.

Synthetic work-count assertions verify that recency is read once per matched
session instead of once per sort comparison. They establish algorithm behavior,
not physical-phone frame rate, battery consumption or temperature.
# Native subagent display boundary

`nativeSession.isSubagent === true` is explicit original membership evidence.
These entries stay under their native parent and in the subagent panel. Ordinary
conversation totals, project conversation counts and the session picker exclude
them; an opened child retains its selected label and parent context. Names or
message recency never infer this flag. The native child remains in the catalog
for exact navigation, logs and its own verified controls.
Buckets containing no ordinary conversations do not emit standalone project
headings or zero project activity counters. Explicit orphan children remain in
the catalog and are discoverable by search without a fabricated project header.
Matching child-only search results likewise retain their exact session identity.

## Directory authority and asynchronous native metadata

An authenticated catalog assertion owns native directory membership and header
classification independently of a selected conversation's metadata version.
A newer stream/observer metadata frame cannot restore a removed entry or change
its ordinary/agent classification, native parent or repository grouping. These
frames still update current owner, capabilities, requests and message state.
Only a later explicit catalog upsert can restore membership or replace the header.
The local assertion is bound to machine, application, host and native identity;
it never transfers to another source reusing a relay identifier. Cached catalog
headers recreate this device-local assertion after loading their pinned scope.
No extra assertion field is sent over the protocol. Removal continues to retain
drafts, histories, keys and unknown operation receipts.
