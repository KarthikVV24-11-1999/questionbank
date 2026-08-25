// Planted violation for platform-rules.spec.ts's "sealDay is unreachable
// from production code" check (M4-34) — proves the check can fail. Never
// imported by production code.
import { sealDay } from '../../platform/persistence/audit-anchor.js';

export const reachesSealDay = sealDay;
