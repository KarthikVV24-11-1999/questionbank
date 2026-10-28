import { makeReleasedSlot } from '../../contexts/assessment/domain/solution-release.js';

/** A handler that decides for itself that a slot is released: the gate walked around. */
export const forged = makeReleasedSlot('attempt', 'slot', 'version');
