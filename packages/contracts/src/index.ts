/**
 * Generated OpenAPI types. `curriculum.ts` is produced by `pnpm generate` from
 * `openapi/curriculum.yaml` and must never be hand-edited — the spec is the
 * source of truth (BACKEND-ARCHITECTURE §3).
 */
export type { components, operations, paths } from './curriculum.js';

export type CurriculumSchemas = import('./curriculum.js').components['schemas'];

export type ProblemDetails = CurriculumSchemas['ProblemDetails'];
export type ErrorCode = CurriculumSchemas['ErrorCode'];
export type TaxonomyVersionDetail = CurriculumSchemas['TaxonomyVersionDetail'];
export type TaxonomyVersionPage = CurriculumSchemas['TaxonomyVersionPage'];
export type ExamProfileVersionDetail = CurriculumSchemas['ExamProfileVersionDetail'];
export type ExamPage = CurriculumSchemas['ExamPage'];
export type MigrationDryRun = CurriculumSchemas['MigrationDryRun'];
export type MarkingRuleSet = CurriculumSchemas['MarkingRuleSet'];
export type NumericAnswerSpec = CurriculumSchemas['NumericAnswerSpec'];
