import type { PrincipalRef } from '@questionbank/domain-types';
import type { CurriculumForLearning } from '../../contexts/curriculum/public/composition.js';
import type { CurriculumSource, ExamOption, ResolvedScope, ScopeOptions } from '../../contexts/learning/public/composition.js';
import { ROLES } from '../auth/roles.js';

/**
 * Learning's port for Curriculum, implemented from the seam Curriculum offers (M8-19, ADR-0060): the one place that names both contexts. It lives in the root because only the root
 * may, and it is **all-or-nothing, naming what it cannot resolve**, as `learning-evidence.ts` is: a chapter the taxonomy version does not have fails the whole resolution and is
 * named, an exam or a year with no profile in force is named, and nothing is returned half-resolved.
 *
 * The questions are put as the system, because the answers are the system's alone. Curriculum never learns whose profile it is for, and Learning never sees a Curriculum type.
 */
const SYSTEM: PrincipalRef = { kind: 'system', id: '00000000-0000-4000-8000-0000000000f9', roleContext: [ROLES.system] };

type Failure = { readonly ok: false; readonly error: Readonly<{ kind: 'NotFound' | 'Unavailable' | 'Validation' | 'Conflict' | 'PreconditionFailed'; code: string; message: string }> };

/** Curriculum's refusal, in Learning's words: a missing thing stays missing, anything else is that the source could not be read. */
function failed(error: { readonly kind: string; readonly code: string; readonly message: string }): Failure {
  const missing = error.kind === 'NotFound';
  return { ok: false, error: Object.freeze({ kind: missing ? ('NotFound' as const) : ('Unavailable' as const), code: missing ? error.code : 'SOURCE_UNAVAILABLE', message: missing ? error.message : `curriculum could not be read: ${error.code}` }) };
}

export class CurriculumLearnerSource implements CurriculumSource {
  constructor(private readonly curriculum: CurriculumForLearning) {}

  async examOptions(context: { readonly correlationId: string }) {
    const answered = await this.curriculum.examOptions.handle({}, { principal: SYSTEM, correlationId: context.correlationId });
    if (!answered.ok) return failed(answered.error);
    const options: readonly ExamOption[] = answered.value.map((option) => Object.freeze({ examCode: option.examCode, displayName: option.displayName, years: Object.freeze([...option.years]) }));
    return { ok: true as const, value: options };
  }

  async resolveExam(examCode: string, targetYear: string, context: { readonly correlationId: string }) {
    const answered = await this.curriculum.resolveExam.handle({ examCode, academicYear: targetYear }, { principal: SYSTEM, correlationId: context.correlationId });
    if (!answered.ok) return failed(answered.error);
    return { ok: true as const, value: Object.freeze({ examCode: answered.value.examCode, targetYear: answered.value.academicYear, examProfileVersionId: answered.value.profileVersionId, taxonomyVersionId: answered.value.taxonomyVersionId }) };
  }

  async scopeOptions(taxonomyVersionId: string, context: { readonly correlationId: string }) {
    const answered = await this.curriculum.scopeNodes.handle({ taxonomyVersionId }, { principal: SYSTEM, correlationId: context.correlationId });
    if (!answered.ok) return failed(answered.error);
    const options: ScopeOptions = Object.freeze({ taxonomyVersionId: answered.value.taxonomyVersionId, nodes: Object.freeze(answered.value.nodes.map((node) => Object.freeze({ ...node }))), conceptTotal: answered.value.conceptTotal });
    return { ok: true as const, value: options };
  }

  async resolveScope(taxonomyVersionId: string, nodeIds: readonly string[], context: { readonly correlationId: string }) {
    const answered = await this.curriculum.resolveScope.handle({ taxonomyVersionId, nodeIds }, { principal: SYSTEM, correlationId: context.correlationId });
    if (!answered.ok) return failed(answered.error);
    const resolved: ResolvedScope = Object.freeze({ conceptIdentityIds: Object.freeze([...answered.value.conceptIdentityIds]), conceptTotal: answered.value.conceptTotal });
    return { ok: true as const, value: resolved };
  }
}
