/**
 * Durable audit sink (SPEC §10, FR-12): persists every emitted event to the
 * `audit_event` table.
 *
 * {@link AuditSink.emit} is synchronous by contract, so the insert is issued
 * fire-and-forget and failures are logged rather than thrown — audit writes must
 * never block or fail the state transition that produced them. Compose this with
 * {@link loggerAuditSink} (see {@link combineAuditSinks}) so events remain
 * observable in the log stream as well.
 */
import type { Postgres } from '../db/postgres.js';
import type { Logger } from '../logging/index.js';
import type { AuditEvent, AuditSink } from './index.js';

export function createPostgresAuditSink(postgres: Postgres, logger: Logger): AuditSink {
  return {
    emit(event: AuditEvent): void {
      postgres
        .query(
          'INSERT INTO audit_event (actor, action, subject, at) VALUES ($1, $2, $3, $4)',
          [event.actor, event.action, event.subject, event.at],
        )
        .catch((err: unknown) => {
          logger.error(
            {
              err,
              actor: event.actor,
              action: event.action,
              subject: event.subject,
            },
            'failed to persist audit event',
          );
        });
    },
  };
}
