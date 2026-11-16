# Installed iOS native codec stress entry

## Entry and ownership

Open `codelight://dev/peer-diagnostics?codec=stress-v1` only after the coordinated
JS artifact is ready. The route's early branch runs before token storage,
connection selection, catalog/API requests or source operations. One mounted
entry starts at most one run; leaving it cancels the diagnostic. A zero-delay
start lets a StrictMode cleanup cancel an unstarted pass.

The runner creates ephemeral synthetic sender/receiver keys and fresh nonces in
memory, constructs exact V3 frames, seals them, and authenticates their intended
body using the existing crypto implementation. No real credential/profile/device
registry is loaded. It never applies a source response or sends an input/RPC/model
request. Secret arrays are cleared after the run. Payloads, packets and keys are
not logged or stored.

Only a sanitized result is placed in the private simulator's
`codelight-native-codec-stress-v1` store. It contains fixed case names, success
booleans, reason codes, elapsed stages, byte counts and numeric native admission
metrics. There are no body, ciphertext, key, text or source-content fields.

## Bounded plan

- One run, native module required, 15-second budget and cancellable waits.
- One logical case is at most 8 MiB minus the authenticated frame prefix.
- At most 12 direct native calls and 24 total native-call upper bound, including
  the existing caller's two busy retries. No unbounded retries or dispatch.
- Queue tests use small compressed inputs with large legitimate synthetic JSON
  output, so bridge transfer does not hide the native pending/byte-budget gates.
- A native busy rejection is data-only and never permits portable/auth fallback.
- Raw native corruption tests begin only after synthetic MAC/peer/header checks;
  malformed gzip reaches the installed decoder without changing production auth.

## Installed cases and pass conditions

| Case | Required observation |
| --- | --- |
| Large Unicode | Exact synthetic result, native-body stage and native work metrics present. |
| MAC tamper | Authentication rejected; no decoded result or native success metric. |
| Foreign peer | Authenticated foreign frame refused; no native success/result. |
| Single and double BOM | Native strips exactly one leading BOM and preserves the second scalar. |
| Malformed UTF8 | Only E_CODEC_UTF8 permits existing post-MAC portable replacement/BOM behavior. |
| Bad gzip CRC | Native compression/CRC failure; no UTF8 compatibility fallback. |
| Truncated gzip | Native compressed-body/length rejection. |
| Trailing or second member | Native single-member boundary rejection. |
| Three gzip→4 MiB calls | Some admitted and some E_CODEC_BUSY; pending ≤2, reserved bytes ≤16 MiB+2. |
| Three gzip→8 MiB-prefix calls | Byte-budget busy observed; no count/budget breach. |
| Local context change | Late native result rejected before JSON publication/metrics. |
| Abort signal | Same late-result fence, zero published results. |

The unit suite uses a synthetic native adapter and checks report privacy,
request bounds, module-required behavior and cancellation. It is not installed
iOS evidence. Root/UI must open the entry once on the registered native1310
artifact with the combined JS snapshot, capture the sanitized store and report
all case results. No native rebuild is needed for this diagnostic-only entry.

## Files for coordinated review/build

- `apps/mobile/sources/sync/nativeCodecStress.ts`
- `apps/mobile/sources/sync/nativeCodecStress.test.ts`
- Early stress branch only in `apps/mobile/sources/app/(app)/dev/peer-diagnostics.tsx`
- Root supplied `gzipSync` from the existing shared wire dependency; no new
  mobile package/lock/native codec changes were made by this lane.

The installed native schema/regular U10/U11 payload evidence remains documented
in `ios-native-payload-codec.md`. A stress gate failure must stay a failure code;
it cannot be relabelled as accepted because the standalone 124 checks passed.
