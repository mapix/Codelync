# tmux TUI integration

Status: deferred by the user's scope change, 2026-11-14. This is retained future
extension research, not an unsupported-feature failure or a blocker for the
current desktop-only commercial goal. Do not activate a TUI/CLI source or bundle
its runtime through the current CodeLight distribution.

The user authorized parallel TUI assessment and support as part of CodeLight's
commercial-quality work. The selected first scope is an existing tmux server and
pane. A tmux client may observe and forward terminal input to that original pane;
it must not start or resume a replacement desktop model runner. Terminal state is
not a native assistant conversation, turn, model acceptance or subagent roster.

## Selection and current evidence

- Existing Terminal/iTerm/window adapters have no verified PTY/agent owner
  protocol and explicitly disable terminal typing. Screenshots and AX IDs do not
  establish TUI runtime ownership. Arbitrary terminal-window takeover remains
  unsupported.
- tmux control mode provides stable native server/pane/PID identities, a
  command-response stream, terminal-output notifications, screen capture and
  resize/input commands. It can attach to a pre-existing server without creating
  the program again.
- The current Mac does not have a `tmux` executable on its default PATH. A
  private test binary may be acquired to validate the protocol. Production
  activation requires an explicit configured or verified bundled binary; binary
  availability alone does not activate a source.
- A dedicated harmless interactive TUI in an isolated tmux server is permitted
  for the native proof. It proves terminal control, not model admission.

The user additionally requires Claude Desktop and Claude CLI to remain in
Gateway mode. A Claude CLI TUI proof must retain the existing configured Gateway
provider/environment in a dedicated isolated native pane. It cannot use official
OAuth, official Remote Control or a claude.ai/code bridge as a fallback. The tmux
terminal channel itself is provider-independent. If no usable non-official
Gateway route is available, model execution stays unverified rather than using
another provider path.

## Original-owner identity

The source uses `app: terminal`, `kind: terminal`, `protocol: tmux-control`,
`adapterKey: tui`. Its native pane ID, native server PID, socket identity and
runtime generation remain independent from all desktop conversations.

The socket is configured on the Mac, never selected by a remote request. It must
be an absolute existing socket owned by the current user in a private directory.
Discovery/list/snapshot/subscribe use commands that cannot start a missing tmux
server. A pane is selected only by its native `%number` identity. Every operation
captures the same owner generation and rejects a missing/dead pane, server
replacement, PID mismatch or changed socket before dispatch. A response from a
different generation cannot confirm an old command.
Input uses a native `if-shell -F` guard that checks server PID, pane PID and
live state in the same tmux command queue. Physical resize additionally checks
the current window ID and single-pane layout; a split/moved pane after preflight
cannot resize another window or its neighboring panes.

## Backend interface

`TuiTmuxBackend` will provide:

- `status()` → binary/server/connection availability and original owner epoch.
- `list()` → bounded native pane descriptors; no transcript read for status.
- `snapshot(paneId, options)` → current owner-bound terminal screen, dimensions,
  sequence and completeness. Screen content is terminal content, not chat rows.
- `subscribe(paneId, listener)` → bounded raw output deltas and explicit
  connection/resync/exit state. Reconnect takes a new current screen before
  publishing live deltas; it never replays input.
- `command(paneId, action, payload, commandId, expectedOwner)` → native terminal
  input, symbolic key or resize. It returns a terminal-server receipt, explicitly
  different from application/model acceptance.
- `getReceipt(commandId)` → read-only current-owner receipt lookup.
- `dispose()` → detach observer clients and release bounded state, preserving the
  original tmux server/program.

Root owns shared discovery/wire/RPC/mobile integration. New terminal RPC actions
must be source-scoped and cannot reach a desktop agent's message-send path.

## Communication and operation rules

- Input and output are UTF-8 byte streams. Native octal escaping is decoded
  incrementally; split UTF-8 and split tmux control frames are retained correctly.
- The input path uses tmux hexadecimal byte arguments or a fixed symbolic-key
  allowlist. Text cannot become a tmux command. Native pane targets, sizes and
  payloads have explicit bounds.
- Each dispatch has a stable `commandId` and input digest bound to owner/pane.
  A repeated confirmed command returns its receipt without a second dispatch.
  ID reuse with a different payload is rejected. An interrupted emitted command
  remains unknown; reconnect/timeout/re-entry never repeats it.
- tmux command completion means the server accepted the terminal write. Only
  observed application output can show that the program processed it. It does
  not imply a model admitted or completed a prompt.
- Output and current-screen reads have per-frame, total-buffer and subscriber
  bounds. Slow subscribers force an explicit resync instead of retaining
  unlimited output. Unchanged reads can return a compact sequence-only response.
- Resize is explicit, dimension-bounded and owner-fenced. It cannot resize an
  unrelated pane. Reconnect retains desired viewport and does not synthesize an
  input command.
- Terminal titles, paths, output and private diagnostic evidence remain outside
  committed QA artifacts. Native diagnostics expose phases/counts/error codes,
  not terminal content or input text.

## Required native and simulator acceptance

The native proof must use an actual tmux server and original interactive pane:
list/identity, initial screen, live output, Unicode input, fixed control key,
resize, disconnect/reconnect, exact duplicate dispatch prevention, unknown
receipt preservation and disposal without terminating the original program.

The iPhone simulator must distinguish terminal screen/input from assistant chat,
preserve session selection through reconnect, render real output and provide
appropriate control keys and a disabled state when owner identity is stale.
No physical iPhone is used for this work.

## Iteration ledger

T01: select original tmux pane scope and establish native owner/protocol proof.
T02: implement bounded incremental control framing and output decoding.
T03: implement durable owner/pane-bound mutation receipts and no-replay behavior.
T04: validate real Unicode/control/resize/reconnect and screen/delta behavior.
T05: integrate native terminal projection with simulator interaction, density and
recovery states. A round is complete only with a concrete result and evidence;
planning or an unexecuted test is not a completed iteration.

## Preserved checkpoint after deferral

The prototype parser/client/backend/receipt journal and targeted tests remain in
`src/tui/` and `test/tui-*.mjs`. Twelve targeted tests passed, including actual
full-screen Vim Unicode/control/resize, native owner/layout races, live output,
same-owner resync and an intentionally lost native receipt without input replay.
This does not establish completed mobile or production integration.

A dedicated Claude CLI 2.1.311 pane was started with the existing non-official
Gateway environment and an OS outbound-network guard permitting only the private
Gateway forwarder. It reached the initial theme screen. No model request or
prompt was sent before the user's deferral. Its owned server, CLI and forwarder
were stopped; configuration, secrets and native evidence remain private and
recoverable. This lane did not perform an explicit Keychain operation or login.

Before any future activation, finish the known multi-server host namespace
(`app/host/pane` must include a stable canonical socket-path hash), native
workspace-path framing, simulator terminal surface and runtime packaging/license
gates. The prototype currently binds one configured socket; it is not ready to
advertise general terminal or native agent-session support.
