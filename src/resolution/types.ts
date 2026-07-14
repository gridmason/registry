/**
 * Resolution API wire contract (FR-7, FR-10; SPEC §8, §9; GW-D22).
 *
 * The Resolution API turns a **gate snapshot** — the set of remotes a host shell
 * has enabled — into an **import-map fragment** the shell merges into its native
 * ESM import map (GW-D22: no Module-Federation runtime). The fragment carries, per
 * resolved module, a **hash-pinned** entry URL (pointing at the R-E2 serving
 * origin) and the **signature bundle** the host verifies with `@gridmason/protocol`
 * before it loads a byte, plus `scopes` entries that resolve shared-dependency
 * majors when two widgets need different ones.
 *
 * **These shapes now live in `@gridmason/protocol`.** They were owned by the
 * registry until a second consumer — the Gridmason Dashboard's Phase-B remote
 * loader (dashboard D-E3.1) — joined as a user of the same contract, so they were
 * promoted into `@gridmason/protocol@0.3.0` (`types/resolution`, protocol #66) with
 * generated JSON schemas + ajv vectors and zero field drift versus the shapes the
 * registry had shipped. The registry now **re-exports** them from the shared
 * package rather than owning them; the resolver (`./resolve.ts`), the shared-scope
 * matcher (`./shared-scope.ts`), and the HTTP route (`../http/resolution`) continue
 * to import from `./index.js` unchanged. `POST /v1/resolve` output validates
 * against `@gridmason/protocol/schemas/import-map-fragment.json`
 * (see `test/resolution/schema.test.ts`).
 *
 * **Anonymous.** The API takes no auth and requires no deployment registration —
 * a registry is never a control plane a deployment must phone (SPEC §1, §8). The
 * gate snapshot is the *host's* enablement state; the registry only maps it to
 * verifiable URLs.
 *
 * **Source-qualified (SPEC §9, FR-10).** Publisher prefixes are unique only within
 * a registry, so every output is qualified by this registry's id: the fragment
 * carries {@link ImportMapFragment.registry}, and each module is keyed by
 * `(registry, publisher, tag)`. A host merging fragments from several registries
 * pins each prefix to one registry and composes absolute URLs by prepending that
 * registry's pinned serving origin to the root-relative paths here.
 */
import type { Manifest } from '@gridmason/protocol';

export type {
  /** One enabled remote in a host's gate snapshot (exact source-qualified `(publisher, tag, version)`). */
  GateModule,
  /** One shared-dependency major the host shell offers for a bare specifier. */
  SharedOffer,
  /** A gate snapshot: the request body of `POST /v1/resolve`. */
  GateSnapshot,
  /** The signature bundle a host verifies before loading a module (`verifyRelease` inputs). */
  SignatureBundle,
  /** One resolved module in a fragment: source-qualified identity + hash-pinned URL + bundle. */
  ResolvedModule,
  /** Stable machine code for why a requested module was not placed in the fragment. */
  ExclusionReason,
  /** A module the host asked for that did not enter the fragment, with the reason. */
  ExcludedModule,
  /** The import-map fragment: the response body of `POST /v1/resolve`. */
  ImportMapFragment,
} from '@gridmason/protocol';

/**
 * The manifest fields resolution reads (a structural narrowing of {@link Manifest}).
 * Registry-local: not part of the promoted Resolution API wire contract — it names
 * only the two manifest fields the resolver consults, so it stays a `Pick` here.
 */
export type ResolutionManifest = Pick<Manifest, 'entry' | 'sharedScope'>;
