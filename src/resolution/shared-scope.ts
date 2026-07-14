/**
 * Shared-dependency major resolution (GW-D22, SPEC dashboard §).
 *
 * A widget's manifest `sharedScope` maps a bare specifier to the SemVer **range**
 * it expects the host to satisfy (e.g. `{ "react": "^18.2.0" }`). The host shell
 * offers one URL per major it provides ({@link SharedOffer}). Resolution picks,
 * per widget, the highest offered major whose number the range permits, then
 * scopes the widget's imports to that major only when it differs from the shell's
 * default (the highest offered major overall) — so widgets that agree share one
 * instance and only a genuinely different major produces a `scopes` entry, never a
 * global (GW-D22 "never globals").
 *
 * ## Range support (v1)
 *
 * `sharedScope` ranges in practice are the framework-default forms a template
 * emits — caret (`^18.2.0`), tilde (`~18.2.0`), an exact version (`18.2.1`), an
 * x-range (`18`, `18.x`, `18.2.x`), a lower bound (`>=18.0.0`), or a `||` union of
 * those. This matcher decides, for those forms, whether a **major** is permitted.
 * Complex ranges (hyphen ranges `1.0.0 - 2.0.0`, upper-bound-only `<`, combined
 * `>=a <b` comparator sets) are not decomposed here and are treated conservatively
 * — see {@link majorSatisfies}. Full range algebra is a documented follow-up; the
 * offer's explicit `major` keeps the surface the matcher must cover small.
 */
import type { SharedOffer } from './types.js';

/** A single comparator's verdict for a candidate major. */
function comparatorPermitsMajor(comparator: string, major: number): boolean {
  const trimmed = comparator.trim();
  if (trimmed === '' || trimmed === '*' || trimmed === 'x' || trimmed === 'X') {
    // A wildcard/empty comparator permits any major.
    return true;
  }

  // Split an operator prefix from the version body.
  const match = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(trimmed);
  if (!match) return false;
  const op = match[1] ?? '=';
  const body = match[2]!;

  // The leading numeric segment is the version's major; an `x`/`*` major permits any.
  const firstSegment = body.split('.')[0]!;
  if (firstSegment === 'x' || firstSegment === 'X' || firstSegment === '*') {
    return true;
  }
  const rangeMajor = Number.parseInt(firstSegment, 10);
  if (!Number.isInteger(rangeMajor)) return false;

  switch (op) {
    // Caret and tilde both lock the major (for major ≥ 1, the common case); an
    // exact version and a bare/x-range version also pin the major.
    case '^':
    case '~':
    case '=':
      return major === rangeMajor;
    case '>=':
      return major >= rangeMajor;
    case '>':
      // `>M.n.p` still admits the same major for a higher minor/patch; permit ≥ M.
      return major >= rangeMajor;
    case '<=':
      return major <= rangeMajor;
    case '<':
      // `<M.0.0` excludes M; without the minor/patch we conservatively admit < M.
      return major < rangeMajor;
    default:
      return false;
  }
}

/**
 * Whether `major` satisfies a `sharedScope` `range`. A `||` union is satisfied when
 * any alternative is; a space-separated comparator set (e.g. `>=1 <3`) must be
 * satisfied by **all** its comparators (intersection). Unparseable input refuses
 * (never guessed), so an offer is only ever matched to a range it provably permits.
 */
export function majorSatisfies(major: number, range: string): boolean {
  const alternatives = range.split('||');
  return alternatives.some((alt) => {
    const comparators = alt.trim().split(/\s+/).filter((c) => c !== '');
    if (comparators.length === 0) return true; // bare `*`/empty alternative
    return comparators.every((c) => comparatorPermitsMajor(c, major));
  });
}

/**
 * The URL the shell offers for the **highest** major that satisfies `range`, or
 * `null` when no offer does (a resolve-time `sharedScope` miss, GW-D22). Highest so
 * a widget lands on the newest compatible major the shell provides.
 */
export function pickOffer(
  offers: readonly SharedOffer[],
  range: string,
): SharedOffer | null {
  let best: SharedOffer | null = null;
  for (const offer of offers) {
    if (!majorSatisfies(offer.major, range)) continue;
    if (best === null || offer.major > best.major) best = offer;
  }
  return best;
}

/** The default major for a specifier: the highest major the shell offers. */
export function defaultOffer(offers: readonly SharedOffer[]): SharedOffer | null {
  let best: SharedOffer | null = null;
  for (const offer of offers) {
    if (best === null || offer.major > best.major) best = offer;
  }
  return best;
}
