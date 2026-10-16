import { describe, expect, it } from 'vitest';
import { isUuid } from './uuid.js';

describe('isUuid', () => {
  it('accepts a UUID in either case', () => {
    expect(isUuid('0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d')).toBe(true);
    expect(isUuid('0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D')).toBe(true);
  });

  it('refuses a label, a near miss, padding and anything that is not a string', () => {
    for (const value of ['model-v3', '', ' ', '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4', '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4dd', ' 0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz', 5, null, undefined]) {
      expect(isUuid(value), String(value)).toBe(false);
    }
  });
});
