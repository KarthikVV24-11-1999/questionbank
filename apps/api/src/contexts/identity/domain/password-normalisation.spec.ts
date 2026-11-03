import { describe, expect, it } from 'vitest';
import { normalisePassword } from './password-normalisation.js';

describe('the form a password is compared and hashed in', () => {
  it('is NFKC: compatibility forms and composed forms become the characters a person meant', () => {
    expect(normalisePassword('ｐａｓｓｗｏｒｄ１２３４')).toBe('password1234');
    expect(normalisePassword('café au lait')).toBe('café au lait');
  });

  it('leaves case, spaces and ordinary text alone: it is a normal form, not a fold', () => {
    expect(normalisePassword('Correct Horse  Battery')).toBe('Correct Horse  Battery');
  });
});
