/** One forward-only schema migration. */
export interface Migration {
  /**
   * Stable, ordered identifier (`NNNN_slug`). Recorded in `schema_migrations`
   * once applied; never change an id after it has shipped.
   */
  readonly id: string;
  /** Idempotent DDL executed inside a single transaction. */
  readonly up: string;
}
