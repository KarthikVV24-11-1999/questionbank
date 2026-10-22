import { describe, expect, it } from 'vitest';
import { conflict, fromDatabaseError, notFound, persistenceRejected } from './repository-errors.js';

describe('repository errors', () => {
  it('builds the three kinds a repository reports', () => {
    expect(notFound('form', 'f1')).toEqual({ kind: 'NotFound', code: 'NOT_FOUND', message: 'no form f1', location: 'form' });
    expect(conflict('taken', 'key')).toEqual({ kind: 'Conflict', code: 'CONFLICT', message: 'taken', location: 'key' });
    expect(persistenceRejected('no')).toEqual({ kind: 'Validation', code: 'PERSISTENCE_REJECTED', message: 'no' });
  });

  it('reports a unique violation as a conflict, naming the constraint when there is one', () => {
    expect(fromDatabaseError({ code: '23505', constraint: 'attempt_one_active_mock_per_student' })).toMatchObject({
      code: 'CONFLICT',
      location: 'attempt_one_active_mock_per_student',
    });
    expect(fromDatabaseError({ code: '23505' })).toMatchObject({ code: 'CONFLICT', location: 'unique key' });
  });

  it('passes on the message of one of the assessment triggers, which says nothing of SQL', () => {
    const rejected = fromDatabaseError({ code: '23001', message: 'assessment_published_form_is_immutable: form x was published at y' });
    expect(rejected).toMatchObject({ code: 'PERSISTENCE_REJECTED', location: 'assessment_published_form_is_immutable' });
    expect(rejected.message).toContain('was published at');
  });

  it('says only the SQLSTATE or constraint of anything else, never the statement', () => {
    expect(fromDatabaseError({ code: '23503', constraint: 'response_event_pin_matches_slot', message: 'INSERT secret' })).toMatchObject({
      code: 'PERSISTENCE_REJECTED',
      message: 'the store rejected the write: response_event_pin_matches_slot',
    });
    expect(fromDatabaseError({ code: '22P02', message: 'INSERT secret' }).message).toBe('the store rejected the write (22P02)');
    expect(fromDatabaseError({ message: 'INSERT secret' }).message).toBe('the store rejected the write');
    expect(fromDatabaseError({ code: '23001', message: 'some other restriction' }).message).toBe('the store rejected the write (23001)');
    expect(fromDatabaseError({ code: '23001' }).message).toBe('the store rejected the write (23001)');
  });

  it('reports a store that cannot be reached as Unavailable — retryable, and not a rejection of what was sent', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EHOSTUNREACH', '53300', '57P01', '57P02', '57P03', '08006', '08001']) {
      expect(fromDatabaseError({ code, message: 'connect secret 10.0.0.1:5432' }), code).toEqual({
        kind: 'Unavailable',
        code: 'STORE_UNAVAILABLE',
        message: 'the store could not be reached; try again',
        location: 'store',
      });
    }
    // an error that merely resembles one is not: a constraint is the caller's to hear about
    expect(fromDatabaseError({ code: '23503', constraint: 'x' }).kind).toBe('Validation');
  });
});
