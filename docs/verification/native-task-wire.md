# Claude task wire integration

Source verification, 2026-11-14. Native installation is not established by these
tests. Contract: [native task wire](../../spec/codelync-native-tasks.md).

## Implemented

- One parent scope per selected task envelope;128 task/dispatch limits and no
  resident log, output or private projection state.
- Directory descriptors omit task envelopes while retaining aggregate attention.
  Full selected descriptors retain them. Mobile directory merges preserve only
  the same current source, owner and query; explicit removal is authoritative.
- SDK tasks have no conversation source. Proven dispatch children retain their
  own host, collection and owner. Missing child transcript support is explicit.
- Task metadata and12-row lifecycle log reads require current source/lease/query
  before and after I/O. The actual bound-source wrapper forwards these APIs;
  foreign app/session/main/host changes cannot borrow them.
- Parent attention includes tasks and dispatch activity without changing its own
  turn/status. Paused tasks do not imply a native permission or input request.
- Metadata changes can notify subscribers independently of conversation text.
  Read-only logs have no mutation journal or automatic operation replay.

## Checks

The shared connector/catalog/task batch passed81 tests. The initial Claude
backend/projector/owner/existing-renderer batch passed35 tests. Bound wrapper and
saved-history checks passed9 tests. A combined129-test run passed before the
latest additional backend concurrency regressions. Mobile task/subagent/merge
checks passed80 tests across11 suites. Owning checks and full
`pnpm typecheck:all`, `pnpm lint`, and diff validation passed; after any further
source changes these gates must be repeated on the final frozen sources. After
the owner/history provenance fixes, the current combined147-test source run,
`pnpm typecheck:all`, and `pnpm lint` passed. An independent61-test/4-derived-case
audit confirmed the old foreground map, missing background status and disappearing
child regressions are resolved. The mobile log-label/truncation follow-up passed
25 targeted tests and mobile typecheck.

The128-task synthetic fixture's compact JSON is below55% of its repeated-scope
JSON size. This is a fixture budget, not a live network benchmark. Unchanged
plaintext already avoids transport version/nonce replacement. A changed selected
task envelope still uses the existing bounded state update; task-specific delta
size and live encrypted cost remain optimization/acceptance work.

## Open native gates

Original Claude bridge is deactivated during duplicate-input diagnosis. The
bounded manual observers were removed after their windows ended. A later actual
human test from an initially empty prompt produced two ASCII `a` characters and
two copies of one Han character; duplication still exists after exact factory
cleanup and trusted renderer reload. Only counts/hashes were read. Automatic
keyboard/model input remained zero, and the user's draft was not edited. Internal
editor-document versus DOM/event diagnosis is the next gate; source tests do not
prove input recovery.

The copied/original task feed must prove exact native foreground/background and
dispatch ownership, capture freshness, read-only paging and terminal readback.
Task output/stop capabilities remain disabled. LAM dispatch metadata does not
establish a Chat/Cowork/dispatch transcript controller; mode guards remain strict.

The physical iPhone still has1.8.0/2026111401 and the previous production peer.
The new task UI and new producer have not been installed or accepted on it.
Simulator/native UI, producer recovery and original Desktop controls remain
required integration gates. All CLI/TUI families remain user-deferred.
The previously copied Claude process and its debugger runtime manifest are now
absent. The QA HTTP service remains live, which does not prove a Claude source is
connected. Re-attest a safely restored copied owner before native feed acceptance;
do not borrow the old PID/runtime or install the new artifact into stock yet.

Global project/session activity also needs native header-level task coverage for
parents without a selected observer. Selected task aggregation alone cannot
prove that every inactive catalog parent has no background tasks; status reads
must obtain lightweight native level/header evidence rather than open histories.
