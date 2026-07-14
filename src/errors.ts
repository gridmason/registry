/**
 * Render any thrown value to a human-readable message.
 *
 * `pg`/network failures against a host that resolves to several addresses
 * surface as an `AggregateError` whose own `message` is empty; unwrap it so log
 * lines and readiness details name the actual cause instead of a blank string.
 */
export function formatError(err: unknown): string {
  if (err instanceof AggregateError) {
    const causes = err.errors.map((e) => (e instanceof Error ? e.message : String(e)));
    return err.message || causes.join('; ') || 'AggregateError';
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
