# Selected task delta verification

2026-11-15. Contract: [selected task deltas](../../spec/codelync-native-task-delta.md).

## Source behavior

Ongoing state deletes restored `nativeTasks` full lists and publishes only
`nativeTaskSignal`. Directory responses omit selected task signals/lists while
retaining parent aggregate attention. Expanded current-screen consumers read
full/delta/unchanged data from an exact materialized baseline. The data scope,
coverage, counts, ordering, composite child identity and SHA256 are verified
before atomic promotion. Missing/evicted/foreign baselines return full data.

Server/mobile retention is at most8 snapshots and512KiB UTF8. Same-source reads
coalesce. Mobile hidden/collapsed/background views do not read or churn LRU;
Tasks/Subagents have independent consumer leases. Peer/query/source changes and
late targets cannot revive an old current view. A future validated target may be
retained as data only until its signal matches.

The backend capture epoch/sequence orders successful observations without
changing semantic task/history digests. Progress-only timestamps and native event
IDs stay in logs and do not trigger state notifications or history-tail reads.
Availability loss can reuse an old capture, so a late same-capture success cannot
restore it; a strictly higher capture can restore valid data. No-query dispatch
metadata remains readable independently of SDK task availability.

## Measured fixture budget

| Payload | UTF8 JSON bytes |
| --- | ---: |
|128 task full snapshot |21968 |
| Selected task signal |561 |
| One task status delta |919 |

The delta reconstructed the full target with an identical SHA256. These are
synthetic JSON byte counts, not installed-device encrypted traffic or latency.

## Verification

The final related Node source batch passed174 tests; mobile passed110 tests in14
suites. Full bridge/mobile/relay `pnpm typecheck:all`, `pnpm lint` and diff checks
passed. Independent tests covered order-only changes, flag-only coverage loss,
upsert/removal conflicts, missing or forged digests, real Unicode byte limits,
cross-collection child IDs, sealed peer identity, old/equal captures, legitimate
newer recovery and no-query dispatch behavior. Joint UI/state tests covered
current-screen foreground intent, two-panel coalescing, stale demand recovery,
directory omission versus explicit null and readonly parent cache lookup.

## Remaining native acceptance

The updated code has not been installed on the phone or the live QA producer.
The phone remains1.8.0/2026111401 on its prior production peer. The copied Claude
process/runtime manifest are absent; the live HTTP QA service alone does not
establish a connected Claude owner. Original Claude bridge remains deactivated
while input duplication is diagnosed. Original task/mode/output/stop/child,
producer recovery, native UI and encrypted payload measurements remain open.
