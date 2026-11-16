# Recent-first catalog and session entry

## Registered catalog authority — 2026-11-16

The paired Mac's peer catalog is its registered source-to-relay descriptor map,
not proof that every original Desktop index is currently available. After the
daemon holds its profile lease, has established its machine connection, and
has loaded the current account/machine's saved native bindings, expose a separate
`registrationAvailable` authority. Startup before that loading completes, a
missing registration reader or invalid result, closed service or lost lease
remains unavailable. A successfully read empty account-bound map is valid.

An unavailable Claude Desktop or other native index must not return a global
503 for an already registered, eligible Antigravity/Codex catalog entry. Restore
only saved native bindings for the same machine/account and existing source
filter; archived or previously unavailable bindings are not revived. Keep native
`inventoryAvailable`, per-app status and removal guards separate. Failed native
discovery neither removes sources nor establishes idle/zero/connected state.
Catalog reads still do not start observers, read histories or change native
sessions. A selected read uses its existing independent owned-lease gate and
confirms the exact current source through the normal observer preparation path.

## Rules and owners

The original Codex owner is the authority for runtime status and latest public
messages. The Mac's index supplies lightweight directory identity/recency; the
phone owns the selected viewport and history cursor. Recency uses native update
time, not the CodeLight mirror's provisioning/update timestamp. Active state is
never inferred from message recency. A source with older public content may be
active, and an unavailable fresh view must not be called idle.

Directory data is ordered most recent first. Records whose native update is
older than 72 hours default to title and basic identity/project/time fields,
without last-message bodies, heavy agent state or message prefetch. Rich data
loads only when the user opens that session. Newer sessions are published first;
older basic entries can arrive later without blocking the first list.
Pinned markers are preserved, but recency is the primary directory order and
pins break equal-recency ties. A root family ranks by its own and descendant
native recency, without changing its parent's actual update time or ancestry.
Explicit subagents with a uniquely proven same-source native parent follow that
parent's directory project across worktrees for display only. Their original
worktree/native project facts remain intact. Ordinary forks stay in their own
native projects; child-only buckets do not create zero-conversation project
headings. Search can still find an explicit orphan without a project heading.
This catalog projection does not read messages, initialize keys or infer status.

Entering a session starts the existing observation and fetches a fresh latest
window after it is ready. A speculative/cached page cannot satisfy that fresh
entry. The initial viewport opens at the newest part; prior scroll restoration
must not reopen an old position. Runtime status and freshness are displayed
independently from the age of the last public message.
For authenticated peers, the combined recent API owns observation preparation.
Mobile peer entry must begin this authenticated HTTP read without waiting for a
separate durable machine observation RPC or its pending receipt. Desktop
navigation remains independent. Old unknown observation commands retain their
identity and are not replayed to unblock message reads. Non-peer legacy entry
keeps its existing observation prerequisite.
An explicit desktop navigation runs independently; a lost navigation RPC cannot
prevent that authoritative recent read or keep the message viewport loading.
The message synchronization banner follows the current message read. A completed
fresh read with a connected original source clears it even if desktop navigation
is still pending or failed. A navigation receipt cannot turn that successful
read into a synchronization error. Retry after a message read failure requests
fresh messages and does not repeat desktop navigation or an unknown operation.

Recent message responses must be self-contained enough to render current text,
tools and revisions, even when prior protocol fragments are outside the window.
Streaming text fragments carry the original native row identity, prefix offset
and correction revision. The phone joins only that identity, retains gaps until
the missing prefix or a fresh full row arrives, and never renders each suffix as
an independent message. Full recent rows, corrections and older wire fragments
share one canonical display row through their explicit identity/alias mappings.
A provisional source/API alias may be consumed by one confirmed native UUID.
Once retired, that alias cannot make a different native UUID overwrite or
retire the confirmed row. Full native UUIDs keep independent canonical payloads;
tool-only assistant envelopes seed each native tool ID independently and do not
claim text aliases. A legitimate empty correction to the same UUID still applies.
An authoritative full seed may repair a missing, empty or foreign-identity
canonical payload at the same owner/snapshot watermark when its stream revision
is not behind. A strictly newer snapshot watermark or stream revision still
rejects that older payload, and explicitly retired native identities stay retired.
A provisional native user row is replaced by the confirmed original row through
its client command identity; identical text from different native rows is retained.
An admitted phone input's full recent row also carries its original broker/local
aliases. It joins the existing optimistic/echo row even before the POST ACK,
keeps that input's actual timestamp, and confirms its pending display only when
the original connector has recorded input admission.
Existing fragment-only checkpoints publish one identity-based full replacement
when next observed, even if the original text has not changed, so an already
paired legacy phone can repair its visible messages without deleting history.
Historical data remains available on the original owner/Mac; only explicit
upward scrolling advances the earlier-history cursor. Background/list/hover
work cannot walk older pages. Concurrent entry requests coalesce; a superseded
selection cannot overwrite the newest selected viewport.

Temporary loss of the current control owner is not a cache invalidation. For
the same authenticated peer, relay/native conversation, application, host,
protocol and collection, the reading window retains its last confirmed content
owner while the live owner is null. Expanded tool groups, visible reply and
scroll/Latest anchors remain readable without another network history request.
This retained owner is reading state only and is never copied into live session
metadata. Input, approval and other native setters remain disabled while the
current source is unavailable. A positive different owner or a peer/native
identity change resets the reading window and group state; old scope is not
borrowed to enable the replacement's controls.
Cached approval and message-option callbacks also recheck their captured native
source, owner and turn against live metadata before dispatch; a positive
replacement cannot repurpose an old callback.
Native phone entry requests the latest single complete row first. Measured list
height may extend that tail only until the first viewport is covered, without
walking a collapsed group whose extra rows make no visible progress. Thereafter
only an upward history gesture or explicit Retry/Load more extends the window.
Native rendering does not extend to a complete turn merely to fill a row budget.
The two native observers retain at most 100 rows for incremental publication.
Their first attachment and newly discovered historical rows prime local delta
baselines without broadcasting old message bodies. The authoritative recent or
history read delivers only the requested page; subsequent live changes still
publish native identity-based deltas. Existing inbox, history and command
receipts remain intact.
Command admission evidence and current question/request mapping still use the
full native view, and existing historical records remain intact. Loading a
complete native view on an explicit history gesture must not broadcast every
new older row to the phone; the history response remains a bounded page.
After the measured first viewport is covered, list layout/content-size events
cannot request older pages. The reader must scroll toward older content (or
explicitly retry/load more).
For Codex, an earlier-page cursor that is still present in the confirmed current
native window uses its already loaded preceding rows first. An incomplete native
history flag alone cannot trigger a complete-history request on every scroll.
Only reaching the loaded start may request the original owner's earlier history.
A foreign or missing row boundary is rejected before any complete-history request. Session/owner/lease
checks still apply, live controls remain independent, and the returned page stays
bounded. Unknown completeness never becomes an invented end-of-history.
New Codex row cursors include their confirmed original-owner generation and
reject a changed owner before loading earlier data. Existing session-scoped
legacy cursors remain readable under the current owner's row validation.

MAC activation/latest-window and catalog/status work should use combined or
parallel requests where the owners allow it. Avoid sequential per-session
descriptor/key/history calls for the entire catalog. Message updates must not
sort/decrypt the whole directory. Channel changes retain the same peer/session
cache and recover latest data without starting another runtime.

## Authenticated peer read interface

The Mac peer box seals the authenticated HTTP response. `/api/peer/catalog`
returns plaintext lightweight descriptors within that sealed response, ordered
by native `source.updatedAt`. The first page defaults to 200 records; subsequent
pages may request 1000, with a hard cap of 2000. The cursor binds its recency/id
boundary and excludes newly moved entries from earlier pages. Entries older
than 72 hours omit preview, last-message, heavy state and session keys. Directory
reads do not activate observers.

`POST /api/peer/sessions/:id/recent` coalesces existing observer activation and a
genuinely fresh original-owner snapshot. It returns the selected full descriptor,
its existing session key and checkpoint field versions, self-contained public
rows, real revision/owner/status, observation time, transport sequence watermark,
and an opaque earlier-row cursor. `/history` uses that session-bound cursor only
after explicit upward scroll and does not start a second runtime. Text rows
carry connector-known fragment identities so a full recent row replaces its
prior fragments rather than duplicating them; tool rows contain both call and
current result/status seeds. Unknown native timestamps remain unknown, separate
from observation time.

Peer credentials and endpoint fencing own channel changes. Phone loading captures
the credential owner and selected session before requests; results from a replaced
peer/account/selection cannot publish. Touch preload does not substitute stale
mirror history for the fresh selected-session request. Legacy non-peer CodeLight
visits still await observation before their bounded latest page.
Descriptor field versions are monotonic: late responses cannot replace newer
metadata or agent state. Basic directory records update index labels without
erasing already-opened rich cache; live actors may include their small current
capability flags, while heavy controls/state/history remain omitted. A response
from an older known native owner cannot replace the viewport after a newer owner
has been published. Local draft changes during key initialization remain local.

Recent seed versions are owned by the CodeLight projection and advance when the
original content stamp changes, including silent snapshots at the same native
revision. They are separate from stream correction counters. A seed records the
stream counter it includes; it cannot replace a later stream correction, and a
large seed version cannot suppress the next lower-numbered stream correction.
Full tool seeds are guarded native upserts, not ordinary tool-start/end replay.
They can create a missing call/result without earlier wire fragments, but an old
running seed cannot reopen a genuinely completed approved tool. Approval-only
placeholders retain their existing transition when the actual tool appears.
Native item `startedAtMs`/`completedAtMs` and the owner's per-item timestamp maps
take precedence over a long turn's start time. Equal native timestamps use
original row order for stable positioning without changing displayed message
time or inventing message activity from observation time.

```mermaid
sequenceDiagram
    participant User
    participant Phone as Phone viewport/history owner
    participant Mac as Index/observation owner
    participant Codex as Original native owner
    User->>Phone: Open session
    Phone->>Mac: Select + request fresh recent window
    Mac->>Codex: Existing observation/fresh tail
    Codex-->>Mac: Current public rows and native status
    Mac-->>Phone: Self-contained recent data + history cursor
    Phone->>Phone: Newest viewport; no old-page prefetch
    User->>Phone: Explicit upward history scroll
    Phone->>Mac: Earlier page using owned cursor
    Mac-->>Phone: Prepend earlier data
```

## Acceptance

Cover a large mixed-age catalog, native vs mirror update timestamps, only basic
old entries, active source with stale cache, activation before fresh entry,
preload/focus races, recent patch/tool dependencies, old cursor only on scroll,
superseded selections and route changes retaining identity. Measure request
counts/RTTs, bytes and time to first recent display; don't substitute fixture
timing for physical-phone acceptance.
