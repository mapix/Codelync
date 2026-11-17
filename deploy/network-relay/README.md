# Codelync network relay

This is the public HTTP/WebSocket forwarding service, not the embedded
`packages/relay` account mirror or the LiveKit desktop media server.

Use [the self-hosting guide](../../docs/SELF-HOSTING.md) and
[`../self-host/`](../self-host/) for the complete Linux Compose setup.

## Docker image

Build from the **repository root**:

```sh
docker build -f deploy/network-relay/Dockerfile -t codelync-network-relay:local .
```

`Dockerfile.dockerignore` restricts the build context to the deployment manifest
and network source. The root workspace dependencies, private settings, extracted
apps and generated assets are not sent to the builder. The manifest pins only
`ws` and `tweetnacl`; no root pnpm install is required. The default image retains
the existing Node 24.22.2 production patch line. `NODE_IMAGE` can select an
operator-reviewed compatible Node 24 image or digest.

Runtime variables: required `REGISTRATION_TOKEN` (32–256 base64url characters),
optional `HOST` (default `0.0.0.0`) and `PORT` (default `8081`). Put HTTPS/WSS in
front of the service. For a single-host proxy, bind `HOST=127.0.0.1`. Use a
private env file, never a token in the URL, QR, image or shell command history.

## Kubernetes

`kubernetes.yaml` is an example for an existing nginx Ingress and cert-manager
installation. Set your hostname, TLS issuer and immutable image reference before
applying. Create the namespace and registration secret separately:

```sh
kubectl create namespace codelync
kubectl -n codelync create secret generic codelync-network-registration \
  --from-file=token=/secure/path/registration-token
```

The token file must contain the credential bytes without a trailing newline.
The template uses **one replica**, `Recreate`, a ClusterIP service and an ingress
policy limited to ingress-nginx. It uses `imagePullPolicy: Never`: preload the
image on the selected node, or change that policy and configure your registry
before deploying. Adjust namespace labels and network policy for your cluster.
HTTP health probes do not prove tunnel registration; finish with the Mac's
**Validate & save Relay** and real paired-phone checks.

`Dockerfile.verified-runtime` is the existing restricted-network alternative.
It expects a separately staged context containing the verified Linux musl Node
binary, this package manifest, its dependencies and `src/network/`; it does not
use the repository-root context of the standard Dockerfile.
