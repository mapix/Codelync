# Codelync self-hosting templates

[Deployment guide](../../docs/SELF-HOSTING.md) ·
[中文部署指南](../../docs/SELF-HOSTING.zh-CN.md)

These Linux Docker Compose templates run either Codelync's HTTP/WebSocket
network relay, an external LiveKit media server, or both. The Mac already owns
an embedded LiveKit server in **This Mac** mode. Deploying the network relay
alone does not forward that server's WebRTC media.

1. Copy `.env.example` to `.env` and set the domain for each service you need.
2. With Node 24, run `node configure.mjs`. It generates independent credentials
   and private `.env`, `Caddyfile` and `livekit.yaml` files. Re-running it retains
   credentials and regenerates configuration from `.env`.
3. Run the appropriate profile:

   ```sh
   # Network relay only; no external LiveKit is started.
   docker compose --profile network up -d --build
   # External media only; keep an existing Codelync communication channel.
   docker compose --profile media up -d
   # Both services.
   docker compose --profile network --profile media up -d --build
   ```

Set unused domains to empty, rather than leaving example domains in `.env`.
`node check.mjs` checks the configured HTTPS endpoints; it does not test ICE,
TURN, authenticated relay registration or a phone's real desktop connection.
Use the full guide for ports, Mac fields, TURN certificates and acceptance.

Compose uses Linux host networking, requires exclusive use of its selected
ports, and uses one network-relay instance. Caddy obtains public TLS certificates
and retains them in named volumes. Generated configuration and certificates are
ignored by Git and are not publication inputs. Do not share `docker compose
config` output: it contains the registration credential.
