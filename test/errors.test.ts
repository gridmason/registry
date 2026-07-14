import { describe, expect, it } from 'vitest';

import { formatError } from '../src/errors.js';

describe('formatError', () => {
  it('returns a plain Error message', () => {
    expect(formatError(new Error('boom'))).toBe('boom');
  });

  it('unwraps an AggregateError with an empty message into its causes', () => {
    const err = new AggregateError(
      [new Error('ECONNREFUSED ::1:5432'), new Error('ECONNREFUSED 127.0.0.1:5432')],
      '',
    );
    expect(formatError(err)).toBe('ECONNREFUSED ::1:5432; ECONNREFUSED 127.0.0.1:5432');
  });

  it('keeps an AggregateError message when present', () => {
    const err = new AggregateError([new Error('a')], 'top-level');
    expect(formatError(err)).toBe('top-level');
  });

  it('stringifies a non-Error value', () => {
    expect(formatError('nope')).toBe('nope');
  });
});
