# Compact authenticated peer responses

2026-11-13. This extends the existing sealed `/api/peer/` response transport.
It does not change native command admission, Socket.IO RPC envelopes or peer keys.

An explicitly opened, one-shot native codec diagnostic may build bounded
synthetic gzip fixtures through the wire package's existing fflate compressor.
This adds no dependency, network route, new transport format or production
compression operation. It never uses saved pairing keys or applies session
state; only sanitized case counts, sizes, timings and rejection codes persist.

## Negotiation and compatibility

A new phone explicitly requests `x-codelight-peer-codec: 3`. An older Mac ignores
that header and returns the existing v2 JSON envelope. Without the header, a new
Mac also returns v2. A new decoder accepts both formats. Format negotiation never
changes authorization or permits a different origin/device/peer.

V3 uses the compact JSON tuple `[3, nonceBase64url, ciphertextBase64url]`. The nonce
remains 24 bytes, and the ciphertext uses the existing pinned Mac/device NaCl box.
The authenticated plaintext contains one format byte, the 32-byte peer identity,
a four-byte little-endian decoded body length and the encoded body. The format
byte selects JSON or a defined compact payload, with an optional gzip bit.

The Mac compacts/compresses before sealing. Gzip is used only when it saves at
least 32 bytes. The phone authenticates the box and verifies the exact peer before
inflation. The declared size, gzip footer and fixed output allocation bound decoded
data to 8 MiB; malformed flags, sizes, payloads and unsupported versions fail closed.
Normal TLS, nonce freshness, source/owner generation and stale-completion fences
remain unchanged. No HTTP 204 can stand in for an authenticated unchanged response.

Native phones use the application's existing native libsodium implementation for
NaCl box authentication/decryption; portable/web callers retain the compatible
JavaScript implementation. Both receive the same bounded ciphertext, nonce and
pinned keys. Native inputs use independent typed-array buffers to avoid the
TurboModule's underlying-buffer offset ambiguity. Authentication failure remains
an error, with no retry through another key, peer or decoder. Wire format, keys,
receipt semantics and decoded-size limits remain unchanged. Physical acceptance
compares received-body decoding time after this implementation change.

## Empty directory delta

An exact v2 directory delta with no changed/removed sessions, no next page and
`baseWatermark === watermark` can encode its body as
`[watermark, machineIds, scannedAt]`. The decoder restores all original constant
fields (`version`, `mode`, arrays, `hasMore`, cursor and base watermark).
Unknown/additional fields use ordinary JSON so compaction cannot discard data.
Other payloads use ordinary JSON plus beneficial gzip. Native text/tool input and
source identifiers are preserved without field-name guessing or truncation.

## Acceptance

- V2 and V3 round trips with the same pinned peer and device keys.
- Catalog, current rows, empty deltas and one-child status packet byte counts,
  including the encrypted JSON envelope, and portable decoder timings.
- Wrong peer, tampered ciphertext, bad flags/lengths, oversized compressed output,
  malformed compact bodies and non-negotiated legacy requests.
- Native phone decoder and Mac integration; no native mutation for codec QA.

Native measurement uses the already paired phone's pinned peer credentials and
the installed Mac's authenticated read endpoints. A development diagnostics page
may read a complete bounded catalog, its unchanged delta, an unnegotiated v2 delta,
and a selected source's latest single row plus one bounded older page. It records
only response UTF-8 byte counts, encrypted frame lengths, decoded logical sizes,
codec versions, row counts and network/decoder timings. Repeated decoder samples
reuse one received packet locally. Credentials, raw encrypted envelopes, decrypted
messages and cursors are never logged or persisted by this measurement branch,
and its native reads do not apply responses to selected-session state. These actual
response-body measurements exclude HTTP headers and TLS/TCP framing.

A selected-row-only measurement resolves one unambiguous existing catalog binding
for the requested native conversation and skips the full directory request. The
original authenticated endpoint still verifies session ownership and supplies the
fresh owner; a cached match never proves current native ownership. Diagnostics
may retain the bounded input relation, parent/child classification and owner-scope
fields, without message text, keys or draft contents.
