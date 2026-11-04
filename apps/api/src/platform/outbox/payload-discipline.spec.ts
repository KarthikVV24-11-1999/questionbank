import { describe, expect, it } from 'vitest';
import { KEY_BEARING_FIELDS } from '../../fitness/content-rules.js';
import { EVENT_FORBIDDEN_FIELDS, checkEventsCarryNoContent } from '../../fitness/generation-rules.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attemptSubmittedEvent } from '../../contexts/assessment/application/handlers/attempt-handlers.js';
import { ASSESSMENT_EVENT_TYPES } from '../../contexts/assessment/domain/events/assessment-events.js';
import { anAttempt, id, TAG } from '../../testing/assessment-fixtures.js';
import { inDeliveryOrder } from './relay.js';
import { FORBIDDEN_PAYLOAD_FIELDS, MAX_PAYLOAD_STRING_LENGTH, checkPayloadDiscipline } from './payload-discipline.js';

describe('the payload discipline', () => {
  it('passes identifiers, version numbers, codes, decimals and timestamps', () => {
    const payload = {
      scoreRecordId: '0190a5c0-0000-7000-8000-000000000001',
      generation: 1,
      markingRuleSetHash: 'a'.repeat(64),
      totalRaw: '-1.25',
      occurredAt: '2026-10-21T08:30:00.000Z',
      pin: { modelVersionId: 'm-7', promptVersionId: 'p-3' },
      itemVersionIds: ['v1', 'v2'],
      retired: false,
      note: null,
    };
    expect(checkPayloadDiscipline(payload)).toEqual([]);
  });

  it('names every forbidden field wherever it sits, at any depth and inside arrays', () => {
    const found = checkPayloadDiscipline({ a: { stem: 'x' }, b: [{ c: { correctOptionId: 'b' } }], justification: 'ok' });
    expect(found.map((violation) => violation.path).sort()).toEqual(['$.a.stem', '$.b[0].c.correctOptionId', '$.justification']);
    expect(found.every((violation) => violation.reason === 'forbidden-field')).toBe(true);
  });

  it('catches prose sent under a name nobody listed: long text, and text over several lines', () => {
    const long = 'A uniform rod of mass M and length L is hinged at one end. '.repeat(5);
    expect(long.length).toBeGreaterThan(MAX_PAYLOAD_STRING_LENGTH);
    expect(checkPayloadDiscipline({ summary: long })).toEqual([{ path: '$.summary', reason: 'prose' }]);
    expect(checkPayloadDiscipline({ summary: 'short\nbut over two lines' })).toEqual([{ path: '$.summary', reason: 'prose' }]);
    expect(checkPayloadDiscipline({ summary: 'x'.repeat(MAX_PAYLOAD_STRING_LENGTH) })).toEqual([]);
  });

  it('holds the key-bearing names content keeps, and the field names generation forbids on its events — one list, three owners, no drift', () => {
    for (const field of KEY_BEARING_FIELDS) expect(FORBIDDEN_PAYLOAD_FIELDS, field).toContain(field);
    for (const field of EVENT_FORBIDDEN_FIELDS) expect(FORBIDDEN_PAYLOAD_FIELDS, field).toContain(field);
  });

  it('passes a scalar and an empty payload', () => {
    expect(checkPayloadDiscipline(5)).toEqual([]);
    expect(checkPayloadDiscipline({})).toEqual([]);
    expect(checkPayloadDiscipline([])).toEqual([]);
  });

  it('is kept at the source too: no context\'s event declarations name a field the relay would refuse', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const files = [
      'src/contexts/assessment/domain/events/assessment-events.ts',
      'src/contexts/scoring/domain/events/scoring-events.ts',
      'src/contexts/curriculum/domain/events/curriculum-events.ts',
      'src/contexts/content/domain/events/content-events.ts',
      'src/contexts/generation/domain/events/generation-events.ts',
    ];
    expect(checkEventsCarryNoContent(root, files)).toEqual([]);
  });
});

describe('what a submission puts in the outbox (M8-25)', () => {
  const context = { principal: { kind: 'human' as const, id: id(TAG.student, 1), roleContext: ['learner'] }, correlationId: 'c' };

  it('declares both submissions, and a payload of either passes the discipline the relay applies', () => {
    expect([...ASSESSMENT_EVENT_TYPES]).toEqual(['AttemptSubmitted', 'PracticeAttemptSubmitted']);
    const mock = attemptSubmittedEvent(anAttempt(), 'manual', '2026-11-04T09:00:00.000Z', context);
    const practice = attemptSubmittedEvent({ ...anAttempt(), mode: 'practice', formId: null }, 'manual', '2026-11-04T09:00:00.000Z', context);
    expect([mock.eventType, practice.eventType]).toEqual(['AttemptSubmitted', 'PracticeAttemptSubmitted']);
    expect(checkPayloadDiscipline(mock.payload)).toEqual([]);
    expect(checkPayloadDiscipline(practice.payload)).toEqual([]);
  });

  it('keeps the mock\'s event as it was: it names its form, and the practice event names none', () => {
    const mock = attemptSubmittedEvent(anAttempt(), 'manual', '2026-11-04T09:00:00.000Z', context);
    const practice = attemptSubmittedEvent({ ...anAttempt(), mode: 'practice', formId: null }, 'expiry', '2026-11-04T09:00:00.000Z', context);
    expect(mock).toMatchObject({ eventType: 'AttemptSubmitted', schemaVersion: 1, payload: { formId: expect.any(String) } });
    expect(practice.payload).not.toHaveProperty('formId');
    expect(practice.payload).toMatchObject({ reason: 'expiry' });
  });
});

describe('delivery order within a drain', () => {
  const at = (ms: number, id: string) => ({ occurred_at: new Date(ms), outbox_message_id: id });

  it('is by time, then by id, and a message is not before itself', () => {
    expect(inDeliveryOrder(at(1, 'b'), at(2, 'a'))).toBeLessThan(0);
    expect(inDeliveryOrder(at(2, 'a'), at(1, 'b'))).toBeGreaterThan(0);
    expect(inDeliveryOrder(at(1, 'a'), at(1, 'b'))).toBe(-1);
    expect(inDeliveryOrder(at(1, 'b'), at(1, 'a'))).toBe(1);
    expect(inDeliveryOrder(at(1, 'a'), at(1, 'a'))).toBe(0);
  });
});
