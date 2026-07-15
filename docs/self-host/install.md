# Self-hosting the Gridmason Registry

This is the fresh-machine quickstart: it stands up a working registry from the
single container image plus its Postgres and object store, generates the instance's
own trust roots, publishes its policy page, and reaches a **publishable instance** —
a state where `gridmason publish --registry <url>` can target it.

A self-hosted instance is a **full registry**: its own trust roots, its own
publisher records, its own review policy. It runs the **same released image** as the
flagship — there is no proprietary fork — and it inherits **none** of the flagship's
launch-phase waivers (SPEC §9, §4a). Everything below is self-host-neutral.

Scope of this cut (SPEC §9, GW-D19): a single container image + `compose` (Helm is a
stretch, not shipped). Object store + database are the only backing services.
Trust-root **rotation** is manual this phase and lives in its own runbook
(`docs/self-host/rotation.md`); this page covers **generation at install** and points
there. There is no publisher console, no offline-bundle serving, and no self-hosted
transparency log (Phase C) — see the SCOPE cut in `docs/SPEC.md`.

## Prerequisites

- Docker with the Compose plugin (`docker compose`).
- Node 20+ and `npm` — for the migration, trust-root, and policy-render steps, which
  run from this repo checkout via `npm run …` (they are docs/ops helpers, not part of
  the running image).
- `openssl` — to generate the countersign key.

Clone this repo and install the dev dependencies the helper scripts use:

```sh
git clone https://github.com/gridmason/registry.git
cd registry
npm install
```

## 1. Bring up the stack

[`compose.yaml`](../../compose.yaml) defines the whole local stack: Postgres
(records, review queue, audit log), MinIO (an S3-compatible object store for
artifacts, release docs, and feeds), a one-shot that creates the bucket, a one-shot
that applies migrations, and the registry service.

```sh
docker compose up --build -d
```

This builds the image, starts Postgres and MinIO, creates the bucket, runs the
database migrations, and starts the registry on **http://localhost:8080**. The
migration one-shot is idempotent and always runs before the service (it is also
available directly as `npm run migrate` — see [`config.md`](config.md#database-migrations)).

> The compose stack uses **development-only** credentials and runs the in-process
> (`memory`) transparency log with no public anchoring — fine to evaluate the install,
> **not** a production configuration. For a real instance set your own secrets and
> `TRANSPARENCY_LOG_DRIVER=rekor`; [`config.md`](config.md) is the full reference.

### Confirm the instance is ready

`GET /healthz` is liveness (up as soon as the process serves); `GET /readyz` is
readiness (200 only once Postgres **and** the object store are reachable):

```sh
curl -fsS http://localhost:8080/healthz          # {"status":"ok",...}
curl -fsS http://localhost:8080/readyz           # {"status":"ready","checks":[...]}
```

## 2. Generate the trust roots

A host bootstraps trust in your registry from a **pinned trust-root document** — the
signed statement of the roots it must pin you against (SPEC §2, §4.4). Hosts never
fetch it blind: an operator pins one of its `countersignRoots` out of band, and a host
refuses a document no pin covers. You generate this document once, at install, in the
public [`@gridmason/protocol`](https://www.npmjs.com/package/@gridmason/protocol)
`TrustRootDoc` format.

The document anchors the registry's **approval** signature, so you need a countersign
key first. Generate a self-signed one offline (full custody guidance in
[`../countersign.md`](../countersign.md)):

```sh
# P-256 private key + self-signed cert (keep the key offline).
openssl ecparam -name prime256v1 -genkey -noout -out countersign.key
openssl req -x509 -new -key countersign.key -days 365 \
  -subj "/CN=$(hostname) countersign" -out countersign.crt
```

Project the two PEMs and your instance identity into the environment, then generate
the document. `trust-root:init` reads the **same** env the service reads (see
[`config.md`](config.md)) and reuses the service's own key handling, so the root it
emits is exactly the one the running service countersigns with:

```sh
export REGISTRY_ID="registry.example.com"
export OIDC_ISSUER_ALLOWLIST="https://token.actions.githubusercontent.com"
export COUNTERSIGN_PRIVATE_KEY="$(cat countersign.key)"
export COUNTERSIGN_CERTIFICATE="$(cat countersign.crt)"

npm run trust-root:init            # writes ./trust-root.json
```

The output is a `TrustRootDoc` whose `countersignRoots` entry is the SHA-256
fingerprint of your certificate's public key — the identifier hosts pin. It is
**operator-checkable**: you can reproduce it straight from the certificate, and it must
match the value in `trust-root.json`:

```sh
openssl x509 -in countersign.crt -pubkey -noout \
  | openssl pkey -pubin -outform DER \
  | openssl dgst -sha256 | awk '{print "sha256:"$2}'
```

Publish `trust-root.json` alongside your instance and hand the `countersignRoots`
fingerprint to your host operators to pin. Optional fields:

- **`OIDC_ISSUER_ALLOWLIST`** flows into the document's `issuerAllowlist` — the issuers
  that anchor authorship. Set it to the issuers you accept publisher registrations from.
- **`TRUST_ROOT_LOG_PUBLIC_KEYS`** (comma-separated) pins your transparency log's
  key(s). The in-process `memory` log's key is ephemeral and is left empty; set this
  when you anchor to a durable log (Rekor).
- **`TRUST_ROOT_PUBLISHER_CA_ROOTS`** (comma-separated) adds publisher-CA roots for the
  issued-cert authorship path; omit it for the keyless OIDC path this cut uses.

Rotating a root later (publishing an overlap document cross-signed by the outgoing
root) is manual — see the rotation runbook `docs/self-host/rotation.md`.

## 3. Publish your policy page

Every instance publishes a human-readable **policy page** stating how it reviews,
signs, and serves remotes (SPEC §4). Render the neutral **self-host** variant, which
carries none of the flagship's waiver language (separation of duties enforced,
operator-defined SLAs):

```sh
npm run policy:render -- --variant self-host
```

Customize it first by copying `docs/policy/variants/self-host.json` and filling in
every `operator: …` field (instance name, operator, review roster, SLAs, contacts,
countersign-key custody), then re-render and publish the resulting HTML. See
[`../policy/README.md`](../policy/README.md). **Do not** copy the flagship's waiver
language.

## 4. Reach a publishable instance

At this point the control-plane API is live. Confirm the publish target responds — an
unauthenticated request is refused with `401`, which proves the endpoint is mounted and
reachable (a `404` would mean it is not):

```sh
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST http://localhost:8080/v1/artifacts \
  -H 'content-type: application/json' -d '{}'      # 401
```

To actually publish, finish wiring identity and a publisher record:

1. **Configure an OIDC issuer.** Publisher registration is bound to an OIDC identity;
   the issuer is the trust anchor (SPEC §2). Set `OIDC_ISSUER_ALLOWLIST` (and, ideally,
   `OIDC_AUDIENCE` to this registry's id) — see [`config.md`](config.md#identity-oidc)
   and [`../api/publisher.md`](../api/publisher.md). An instance with an empty allowlist
   accepts **no** registrations (fail closed).
2. **Register a publisher** and claim a namespace prefix (`POST /v1/publishers`, bearer
   token from an allowlisted issuer).
3. **Set the reviewer roster** (`REVIEW_REVIEWER_IDENTITIES`) — an upload moves through
   automated checks and the human review lane before it is countersigned and served.
4. **Publish** with the CLI against your instance:

   ```sh
   gridmason publish --registry https://registry.example.com
   ```

The registry content-addresses each part, runs the shared checks, moves the artifact
through review, and — once approved — countersigns it with your countersign key and
anchors it in the transparency log, emitting a signed release document the serving and
resolution surfaces hand to hosts. That release verifies against your published
`trust-root.json`.

## Going to production

The compose stack is an evaluation default. Before running for real, at minimum:

- Replace every development credential (Postgres, object store) — see the
  security note in [`config.md`](config.md#object-store).
- Point `DATABASE_URL` and the `OBJECT_STORE_*` settings at managed Postgres and S3
  (`OBJECT_STORE_FORCE_PATH_STYLE=false` for real AWS S3).
- Set `TRANSPARENCY_LOG_DRIVER=rekor` so releases are publicly anchored (the boot guard
  refuses the `memory` log under `NODE_ENV=production` unless you explicitly accept no
  public log — see [`config.md`](config.md#countersign--transparency-logging)).
- Set `REGISTRY_ID` to your canonical id (it becomes the widget `source` string and
  qualifies every published identity), and keep the countersign key in a
  secret manager, projected into the process.

[`config.md`](config.md) documents every setting.
