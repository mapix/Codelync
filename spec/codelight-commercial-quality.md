# CodeLight commercial quality contract

Status: active implementation, 2026-11-14. This user-authorized scope adds Claude Desktop Gateway to the verified desktop product. The user subsequently deferred all CLI/TUI families, including Claude CLI, Codex CLI and apy, to future extension. It does not permit replacing an existing desktop session owner.

## Completion requirements

- Full native Claude Desktop support for its Gateway profile, including available Code, local Chat and Cowork surfaces; prove original desktop/query ownership and native model/command readback. Separate cloud/remote identities where present.
- Claude Desktop is Gateway-only for this task. Claude CLI also uses Gateway but
  is user-deferred. Reuse the native applied third-party Gateway configuration.
  Official Claude OAuth/account or `claude.ai/code` Remote Control is not an
  inference/control dependency or fallback. Static vendor UI/assets and CodeLight's
  own network channels are distinct from those official model/control routes.
- Codex, Claude Desktop and Antigravity original sessions, projects/common Git worktrees, archive exclusions, subagent variants, parent links, status, tools/logs, supported native approvals and controls.
- Connection recovery across channel changes, background/foreground, native owner restart, cancellation, stale responses and lost acknowledgments. Unknown mutations retain their IDs and are never replayed automatically.
- Incremental directories and selected-message/event synchronization. Catalog/status reads must not load complete conversations or activate every child.
- Newest complete message first, measured viewport fill, older history only on gestures, stable scroll anchors and bounded read/subscriber/cache lifetimes.
- Clear native state, errors/retry, source grouping, readonly children, drafts, handoff, source-specific models/slash commands, touch targets, accessibility, long content and light/dark mobile states.
- CLI/TUI assessment and implementation are user-deferred. Preserve bounded
  research and native proof for future use; do not activate sources, bundle new
  terminal dependencies, advertise them or make them a completion gate.
- At least31 substantive iteration cycles, each with a problem, concrete capability/behavior improvement, verification and remaining limits. Planned items, repeated unchanged tests and screenshots alone do not count as completed cycles.
- Client/native interaction acceptance uses iPhone simulator. The user subsequently requested a connected physical iPhone trial; preserve its pairing, credentials and draft through in-place updates. Installed artifact identity is separate from acceptance of a new producer or original Desktop control.

## Evidence matrix

| Area | Required evidence |
| --- | --- |
| Each native app/mode/profile | Native app version, storage/profile namespace, process/bridge epoch, real selected session identity and original-owner readback |
| Gateway | Existing native Gateway config honored, request and execution/model readback under that profile, no replacement runner |
| Catalog | Same-snapshot ordinary/child/archive/project membership; complete scans only remove membership |
| Subagents | Explicit native membership/role/parent and complete/partial roster; lifecycle is independent of message recency and tool completion |
| Native controls | Stable command/message ID, native accepted/refused/unknown distinction, exact target, stale-owner rejection and no duplicate dispatch |
| Communication | Logical/sealed byte counts, bounded decode, v2/v3 compatibility, malformed/authenticated-frame rejection, deltas/on-demand reads |
| Recovery | Actual channel/process interruptions, recovered same-owner observation, preserved draft/history/receipt state and no replay |
| Mobile | Build/JS identity, simulator actions and observed result, source state, keyboard/draft, source/parent/child/filter/log navigation |
| CLI/TUI | User-deferred; no current source/UI/runtime activation or completion requirement |
| Final |31+ completed cycles plus capability, protocol/type/lint and integrated simulator audit; required unknowns remain open |

## Cross-source identity

Claude uses `app:claude-desktop`, `kind:session`, `protocol:claude-desktop-native`, and `adapterKey:claude-desktop`.
Its host identity is `local:claude-desktop:<sha256>` of the canonical native storage/profile namespace. The owner generation binds actual desktop process/bridge lifetime. App mode is independent metadata. Production discovery is enabled only after the native bridge is verified.

Desktop and CLI model aliases are separately authoritative. The current applied
native3p configuration is under the genuine `Claude-3p` profile/configLibrary;
CLI environment is not a substitute for that native model catalog. Provider URLs,
credentials and raw applied profiles remain private.

Deferred research selected `app:terminal`, `kind:terminal`, `protocol:tmux-control`,
`adapterKey:tui`. It is not activated in the current desktop-only product.
Preserved terminal-server receipts are not native model admission.

Unknown native control IDs are preserved across all sources. Models/effort/settings require original-owner confirmation. Existing paired/sealed transport provides CodeLight access security; this is not a new authentication project.

## Protocol quality invariants

1. A catalog scan cannot commit removals until a valid terminal page; no repeated/contradictory cursor or post-terminal page is accepted.
2. Every catalog row and cursor is scoped to the authenticated machine/snapshot. Empty directory scope changes cannot silently reuse a foreign scope watermark.
3. Snapshot/message/version clocks remain independent of directory membership and current control state.
4. All incoming history/events recheck selected source, owner epoch and read generation. Exiting a session releases read intent and preserves materialized authenticated history/drafts.
5. Missing/stale/partial counts show uncertainty. Histories are not opened to manufacture activity counts.
6. Compact encrypted packets remain lossless and bounded. Optimization cannot discard unknown fields or bypass native authentication/identity checks.
7. Publishing chunks may yield UI time, but partially loaded scans are not complete directory authority.
8. Catalog retention uses recent access, not creation order. Frequently used
   unchanged watermarks and active pagination stay cached within the bounded
   snapshot count. Retention timestamps are separate from the immutable snapshot
   capture time returned across its pages.
9. A verified original Desktop saved-history view is separate from a live child
   controller. It has null control owner/current turn, explicit data provenance,
   read-only metadata and no command/admission reconciliation or native requests.
   Historical display grouping may use a display-only turn ID; it never enables
   sending, stopping, model selection or approval responses.
   Async historical reads also bind their namespace/source stamp before and after
   the read. A newer saved-data projection or live-owner transition invalidates a
   captured older page instead of publishing it under the new metadata.
   The client also validates historical response/descriptor provenance and current
   data stamp after network/key initialization. A captured historical response
   cannot overwrite a newer live-owner descriptor, and its rows never carry a
   current controller generation.
   History GET routes accept an absent/empty body and only validated query
   parameters; recent POST routes validate their JSON body separately. Query
   limits normalize before calling native readers that require integers.
   A verified child with an actually observed terminal native lifecycle and no
   confirmed live owner may use saved data before slow owner discovery. Unknown,
   incomplete or nonterminal tails cannot establish that fast path.

## Measurement and acceptance

Directory completeness and selected-session readability are separate gates.
A failed application inventory cannot authorize directory removal or a complete
catalog response. It also cannot block a read from another verified existing
native source. Selected recent/older reads require the live CodeLight service,
its source lease and the selected source's own identity/owner checks; catalog
reads retain their stronger inventory-completeness requirement.

Native input admission checks the same source owner before each observed row,
after awaited snapshots and immediately before accepting that observation. A
matching message ID from a replacement owner cannot confirm an old command.
Reconciliation rejects explicit view-owner/record-owner disagreement. Uncertain
native effects retain the original ID and remain unknown without another send.

Record logical/sealed bytes, samples, decode/read/render phases, data scale and cold/warm state. The prior full284 directory~78KB/~0.36s decode is a baseline, not a future guarantee.

Opt-in diagnostics may record validation, Base64, native authentication, inflate,
checksum, UTF-8 and JSON timings. These callbacks contain only phase/duration,
add no wire fields and preserve decoding and authentication behavior. A failed
diagnostic callback cannot change an accepted payload or authentication failure.
Production decoding has no timing callback. Native simulator measurements must
identify the phase before replacing its implementation.

The measured native decode baseline attributes135.8ms to UTF-8 and45.9ms to
CRC for a488,031-byte response. Optimize these byte operations independently of
encryption: native clients may use an indexed UTF-8 fast path for valid input,
with standard TextDecoder semantics for malformed sequences/BOM, and indexed
CRC32. Node/web keep their native TextDecoder by default. Check exact Unicode,
offset/chunk boundaries, malformed input and authenticated-frame tamper gates;
confirm per-phase improvement in the simulator before declaring the round done.

Large iOS peer payloads may use a bounded asynchronous Foundation/zlib decoder
after existing MAC/peer/frame validation. Inputs contain only the exact body
view, expected length and compression flag, never keys or authorization. Native
busy retry is data-only, at most two retries, with context checks before/after
work and delays. Only malformed UTF-8 may use the portable post-MAC compatibility
path; authentication, gzip, CRC, length and unrelated failures remain final.
Missing native modules keep the existing portable decoder. Native module timing
and UI responsiveness require simulator evidence after registration/build.

Targets are interactive first results, bounded page/decode/parse work, no long main-thread stall on scroll/input, no repeated full unchanged scans, and prompt recovery. Set concrete budgets from fresh simulator measurements; retain actual latency limits instead of inventing a pass.

## Working boundaries

Root owns shared wire/source/discovery/protocol state and integrated runtime/builds.
Claude lane owns Claude native backend/bridge/probes.
Mobile lane owns mobile components/owned helpers and exclusive simulator operation.
CLI/TUI lane is stopped and cleans up only its owned isolated probes. Research
sources remain deferred. Shared source/package/UI edits are coordinated.
Private data/builds/probes remain under dedicated private QA folders and outside Git. Original apps, histories, keys and unrelated local edits are preserved.

