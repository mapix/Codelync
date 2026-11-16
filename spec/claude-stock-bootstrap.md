# Stock Claude Desktop bootstrap

Status: stock Code readonly access restored and verified, 2026-11-15.

## Supported artifact and entry

The verified target is Claude Desktop 4.16336.0. Installation checks the actual
ASAR SHA256 and existing main PID, parent, executable and data profile. Unknown
versions or changed artifacts fail closed. The original Gateway provider,
credential, native account scope and config-library profile stay unchanged.

The stock Electron fuses disable Node CLI inspection, Node options and
RunAsNode. Those command-line entry points are not used. The vendor's existing
Developer menu supplies **Enable Main Process Debugger**, which calls the
native Node inspector in the running main process. The copied test proved a
loopback debugger target owned by the exact main process and a bridge installed
without changing ASAR or code signing.

On this Mac, the original stock profile already has `allowDevTools:true`.
Enabling the main debugger does not restart the app. If Developer Mode is not
already enabled on another machine, Help → Troubleshooting → Enable Developer
Mode writes native developer settings and calls app quit/relaunch. That path
must wait for a native idle proof or one explicit user-controlled idle/restart
step. It is not silently run during discovery.

## Reviewable implementation

- `src/adapters/claude-native-debugger.mjs`: existing-PID debugger discovery and
  native main/profile/version/Gateway/header-only idle attestation.
- `src/adapters/claude-owner-bridge.mjs`: version-bound standalone main bridge.
- `scripts/claude-native-bootstrap.mjs`: status/install/remove administration.

The standalone bridge must be bundled as CJS before loading it into the actual
native main. It resolves vendor manager modules only through `app.getAppPath()`
and the same original module cache. For the native API, it calls the existing
`window['claude.web'].LocalSessions` or `LocalAgentModeSessions` through the trusted
`app://localhost` main frame and its original IPC sender. It must never invoke
the native API factories again: those factories initialize managers and register
window lifecycle callbacks and surfaces. The outer `file:` BrowserWindow is not
the native API owner. The bridge does not install a probe keystore,
replace safeStorage, change Gateway configuration, patch ASAR, resign binaries,
launch another model runner or restart the original Desktop.

## Installation sequence

1. Confirm the exact existing stock main and existing native Developer Mode.
   Do not launch another stock instance.
2. After the Mac is unlocked, enable the vendor main debugger in that app.
   This step is the only remaining stock UI action in the current plan.
3. Inspect only loopback TCP listeners owned by that exact PID. Do not select
   another Node target. If the vendor inspector port is occupied by our copied
   probe, close only that known copied inspector; never kill a foreign listener.
4. Run `status` with explicit expected profile and ASAR fingerprint. It reads
   original native Code/LAM headers, reports active work and pending requests,
   and proves native 3p Gateway mode. No histories or provider objects are output.
5. Ordinary writable installation requires the native owner to be idle. Explicit
   readonly installation preserves active native work. `install` loads the
   reviewed standalone bridge into that same main process and writes a private
   0600 manifest under CodeLight's private runtime directory.
6. Verify Code/Chat headers, bounded first read, collection-scoped identities,
   native query token and readonly source binding. Use a dedicated native probe
   session for any final send/stop/permission verification.
7. Close the inspector once the limited bridge is verified. Keep CodeLight's
   paired/sealed transport as the external boundary; do not expose the inspector
   through a tunnel or relay.

`CODELIGHT_CLAUDE_EXPECTED_PROFILE` and `CODELIGHT_CLAUDE_EXPECTED_ASAR` are explicit
inputs to the administrative script. It never prints the debugger endpoint,
Gateway URL/key, provider object or private manifest contents. The app root,
private manifest path and bundled bridge path are explicit arguments.

## Boundary and recovery

The native Gateway marker binds 3p/local-source mode, actual config-library
profile, provider/base/credential kind, account/org scope and credential epoch.
Every request checks that marker. Profile/provider/account/credential drift
refuses the old bridge; new native data is not read or executed under old source
proof. Lifecycle owner generation also binds this marker. Query token is a
separate execution identity, and no native Turn ID is fabricated.

Only actual native `sessionType:chat` is accepted in the LAM Chat path. A native
mode conversion invalidates old controls. Cowork VM, model/effort mutations and
unverified child controls remain unavailable.

`remove` closes only CodeLight's bridge and event listeners, deletes its private
manifest and leaves native queries and settings intact. A Desktop quit removes
the runtime endpoint. Renderer reload does not replace the main owner: the copied
test preserved PID, native IDs, owner generation, query token and history rows.
After any disconnect, uncertain command IDs are retained and never replayed
automatically. Recovery re-attests the actual owner before reconnecting.

The pure renderer WebSocket candidate is not the installation path: an actual
copied `app:` renderer installed it, but native CSP `connect-src` rejected its
loopback connection and the endpoint deactivated. CSP is preserved.

## Copied evidence completed

- Actual vendor-enabled main debugger: PID/executable/profile/version/ASAR/
  native Gateway match; zero extracted main modules.
- Independent standalone bridge installed through that debugger, no ASAR change.
- Code/Chat bounded reads and exact native send UUID/result readbacks.
- Explicit bridge deactivate → manifest removed → same-PID reinstall.
- Native software renderer reload preserves owner/session/query/history identity.
- Synthetic native credential-epoch drift refuses old requests without leaking
  provider, endpoint or credential data.

The copied endpoint remains available for native CodeLight client acceptance.
The original stock Code read gate is recorded below. Copied Chat support does
not establish stock Chat support for an untyped or missing native record.

## Stock read and input incident

The reviewed stock install ran without restart and attested the actual original
version, artifact, Gateway profile and idle owner. Original Code headers and two
bounded reads preserved owner/query identity. The two stock LAM records had no
explicit `sessionType:chat`; no stock Chat read was claimed and no record was
created or sent a model request to manufacture that proof.

The user reported duplicate input during this interval. The limited bridge was
deactivated, its private manifest removed, and the exact original main retained
zero TCP listeners. No stock model send or typing was performed. Removal of the
bridge's own manager listener does not retroactively remove side effects created
by the old native API factory call. Existing factory registration is therefore
being replaced by the original renderer API path before any reinstallation.
Additional window lifecycle callbacks are an observed implementation issue;
the cause of duplicate input remains unproved pending actual input-value evidence
and a user-controlled comparison after removal. Do not remove unrelated native
listeners, restart the original app or type test characters into user sessions.

The input remained duplicated after initial endpoint removal. A subsequent
native debugger inspection attributed the original and added factory groups by
their V8 closure surface identity. Only the added group's exact function
references were removed: six window callbacks and one surface unregister hook.
The original surface remained registered; the original SSH prompt function was
restored only after proving that the current function was the added factory's
function. The bridge's remaining quit callback was similarly removed by its
exact install closure and runtime path. Existing keyboard listeners were
unchanged, and native record/query/CLI identity remained stable during cleanup.
This is a completed isolation step, not evidence that input duplication is fixed.

## Readonly stock access

Stock access may be installed with `readOnly:true` independently of input repair.
This installs only the limited observer and existing native renderer API reads.
It does not invoke a new API factory, account initialization, surface registration
or keyboard handler. The original app remains the session and runtime owner.

The private manifest and `owner.status` both carry `readOnly:true` and
`mutationAllowed:false`. The owner refuses send, interruption and permission
operations before admission. Backend capabilities agree: source commands, send,
cancel and operable approval actions remain unavailable while histories and
native headers can be viewed. Task output/stop remain unverified and disabled.
The phone must not infer write capability from the presence of an original query.

This mode can restore viewing existing native sessions while duplicate input is
still under diagnosis. It does not establish that input is repaired or authorize
model requests. Installation uses a new content-addressed CJS path to avoid old
native `require` cache entries. Verify original keyboard handlers, native record
and query references, editor content statistics and Gateway fingerprint before
and after installation; close the main inspector after verification.
The administrative bootstrap uses `CODELIGHT_CLAUDE_READ_ONLY=1` for this explicit
mode. It does not stop running native work to obtain an idle condition; ordinary
write-enabled installation retains its native idle gate.

The original 4.16336.0 stock owner passed this readonly installation gate on
2026-11-15 with one native active session and no pending requests. It exposed
69 Code headers and two bounded 32-row reads with stable owner/query tokens.
Both stock LAM records remained untyped, so the verified Chat inventory was empty.
Before/after checks retained all 71 native record/query/CLI references, original
window callbacks, all 11 keyboard function references and hashes, current
visible DOM/ProseMirror draft hashes, Gateway fingerprint, PID and ASAR hash.
Provenance confirmed zero native API factory invocations and reuse of the
existing trusted renderer API. The main inspector was closed and an independent
RPC read confirmed the readonly runtime/status markers. This restores viewing;
it does not establish that the separately reported input duplication is repaired.

An actual phone-selected stock Code session exposed a native tail expansion:
`getTranscriptTail(id, 32)` succeeded in both the native manager and existing
renderer API but returned 512 messages. The previous 500-row public projection
rejected that result. Snapshot now validates the expanded native window against
the bridge's bounded envelope and publishes its latest 32 whole messages with
truthful older coverage, preserving UUIDs and bodies. It does not replace the
native reader or manufacture an older-page cursor.

## Readonly task feed

`code.taskFeed` and `cowork.taskFeed` read the current native parent query's
bounded task metadata. They do not call native API factories, `getAgents`,
transcript readers, model runners, task output or task stop. Responses bind the
exact collection host, parent ID, owner/runtime generation, nullable query token
and nullable native CLI ID. The owner and query are rechecked after header reads.
An explicitly absent query accepts the public null query fence; it does not
fabricate a running SDK query from the internal empty-query execution hash.

The foreground map and background level require an observed current-query task
event to establish their provenance. The observer retains the original query,
CLI and map/level references together with the owner and execution token. A
pre-existing field at bridge installation does not gain current proof merely by
being read. Query/CLI/owner drift or a replaced map/level removes availability
and completeness. Native map membership stays separate from lifecycle events;
the bridge never invents `task_started` or a native event UUID for a map row.
Foreground provenance is per task ID from a current-query native foreground
`task_started`, not from an arbitrary progress or background event. Reused CLI
IDs, query transitions and unproved IDs remaining in the native map cannot stamp
an old roster under a new query; they remove foreground completeness.
Primitive map/level snapshots are taken after awaited header reads. A projected
level digest must match its observed event proof; an in-place content change
without new native proof publishes unknown status and removes level completeness.
An omitted native background-row status stays omitted, preserving the native
active-membership meaning. Explicit null/unknown status remains unknown and is
never upgraded to running by projection.

Feeds use original event cursors with a limit of 128 rows. Log gaps remain
explicit and never become complete lifecycle coverage. Foreground map and
background level completeness are separate. Collection-proven dispatch children
retain their own collection host and owner identity, with the exact parent scope.
Task output and stop capabilities remain false until separate copied-owner RPC
and native terminal/readback verification succeeds.
Dispatch collection header reads share a 750 ms cache measured from the read's
start. Pending inventory is partial. Child record, owner, query and relationship
references are checked before and after cross-collection reads; changed children
cannot reuse older header status under a new owner. Cache reuse never renews age.
