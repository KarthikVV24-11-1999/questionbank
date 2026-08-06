/**
 * A deliberate architecture violation, used by the boundary spec to prove the
 * rules actually fire. It is excluded from the production cruise config and
 * imported by nothing.
 */
import { TaxonomyVersion } from '../contexts/curriculum/domain/taxonomy-version.js';

export const plantedViolation = TaxonomyVersion.name;
