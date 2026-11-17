# Self-hosting template verification

Date: 2026-11-17. Scope: deployment documentation, generated configuration and
Mac documentation links. No original Desktop model/session owner was started or
reconfigured for this work.

## Passed

- Linux Compose configuration parsing for `network`, `media` and both profiles;
  selected service sets were exactly Caddy plus the requested services.
- Caddyfile validation with local Caddy 2.11.7. The template's pinned image is
  Caddy 2.10.2; its Linux container was not run in this check.
- Independent credential generation, mode-600 files, credential retention after
  domain changes, network-only proxy generation, and refusal to replace working
  configuration with shared credentials or reserved example domains.
- Optional TURN configuration generation using distinct TLS/UDP ports and mounted
  certificate paths; no live TURN certificate or allocation was tested.
- Endpoint checker against real isolated local LiveKit and Codelync network
  service processes. The checker used synthetic loopback URL routing; this
  confirms RoomService token/response compatibility and network discovery,
  without establishing public TLS, ICE or TURN reachability.
- 27 targeted existing/new tests covering network registration and forwarding,
  desktop grants/input/media paths, Mac values and configuration generation.
- Root ESLint and explicit lint/strict type checks for deployment scripts.
- Mobile and production embedded-relay type checks.
- Swift compilation and isolated native UI observation: one guide link in each
  server form, usable while paused, with English/Chinese captions and matching
  main-branch GitHub document destinations. No real server or pairing values
  were used in the preview.
- Relative documentation links resolve inside the repository.

## Existing gate failure

The full `pnpm typecheck:all` stops at five existing implicit-parameter-type
errors in `test/codex-fresh-owner.test.mjs` (lines 11, 16 and 17). The same errors
occur in the unchanged canonical GitHub baseline. They are separate from the
new deployment code; mobile/relay and new-script checks were run separately.

## Not established

Docker Engine was unavailable locally, so Linux container build/start and actual
public certificate issuance were not exercised. A Docker image-manifest request
also timed out; no image availability claim comes from that attempt. These
templates retain the existing network-relay Node image and the source-pinned
LiveKit version, with explicit version tags.

Public-server deployment, real-phone cross-network media, restricted-network
TURN and 443-only routing require the operator's acceptance steps in the guide.
This work does not publish a new installed/notarized Mac binary or change source
repository visibility. Raw screenshots, generated credentials and private test
configuration remain outside committed source.
