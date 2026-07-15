# Rotation + key-custody runbook

This is the manual procedure for **rotating your registry's countersign root** and
for **holding the countersign key in custody**. It picks up where the install
quickstart leaves off — [`install.md`](install.md) generated your first trust-root
document; this page replaces the key behind it, without a flag day, and covers what
to do when a key is compromised.

Rotation is **manual this phase** (SPEC §9, GW-D19 SCOPE cut): there is **no
automated rotation service**. The two operator scripts here — `rotate:root` and
`rotate:dry-run` — perform the one cryptographic step (cross-signing) and validate
the result; every process step (generate the new key, publish the document, run the
overlap window, switch signing, drop the old root) is a deliberate operator action
you walk from this page. A registry is **supply chain, never a control plane**
(SPEC §1): rotation changes the roots hosts *pin*, and hosts re-pin on their own
release cadence — the registry never reaches into a host to force a change.

Everything below is self-host-neutral. The flagship instance holds a single review
roster under the launch-phase waiver (SPEC §4a); its custody note simply points
here — the procedure is the same.

## The pieces (read this first)

- **Countersign root** — the identity a host pins to anchor your registry's
  **approval** (`registrySig`) signatures. It is the `sha256:` fingerprint of your
  countersign certificate's public key (SPEC §2, §4.4); an operator reproduces it
  straight from the certificate. Rotating "the root" means moving to a **new
  countersign key** and getting hosts to pin its fingerprint.
- **Pin** — a host's out-of-band declaration that a root is trusted for your
  registry. Hosts never trust a trust-root document blind; they match it against a
  pin shipped in the host build or supplied as deploy config (SPEC §4.4). This is
  why rotation needs an **overlap window**: hosts change their pins on their own
  clock, not yours.
- **Overlap document** — a trust-root document that lists **both** the outgoing and
  incoming roots and carries a **`crossSig`**: the outgoing key's signature over the
  document. During the overlap a host pinned to either root trusts it, and the
  cross-signature is the proof the outgoing root authorized the incoming one — so a
  host can safely add the incoming pin (SPEC §4.4).
- **Custody** — the countersign private key is held **offline**, distinct from any
  reviewer's publishing identity (SPEC §2, §4a). See
  [Key custody](#key-custody-spec-2-4a) below and [`../countersign.md`](../countersign.md).

## Prerequisites

- The prerequisites from [`install.md`](install.md#prerequisites): Node 20+, `npm`,
  and `openssl`, from a checkout of this repo (`npm install`).
- The **outgoing** countersign key — the one your instance currently countersigns
  with (`COUNTERSIGN_PRIVATE_KEY` / `COUNTERSIGN_CERTIFICATE`). It is the
  cross-signer, so the rotation ceremony is run where that key is available.

---

## Part 1 — Overlap-window rotation

The planned rotation: move to a new countersign key while every host keeps loading
releases throughout. Do this to retire an ageing key on schedule — **not** for a
compromised key, which cannot cross-sign (see [Part 3](#part-3--key-compromise-path)).

### Step 1 — Generate the incoming key (offline)

Mint the new P-256 key and a self-signed certificate offline, exactly as at install
([`../countersign.md`](../countersign.md#generating-a-self-signed-countersign-key-self-hosters)).
Keep the private key offline; you only feed its **certificate** to the next step.

```sh
openssl ecparam -name prime256v1 -genkey -noout -out new-countersign.key
openssl req -x509 -new -key new-countersign.key -days 365 \
  -subj "/CN=$(hostname) countersign" -out new-countersign.crt
```

The incoming root a host will pin is the fingerprint of this certificate — check it
now so you can hand it to host operators:

```sh
openssl x509 -in new-countersign.crt -pubkey -noout \
  | openssl pkey -pubin -outform DER \
  | openssl dgst -sha256 | awk '{print "sha256:"$2}'
```

### Step 2 — Cross-sign the overlap document

Run `rotate:root` with the **outgoing** key in the environment (the same env the
service runs with) and the **incoming** certificate as `--incoming-cert`. It reuses
the service's own key handling, so the outgoing root it cross-signs with is exactly
the one the running instance countersigns with:

```sh
export REGISTRY_ID="registry.example.com"
export OIDC_ISSUER_ALLOWLIST="https://token.actions.githubusercontent.com"
export COUNTERSIGN_PRIVATE_KEY="$(cat countersign.key)"        # OUTGOING key
export COUNTERSIGN_CERTIFICATE="$(cat countersign.crt)"        # OUTGOING cert

npm run rotate:root -- --incoming-cert new-countersign.crt     # writes ./trust-root.overlap.json
```

The output is a `@gridmason/protocol` `TrustRootDoc` whose `countersignRoots` lists
the outgoing root **and** the incoming root, plus a `crossSig` over its canonical
bytes (SPEC §4.4). It prints both fingerprints and the validity window. The other
trust anchors (issuer allowlist, log keys, publisher-CA roots) carry over unchanged
— a rotation moves only the countersign root. `TRUST_ROOT_LOG_PUBLIC_KEYS` and
`TRUST_ROOT_PUBLISHER_CA_ROOTS` behave exactly as in
[`install.md`](install.md#2-generate-the-trust-roots).

> The overlap document's **validity window** (`--validity-days`, default 365) is the
> lifetime of the document itself. The **overlap window** below is a separate,
> operator-run duration — keep the document valid for at least as long as the
> overlap runs.

### Step 3 — Publish it and announce the incoming root

Publish `trust-root.overlap.json` the same way you publish your trust-root document
— in your **transparency log** and alongside the instance — replacing the current
one (SPEC §2: new roots are published in the transparency log). Then **hand the
incoming root fingerprint to your host operators** and ask them to *add* it to their
pins (keeping the outgoing pin). The cross-signature is their assurance the incoming
root came from you.

At this point **nothing else changes**: your instance still countersigns releases
with the **outgoing** key, so every existing host keeps verifying releases against
the pin it already holds.

### Step 4 — Run the overlap window (≥ one host release cycle)

Leave the overlap document published for **at least one host release cycle** (SPEC
§2). That is the whole point of the window: it guarantees every host has had a
release in which to ship the incoming pin *before* your instance starts signing with
the incoming key. During the window:

- A host pinned to the **outgoing** root trusts the overlap document and verifies
  releases (still outgoing-signed). ✔
- A host that has added the **incoming** pin also trusts the document (it lists both
  roots). ✔

Do **not** switch the signing key until the window has fully elapsed. A host that
has not yet pinned the incoming root cannot verify an incoming-signed release — the
release countersignature is checked against the host's *pinned* keys, and a valid
`crossSig` authorizes *pinning* the incoming root, not verifying a release under it.
The window is what closes that gap.

### Step 5 — Switch signing and drop the outgoing root

Once the window has elapsed and hosts have pinned the incoming root, complete the
rotation in one move:

1. **Reconfigure the instance to countersign with the incoming key** — project the
   incoming PEMs as `COUNTERSIGN_PRIVATE_KEY` / `COUNTERSIGN_CERTIFICATE` and
   restart. New releases are now signed under the incoming root.
2. **Publish a single-root document** that lists only the incoming root, dropping
   the outgoing one. This is ordinary install-time generation under the new key:

   ```sh
   export COUNTERSIGN_PRIVATE_KEY="$(cat new-countersign.key)"   # now the INCOMING key
   export COUNTERSIGN_CERTIFICATE="$(cat new-countersign.crt)"
   npm run trust-root:init -- --force                            # single-root document
   ```

A host that pinned both roots keeps working (it still matches the incoming root and
holds the incoming key). A host that never pinned the incoming root during the window
is now refused until it re-pins — **fail-closed** (SPEC §4.4). Hosts drop the stale
outgoing pin on their next release.

The outgoing key can now be **retired** (destroyed per your custody policy). The
rotation is complete.

---

## Part 2 — Validating dry-run

Before (or instead of) touching a live instance, prove the overlap behaves as
documented. `rotate:dry-run` walks the whole ceremony against throwaway keys — no
live registry, no database — and checks every claim with the **host's own**
`@gridmason/protocol` functions (`parseTrustRoot`, `evaluateTrustRoot`), so what it
proves is exactly what a real host decides. It exits non-zero if any host decision
disagrees with this runbook.

```sh
npm run rotate:dry-run
```

A representative run (your fingerprints are instance-specific and will differ):

```text
Rotation dry-run — overlap-window countersign-root rotation

Step 1–2 — overlap document generated
  outgoing root: sha256:58e281c5dbb8c0c123e1012d99d8eaf2e9a9cfcb01f75d433852247f9f97f148
  incoming root: sha256:9321575c9539a603c58fa2a28b8d1f4d1714c5552d8b954995720ba23c795980
  valid 2026-07-14T00:00:00.000Z → 2027-07-14T00:00:00.000Z
  ✓ document lists both roots
  ✓ document carries a crossSig
  ✓ crossSig verifies under the outgoing root (verifyRelease §4.4 check)

Step 3 — during the overlap window (host decisions)
  ✓ host pinned to the OUTGOING root → trusted (overlap)
  ✓ host pinned to the INCOMING root → trusted (overlap)
  ✓ host pinned to neither root → refused (fail-closed)

Step 4 — after the window: drop the outgoing root
  new document lists only: sha256:9321575c9539a603c58fa2a28b8d1f4d1714c5552d8b954995720ba23c795980
  ✓ dropped document carries only the incoming root
  ✓ host still pinned only to the OUTGOING root → refused (must re-pin)
  ✓ host pinned to the INCOMING root → trusted

PASS — hosts accept either root during overlap; the outgoing root is refused once dropped.
```

The same behaviour is locked in CI by `test/rotate-root.test.ts`, which asserts the
overlap document parses, validates against the shipped JSON Schema (FR-5), and is
accepted by a host pinned to *either* root — and refused once the outgoing root is
dropped.

---

## Key custody (SPEC §2, §4a)

The countersign key is the registry's **approval** authority; its custody is what
keeps approval separate from review.

- **Offline, and distinct from the publishing identity.** The private key is
  generated offline and projected into the running service only as a secret — env
  vars or a secret-manager mount, never written from the application UI (SPEC §4a:
  "offline key, distinct from the reviewer's publishing identity"). In this codebase
  the separation is **structural**: the key loads only from `COUNTERSIGN_PRIVATE_KEY`
  / `COUNTERSIGN_CERTIFICATE`, which are distinct from the reviewer roster
  (`REVIEW_REVIEWER_IDENTITIES`); the countersign path never reads a review-lane
  credential. Full detail in [`../countersign.md`](../countersign.md#key-custody-spec-2-4a).
- **The rotation ceremony runs in custody.** Cross-signing (Step 2) needs the
  outgoing private key and produces the incoming root from a certificate only — the
  incoming private key never touches `rotate:root` and stays offline. Run the
  ceremony where the outgoing key is available, then return it to custody.
- **Single-operator instances still document custody.** Even where the operator and
  reviewer are one person (the flagship at launch, SPEC §4a), the key is held under
  this procedure so the separation is real the moment a second person joins. The
  flagship's single-roster custody note references this runbook rather than
  restating it.

---

## Part 3 — Key-compromise path

A compromise is **not** an overlap rotation: a compromised outgoing key cannot be
trusted to cross-sign its own successor, so there is no cross-signed overlap and
hosts must re-pin out of band. The goal shifts from "no flag day" to "stop loading
the bad artifacts now, then re-key." The order (SPEC §2):

### 1. Kill the affected artifacts (fleet-wide, via the revocation feed)

Everything signed under the compromised key is suspect. Issue a **kill** for each
affected artifact through the R-E2 revocation feed — `killed` blocks new loads
**and** force-unloads running instances (see
[`../api/revocation-feed.md`](../api/revocation-feed.md)):

```sh
curl -fsS -X POST https://registry.example.com/v1/ops/artifacts/<artifact-id>/kill \
  -H "authorization: Bearer $OPS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"severity":"critical","reason":"countersign key compromise"}'
```

Hosts poll the feed on their TTL clock (≤ 1 h online bound, SPEC §6) and unload the
killed remotes — this is the fleet-wide kill switch. The registry also drops killed
artifacts from its own resolution output, so they stop entering import maps at the
source.

### 2. The transparency log flags the affected versions

Every release was anchored in the transparency log at approval
([`../countersign.md`](../countersign.md#transparency-log--sigstore-public-instance-dependency-gw-d17)),
so the logged leaves are the authoritative record of **what was signed under the
compromised key** — use them to enumerate the versions to kill in Step 1 and to
scope the re-signing in Step 4. Nothing signed under the key can be un-signed; the
kill feed is what makes those versions non-loadable.

### 3. Re-key (a forced re-pin, not an overlap)

Generate a fresh countersign key offline (Step 1 of Part 1), reconfigure the
instance to countersign with it, and publish a **single-root** document under the new
key (`npm run trust-root:init --force`). Because the compromised key cannot
cross-sign, there is **no overlap document**: distribute the new root fingerprint to
host operators over a trusted out-of-band channel and have them **replace** the
compromised pin. Hosts that have not re-pinned fail closed — which is the intended
outcome while a key is known-bad.

### 4. Re-sign the clean releases under the new key

For artifacts that were legitimate but signed under the compromised key, re-run them
through publish/review so they are countersigned afresh under the new key and
re-anchored in the log, then lift their kill once a clean release exists. Artifacts
that were themselves malicious stay killed.

---

## See also

- [`install.md`](install.md) — first-time trust-root generation (Part 1 replaces the
  key behind it).
- [`../countersign.md`](../countersign.md) — countersign key custody, the signing
  algorithm, and the transparency-log dependency.
- [`../api/revocation-feed.md`](../api/revocation-feed.md) — the revoke/kill feed the
  compromise path drives.
- `docs/SPEC.md` §2, §4a, §4.4 — the rotation, custody, and pinning requirements
  (FR-9) this runbook satisfies.
