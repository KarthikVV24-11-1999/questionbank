import { describe, expect, it } from 'vitest';
import { conflict, fromDatabaseError, notFound, persistenceRejected } from './repository-errors.js';

describe('the repository error constructors', () => {
  it('reports a missing aggregate as NotFound by its kind and identifier', () => {
    expect(notFound('candidate', 'c-1')).toEqual({
      kind: 'NotFound',
      code: 'NOT_FOUND',
      message: 'no candidate c-1',
      location: 'candidate',
    });
  });

  it('reports a clash as a Conflict', () => {
    expect(conflict('moved on', 'verdicts')).toEqual({
      kind: 'Conflict',
      code: 'CONFLICT',
      message: 'moved on',
      location: 'verdicts',
    });
  });

  it('reports a refusal as PERSISTENCE_REJECTED, with or without a location', () => {
    expect(persistenceRejected('no', 'x')).toEqual({
      kind: 'Validation',
      code: 'PERSISTENCE_REJECTED',
      message: 'no',
      location: 'x',
    });
    expect(Object.hasOwn(persistenceRejected('no'), 'location')).toBe(false);
  });
});

describe('fromDatabaseError', () => {
  it('maps a unique violation to a Conflict, naming the constraint when there is one', () => {
    const named = fromDatabaseError({ code: '23505', constraint: 'candidate_decision_pkey' });
    expect(named.kind).toBe('Conflict');
    expect(named.message).toContain('candidate_decision_pkey');
    expect(named.location).toBe('candidate_decision_pkey');

    const unnamed = fromDatabaseError({ code: '23505' });
    expect(unnamed.kind).toBe('Conflict');
    expect(unnamed.location).toBe('unique key');
  });

  it('maps any other refusal to PERSISTENCE_REJECTED, saying only what is safe to say', () => {
    const constrained = fromDatabaseError({ code: '23503', constraint: 'generation_candidate_pin_matches_run' });
    expect(constrained.code).toBe('PERSISTENCE_REJECTED');
    expect(constrained.message).toBe('the store rejected the write: generation_candidate_pin_matches_run');

    const coded = fromDatabaseError({ code: '22P02' });
    expect(coded.message).toBe('the store rejected the write (22P02)');
    expect(Object.hasOwn(coded, 'location')).toBe(false);

    expect(fromDatabaseError(new Error('connection terminated')).message).toBe('the store rejected the write');
  });

  it('never repeats the statement or the driver’s own message', () => {
    const error = Object.assign(new Error('INSERT INTO ai.generation_run VALUES (secret)'), { code: '22P02' });
    expect(JSON.stringify(fromDatabaseError(error))).not.toContain('INSERT');
    expect(JSON.stringify(fromDatabaseError(error))).not.toContain('secret');
  });
});
