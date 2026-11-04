import { err } from '../contexts/learning/domain/result.js';
import type { CurriculumSource } from '../contexts/learning/public/composition.js';

/** A Curriculum that cannot be reached, for a spec of Learning that does not touch the profile: every read says so, and none is a surprise. */
const unavailable = () => err({ kind: 'Unavailable' as const, code: 'SOURCE_UNAVAILABLE', message: 'curriculum is not composed in' });

export const noCurriculum: CurriculumSource = {
  examOptions: async () => unavailable(),
  resolveExam: async () => unavailable(),
  scopeOptions: async () => unavailable(),
  resolveScope: async () => unavailable(),
  conceptNames: async () => unavailable(),
};
