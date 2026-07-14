import { afterEach, describe, expect, it } from 'vitest';

import {
  emitAuditEvent,
  formatAuditSubject,
  noopAuditSink,
  setAuditSink,
  type AuditEvent,
  type AuditSink,
} from '../src/audit/index.js';

/** A fake sink that records every event it receives. */
class FakeSink implements AuditSink {
  readonly events: AuditEvent[] = [];
  emit(event: AuditEvent): void {
    this.events.push(event);
  }
}

afterEach(() => {
  setAuditSink(noopAuditSink);
});

describe('emitAuditEvent', () => {
  it('emits the event through the active sink', () => {
    const sink = new FakeSink();
    setAuditSink(sink);

    const at = new Date('2026-07-14T00:00:00.000Z');
    const event = emitAuditEvent('publisher-1', 'publish', 'acme-widget', at);

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toEqual({
      actor: 'publisher-1',
      action: 'publish',
      subject: 'acme-widget',
      at,
    });
    expect(event).toBe(sink.events[0]);
  });

  it('defaults `at` to the current time', () => {
    const sink = new FakeSink();
    setAuditSink(sink);

    const before = Date.now();
    const event = emitAuditEvent('system', 'service.start', 'gridmason-registry');
    const after = Date.now();

    expect(event.at.getTime()).toBeGreaterThanOrEqual(before);
    expect(event.at.getTime()).toBeLessThanOrEqual(after);
  });

  it('renders a source-qualified WidgetID subject to its canonical string', () => {
    const sink = new FakeSink();
    setAuditSink(sink);

    emitAuditEvent('reviewer-1', 'review', {
      source: 'registry.gridmason.dev',
      tag: 'acme-clock',
    });

    expect(sink.events[0]?.subject).toBe('registry.gridmason.dev#acme-clock');
  });

  it('setAuditSink returns the previously installed sink', () => {
    const first = new FakeSink();
    const second = new FakeSink();
    setAuditSink(first);
    const previous = setAuditSink(second);
    expect(previous).toBe(first);
  });
});

describe('formatAuditSubject', () => {
  it('passes strings through unchanged', () => {
    expect(formatAuditSubject('artifact-42')).toBe('artifact-42');
  });

  it('joins WidgetID source and tag', () => {
    expect(formatAuditSubject({ source: 'local', tag: 'clock' })).toBe('local#clock');
  });
});
