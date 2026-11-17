# Async iOS authenticated payload decoder

## Approved interface and trust boundary

`NativeModules.CodelyncCodec.decodeAuthenticatedPayload({bodyBase64, expectedBytes,
compression, includeMetrics?})` returns a promise containing `{text, metrics?}`.
The body uses canonical standard base64 for exactly the intended authenticated
byte view. Compression is `none` or `gzip`; expected bytes are an integer from
zero to 8 MiB. The existing caller still authenticates the NaCl box and checks
peer identity, flags and protocol limits before this helper. Keys, nonce,
authorization and decryption are outside this module.

Foundation and system zlib perform bounded base64 decoding, gzip inflation/CRC
and UTF-8 conversion on a private serial worker. Native gzip accepts the existing
flags-zero member format and rejects bad CRC/ISIZE, trailing bytes, concatenated
members, truncation and output-length mismatch. Inflation allocates at most the
expected output plus one detection byte. Encoded input and decoded output each
have an 8 MiB bound. The worker admits at most two pending calls and reserves at
most 16 MiB plus two bytes of combined encoded/output budget before dispatch;
excess work fails transiently with `E_CODEC_BUSY`.

UTF-8 uses strict native validation with leading-BOM semantics matching the
portable TextDecoder. Only `E_CODEC_UTF8` may cause an explicit post-MAC portable
compatibility decode. That path must revalidate the authenticated peer/flags,
length and gzip/CRC and retain standard replacement/BOM behavior. Authentication,
gzip, CRC, length and unrelated native failures never fall back. Busy handling
may retry this same data-only native decode at most twice after a short bounded
5–20 ms delay; every attempt must first recheck the caller's account/source/
connection lifetime. A busy rejection cannot launch another model request or
relax authentication. Results from a changed context are discarded by the caller.

Errors and metrics contain reason codes, counts and elapsed phases only. Payload
text is returned only as the decoded result, never in logs or error messages.
The module does not parse JSON or alter compact-payload reconstruction.

## Registered iOS implementation

- Add `CodelyncCodec.mm` to the Codelync Compile Sources phase and the header
  to its source group.
- Link the system `libz.tbd` (`-lz`); Foundation is already available.
- Register with `RCT_EXPORT_MODULE(CodelyncCodec)` and
  `requiresMainQueueSetup = NO`; use RN 0.83.1's existing legacy-module interop.
- Wire the async authenticated body decoder after the existing MAC/peer checks.
  Preserve exact typed-array offset/length ownership when encoding base64.
- Keep JSON parsing, compact reconstruction and stale-context checks in the
  existing caller. Retain the portable path outside the integrated iOS module.

Root added the module Compile Sources and system libz references to the Xcode
project, plus the asynchronous caller after peer authentication. Native build
2026111310 is registered and has executed through the actual simulator app.
The portable path remains when the native module is absent. No Pod dependency
or physical-device installation was introduced by this codec work.

| Actual simulator gate | U10 | U11 |
| --- | ---: | ---: |
| Native build | 2026111310 | 2026111310, unchanged |
| Source inputs / drift | 1,760 / 0 | 1,761 / 0 |
| Native source sections | — | 59 |
| Catalog rows | 311 | 318 |
| Received body bytes | 83,967 | — |
| Logical JSON bytes | 535,833 | 547,659 |
| First complete decode | 9.96 ms | 9.35 ms |
| Repeated mean decode | 8.60 ms | 12.83 ms |
| Native body work | 1.68 ms | 1.61 ms |
| Native queue wait | 0.007 ms | — |
| Unchanged V3 delta | 241 B / 0.114 ms | 243 B / 0.114 ms |
| V2 fallback delta | 587 B / 0.098 ms | 590 B / 0.102 ms |

U10 and U11 use different real payloads and counts; they are separate
acceptance observations. They are not a same-payload benchmark comparison.
U10's JS revision starts `55cd…`; U11 final starts `fba045…`.

Installed queue/corruption/late-context stress acceptance remains pending the
explicit diagnostic entry and the coordinated JS build. The standalone core
suite below is separate synthetic helper evidence and cannot replace that gate.


## Isolated native result

The same implementation compiled with ARC, blocks, C++20 and
`-Wall -Wextra -Werror`. Its React module branch passed an arm64 iOS 15.1
syntax check against the current iPhoneOS SDK and actual RN 0.83.1 Pod headers.
This does not establish runtime module discovery or app integration.

The standalone suite passed **124 checks**. A varied legitimate
Unicode JSON body of 475,932 bytes compressed to
60,019 bytes. Across 30 native Mac helper samples, median core
work was 1.119 ms and P95 1.240 ms;
mean inflate/CRC was 0.168 ms and strict UTF-8/BOM work
0.959 ms. These are synthetic native Mac helper timings,
not iPhone/RN bridge latency or the caller's JSON parse cost.

The queue tests independently reached both bounds: one 8 MiB request was admitted
and 31 excess requests were busy; two 4 MiB requests were admitted and 30 excess
requests were busy. The native worker ran off the main thread. Tests also cover
owned mutable-input snapshots, request shape/canonical base64, Unicode/BOM,
malformed UTF-8, gzip CRC/truncation/trailing/multiple members, bad flags,
length mismatch and oversized expansion.

Reproduce from the repository root, choosing a private output path:

```sh
xcrun clang++ -std=c++20 -fobjc-arc -fblocks -O2 \
  -Wall -Wextra -Werror -DCODELYNC_CODEC_STANDALONE=1 \
  -I apps/mobile/ios apps/mobile/ios/CodelyncCodec.mm \
  test/native/CodelyncCodecTests.mm -framework Foundation -lz \
  -o /private/output/native-codec-tests
/private/output/native-codec-tests
```

JSON parsing and native-to-JS string transfer remain caller/bridge costs. The remaining installed app gates are the UTF8-only compatibility fallback,
queue/byte-budget/busy stress, late-context behavior and one-shot cancellation
through the explicit diagnostic entry. Root/UI owns the coordinated build and
simulator operation for those gates.
