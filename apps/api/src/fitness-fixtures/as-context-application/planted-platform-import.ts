/**
 * Planted violation for `role-rules.spec.ts` (ADR-0026): a context reaching into
 * `platform/` for something other than the role vocabulary. Never imported by
 * production code.
 */
import { createApplication } from '../../platform/composition/app-factory.js';
import { ROLES } from '../../platform/auth/roles.js';

export const reachesPastTheVocabulary = [createApplication, ROLES];
