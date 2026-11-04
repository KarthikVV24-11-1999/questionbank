import { describe, expect, it } from 'vitest';
import { PROFILE, TAXONOMY } from '../testing/learning-fixtures.js';
import { chosenProfile, emptyProfile } from '../testing/profile-fakes.js';
import { pinsOf } from './exam-pins.js';

describe('the exam a learner chose, as a screen needs it (D88)', () => {
  it('is the exam profile version and the taxonomy version the profile pinned, and nothing else of it', () => {
    expect(pinsOf(chosenProfile())).toEqual({ examProfileVersionId: PROFILE, taxonomyVersionId: TAXONOMY });
  });

  it('is nothing for a learner who has chosen no exam, and for a profile that could not be read', () => {
    expect(pinsOf(emptyProfile())).toBeNull();
    expect(pinsOf(null)).toBeNull();
  });
});
