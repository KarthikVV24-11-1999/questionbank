/**
 * Not production code. Proves review plumbing importing `application/ports.ts`
 * is permitted (M4-27) — the second named exception outside the domain layer.
 */
import { fakePorts } from '../ports.js';

export const usesPorts = fakePorts;
