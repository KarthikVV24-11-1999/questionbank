import { describe, expect, it } from 'vitest';
import {
  BLOCK_KINDS as RENDERER_BLOCK_KINDS,
  CONTENT_BODY_SCHEMA_VERSION as RENDERER_SCHEMA_VERSION,
  INLINE_KINDS as RENDERER_INLINE_KINDS,
  MEDIA_SIZE_HINTS as RENDERER_SIZE_HINTS,
  TEXT_MARKS as RENDERER_TEXT_MARKS,
} from '@questionbank/content-renderer/content-body';
import {
  BLOCK_KINDS,
  CONTENT_BODY_SCHEMA_VERSION,
  INLINE_KINDS,
  MEDIA_SIZE_HINTS,
  TEXT_MARKS,
} from './domain/content-body.js';

/**
 * The content → renderer seam.
 *
 * The renderer declares the node vocabulary itself: a package cannot import an
 * app, and `domain/` imports nothing (§9 rule 2), so there is no direction in
 * which one definition serves both. What keeps them honest is this file — a
 * kind added on one side and not the other fails the build here, which is the
 * same instrument the M2→M3 answer-key seam uses and the same reason.
 *
 * Without it, a new node kind ships as a fallback box on a student's screen
 * and nobody finds out until a mark is disputed.
 *
 * The import is the **vocabulary subpath**, not the package barrel: the API is
 * a Node process with no JSX, and it needs the node kinds rather than the
 * component that draws them.
 */

describe('the node vocabulary is the same on both sides (DEC-2)', () => {
  it('agrees on the block kinds', () => {
    expect([...RENDERER_BLOCK_KINDS]).toEqual([...BLOCK_KINDS]);
  });

  it('agrees on the inline kinds', () => {
    expect([...RENDERER_INLINE_KINDS]).toEqual([...INLINE_KINDS]);
  });

  it('agrees on the text marks', () => {
    expect([...RENDERER_TEXT_MARKS]).toEqual([...TEXT_MARKS]);
  });

  it('agrees on the media size hints', () => {
    expect([...RENDERER_SIZE_HINTS]).toEqual([...MEDIA_SIZE_HINTS]);
  });

  // A document written under one schema version and rendered under another is
  // exactly the divergence the sibling `*_schema_version` column exists to
  // catch at rest; this catches it in the code path.
  it('agrees on the schema version', () => {
    expect(RENDERER_SCHEMA_VERSION).toBe(CONTENT_BODY_SCHEMA_VERSION);
  });

  it('checks a vocabulary that is not empty', () => {
    expect(RENDERER_BLOCK_KINDS.length).toBeGreaterThan(0);
    expect(RENDERER_INLINE_KINDS.length).toBeGreaterThan(0);
  });
});
