/**
 * A planted violation of all three generation-domain guards, in one file. Not
 * production code — `generation-error.spec.ts` runs the same guards over this
 * directory to prove each fails when it should, rather than only that it
 * passes on a tree that happens to be clean.
 *
 * It reaches into another context's barrel and into a package, it throws, and
 * it reads a clock and a source of randomness.
 */
import { z } from 'zod';
import type { SubmitItemForReview } from '../../contexts/content/public/index.js';

export type SmuggledThroughABarrel = SubmitItemForReview;

export const smuggledPackage = z.string();

export function refuse(): never {
  throw new Error('a domain module that throws instead of returning a Result');
}

export function proposedAt(): string {
  return new Date().toISOString();
}

export function jitter(): number {
  return Math.random();
}
