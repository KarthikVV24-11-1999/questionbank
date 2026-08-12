/**
 * A planted violation of all three content-domain guards, in one file. Not
 * production code — `content-error.spec.ts` runs the same guards over this
 * directory to prove each fails when it should, rather than only that it
 * passes on a tree that happens to be clean.
 *
 * It reaches outward, it throws, and it reads a clock.
 */
import { curriculum } from '../../contexts/curriculum/infrastructure/schema.js';

export const smuggledSchema = curriculum;

export function refuse(): never {
  throw new Error('a domain module that throws instead of returning a Result');
}

export function authoredAt(): string {
  return new Date().toISOString();
}
