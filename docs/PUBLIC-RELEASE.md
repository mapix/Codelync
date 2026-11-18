# Public Mac release and static website

Source: <https://github.com/mapix/Codelync>

Website: <https://codelync.novarock.io/>

The website serves static introduction/download files only. The Mac App keeps
hosting its own relay, keys, native observers and pairing. Do not deploy that
personal session service into the website's Kubernetes namespace.

## Reviewed source snapshot

Keep private development history locally. Create the initial public Git history
from the same source selection as the current archive, using
`copyPublicSourceSnapshot` in `src/release/source-snapshot.mjs`. It permits the
standalone source/configuration roots, excludes private/generated inputs and
obsolete prototype artifacts, skips deleted tracked files and refuses symlinks.
Do not push the original local history or upload the complete workspace.

```sh
pnpm package:source
node scripts/verify-codelync-source.mjs --install
```

Scan the fresh extracted snapshot with the repository's `.gitleaks.toml`, then
scan the new initial Git history before pushing it. The source ZIP and public
commit must reflect the final tested source; regenerate them after any fixes.
Do not reuse a source archive from an earlier candidate just because its build
or secret scan passed.

For later updates, apply the reviewed source selection to the existing clean
public checkout and retain its public history. Remove public files absent from
the new selection, inspect the diff, then run source/privacy/history scans before
committing. Never merge or push the original private development history.

## Codelync 1.0.0 beta preparation

Mac and iPhone use version `1.0.0`, build `2026111705`, with the Codelync
application identifiers. The distribution targets existing Gateway setups in
Codex, Antigravity Desktop and Claude Desktop. English, Chinese and Japanese
follow the system language by default. Remote Desktop is hidden on iPhone until
its feature switch is enabled in Settings.

Publish only after source/privacy checks, Developer ID signing, Apple
notarization, stapling and external download verification. TestFlight joining
remains hidden until the exact external build is approved and its public group
is enabled. The website publishes verified Apple status; older immutable Mac
downloads remain available.

## Prior preview 0.7.2

Mac 0.7.2 and iPhone 1.9.2 share build `2026111702`. This preview corrects Spaces
input-queue/readiness handoff and Codex fresh-owner read admission. Old history
cursors and native write identities retain their guards; unknown commands are
not replayed. The three Desktop sources remain individually optional, enabled
by default, and the original applications keep their sessions and runtimes.
Claude Desktop Gateway's complete formal controls remain unaccepted; CLI/TUI
families are deferred.

The user explicitly authorized publishing the existing candidate and updating
source, website and packages. Physical-phone feedback is still being collected;
it is not marked as passed. Reuse the current archive's verified technical
records rather than rebuilding or repeating notarization:

- File: `CodeLight-0.7.2-macos-arm64.zip`
- Bytes: `156993885`
- SHA-256: `aa0432d8d69cc8625bd24f84fcb8115eda435a6039c82af4e5b365c724c8fbe9`
- Apple notarization: Accepted; ticket stapled; Gatekeeper accepted; final ZIP
  privacy review passed for these exact bytes.

Keep the iPhone install private and publish no device-bound IPA or provisioning
profile. Freeze the selected source, commit/push its reviewed canonical history,
then bind the public release pointer to that source commit. Existing 0.5.8 and
0.6.1 downloads/checksums remain available.

## Prior mobile experience 0.7.1 candidate

Mac 0.7.1 and iPhone 1.9.1 share build 2026111701. The remote page uses one
landscape canvas, translucent expandable controls and a focused native keyboard.
Confirmed input acknowledgments protect local editing; unknown results retain
the draft. Use this candidate's own build and phone acceptance record.

## Prior integrated 0.7 candidate

Mac 0.7.0 and iPhone 1.9.0 share build 2026111608. The device package is a full
native Release build. The three Desktop subscriptions default to selected and
persist independently; remote desktop is separate and defaults to disabled.
Available session operations still depend on each original owner's confirmed
capabilities. Claude Desktop Gateway's complete controls remain unaccepted.

The installed trial preserves existing pairing and data. Record the user's
phone acceptance separately from signing, install success and pairing bootstrap.
Prepare a public Mac artifact with portable native compiler paths, a fresh
privacy review and Apple notarization; leave the installed trial intact. Keep
the verified public download until all current-candidate publication gates pass.

## Historical version 0.5 behavior

Mac Local network, Cloudflare and configured Relay are independent checkbox
entries, enabled by default on first migration. One pinned-key QR conveys all
enabled candidates; the phone proves a reachable channel automatically and has
a manual Connection sheet. LAN authorization stays sealed to the approved
device, and public channels retain TLS validation. Same-peer route changes keep
the account/session cache and recover uncertain operations by their original
receipts, without mutation replay.

Directory pages are ordered by original Codex update time. Entries older than
72 hours default to basic title/project/time information. Opening a session
waits for its existing observation, then loads a fresh recent window at the
newest end. Older history is bounded and requested only on explicit upward
scroll; current/native status is independent of message age. These code rules
do not substitute for the physical-phone acceptance recorded per release.

## Build and sign

Use the pinned workspace and a supported Node 24 LTS patch. For official runtime
inputs, download the macOS arm64 archive from nodejs.org, verify its exact filename
against `SHASUMS256.txt`, and supply its license. Download cloudflared's macOS
arm64 release from the official Cloudflare repository and verify the release
asset digest. Keep downloaded binaries and credentials outside Git.

```sh
pnpm install --frozen-lockfile
pnpm typecheck:all
pnpm lint
pnpm security:release
pnpm build:native
CODELYNC_NODE_BINARY=/absolute/path/to/verified/node \
CODELYNC_NODE_LICENSE=/absolute/path/to/Node-LICENSE \
CODELYNC_CLOUDFLARED_BINARY=/absolute/path/to/verified/cloudflared \
node scripts/build-mac-app.mjs /absolute/path/to/release/Codelync.app
# Uses package.json version (1.0.0) and codelyncBuild (2026111705) unless CODELYNC_MAC_BUILD is set.
node scripts/sign-mac-app.mjs /absolute/path/to/release/Codelync.app \
  'Developer ID Application: Your Name (TEAMID)'
codesign --verify --deep --strict /absolute/path/to/release/Codelync.app
```

Copy bundles with `ditto` or `verbatimSymlinks: true`. Rewriting relative symlinks
breaks the resource seal. Do not modify an original Codex bundle or overwrite a
running owner's data to verify a release.

## Apple notarization

Create a submission ZIP from the signed candidate with `ditto`. Submit through
Apple's official `notarytool` using your existing keychain profile, App Store
Connect API key or Apple ID/app-specific credentials. Keep credential values out
of logs, shell history and source. A completed upload is not acceptance.

```sh
ditto -c -k --keepParent /absolute/path/to/release/Codelync.app candidate.zip
unzip -tq candidate.zip
xcrun notarytool submit candidate.zip --keychain-profile YOUR_PROFILE --output-format json
xcrun notarytool info SUBMISSION_ID --keychain-profile YOUR_PROFILE \
  --output-format json > /private/path/notary-status.json
```

Wait until the real status is `Accepted`; retrieve the Apple log if invalid.
`prepare-mac-release.mjs` refuses other status, verifies the Codelync identity,
Developer ID/team/timestamp, staples and validates the ticket, assesses Gatekeeper,
then creates an immutable ZIP, SHA-256 file and public numeric release metadata.

```sh
node scripts/prepare-mac-release.mjs \
  --app /absolute/path/to/release/Codelync.app \
  --notary-status /private/path/notary-status.json \
  --output /absolute/path/to/public-release \
  --team YOUR_TEAM_ID
```

The ZIP is produced after stapling. Never attach a personal-development iPhone
IPA or signing profile to a public release.

## Static image and Kubernetes

Create a fresh build context with `Dockerfile`, `nginx.conf` and
`security-headers.conf` from `deploy/website`. Copy `website/` into `site/`, the
verified `release.json` into `site/release.json`, and only the public ZIP/checksum
into `site/downloads/`. Include the public source commit in release metadata.
When replacing a deployed release, include its existing versioned public
downloads/checksums in the new context as well; updating `release.json` must not
break an older immutable download URL. Verify retained bytes against the earlier
published digest. Personal phone IPAs and private notary records are excluded.
Do not send the complete workspace, `.git`, `.runtime` or private evidence as a
Docker build context. Pin the resolved nginx base-image digest for a release.

```sh
docker build --build-arg NGINX_IMAGE=nginxinc/nginx-unprivileged@sha256:VERIFIED_DIGEST \
  -t codelync-website:RELEASE_TAG /path/to/public/context
```

When the cluster already holds a verified base image, inspect its architecture
and content ID against the saved vendor verification before reusing its local
tag. Build with `--pull=false` and `--build-arg NGINX_IMAGE=YOUR_VERIFIED_LOCAL_TAG`;
do not silently pull a moving tag or change daemon-wide registry settings.
Record the resulting website image ID, use a fresh release tag, and import only
that exact image into the cluster's containerd store.

The supplied manifest targets the existing nginx ingress / `letsencrypt-prod`
issuer and a dedicated `codelync` namespace. Render the manifests with
`python3 deploy/website/render-manifests.py --phase prepare|route|legacy` (which
rejects unresolved `RELEASE_TAG` placeholders across all phases and substitutes
the immutable `codelync-website` image tag). This cluster's single-node workflow
imports the image into containerd and uses `imagePullPolicy: Never`; a multi-node
deployment must publish the image to your registry and update that policy before
scheduling elsewhere.

Create the dedicated namespace, validate the rendered manifest server-side, then
apply it. The website runs without root, a writable root filesystem, Linux
capabilities or a service-account token. Only the ingress controller may connect;
egress is denied. Existing cluster workloads and personal Codex owners remain
independent of this deployment.

```sh
kubectl create namespace codelync --dry-run=client -o yaml | kubectl apply -f -
kubectl apply --dry-run=server -f rendered-kubernetes.yaml
kubectl apply -f rendered-kubernetes.yaml
kubectl -n codelync rollout status deployment/codelync-website --timeout=180s
kubectl -n codelync wait --for=condition=Ready certificate/codelync-tls --timeout=180s
```

Verify HTTPS, security headers, language/FAQ controls, narrow layouts, the exact
download size/SHA-256, ZIP integrity and HTTP Range behavior. Publish only after
those checks. Keep deployment credentials in your own SSH/Kubernetes setup.

## Optional source CI

The reviewed GitHub Actions template is in `docs/ci/verify.yml`. The current
publisher cannot create workflows with its OAuth scope, so this release does
not activate Actions. A repository owner with workflow write permission may
copy the template into `.github/workflows/verify.yml` to enable it. Local type,
lint, security and scoped regression gates are executed before publication.

## Updating and recovery

Use a new immutable image/release filename for each update. Retain the previous
deployment revision and public artifact; roll back only this website's deployment
if verification fails. Do not remove old downloads while clients may still use
their versioned URL. A website rollback does not change any user's Mac session.

### Website copy updates

The existing site is `codelync.novarock.io`, served by
`codelync/codelync-website`. A copy update does not publish a new app release.
The 2026-11-16 Mac 0.6.1/build 2026111605 passed Apple Accepted, stapling and
Gatekeeper. Publish its verified release metadata and archive after the final
privacy check, retaining the immutable 0.5.8 archive and checksum. The private
iPhone development package remains separate from public downloads.

First update the website section of `spec/codelync-public-release.md`, using
`spec/codelync-error-recovery.md` and the verified Desktop capability rules.
Keep Chinese and English meaning aligned, preserve the current layout, and use
fictional examples. Check language switching, recovery FAQ, the current download
link and a narrow phone layout before deployment.
Set the HTML script query revision from the final `app.js` SHA-256. Verify normal
browser loading after publication; an uncached fetch alone cannot establish that
the page executed the matching language dictionary.

For a page-only update, `deploy/website/Dockerfile.copy-update` inherits the exact
previously verified static image and replaces the staged website, metadata and
nginx security files (`site/index.html`, `site/app.js`, `site/language.js`,
`site/japanese.js`, `site/styles.css`, `site/assets/icon.png`, `site/privacy.html`,
`site/support.html`, `site/testflight.json`, `site/release.json`, `nginx.conf`,
and `security-headers.conf`, keeping `app.js`, `language.js`, `japanese.js`, and
`styles.css` `?v=` hashes in sync with the HTML). Verify the selected current image
ID against the running deployment and its retained public archive/checksum.
Build with `--pull=false` and an explicit verified local `STATIC_IMAGE`; record
the resulting immutable image ID. This preserves existing `release.json`, all
versioned downloads, nginx configuration and security headers byte-for-byte.
Never include workspace, app state, phone packages or private QA in the context.

Import only that image into the existing cluster. Server-side dry-run a change
to the existing deployment image, then apply only that image change. Verify both
ready replicas, unchanged ingress/TLS/security headers, rendered bilingual copy,
the same public release metadata and a small Range response from its download.
Keep the previous revision and image available for a scoped website rollback.

### Updating the preview download

For 0.7.2, inherit the currently verified static image. First add only the new
immutable Mac ZIP/checksum and roll out both replicas while retaining the old
page and `release.json`. Once every replica holds the new file, publish the
updated four landing assets and verified 0.7.2 pointer. Include the final reviewed
public source commit in that pointer. Neither phase changes nginx security
configuration, ingress/TLS, services, network policy or other workloads.

Use a small, explicit public context; existing downloads stay in the inherited
image. Do not upload repository state, phone packages, profiles or private QA.
Verify the previous download hashes, the new archive's exact recorded bytes,
release metadata and normal HTTPS browser reload after deployment. A fresh hash
check alone does not prove that an existing browser executed the new dictionary.
