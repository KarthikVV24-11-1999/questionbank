import { describe, expect, it } from 'vitest';
import { UuidIdentifierFactory } from './identifiers.js';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

describe('UuidIdentifierFactory — unique and v4-shaped', () => {
  it('produces a v4-shaped UUID', () => {
    const factory = new UuidIdentifierFactory();
    expect(factory.next()).toMatch(UUID_V4_PATTERN);
  });

  it('produces unique identifiers across many calls', () => {
    const factory = new UuidIdentifierFactory();
    const ids = new Set(Array.from({ length: 1000 }, () => factory.next()));
    expect(ids.size).toBe(1000);
  });
});
