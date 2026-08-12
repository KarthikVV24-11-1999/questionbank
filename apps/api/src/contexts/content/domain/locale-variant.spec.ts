import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { AUTHOR, AUTHORED_AT, REVIEWER, textBody } from '../../../testing/content-fixtures.js';
import { stripComments } from '../../../fitness/source-scan.js';
import {
  applySourceVersionChange,
  createLocaleVariant,
  isServable,
  isVariantReviewState,
  VARIANT_REVIEW_STATES,
  type CreateLocaleVariantProps,
  type LocaleVariant,
  type LocaleVariantOption,
} from './locale-variant.js';

const CONTEXT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const MODULE_SOURCE = readFileSync(fileURLToPath(new URL('./locale-variant.ts', import.meta.url)), 'utf8');

const SOURCE_OPTIONS = ['a', 'b', 'c', 'd'];

function options(ids: readonly string[] = SOURCE_OPTIONS): readonly LocaleVariantOption[] {
  return ids.map((optionId) => ({ optionId, body: textBody(`विकल्प ${optionId}`) }));
}

function variantProps(overrides: Partial<CreateLocaleVariantProps> = {}): CreateLocaleVariantProps {
  return {
    locale: 'hi-IN',
    sourceItemVersionId: 'version-1',
    stem: textBody('एक गुटका घर्षणरहित ढाल पर फिसलता है।'),
    options: options(),
    translatedBy: AUTHOR,
    createdAt: AUTHORED_AT,
    ...overrides,
  };
}

function variant(overrides: Partial<CreateLocaleVariantProps> = {}): LocaleVariant {
  return expectValue(createLocaleVariant(variantProps(overrides), SOURCE_OPTIONS));
}

describe('a variant carries no correctness (FR-QM-11 rule 1, D-005)', () => {
  // A translated key would be a second answer to the same question,
  // diverging silently the first time either side is corrected.
  it('declares no key, numeric specification or correct-option marker', () => {
    const code = stripComments(MODULE_SOURCE);
    expect(code).not.toMatch(
      /readonly\s+(correctOptionId|correctOptionIds|answerKey|spec|isCorrect|expectedValue|pairs)\s*\??:/u,
    );
  });

  it('translates the option identities the source defines, and nothing more', () => {
    expect(variant().options.map((option) => option.optionId)).toEqual(SOURCE_OPTIONS);
  });

  it('refuses an option the source version does not define', () => {
    const failure = expectError(
      createLocaleVariant(variantProps({ options: options([...SOURCE_OPTIONS, 'e']) }), SOURCE_OPTIONS),
    );
    expect(failure.code).toBe('OPTION_NOT_IN_SOURCE');
  });

  // A partial translation shows a learner some options in one language and
  // some in another, which is worse than none of it translated.
  it('refuses a partial translation, naming what is missing', () => {
    const failure = expectError(
      createLocaleVariant(variantProps({ options: options(['a', 'b']) }), SOURCE_OPTIONS),
    );
    expect(failure.code).toBe('OPTION_MISSING_FROM_TRANSLATION');
    expect(failure.message).toContain('c');
    expect(failure.message).toContain('d');
  });

  it('refuses the same option translated twice', () => {
    expect(
      expectError(
        createLocaleVariant(variantProps({ options: options(['a', 'a', 'b', 'c', 'd']) }), SOURCE_OPTIONS),
      ).code,
    ).toBe('OPTION_ID_DUPLICATE');
  });

  it('refuses a translated option that names nothing', () => {
    const withBlank: readonly LocaleVariantOption[] = [
      { optionId: ' ', body: textBody('x') },
      ...options(['b', 'c', 'd']),
    ];
    expect(expectError(createLocaleVariant(variantProps({ options: withBlank }), SOURCE_OPTIONS)).code).toBe(
      'OPTION_ID_REQUIRED',
    );
  });

  it('accepts an item type with no options at all', () => {
    const numericVariant = expectValue(createLocaleVariant(variantProps({ options: [] }), []));
    expect(numericVariant.options).toEqual([]);
  });
});

describe('construction', () => {
  it('builds a complete variant', () => {
    expect(variant()).toMatchObject({ locale: 'hi-IN', sourceItemVersionId: 'version-1', reviewState: 'draft' });
  });

  it.each([['hi'], ['bn'], ['hi-IN'], ['ta-IN'], ['sr-Latn-RS']])('accepts the locale tag %s', (locale) => {
    expect(variant({ locale }).locale).toBe(locale);
  });

  it.each([['english'], ['HI'], ['hi_IN'], ['hi-in']])('refuses the malformed locale tag %s', (locale) => {
    expect(expectError(createLocaleVariant(variantProps({ locale }), SOURCE_OPTIONS)).code).toBe(
      'LOCALE_MALFORMED',
    );
  });

  it('refuses a blank locale', () => {
    expect(expectError(createLocaleVariant(variantProps({ locale: '  ' }), SOURCE_OPTIONS)).code).toBe(
      'LOCALE_REQUIRED',
    );
  });

  // The source version is authoritative for correctness, and a different
  // version may say something different.
  it('refuses a variant that attaches to no source version', () => {
    expect(
      expectError(createLocaleVariant(variantProps({ sourceItemVersionId: '' }), SOURCE_OPTIONS)).code,
    ).toBe('SOURCE_ITEM_VERSION_REQUIRED');
  });

  it('records who translated it (INV-02)', () => {
    expect(
      expectError(
        createLocaleVariant(variantProps({ translatedBy: { ...AUTHOR, id: '' } }), SOURCE_OPTIONS),
      ).code,
    ).toBe('TRANSLATED_BY_REQUIRED');
  });

  it('rejects a malformed timestamp', () => {
    expect(expectError(createLocaleVariant(variantProps({ createdAt: 'now' }), SOURCE_OPTIONS)).code).toBe(
      'CREATED_AT_NOT_A_TIMESTAMP',
    );
  });

  it('defaults to draft', () => {
    expect(variant().reviewState).toBe('draft');
  });

  it('rejects an unknown review state', () => {
    expect(
      expectError(
        createLocaleVariant(variantProps({ reviewState: 'approved' as never }), SOURCE_OPTIONS),
      ).code,
    ).toBe('REVIEW_STATE_UNKNOWN');
  });

  it('is frozen, including options and principals', () => {
    const built = variant({ reviewState: 'attested', attestedBy: REVIEWER });
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.options)).toBe(true);
    expect(Object.isFrozen(built.options[0])).toBe(true);
    expect(Object.isFrozen(built.translatedBy.roleContext)).toBe(true);
    expect(Object.isFrozen(built.attestedBy?.roleContext)).toBe(true);
  });
});

describe('attestation is fidelity, not adjudication (D-005)', () => {
  it('has three states, not the item lifecycle’s eight', () => {
    expect([...VARIANT_REVIEW_STATES]).toEqual(['draft', 'attested', 'invalidated']);
  });

  it('recognises each state and rejects anything else', () => {
    for (const state of VARIANT_REVIEW_STATES) expect(isVariantReviewState(state)).toBe(true);
    expect(isVariantReviewState('published')).toBe(false);
  });

  it('records who attested', () => {
    expect(variant({ reviewState: 'attested', attestedBy: REVIEWER }).attestedBy?.id).toBe('reviewer-1');
  });

  it('refuses an attested variant with nobody attesting', () => {
    expect(
      expectError(createLocaleVariant(variantProps({ reviewState: 'attested' }), SOURCE_OPTIONS)).code,
    ).toBe('ATTESTED_BY_REQUIRED');
  });

  it('refuses an attester with no identity', () => {
    expect(
      expectError(
        createLocaleVariant(
          variantProps({ reviewState: 'attested', attestedBy: { ...REVIEWER, id: '' } }),
          SOURCE_OPTIONS,
        ),
      ).code,
    ).toBe('ATTESTED_BY_REQUIRED');
  });

  // The same prohibition as INV-12, for the same reason.
  it('refuses a translator attesting to their own translation', () => {
    expect(
      expectError(
        createLocaleVariant(
          variantProps({ reviewState: 'attested', attestedBy: AUTHOR }),
          SOURCE_OPTIONS,
        ),
      ).code,
    ).toBe('ATTESTER_IS_TRANSLATOR');
  });

  it('omits the attester key on a draft', () => {
    expect(Object.hasOwn(variant(), 'attestedBy')).toBe(false);
  });

  it('serves only an attested variant', () => {
    expect(isServable(variant({ reviewState: 'attested', attestedBy: REVIEWER }))).toBe(true);
    expect(isServable(variant())).toBe(false);
    expect(isServable(variant({ reviewState: 'invalidated' }))).toBe(false);
  });
});

describe('a correctness change invalidates every variant (FR-QM-11 rule 3)', () => {
  const ATTESTED = () => variant({ reviewState: 'attested', attestedBy: REVIEWER });

  // A translation of a stem whose key has moved is a translation of a
  // different question.
  it('invalidates an attested variant', () => {
    const [updated] = applySourceVersionChange([ATTESTED()], {
      newItemVersionId: 'version-2',
      correctnessChanged: true,
    });
    expect(updated?.reviewState).toBe('invalidated');
  });

  it('drops the attestation, which was to a fidelity that no longer means what it meant', () => {
    const [updated] = applySourceVersionChange([ATTESTED()], {
      newItemVersionId: 'version-2',
      correctnessChanged: true,
    });
    expect(Object.hasOwn(updated as object, 'attestedBy')).toBe(false);
  });

  it('keeps who translated it', () => {
    const [updated] = applySourceVersionChange([ATTESTED()], {
      newItemVersionId: 'version-2',
      correctnessChanged: true,
    });
    expect(updated?.translatedBy.id).toBe('author-1');
  });

  it('leaves variants alone when only the prose changed', () => {
    const before = [ATTESTED()];
    const after = applySourceVersionChange(before, {
      newItemVersionId: 'version-2',
      correctnessChanged: false,
    });
    expect(after).toBe(before);
    expect(after[0]?.reviewState).toBe('attested');
  });

  it('invalidates every variant, not just the first', () => {
    const many = [ATTESTED(), variant({ locale: 'bn-IN' }), variant({ locale: 'ta-IN' })];
    const after = applySourceVersionChange(many, {
      newItemVersionId: 'version-2',
      correctnessChanged: true,
    });
    expect(after.every((entry) => entry.reviewState === 'invalidated')).toBe(true);
  });

  it('is pure — the originals are untouched and the result is frozen', () => {
    const original = ATTESTED();
    const after = applySourceVersionChange([original], {
      newItemVersionId: 'version-2',
      correctnessChanged: true,
    });
    expect(original.reviewState).toBe('attested');
    expect(original.attestedBy?.id).toBe('reviewer-1');
    expect(Object.isFrozen(after)).toBe(true);
    expect(Object.isFrozen(after[0])).toBe(true);
  });

  it('handles an item with no variants', () => {
    expect(applySourceVersionChange([], { newItemVersionId: 'version-2', correctnessChanged: true })).toEqual(
      [],
    );
  });
});

describe('modeled, not half-shipped', () => {
  // A field nothing populates acquires a wrong default; a feature nothing
  // finishes gets discovered by a user.
  it('is accepted by no other module in the context', () => {
    function tsFiles(directory: string): string[] {
      return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return tsFiles(path);
        return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
      });
    }

    const importers = tsFiles(CONTEXT_ROOT).filter(
      (file) => !file.endsWith('locale-variant.ts') && /locale-variant/u.test(readFileSync(file, 'utf8')),
    );
    expect(importers).toEqual([]);
  });

  it('is absent from ItemVersion until H1', () => {
    const itemVersionSource = readFileSync(join(CONTEXT_ROOT, 'domain', 'item-version.ts'), 'utf8');
    expect(stripComments(itemVersionSource)).not.toMatch(/localeVariants/u);
  });
});
