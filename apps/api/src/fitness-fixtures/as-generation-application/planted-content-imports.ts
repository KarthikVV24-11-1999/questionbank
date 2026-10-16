/**
 * Planted violations for `generation-rules.spec.ts` — generation reaching into
 * `contexts/content/` in the two ways ADR-0025 forbids, beside the one way it
 * permits. The spec cruises this file as if it were in generation's
 * application layer.
 *
 * Never imported by production code.
 */

// Permitted: the barrel, as a type. Must NOT be reported.
import type { CreateItemDraft } from '../../contexts/content/public/index.js';

// Forbidden: a deep import past the barrel.
import type { Provenance } from '../../contexts/content/domain/provenance.js';

// Forbidden: the barrel at runtime. Generation holds no capability to run
// anything in content; it names commands, and the composition root runs them.
import { REJECTION_REASONS } from '../../contexts/content/public/index.js';

export type Planted = [CreateItemDraft, Provenance, typeof REJECTION_REASONS];

// Forbidden (F27): generation writing content's table itself.
export const SMUGGLED_WRITE = `INSERT INTO content.item (item_type) VALUES ('SINGLE_CORRECT_MCQ')`;
