# Message files and video

Message attachment cards show filename, known size and media kind from verified
metadata. Video uses a play affordance; other files use a document affordance.
Mounting, scrolling, grouping and expanding a tool group never download these
bytes. Only opening the attachment starts its scoped encrypted download.

Existing native image markers retain their original image-owner read route.
An uploaded attachment reference belongs to its session's encrypted blob store.
Ordinary tool parameters and local paths never become attachment references or
file-read permissions. Native metadata without a verified readable reference is
shown unavailable; no generic native file/video RPC is advertised.

Filename/MIME metadata is preserved in file events and native file markers.
Missing image dimensions do not make a PDF or video an image. MIME and extension
guide the card; loaded bytes are checked separately. Video playback uses only
the decrypted local file after opening in the native video player, with standard
controls and no autoplay. Text files have a bounded text preview; all loaded files
may be saved through the system menu. Closing cancels pending reads and removes
temporary cleartext files. Account/session/ref changes cannot publish old bytes.

An opened preview captures the authenticated account/peer/device, session blob
key, immutable ref and opening navigation context. A scope mismatch hides the
old bytes immediately, cancels/disposes the load and closes the preview. Save
callbacks revalidate the captured scope and the connection owner's saved
credentials before handing the file to the system. One scoped metadata/status
subscription per preview is released on close; there is no credential polling,
history scan or per-store-update download.
Initial lack of a ready blob key is an unavailable preview with explicit Retry,
not a scope replacement or a silent close. No byte read starts in that state.
The opening authenticated account/peer/device, ref, navigation and known native
identity are captured before key readiness. Only explicit Retry can bind the
first ready key within that unchanged trusted opening source; key readiness
alone never starts a download. An opening without a trusted credential/peer
scope cannot adopt a later account. A previously bound key becoming missing or
different, or any known opening source mismatch, still hides/closes immediately
and cancels/disposes old bytes. Retry and stale Save cannot borrow another peer.
Device-private readiness diagnostics contain only fixed reason codes and
key-present/peer-match booleans, never keys, credentials, refs, paths or text.

An already authorized immutable attachment remains readonly data when the live
native control owner is temporarily null or changes within the same native
conversation identity. A positive application/host/collection/conversation
identity replacement closes it; it does not gain a native file-read grant from
the replacement. Paired channel or owner-auth-token refresh does not invalidate
same-peer/device immutable bytes. Existing explicitly opened live image views
retain their ref-refresh behavior without advertising new window/media support.

Video previews have a strict decimal 1 MB (1,000,000 plaintext bytes) limit.
Known video metadata above that limit disables Open on the card and shows the
1 MB limit without starting any byte IO. Exactly 1,000,000 bytes remains allowed.
A recognized video extension remains a video hint when MIME is the generic
`application/octet-stream`; it cannot use the ordinary-file budget merely from
that generic declaration. A generic name and MIME without video evidence still
use the ordinary-file budget until bytes can establish their actual media type.
Unknown-sized videos use a 1,000,040-byte encrypted download cap, including the
existing 40-byte encryption overhead. Before sending a blob GET, the video
loader requests `request-download` with `{ref,maxBytes:1000040}`. The trusted
server reply must include the exact requested `maxBytes`, an integer
`encryptedSize` between 40 and that cap, and a download URL with a single exact
`maxBytes=1000040` query value. Missing, mismatched or oversized proof prevents
the blob GET; an older server cannot silently fall back to an unbounded read.
The server checks actual encrypted size before serving the capped GET and
enforces its body budget. A 413 size-gate response is shown as the video limit.
Capped S3 presigning is unavailable (501) until the storage backend can enforce
that exact size/body contract; it returns no capped download URL. Missing local
blobs retain 404 and invalid cap requests return 400.
Ordinary file requests retain their original `{ref}` request-download contract
and existing 10 MiB plaintext limit.
Oversized response headers additionally cancel the body before reading; a stream
exceeding the cap is cancelled immediately. The native blob GET uses existing
Expo streaming fetch with native request abort as another protection. This
client abort alone is not an absolute network budget because native response
buffers may already contain data. A video read without a streaming body fails
without an arrayBuffer fallback.
The decrypted bytes and actual detected video MIME are checked again before
creating temporary cleartext files, even when metadata called the file generic.
Oversized loaded/cached video results are disposed and cannot construct a player
or enable Save. Oversized previews show the applicable video/file limit without
Retry. Existing source guards and readonly behavior remain in force.
Larger native-file transfers require their own verified protocol; this change
does not invent such support.

Acceptance covers zero IO on card mount, explicit open/download, video/file
classification, source change/cancellation, oversize rejection, temporary-file
cleanup, and native UI rendering. Fixtures and native acceptance are distinct.
Regressions cover initial null key, same-source readiness followed by explicit
Retry, zero IO before that Retry, positive peer/account/device/native/ref changes
while awaiting a key, and bound-key removal/replacement with cleanup.
Video regressions cover 1,000,000 bytes and +1, unknown-size header/stream caps
with cancellation, zero IO for known oversized cards/previews, detected video
behind generic metadata, loaded oversized video disposal and the ordinary-file
10 MiB boundary.
They also cover exact server size/URL proof, old-server or mismatched proof with
zero blob GET, the server 413 path and unchanged ordinary-file requests.
The explicit developer attachment-preview route accepts an already stored
session and its existing encrypted attachment reference for component/transport
QA. It never inserts a synthetic native conversation message or advertises a
native owner file capability. A generated fixture on this route does not prove
original Desktop artifact discovery or read permission.
