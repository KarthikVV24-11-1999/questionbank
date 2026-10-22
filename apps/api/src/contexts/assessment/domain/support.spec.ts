import { describe, expect, it } from 'vitest';
import { ASSESSMENT_ERROR_KINDS, ERROR_KINDS, conflictError, notFoundError, preconditionFailedError, ruleViolationError, validationError } from './assessment-error.js';
import { freezeJson, isJsonObject } from './json-document.js';
import { err, ok } from './result.js';
import { addMilliseconds, isNonBlank, isNonNegativeInteger, isPositiveInteger, isSha256Hex, isUtcTimestamp, isUuid } from './uuid.js';

describe('errors', () => {
  it('uses only kinds from the platform taxonomy', () => {
    expect(ASSESSMENT_ERROR_KINDS.filter((kind) => !ERROR_KINDS.includes(kind))).toEqual([]);
    expect(ASSESSMENT_ERROR_KINDS).toHaveLength(6);
  });

  it.each([
    ['Validation', validationError],
    ['NotFound', notFoundError],
    ['Conflict', conflictError],
    ['PreconditionFailed', preconditionFailedError],
    ['RuleViolation', ruleViolationError],
  ] as const)('%s builds a frozen error, with a location only when given one', (kind, make) => {
    const bare = make('CODE', 'message');
    expect(bare).toEqual({ kind, code: 'CODE', message: 'message' });
    expect(Object.isFrozen(bare)).toBe(true);
    expect(make('CODE', 'message', 'field')).toEqual({ kind, code: 'CODE', message: 'message', location: 'field' });
  });
});

describe('result', () => {
  it('tags success and failure', () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 });
    expect(err('no')).toEqual({ ok: false, error: 'no' });
  });
});

describe('json documents', () => {
  it('knows an object from everything else', () => {
    expect(isJsonObject({})).toBe(true);
    for (const value of [[], null, 'x', 1, undefined]) expect(isJsonObject(value)).toBe(false);
  });

  it('freezes all the way down and leaves scalars alone', () => {
    const doc = freezeJson({ a: { b: [1, { c: 2 }] } });
    expect(Object.isFrozen(doc.a.b[1])).toBe(true);
    expect(freezeJson(5)).toBe(5);
    expect(freezeJson(null)).toBeNull();
  });
});

describe('value checks', () => {
  it('recognises each form and nothing near it', () => {
    expect(isUuid('00000000-0000-4000-8000-000000000001')).toBe(true);
    expect(isUuid('0000')).toBe(false);
    expect(isUuid(7)).toBe(false);
    expect(isSha256Hex('a'.repeat(64))).toBe(true);
    expect(isSha256Hex('A'.repeat(64))).toBe(false);
    expect(isSha256Hex('a'.repeat(63))).toBe(false);
    expect(isUtcTimestamp('2026-10-21T08:00:00.000Z')).toBe(true);
    expect(isUtcTimestamp('2026-10-21T08:00:00Z')).toBe(false);
    expect(isUtcTimestamp('2026-13-40T99:00:00.000Z')).toBe(false);
    expect(isUtcTimestamp(5)).toBe(false);
    expect(isNonBlank('x')).toBe(true);
    expect(isNonBlank('  ')).toBe(false);
    expect(isNonBlank(null)).toBe(false);
    expect([isNonNegativeInteger(0), isNonNegativeInteger(-1), isNonNegativeInteger(1.2), isNonNegativeInteger('1')]).toEqual([true, false, false, false]);
    expect([isPositiveInteger(1), isPositiveInteger(0)]).toEqual([true, false]);
  });

  it('adds milliseconds without leaving the form', () => {
    expect(addMilliseconds('2026-10-21T09:00:00.000Z', 3 * 3_600_000)).toBe('2026-10-21T12:00:00.000Z');
    expect(addMilliseconds('2026-12-31T23:59:59.999Z', 1)).toBe('2027-01-01T00:00:00.000Z');
  });
});
