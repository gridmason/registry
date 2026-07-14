/**
 * Resolution API (FR-7, FR-10; SPEC §8, §9): gate snapshot → import-map fragment.
 * The registry-owned wire types, the gate-snapshot resolver, and the shared-scope
 * major matcher. Consumed by the HTTP route (`../http/resolution`).
 */
export { resolveGateSnapshot, MANIFEST_PATH, type ResolveDeps, type RevocationCheck } from './resolve.js';
export { majorSatisfies, pickOffer, defaultOffer } from './shared-scope.js';
export type {
  GateSnapshot,
  GateModule,
  SharedOffer,
  ImportMapFragment,
  ResolvedModule,
  SignatureBundle,
  ExcludedModule,
  ExclusionReason,
} from './types.js';
