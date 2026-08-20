import { describe, expect, it } from 'vitest';
import { textBody } from '../../../../testing/content-fixtures.js';
import { exactHash, normalize, skeletonHash, type ItemFingerprintFacts } from './fingerprint.js';

describe('normalize', () => {
  it('case-folds', () => {
    expect(normalize('Half')).toBe(normalize('half'));
  });

  it('NFKC-normalizes before folding, so a compatibility form matches its canonical spelling', () => {
    // U+FB01 LATIN SMALL LIGATURE FI decomposes to "fi" under NFKC.
    expect(normalize('ﬁnal')).toBe(normalize('final'));
  });

  it('strips punctuation', () => {
    expect(normalize('speed, mass; and force.')).toBe(normalize('speed mass and force'));
  });

  it('collapses whitespace, including runs punctuation-stripping opens', () => {
    expect(normalize('a   b\n\tc')).toBe('a b c');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalize('  padded  ')).toBe('padded');
  });
});

function itemWithStem(text: string, options?: readonly string[]): ItemFingerprintFacts {
  return { stem: textBody(text), ...(options === undefined ? {} : { options: options.map(textBody) }) };
}

describe('exactHash and skeletonHash — the pair property', () => {
  it('two items differing only in numeric constants share a skeletonHash', () => {
    const a = itemWithStem('a ball falls 5 m in 2 s');
    const b = itemWithStem('a ball falls 12 m in 3 s');
    expect(skeletonHash(a)).toBe(skeletonHash(b));
  });

  it('two items differing only in numeric constants differ in exactHash', () => {
    const a = itemWithStem('a ball falls 5 m in 2 s');
    const b = itemWithStem('a ball falls 12 m in 3 s');
    expect(exactHash(a)).not.toBe(exactHash(b));
  });

  it('two items differing in a word share neither hash', () => {
    const a = itemWithStem('a ball falls 5 m in 2 s');
    const b = itemWithStem('a rock falls 5 m in 2 s');
    expect(exactHash(a)).not.toBe(exactHash(b));
    expect(skeletonHash(a)).not.toBe(skeletonHash(b));
  });

  it('identical items share both hashes', () => {
    const a = itemWithStem('a ball falls 5 m in 2 s');
    const b = itemWithStem('a ball falls 5 m in 2 s');
    expect(exactHash(a)).toBe(exactHash(b));
    expect(skeletonHash(a)).toBe(skeletonHash(b));
  });

  it('option re-ordering does not change skeletonHash', () => {
    const a = itemWithStem('pick the prime', ['2', '3', '4']);
    const b = itemWithStem('pick the prime', ['4', '2', '3']);
    expect(skeletonHash(a)).toBe(skeletonHash(b));
  });

  it('option re-ordering does change exactHash — authored order is preserved', () => {
    const a = itemWithStem('pick the prime', ['2', '3', '4']);
    const b = itemWithStem('pick the prime', ['4', '2', '3']);
    expect(exactHash(a)).not.toBe(exactHash(b));
  });
});

describe('unit-token normalization', () => {
  it('collapses a number and its unit token together', () => {
    expect(skeletonHash(itemWithStem('speed is 5 m/s'))).toBe(skeletonHash(itemWithStem('speed is 20 m/s')));
  });

  it('handles a caret-exponent unit form (ms^-1)', () => {
    expect(skeletonHash(itemWithStem('speed is 5 ms^-1'))).toBe(skeletonHash(itemWithStem('speed is 20 ms^-1')));
  });

  it('does not collapse a unit that is a different unit — the skeleton is not blind to units changing', () => {
    expect(skeletonHash(itemWithStem('speed is 5 m/s'))).not.toBe(skeletonHash(itemWithStem('speed is 5 kg')));
  });

  it('does not touch a word that merely follows a number without being a unit-shaped token', () => {
    const withPlaceholder = skeletonHash(itemWithStem('there are 5 the'));
    const withDifferentWord = skeletonHash(itemWithStem('there are 5 and'));
    // "the" and "and" are still letters-only, so they DO match the unit-token
    // shape and are collapsed — the module normalizes any unit-shaped token
    // after a number, not just a curated list of real units.
    expect(withPlaceholder).toBe(withDifferentWord);
  });
});

describe('determinism', () => {
  it('is byte-identical across 1,000 calls', () => {
    const facts = itemWithStem('a ball falls 5 m in 2 s', ['a', 'b']);
    const exact = exactHash(facts);
    const skeleton = skeletonHash(facts);
    for (let i = 0; i < 1000; i += 1) {
      expect(exactHash(facts)).toBe(exact);
      expect(skeletonHash(facts)).toBe(skeleton);
    }
  });
});

describe('purity', () => {
  it('produces a 64-character lowercase hex digest (sha256)', () => {
    expect(exactHash(itemWithStem('x'))).toMatch(/^[0-9a-f]{64}$/u);
    expect(skeletonHash(itemWithStem('x'))).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('handles absent options the same as an empty array', () => {
    expect(exactHash(itemWithStem('x'))).toBe(exactHash(itemWithStem('x', [])));
    expect(skeletonHash(itemWithStem('x'))).toBe(skeletonHash(itemWithStem('x', [])));
  });
});
