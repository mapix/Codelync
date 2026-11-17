# Error states, recovery and product copy

## Contract — 2026-11-16

Codelync presents failures at the affected surface with a short explanation
and a recovery action. Cached messages, drafts, pairing and original operation
IDs survive failures. Status synchronization remains separate from message
loading. The supported Desktop sources keep their original owners; CLI families
remain deferred.

| Condition | Display | Allowed recovery |
| --- | --- | --- |
| Connecting to Mac | Connecting/reconnecting with a visible connection control | Inspect or switch saved connections; bounded automatic selection continues |
| All saved connections failed | Mac connection failed; open Codelync on the Mac, check network, then retry or choose a connection | Retry connection discovery for the same paired Mac; preserve cached sessions |
| Device access removed | Access to this Mac ended | Scan the Mac's current pairing code; no automatic new pairing |
| Saved connection cannot be read | Connection could not be restored; unlock the phone and retry | Read saved credentials again; do not clear storage |
| Connected, directory read failed | Session list could not be refreshed | Retry only the lightweight directory read; keep cached rows clickable |
| Original Desktop/source unavailable | Desktop session cannot be reached; open the original app and retry | Read original-owner state again; retain body/scroll and disable native setters |
| Session missing from current directory | Session is currently unavailable; saved content remains readable | Refresh directory or return to the session list; do not assert deletion without evidence |
| Earlier-page read failed | Earlier messages could not be loaded | Retry only that cursor; latest content and reading position remain |
| Mutation result unknown | Result not confirmed; check the original operation | Query its original receipt ID; never automatically resubmit |
| Attachment read unavailable/failed | Explain loading, unavailable, size limit or save failure separately | Retry permitted reads only; a video above 1,000,000 bytes stays blocked |
| Child/task state unavailable | State could not be confirmed | Explicit scoped refresh; an empty or failed roster cannot imply zero tasks |

## Copy and interaction rules

- Use user words: Mac, connection, session, messages, task, original app. Avoid
  runtime, RPC, lease, manifest, contract and observer in ordinary product copy.
- Distinguish connection failure from a source-app failure and a history-page
  failure. A successful message read does not prove the live connection healthy.
- A terminal connection failure must not remain an endless loading spinner.
  Loading text describes the current work; errors appear only after that attempt
  fails. Recovery clears obsolete error text.
- Native session writes also require the live socket to be connected. A fresh
  HTTP message read may keep cached content readable while the socket is failed;
  it cannot enable Send, Stop, model/effort, permission, command or other native
  mutation controls. Rendered controls and captured callbacks recheck the live
  connection as well as their original source/owner scope before dispatch.
  Reconnection only restores eligible controls; it never replays a rejected
  offline action or replaces an unknown operation ID. Ordinary legacy behavior,
  message/scroll caches and local drafts are unchanged.
- Session connection status stays in the fixed header connection control.
  Its details and safe recovery actions use the existing picker. Retained
  messages do not mount a connection card or change their header inset when
  the socket reconnects. Initial source-read recovery keeps its normal inset.
- Retry means a safe read/connection action. Mutations with uncertain outcomes
  offer Check result. Repeated presses coalesce and busy actions are disabled.
- A missing or unavailable native session keeps its title, status and Retry
  below the floating header. When the conversation container runs under that
  header, the unavailable surface owns its full inset once. Otherwise the
  container owns it. A Retry hit area must never overlap header Back.
- Foreground native routes may initialize an uncached session from one bounded,
  authenticated peer recent response. The response must identify that exact
  route and a supported original source; credentials, viewport and source
  identity are rechecked after key initialization. A missing cached directory
  descriptor must not prevent that read. Unknown, failed or superseded reads
  retain the unavailable surface and cannot create a source or navigate Desktop.
  Its Retry awaits that exact bounded observation read and reports its failure;
  a separate failed directory refresh must not prevent the selected read.
  Foreground peer entry has one coalesced read attempt. Background retry backoff
  must not keep this explicit action busy forever; read failure restores Retry
  even while the separate directory synchronization remains pending.
- Do not render raw exceptions, URLs, credentials, paths or private native
  payloads as errors. Fixed error codes may appear only in explicit diagnostics.
- Keep labels and actions consistent in Simplified Chinese and English, with
  the same meaning in the remaining supported languages. Only claim support
  that has passed the source's published acceptance contract.

## Acceptance

### Fixed connection geometry — phone feedback, 2026-11-16

The session header keeps one 44-by-44 connection control slot throughout live,
recovering and failed connections. Only its icon/color/accessibility state
changes; connection failure text and recovery actions belong to its existing
picker. Do not mount a connection notice above retained messages or change the
message/header inset when WebSocket status flaps. The settings and header reuse
the same picker; no second picker is added inside session content.

Retained message rows, scroll position and device-local draft keep their renderer
and geometry through deterministic connected/connecting/error/disconnected
sequences. Network readiness still cannot authorize original-owner writes.

Source-read failure is separate from WebSocket failure. A completed genuinely
unavailable source or failed read keeps an explicit read Retry in the header
picker even during realtime recovery. Cache revalidation is not a new source
failure. Cold/uncached unavailable screens retain their existing recovery and
do not manufacture an empty successful session. Their initial loading may change
when actual data arrives; socket status alone cannot insert/remove source panels.

Verify offline cold start, cached browsing during disconnection, exhausted
connections, read failure/retry/recovery, source loss with saved content,
unknown receipts, child/task unavailable states and blocked large videos.
Separate protocol tests, component tests and native UI observations. Public
screenshots and website examples use fictional data.
