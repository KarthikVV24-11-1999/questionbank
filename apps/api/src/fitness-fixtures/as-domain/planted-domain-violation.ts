/**
 * Stands in for a domain module that reached for infrastructure. The boundary
 * spec cruises it under a config whose `from` is widened to this directory, so
 * the F2 rule is exercised without shipping a real violation.
 */
import { curriculum } from '../../contexts/curriculum/infrastructure/schema.js';

export const plantedDomainViolation = curriculum;
