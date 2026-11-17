# Original-owner media references

Status: adapter preparation and static interface audit. Generic native file and
video reads are **unsupported**. `source.files.read` remains false until an
actual source-bound native reference and its read scope are proved. This does
not change existing encrypted attachment-ref downloads.

## Current methods

| Source | Observed metadata / existing path | Current Codelync read support |
| --- | --- | --- |
| Local original Codex | Native `imageView` item ID and its image path | `native-image-read(imageId)` resolves only that item in the current bound view; 64 MiB input image, JPEG preview below 499960 bytes; immutable encrypted attachment ref |
| Codex MCP results | Native `resource_link` blocks can identify URI, name, MIME and source server | No generic resource-link file/video reader is implemented; URI alone is not a download grant |
| Antigravity | Native trajectory tool/file-change/view-file metadata | No generic file/video reader; tool arguments, change paths and command output paths do not grant reads |
| Claude Code | Native session file, image, media and document delegates exist in shipped 4.16336.0 | Current stock9a/copy0003 RPC exposes no file/image/video byte read; content blocks beyond text/thinking/tool data are projected unsupported |
| Claude native artifacts | Typed native artifact UUID/store metadata and MCP vouch state exist | No Codelync artifact reader or verified per-message reference catalogue yet |
| Existing Codelync attachment | Encrypted session attachment ref and MIME metadata | Existing request-download/decrypt path; clicking opens the ref, without eager media IO |

The local Codex image reader checks regular-file identity with lstat/open,
O_NOFOLLOW and O_NONBLOCK, compares device/inode/size/mtime during the read,
validates image bytes, and checks the source owner/lease before and after reading
and uploading. It cannot be generalized into arbitrary file reads by supplying
a path from the phone.

## Proposed native reference evidence

Native file cards first need bounded metadata from the actual original-owner
message/item. Retain its native message/item ID and one of these identities:

- An MCP `resource_link` URI together with the originating native MCP server and
  existing connection identity. Link metadata is observed; read authorization
  still requires that original connection's admitted resource-read route.
- A typed native Claude artifact UUID, name and MIME, matched to native artifact
  store membership and the native session's vouched publish/resource evidence.
- A dedicated original native media/file item with an explicit stable identity
  and native resolver. A path copied from ordinary tool arguments, Markdown,
  terminal output or file-change metadata is not such an identity.

Each catalogue entry must bind app, host, native collection, conversation,
message/item, original owner generation and runtime/source epoch. Query/CLI or
MCP-connection identity is additionally required when that native route depends
on a live connection. Historical entries remain data only and cannot establish
a current file-read capability.

Cards can carry name, MIME, kind, known size and an authorized encrypted ref.
Unknown size/MIME stays unknown. An unsupported native URI or UUID can have a
card with `readAvailable:false`; it must not receive a fabricated attachment ref,
eager HTTP fetch, guessed local path or substitute model runner.

## Candidate Claude native paths

These are static shipped-interface findings, not native read acceptance:

- Code manager `readSessionFileWithStatus(sessionId,path,options)` delegates to
  the original session file reader. It resolves native canonical session roots,
  applies policy, can refuse multiply linked files, and returns bounded UTF-8
  text/status data. It is not a generic binary/video reader or per-message grant.
- `readSessionImageAsDataUrl` and `getSessionImageStreamUrl` use contained session
  paths and native image limits. Returned stream/data URL handling still needs
  per-message native reference provenance and source fencing before exposure.
- The shipped `LocalSessions` facade also exposes `listSessionDirectory`,
  `readSessionMediaAsDataUrl`, `readSessionPanelMediaAsDataUrl`,
  `getSessionMediaStreamUrl` and `getSessionPanelMediaStreamUrl`. The media
  data-URL limits are 50 MiB and 25 MiB for the contained panel route; neither
  automatically meets Codelync's 10 MiB attachment limit.
- Native media stream URLs use an opaque random token in the original
  application's custom protocol. The native registry holds at most 64 entries
  with a six-hour idle lifetime. Its handler checks the native session/file
  policy on each request and supports a single byte range with 206/416 responses.
  This is a candidate for bounded reads through the original Electron handler,
  not a public HTTP URL or an established Codelync byte reader. An actual
  native directory/item reference, original handler invocation and range/file
  identity fencing still require copied-owner acceptance before enabling it.
- Native panel document reads cover PDF/XLSX and gated DOCX/PPTX conversion.
  The conversion gate can involve a cloud operation and is outside a local
  file-read proof; it must not be invoked as an implicit preview fallback.
- Native artifact `resolveArtifactReadSource(artifactUuid)` validates UUID,
  canonical Cowork file-store containment, a regular file and a single hard link.
  `readArtifactContentForShare` reads UTF-8 content. Its neighboring share/import
  operations are mutations and are excluded from read preparation.
- Native MCP artifact vouch logic binds a publish tool result to a native call
  and verified original server scope. Tool-result URL text alone is insufficient.

No factory, CLI/TUI, replacement query, account repair, share/import operation,
original app restart or original desktop mutation belongs to this preparation.

## Read gate and transfer preparation

Before enabling any native file reader:

1. Observe an actual native reference with known original provenance, without
   fetching bytes or loading full conversation history for directory/status.
2. Resolve only its opaque identity through the original owner's existing
   session/artifact/resource resolver. Reject caller-supplied paths and URLs.
3. Validate owner/runtime/host/collection and native membership before and after
   metadata resolution and every byte read. Drift discards the result.
4. Establish the route's actual maximum bytes, regular-file/link constraints,
   MIME handling and native permission behavior in an isolated copied owner.
5. Where chunking is supported, validate integer offset/length and bind chunks
   to the same reference, source epoch and file/content identity. The current
   native file/video route has no proved chunk interface or byte limit, so no
   chunk capability is advertised yet.
6. Publish an immutable encrypted attachment through the current session's
   existing key/ACL; persist its ref before returning it. Repeated clicks and
   lost replies reuse that ref. The phone loads/decrypts only after open.

Until these gates pass, local adapters return an explicit unsupported marker
with `readAvailable:false`, and the UI uses only existing authorized encrypted
attachment refs for file/video opening.
