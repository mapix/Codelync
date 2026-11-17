# Website publication inputs

Keep the existing static design and immutable downloads. Do not publish a
private or intermediate build. `release.json` is generated release metadata and
is excluded from source Git; `testflight.json` starts with no join link.

## Required frozen inputs

| Input | Required evidence |
| --- | --- |
| Mac archive and `release.json` | Frozen ZIP, version, exact filename/bytes/SHA-256, Apple Accepted, stapled, Gatekeeper accepted |
| Source provenance | Final reviewed public Git commit; optional `sourceCommit` in the existing Mac metadata format |
| GitHub Release | Actual published release URL and matching immutable ZIP/checksum; do not manufacture a tag link |
| TestFlight | Codelync app/version/build, external build approval, external group enabled and containing that build, actual Apple public link, UTC check time |
| Privacy/support | Review of `privacy.html` and `support.html`; authorized public support email is mapix.me@gmail.com |

`schema/release.schema.json` documents the existing metadata; also run
`validatePublicArtifact` from `src/release/public-artifact.mjs` for the exact
filename/version relationship. Do not add private notary IDs, signing details,
Apple account details, private review-contact names/phone numbers, paths or device state to either public JSON file.

## TestFlight status

`schema/testflight.schema.json` defines public schema version 2 with `version`, `build`, `appId`, `groupId`, `publicURL`, `externalApproved` and `publishedAt`. App/group IDs must come from the verified Codelync release; they are not Apple account details. `externalGroupEnabled` means an external group with its Apple public link enabled; `externalGroupContainsBuild` confirms the exact target build is in that group. Approval alone never enables joining. Use `coming-soon` before
submission, `in-review` only after an actual external testing submission,
`available` only after all stated gates pass, and `closed` if joining is suspended.
Keep `publicURL: null` except for `available`. Preserve version/build/appId/groupId/check
time when known; `publishedAt` records the UTC time of the verified public projection. The client validates the join URL, group/build flags and version
before creating any link. Invalid or missing metadata keeps the action hidden.

Only Apple's exact `https://testflight.apple.com/join/…` public link is accepted.
It is obtained from Apple, never assembled from internal IDs. The manifest is a
published observation; the static site does not authenticate to Apple or poll it.

The authorized two-hour check runs in Codex with the existing account setup. It
reads current Apple status and only updates the public site when the review
progress changes, joining opens, or a previously available group becomes closed.
An unchanged check creates no new deployment or user notification. A metadata-only
update preserves all Mac release fields and download hashes. Record private
Apple checks outside the repository; publish only this public status projection.

## Static staging and publication

1. Stage `index.html`, `app.js`, `styles.css`, `assets/`, `privacy.html`,
   `support.html`, the reviewed `testflight.json`, and the current verified
   `release.json`. Documentation/schema files need not be served.
2. Hash `app.js` and put its leading 16 SHA-256 characters in the HTML script
   query. Do this after every script change to keep both languages in sync.
3. Retain every older immutable `downloads/` ZIP and checksum unchanged. Add new
   frozen archive/checksum bytes to every replica before switching the pointer.
4. Prepare the new dedicated `codelync/codelync-website` resources only after final release gates. Use `deploy/website/` security configuration; both JSON metadata paths have no-store response rules. Open the new host/TLS after its pointer image is ready. Retain the old service/TLS and six immutable legacy download files, then patch the legacy redirect image only after new HTTPS verification. Preserve other apps.
5. Verify HTTPS page language, beta visibility/href, public policy/support URLs,
   displayed release metadata and download SHA. Keep private proof outside Git.

This preparation does not authorize publishing an intermediate candidate.

## First Codelync publication

The public repository is https://github.com/mapix/Codelync and the final site is
https://codelync.novarock.io. The first branded package is proposed as
`Codelync-1.0.0-macos-arm64.zip`, build `2026111705`; use only Root's final
frozen archive/hash/source commit and Apple acceptance evidence. The original
legacy download filenames must not be renamed or repacked.

- Build the asset image with `deploy/website/Dockerfile.assets`, inheriting the
  exact currently deployed legacy static image. Stage only the new archive and
  checksum under `site/downloads/`; old files survive in the parent image.
- Render `prepare` with `deploy/website/render-manifests.py --phase prepare
  --image <frozen-asset-image> --output <private-plan-file>`. This includes the
  new namespace, deployment, service and network policy, without public ingress.
- After both replicas contain all retained/new downloads, build the pointer
  image with `Dockerfile.copy-update` from that asset image. Stage final branded
  pages, icon, policy/support, reviewed TestFlight status, final release metadata
  and the current nginx/security configuration. Update only the new deployment
  image and wait for both replicas to be ready.
- Render `route` separately to expose the new host and request its TLS certificate.
  Verify ready certificate, HTTPS page/metadata and the actual archive SHA.
- Finally build `Dockerfile.legacy-redirect` from the exact original legacy
  static image. It changes only nginx configuration. Render `legacy` with that
  frozen image; its output is a strategic deployment image patch, not an apply
  manifest. Patch only `codelight/codelight-website` after new HTTPS verification.
  Its service, Ingress, TLS and six download bytes stay in place. Root paths
  redirect with 308 and retain path/query; legacy `/downloads/` paths still serve
  their original bytes.

The renderer only writes manifests. It does not build, connect or apply. For
advance server-dry-run while the new namespace is absent, `--validation-namespace
codelight` creates a clearly marked projection of new namespaced resources into
the existing namespace. Never apply a projection. Namespace validation remains
a dry-run. The cluster rejects redirect annotations containing `$request_uri`; use the
provided native nginx return in the separate legacy image instead. Validate
the rendered legacy patch with `kubectl patch --dry-run=server --type strategic
--patch-file <private-plan-file>` before the final image-only patch. Do not
change live routing to make a pre-release check pass.
