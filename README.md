# registry

Gridmason Registry — open-source, self-hostable federated widget/plugin registry: signed content-hashed remotes, publisher records, review pipeline, dual-signature + transparency log. Flagship hosted instance: `registry.gridmason.dev`. Public OSS (AGPL-3.0). Engineering spec: `docs/SPEC.md` · Build plan: `docs/specs/registry-v0/spec.md`.

> **Status:** service skeleton (R-E0). This is the runnable spine — HTTP server,
> config, health, structured logging, and the audit seam. It deliberately
> implements **no** publish, review, serving, or resolution behaviour; those
> arrive in later epics.

## Requirements

- Node.js >= 20 (developed on Node 22+)
- npm

## Run locally

```sh
npm install       # install dependencies
npm run dev       # start with reload (tsx watch)
```

Or build and run the compiled output (the same path the container uses):

```sh
npm run build     # compile TypeScript to dist/
npm start         # node dist/index.js
```

Then:

```sh
curl -i localhost:8080/healthz   # 200 while the process is up
curl -i localhost:8080/readyz    # 503 until the storage layer lands (#3)
```

Configuration is entirely environment-driven — see [`docs/config.md`](docs/config.md)
for every variable and its default. To stand up your own instance, follow the
[self-host quickstart](docs/self-host/install.md). Example:

```sh
PORT=3000 LOG_LEVEL=debug npm start
```

### Endpoints

- `GET /healthz` — **liveness**. Returns `200` with `{ "status": "ok", ... }`
  whenever the process is up.
- `GET /readyz` — **readiness**. Returns `200` only when every readiness probe
  passes, `503` otherwise (body lists the failing checks). Reports not-ready
  until the storage layer (#3) is wired in.

### Logging

Structured JSON, one object per line, on stdout. Every line carries `level`
(label), `time` (ISO 8601), `message`, `service`, and — for request-scoped
lines — the correlation id under `reqId`. A caller may supply the correlation id
via the `x-request-id` header (configurable); it is echoed back on the response.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Run with reload via `tsx watch`. |
| `npm run build` | Compile `src/` to `dist/`. |
| `npm start` | Run the compiled service. |
| `npm test` | Run the test suite (Vitest). |
| `npm run lint` | ESLint. |
| `npm run typecheck` | `tsc --noEmit`. |

## Container

```sh
docker build -t gridmason-registry .
docker run --rm -p 8080:8080 gridmason-registry
```

The image is multi-stage (build → prod deps → minimal non-root runtime) and
ships a `HEALTHCHECK` that probes `/healthz`. CI builds the image, boots it, and
asserts the healthcheck returns `200`.

## Layout

```
src/
  index.ts        entrypoint: config → logger → server → listen → graceful shutdown
  server.ts       Fastify assembly + correlation-id wiring
  config/         typed, env-driven configuration loader
  logging/        structured (pino) logger factory
  audit/          FR-12 audit seam: emitAuditEvent + pluggable sink
  http/
    health.ts     /healthz + /readyz routes
    readiness.ts  readiness-probe registry (storage probe pending #3)
test/             Vitest suites
```

## Technology choices

The service is **Node + TypeScript (ESM)** per the engineering spec (SPEC §9,
GW-D15) — one toolchain shared with `@gridmason/{protocol,core,sdk,cli}`, so the
verification library and review checks are the *same code* server-side, not a
reimplementation. It depends on `@gridmason/protocol` (types-only at this stage)
to prove that shared-toolchain wiring.

- **HTTP framework — [Fastify](https://fastify.dev/).** The build spec left the
  framework open; Fastify is the default. It is a mature, low-overhead,
  TypeScript-friendly server with first-class structured logging (pino is its
  native logger, so app and request logs share one instance and format),
  built-in request-id/correlation handling, schema-based validation for the
  route surface that later epics add, and a plugin model that keeps each epic's
  routes encapsulated.
- **Logger — [pino](https://getpino.io/).** Chosen because it *is* Fastify's
  logger: one instance covers request and application logging with no bridging,
  and it emits exactly the one-JSON-object-per-line format the NFRs require.

Both are pinned in `package.json`.

## Operator policy page

Every registry instance publishes a **policy page** stating how it reviews,
signs, and serves remotes — the mechanism is platform, the policy is the
operator's, and it is published (no secret rules, SPEC §4). The in-repo template
renders two variants from one source: the flagship invite-only launch instance
and the neutral self-host default. See [`docs/policy/`](docs/policy/) and run
`npm run policy:render`.

## Contributing & community

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — dev setup, the design principles this
  repo holds to, and the PR checklist.
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — Contributor Covenant 2.1.
- [`SECURITY.md`](SECURITY.md) — report vulnerabilities privately, never as a
  public issue.
- [Contributor License Agreement](.github/CLA.md) — required; the CLA gate blocks
  merge until it is signed.

## License

[AGPL-3.0](LICENSE). External contributions require the Gridmason CLA.
