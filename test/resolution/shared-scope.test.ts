/**
 * Shared-dependency major matching (#13, GW-D22). The resolver picks, per widget,
 * the highest offered major whose number the manifest `sharedScope` range permits,
 * and scopes only when that differs from the shell's default (highest offered).
 * These unit tests pin the matcher across the range forms a `sharedScope` uses.
 */
import { describe, expect, it } from 'vitest';

import { defaultOffer, majorSatisfies, pickOffer } from '../../src/resolution/shared-scope.js';
import type { SharedOffer } from '../../src/resolution/types.js';

describe('majorSatisfies', () => {
  it('locks the major for caret, tilde, and exact ranges', () => {
    for (const range of ['^18.2.0', '~18.2.0', '18.2.1', '=18.0.0']) {
      expect(majorSatisfies(18, range)).toBe(true);
      expect(majorSatisfies(17, range)).toBe(false);
      expect(majorSatisfies(19, range)).toBe(false);
    }
  });

  it('treats a bare or x-range major as that major', () => {
    for (const range of ['18', '18.x', '18.2.x']) {
      expect(majorSatisfies(18, range)).toBe(true);
      expect(majorSatisfies(17, range)).toBe(false);
    }
  });

  it('permits any major for a wildcard or empty range', () => {
    for (const range of ['*', 'x', '']) {
      expect(majorSatisfies(17, range)).toBe(true);
      expect(majorSatisfies(999, range)).toBe(true);
    }
  });

  it('honours a lower bound', () => {
    expect(majorSatisfies(18, '>=17.0.0')).toBe(true);
    expect(majorSatisfies(17, '>=17.0.0')).toBe(true);
    expect(majorSatisfies(16, '>=17.0.0')).toBe(false);
  });

  it('intersects a comparator set and unions across ||', () => {
    // `>=16 <18` admits 16 and 17, not 18.
    expect(majorSatisfies(16, '>=16.0.0 <18.0.0')).toBe(true);
    expect(majorSatisfies(17, '>=16.0.0 <18.0.0')).toBe(true);
    expect(majorSatisfies(18, '>=16.0.0 <18.0.0')).toBe(false);
    // A `||` union admits either alternative's majors.
    expect(majorSatisfies(17, '^17.0.0 || ^18.0.0')).toBe(true);
    expect(majorSatisfies(18, '^17.0.0 || ^18.0.0')).toBe(true);
    expect(majorSatisfies(16, '^17.0.0 || ^18.0.0')).toBe(false);
  });

  it('refuses unparseable input rather than guessing', () => {
    expect(majorSatisfies(18, 'not-a-range')).toBe(false);
  });
});

describe('pickOffer / defaultOffer', () => {
  const offers: SharedOffer[] = [
    { major: 17, url: '/vendor/react@17.js' },
    { major: 18, url: '/vendor/react@18.js' },
  ];

  it('picks the highest offered major satisfying the range', () => {
    expect(pickOffer(offers, '^18.0.0')?.url).toBe('/vendor/react@18.js');
    expect(pickOffer(offers, '^17.0.0')?.url).toBe('/vendor/react@17.js');
    // A lower bound both majors satisfy resolves to the highest.
    expect(pickOffer(offers, '>=17.0.0')?.url).toBe('/vendor/react@18.js');
  });

  it('returns null when no offer satisfies the range', () => {
    expect(pickOffer(offers, '^16.0.0')).toBeNull();
  });

  it('defaults to the highest offered major regardless of any range', () => {
    expect(defaultOffer(offers)?.major).toBe(18);
    expect(defaultOffer([])).toBeNull();
  });
});
