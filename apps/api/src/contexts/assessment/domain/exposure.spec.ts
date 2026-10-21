import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { SESSION_REF, TAG, aDraftForm, aPublishedForm, id } from '../../../testing/assessment-fixtures.js';
import * as exposureModule from './exposure.js';
import { exposureEntriesOf } from './exposure.js';

describe('the exposure ledger is a function of a published form', () => {
  it('has one entry per slot, keyed on the form, the item VERSION and the session', () => {
    const form = aPublishedForm();
    const entries = expectValue(exposureEntriesOf(form));
    expect(entries).toHaveLength(6);
    const first = entries[0]!;
    expect(first.formId).toBe(form.formId);
    expect(first.slotId).toBe(id(TAG.slot, 1));
    expect(first.itemId).toBe(id(TAG.item, 1));
    expect(first.itemVersionId).toBe(id(TAG.itemVersion, 1));
    expect(first.itemVersionId).not.toBe(first.itemId);
    expect(first.sessionRef).toBe(SESSION_REF);
    expect(first.isAnchor).toBe(true);
    expect(first.writtenAt).toBe(form.publishedAt);
    expect(Object.keys(first).sort()).toEqual(['formId', 'isAnchor', 'itemId', 'itemVersionId', 'sessionRef', 'slotId', 'writtenAt']);
    expect(entries.map((e) => e.isAnchor)).toEqual([true, false, false, false, false, false]);
    expect(Object.isFrozen(entries)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('is stamped with the moment of publication, not read from any clock', () => {
    expect(expectValue(exposureEntriesOf(aPublishedForm())).every((e) => e.writtenAt === '2026-10-21T07:00:00.000Z')).toBe(true);
  });

  it('records nothing for a draft: it may still change', () => {
    const error = expectError(exposureEntriesOf(aDraftForm()));
    expect(error.code).toBe('EXPOSURE_FORM_NOT_PUBLISHED');
    expect(error.kind).toBe('PreconditionFailed');
  });

  it('has no operation that takes an attempt: nothing here can write exposure at attempt time', () => {
    expect(Object.keys(exposureModule)).toEqual(['exposureEntriesOf']);
    expect(exposureEntriesOf.length).toBe(1);
  });
});
