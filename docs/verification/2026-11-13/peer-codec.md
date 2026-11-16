# Peer response codec verification

Protocol: opt-in compact v3, compatible with existing v2 peer replies.
Implementation: Node gzip before sealing; fflate 0.8.2 portable decode after
pinned-Mac authentication. Uncompressed logical size remains bounded to 8 MiB.

## Synthetic packet measurements

These are controlled source fixtures with varying IDs/text, not measured phone
traffic or an estimate of production compression ratios. Decode timings include
NaCl authentication, portable decompression and JSON reconstruction on Node.
HTTP estimates include the existing 565-byte synthetic device-proof header,
request/response framing and the new negotiation header; actual TLS/TCP overhead
and platform-specific headers are excluded.

| Fixture | Logical UTF-8 | V2 sealed JSON | V3 sealed JSON | Estimated HTTP v2 → v3 | Box + decode |
| --- | ---: | ---: | ---: | ---: | ---: |
| 200-session catalog | 79,070 B | 105,638 B | 9,555 B | 106,403 → 10,345 B | 2.8 ms |
| 50 native rows | 238,136 B | 317,726 B | 69,587 B | 318,491 → 70,378 B | 4.1 ms |
| Unchanged catalog delta | 217 B | 500 B | 184 B | 1,262 → 973 B | 0.4 ms |
| One-child status | 303 B | 615 B | 372 B | 1,377 → 1,161 B | 0.4 ms |

The unchanged reply remains authenticated. Constant-field compaction preserves
watermark, machine identities and scan time; it never substitutes an unsealed 204.
Unknown payload fields use ordinary JSON and are retained.

## Gates

- 22 Mac gateway/device/codec tests passed, including negotiated v3 and legacy v2.
- 31 mobile decoder/connection/recent tests passed.
- Wrong peer, tampered ciphertext, unsupported flags, declared-length overflow,
  truncated gzip output and invalid checksum cases fail closed.
- New Mac + old phone and new phone + old Mac use the existing v2 fallback.
- Native Socket.IO RPC envelopes and unknown operation receipts are unchanged.

Reproduce synthetic counts with `node --test test/peer-response-codec.test.mjs`.
Native phone + packaged Mac codec acceptance remains a separate deployment gate.

## Actual physical iPhone, build 2026111305

The already paired physical phone received these authenticated responses from the
packaged formal Mac. Measurements include the encrypted UTF-8 response body;
HTTP headers and TLS/TCP framing are excluded. No response was applied to the
selected conversation for measurement, and ten decode samples reused one packet.

| Response | Rows | Encrypted body | Logical JSON | First decode | Ten-decode mean |
| --- | ---: | ---: | ---: | ---: | ---: |
| Full native directory, v3 | 284 | 78,349 B | 515,048 B | 374.17 ms | 398.34 ms |
| Unchanged directory delta, v3 | 0 | 241 B | 282 B | 9.54 ms | 9.84 ms |
| Same-watermark unchanged delta, v2 | 0 | 587 B | 282 B | — | — |
| Codex latest row, v3 | 1 | 3,996 B | 8,642 B | 17.08 ms | — |
| Codex older page, v3 | 4 | 6,777 B | 13,959 B | 21.85 ms | — |

The recent and older requests took 649 ms and 463 ms respectively before local
decode. Their original owner matched, and the older cursor advanced. This confirms
native protocol/wire behavior; UI scroll anchoring remains a separate gate.

A later Antigravity measurement overlapped the Mac role7 restart and failed before
recent/history completed. Its full-directory repeated decode timing also varied
substantially during background interruption. It is not a completed Antigravity
recent/history result. Full decoding here used the JavaScript NaCl implementation;
the native libsodium response implementation is being compared in build1306.

## Actual physical iPhone, build 2026111306

The native libsodium implementation retains the same authenticated v2/v3 wire
formats. Eight focused interoperability and rejection tests passed before the
signed update was installed in place. A fresh physical-phone measurement showed:

| Response | Encrypted body | First decode | Ten-decode mean |
| --- | ---: | ---: | ---: |
| Full directory, 284 rows / 515,049 logical B | 78,351 B | 358.63 ms | 356.15 ms |
| Unchanged v3 delta | 243 B | 0.1085 ms | 0.0992 ms |
| Same-watermark v2 delta | 590 B | 0.222 ms | — |
| Codex latest row | — | 9.53 ms | — |
| Codex older four-row page | — | 8.86 ms | — |

The unchanged response no longer incurs JavaScript NaCl box cost. Full-directory
decoding still costs approximately 0.36 seconds on this device. The measurement
does not separate decompression, checksum, UTF-8 conversion and JSON parsing, so
their individual contributions are unknown. Full catalogs are bootstrap/recovery
reads; ordinary unchanged synchronization uses the small authenticated delta.
Original owner matching and older cursor advancement also passed in this run.

Antigravity's physical selected-row-only run skipped the directory request and
verified the original 2.31.2 ordinary guide conversation. Recent1 returned 6,136 B
encrypted / 11,034 B logical in 1,337.8 ms plus 7.75 ms decode. Older4 returned
8,176 B encrypted / 16,984 B logical in 49.85 ms plus 12.63 ms decode. The selected
owner matched on both reads and the cursor advanced. The fresh source was
connected/ready with its native models and commands available. These rows were
not applied to the selected UI during measurement.
