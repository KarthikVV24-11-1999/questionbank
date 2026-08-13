/**
 * Planted violations of §9 rule 1 from the **content** context, one per way a
 * module could reach past a barrel. Not production code; `boundary-rules.spec.ts`
 * runs F1 over this directory to prove the rule fires for content the same way
 * it fires for scoring.
 *
 * Each import is a different reach: into another context's domain, into its
 * infrastructure, and into its application layer — the three places a barrel
 * exists to stand in front of.
 */
import type { AnswerKey } from '../../contexts/scoring/domain/answer-key.js';
import { curriculum } from '../../contexts/curriculum/infrastructure/schema.js';
import type { ScoreRecordView } from '../../contexts/scoring/application/queries/scoring-queries.js';

export type SmuggledKey = AnswerKey;
export type SmuggledView = ScoreRecordView;
export const smuggledSchema = curriculum;
