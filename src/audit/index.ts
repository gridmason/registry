/**
 * Audit seam (SPEC §10, FR-12).
 *
 * Every registry state transition — publish, review, sign, gate flip, revoke —
 * MUST be an auditable event. None of those transitions exist yet; this module
 * ships the plumbing they wire into from the first commit, so later epics only
 * call {@link emitAuditEvent} rather than re-inventing audit.
 *
 * The subject of an audit event is often a source-qualified widget identity, so
 * subjects accept `@gridmason/protocol`'s {@link WidgetID} directly (this is also
 * the type-level proof that the shared-toolchain wiring compiles). The sink is
 * pluggable: a console/logger sink by default, a durable store (Postgres, #3)
 * later, and a fake sink in tests.
 */
import type { WidgetID } from '@gridmason/protocol';

import type { Logger } from '../logging/index.js';

/** What an audit event points at: a free-form id or a source-qualified widget. */
export type AuditSubject = string | WidgetID;

/** A recorded state transition. Matches the `AuditEvent` data-model row. */
export interface AuditEvent {
  /** Who caused the transition (publisher id, reviewer id, `system`, ...). */
  readonly actor: string;
  /** The transition verb (`publish`, `review`, `sign`, `revoke`, ...). */
  readonly action: string;
  /** What the transition acted on, rendered to its canonical string form. */
  readonly subject: string;
  /** When it happened. */
  readonly at: Date;
}

/** A destination for emitted audit events. */
export interface AuditSink {
  emit(event: AuditEvent): void;
}

/** Render an {@link AuditSubject} to the stable string stored on the event. */
export function formatAuditSubject(subject: AuditSubject): string {
  if (typeof subject === 'string') return subject;
  return `${subject.source}#${subject.tag}`;
}

/** A no-op sink: drops events. Useful as an explicit "audit disabled" choice. */
export const noopAuditSink: AuditSink = {
  emit() {
    /* intentionally empty */
  },
};

/** A sink that writes each event as one structured log line at `info`. */
export function loggerAuditSink(logger: Logger): AuditSink {
  return {
    emit(event) {
      logger.info(
        {
          audit: true,
          actor: event.actor,
          action: event.action,
          subject: event.subject,
          at: event.at.toISOString(),
        },
        'audit event',
      );
    },
  };
}

// The active sink. Starts as no-op so importing the module has no side effects;
// `setAuditSink` installs the real sink during service boot, and tests swap in
// a fake sink.
let activeSink: AuditSink = noopAuditSink;

/** Install the process-wide audit sink. Returns the previous sink. */
export function setAuditSink(sink: AuditSink): AuditSink {
  const previous = activeSink;
  activeSink = sink;
  return previous;
}

/**
 * Emit an audit event through the active sink and return the recorded event.
 *
 * @param actor   who caused the transition
 * @param action  the transition verb
 * @param subject what it acted on (string or {@link WidgetID})
 * @param at      when it happened (defaults to now)
 */
export function emitAuditEvent(
  actor: string,
  action: string,
  subject: AuditSubject,
  at: Date = new Date(),
): AuditEvent {
  const event: AuditEvent = {
    actor,
    action,
    subject: formatAuditSubject(subject),
    at,
  };
  activeSink.emit(event);
  return event;
}
