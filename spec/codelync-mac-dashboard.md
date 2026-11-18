# Mac connection dashboard

## Relay deployment help

Configure Relay and the Remote desktop custom-server form each contain one
localized Deployment guide link. It opens the canonical GitHub main-branch
Markdown preview in the default browser, choosing Chinese or English from the
app's localization. The link remains usable while Codelync is stopped and
does not submit, save or clear server settings. Keep the link outside disabled
save controls and show it beside the corresponding server fields.

## Start and pause

The Mac dashboard always exposes Start and Pause controls. Its service controller
owns the lifecycle: starting/running → pausing → paused, or failed. Pause closes
Codelync's owned gateway, observer and relay/database children through their
existing graceful shutdown. Start stays disabled until that shutdown has exited;
late output cannot restore a ready state while pausing. Paused is an intentional
state, not a connection error. Starting again reuses saved pairing/configuration,
accepted work and unknown operation identities. It never replays a native
mutation or pauses/restarts the original Codex owner. The app's existing automatic
start on launch is retained; pause applies to the current app lifetime.

## Windows, settings and quit

Codelync is a regular Dock application with one main window. Closing that window
keeps the service state and saved user inputs; clicking the Dock icon or choosing
Show Codelync from the Window menu reopens the same window. A visible Settings
action and the native Settings menu/Command-comma open a separate settings window
with Connections, Sources and Remote desktop tabs. Settings are not buried below
the statistics or pairing content. Both windows scroll at short heights; the main
window must fit a 520-by-480-point content area without losing its controls.

Quit is explicit in the main window and the native app menu/Command-Q. App
termination is deferred until Codelync's owned service process has completed its
graceful shutdown and reported termination. Repeated Quit requests do not create
another shutdown or bypass the wait. Original Desktop apps and their model
processes are not terminated, restarted or adjusted by window, settings or quit
actions.

Paused settings use the service's `--settings-only=1` mode under the same service
lease. That process publishes
the saved source, access and remote-desktop configuration and then `settings-ready`;
it owns serialized settings commands without starting a gateway, daemon, relay,
native discovery or model/session owner. The Mac UI writes configuration only
through this owned pipe and waits for its existing matching command results.
Inactive Relay changes validate the address and read-only server information
before saving for the next Start; they do not claim a live phone connection.
Inactive media configuration saves settings without starting capture, and
permission requests remain unavailable while paused. Saving an external media
relay requires a non-empty server URL and API key, and media-relay controls are
disabled while settings are unavailable or a save is in flight.
While starting or restarting with saved channel configuration, enabled channels
display Starting… until live channel states arrive rather than Unavailable.
Pause first waits for the normal service to exit, then starts the settings writer;
Start waits for that writer to exit before starting the normal service. A failed
settings writer remains a visible unavailable state with a retry action. Closing
or reopening a window must not start a second writer or overwrite an input draft.
Start and Pause clear stale transient command errors and discard only individual
oversized NDJSON stdout lines (>64 KiB) without dropping valid subsequent lines
in the same read. Unsaved Relay and Media relay form drafts stay intact while
controls disable during busy saves, toggling Remote desktop enablement, or
pausing.
Source revision ordering is scoped to the current service process. A fresh
writer may begin at revision 1; its first valid configuration replaces the saved
projection while subsequent revisions are monotonic within that process. Output
from a terminated process cannot update a new process or its pending commands.

Verify close/Dock reopen, native settings access while running and paused, a
settings command and its acknowledgement, and delayed owned-process shutdown on
Quit using one isolated native fixture with synthetic configuration. No real
pairing, account, credentials, original Desktop owner or business message is
part of this UI fixture. Formal packaging and installation are a separate step.

The main status uses live device connection state for Phone connected. A ready
enabled gateway without a live phone displays Ready to connect. Saved pairing
continues to select the statistics panel without implying a live connection.
Paused settings keep the saved configuration visible while live channel and
traffic observations and old device connection flags are cleared. Device
rename, revocation and pairing-invitation refresh require the active running
service; revoked devices remain read-only in the paired devices list.

After a device has paired, the Mac App defaults to a statistics dashboard. The
QR screen remains reachable through a visible switch; renewing an invitation
does not replace the dashboard or regenerate QR artwork while it is hidden.
Before the first pairing the QR screen is the default onboarding view.

The dashboard shows current gateway throughput, connection-session byte totals,
persisted cumulative gateway byte totals, request/RPC interaction counts and
connected devices. Metrics count bytes crossing the owned HTTP/WebSocket gateway;
they do not claim ISP/TLS/IP overhead or model token usage. No request bodies,
credentials, conversation text or device secrets are retained by metrics.

One sampler publishes small numeric snapshots at most once per second. Durable
cumulative totals are coalesced, not written on every chunk; shutdown flushes the
owned counter file. Live throughput uses monotonic elapsed time. Connection
closure and concurrent sockets must not double-count bytes.

The UI identifies Codex and configured Antigravity Desktop native conversations.
Codex retains its existing gateway-mode owner; Antigravity requires a verified
native protocol endpoint, as specified in [remote control integration](antigravity-remote-control.md).
This wording must not imply support for historical CLI/window harnesses or
arbitrary desktop connection modes.

The Mac controller owns the selected statistics/pairing panel. Before pairing it
defaults to pairing; the first non-revoked saved or newly paired device selects
statistics unless the user already selected a panel. Later ready messages, device
updates and invitation renewals preserve that selection. The numeric metrics
store is observed separately from the device list. Missing, invalid or unsupported
metrics display an unmeasured placeholder; rates use bytes per second and byte
totals use binary units. Closing a service makes live rates unavailable.
If cumulative storage cannot be read or validated, the volatile sampler still
measures this connection, but emits null cumulative totals and never overwrites
the existing counter file. The UI displays those totals as unmeasured.

QR artwork is cached by the complete pairing URL. Rendering is requested only
while the pairing panel is visible; an unchanged URL reuses the image and Core
Image context. Metrics samples never regenerate the QR image. The main service
status summary, pairing QR artwork, and paired device status expose localized
VoiceOver accessibility labels without adding decorative visual clutter.

Verify the post-pair default view, QR/statistics switching, persistent cumulative
totals, real HTTP and WebSocket byte counts, interaction counters, sampling/write
budgets and clean shutdown. Original Codex applications and runtimes remain owned
by their existing processes.
