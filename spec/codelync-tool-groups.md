# Adjacent native tool calls

Codelync chats show each consecutive run of ordinary tool-call messages as one
collapsed row. The row contains the tool-call count, the latest known original
timestamp and an expand indicator. It has no extra status label or description.
An unknown timestamp is shown as `—`, never zero, observation time or the session
update time.

## Boundaries and identity

- Group only adjacent tool-call rows in one session's chronological display
  order. A user/assistant text row or other visible row ends the run; final text
  stays an independent message. User attachments, interactive questions and
  tools with pending permissions remain independently visible and end a run.
- Hidden tools retain their existing visibility policy. They do not contribute
  to the displayed count. Each ordinary run, including a single tool, starts
  collapsed in native Codelync chats.
- Native chats do not hide intervening text inside a completed-turn work group.
  Existing completed-turn work groups remain available for other chat modes.
- A group stores the original messages and IDs. Expanded tools render as the
  same flat, virtualized message rows; no native identity, message timestamp or
  viewport/history cursor is rewritten by grouping.
- Expansion is local to the current session and follows retained member IDs
  when live tools or older history extend a run. Another session cannot inherit
  the expansion state. Latest still targets the newest visible content and
  cannot turn a final answer into a tool group.

## Timestamp provenance

`meta.nativeTimestamp` is the original native row timestamp in milliseconds,
or explicit `null` when unavailable. The projection owner preserves the native
`row.at` distinction while keeping existing `createdAt`/`nativeOrder` sorting.
Legacy native messages without this provenance have unknown display time.
Generic protocol messages may use their existing original tool/message time.
The group displays the maximum known timestamp among its members; it does not
claim a missing member's time is known.

Readonly/native rendering and tool details retain the selected original
session's metadata. Model controls, input controls, native projections and file
or video media rendering are separate contracts.

## Rendering and verification

Collapsed rows mount only their summary. Opening a group inserts its original
tool messages into the list; each tool's existing details remain on demand.
Closing removes those detail rows without fetching history or issuing a native
command. A matching trailing collapse row keeps the inverted list's interaction
position stable when an expanded run grows upward.

Verification covers adjacency/text boundaries, original IDs, session isolation,
unknown/native timestamps, collapsed lazy rendering, live/history membership
changes and Latest/viewport behavior. Fixture and native UI observations must
remain separately identified.
