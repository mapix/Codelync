# Desktop network stability verification

N01–N09 cover nine distinct verified changes to the desktop connection owner.
The network spec was updated before helper behavior. Existing paired-device proof,
sealed channel responses, signing identity, source-use pins and original command
receipt rules are retained.

## Changes and evidence

| Round | Change | Concrete evidence |
| --- | --- | --- |
| N01 | Enabled cold-start failures recover with one retry timer per kind, capped exponential backoff, and cancellation on disable. | Isolated transport failure recovered without another configuration request; repeated failure remained bounded and disabling prevented another start. |
| N02 | A stopped Cloudflare process withdraws its dead URL and starts a new owned transport. | Actual synthetic child process terminated; its route disappeared, a different child became ready, and the manager identity remained the same. |
| N03 | Relay replacement suspension belongs to the latest intent; reaffirming current settings cancels older pending intent. | Both overlapping same-server pause loss and stale settings overwrite were reproduced before correction. |
| N04 | Reconnect cancels obsolete read-only proofs and contains synchronous probe failures. | Stale signals were aborted. Real local HTTP/WS probes released their sockets and independent challenges after supersession and paired confirmation. |
| N05 | Concurrent manager/service shutdown callers join one cleanup flight. | Deferred transport cleanup and actual owned gateway shutdown returned the same pending promise to both callers. |
| N06 | A closed LAN listener loses its advertised route immediately; the interface watcher repairs it. | Actual local HTTP socket closed, retained route and public transport stayed available, saved port was reused, and a fresh sealed response retained the same peer. |
| N07 | LAN binding requires valid numeric IPv4 matching the reported family. | Empty IPv4 components, whitespace, noncanonical components and mislabeled IPv6 records were excluded before binding. |
| N08 | Port hints use one no-follow descriptor and a read capped at 4 KiB. | Real synthetic pathname-to-symlink swap and growth after metadata check both failed before correction and passed afterward. |
| N09 | Cloudflare shutdown clears its losing grace timer and awaits forced child exit. | Standalone graceful process duration changed from 5,587 ms to 316 ms. A SIGTERM-ignoring child exited with confirmed SIGKILL after its five-second grace period; failed spawn closed promptly. |

## Verification

Node 24.15.0 and pnpm 10.11.0 were used for this lane. The final targeted set:

```sh
node --test \
  test/network-stability.test.mjs \
  test/lan-listener-state-races.test.mjs \
  test/cloudflare-cleanup.test.mjs \
  test/connection-channels.test.mjs \
  test/mac-connection-service.test.mjs \
  test/lan-listener-restart.test.mjs \
  test/lan-network-refresh.test.mjs \
  test/network-relay.test.mjs
```

Result: **49 tests, 48 passed, 0 failed, 1 skipped**, 5.875 seconds. The skip is the
explicit live-private-interface integration test, which requires a selected live
network inventory. Changed-file ESLint and a scoped typecheck using the repository
compiler options passed. An initial whole-bridge typecheck reported diagnostics
in simulator signing and keychain test ownership; the whole repository gate
remains an integration requirement.

## Acceptance boundary

These results use isolated helpers, actual local HTTP/WS sockets, real synthetic
child processes and synthetic upstream/device fixtures. They establish network
failure, recovery and cleanup behavior. Runtime deployment and desktop UI
acceptance remain integration work. The root live QA service, original desktop
apps, simulator ownership, real pairing data and native model actions were not
operated by this lane. Network recovery does not retain or replay forwarded
requests or native mutations.

## Integration files

- `src/network/connection-channels.mjs`
- `src/network/public-access.mjs`
- `src/happy/mac-connection-service.mjs`
- `src/happy/lan-listener-ports.mjs`
- `spec/codelight-network-relay.md`
- `test/network-stability.test.mjs`
- `test/lan-listener-state-races.test.mjs`
- `test/cloudflare-cleanup.test.mjs`
- `test/mac-connection-service.test.mjs`
- `test/lan-network-refresh.test.mjs`
- this verification report
