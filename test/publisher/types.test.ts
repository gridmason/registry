import { describe, expect, it } from 'vitest';

import { composeOidcIdentity } from '../../src/publisher/types.js';

describe('composeOidcIdentity', () => {
  it('does not collide across the issuer/subject boundary', () => {
    // A naive `${issuer} ${subject}` join maps both of these to "a b c", so two
    // different identities would share one unique key. Per-part encoding keeps
    // them distinct.
    expect(composeOidcIdentity('a b', 'c')).not.toBe(composeOidcIdentity('a', 'b c'));
  });

  it('encodes each part so the separating space stays unambiguous', () => {
    const composed = composeOidcIdentity('https://accounts.example.com', 'user 1');
    const parts = composed.split(' ');
    expect(parts).toHaveLength(2);
    expect(decodeURIComponent(parts[0]!)).toBe('https://accounts.example.com');
    expect(decodeURIComponent(parts[1]!)).toBe('user 1');
  });
});
