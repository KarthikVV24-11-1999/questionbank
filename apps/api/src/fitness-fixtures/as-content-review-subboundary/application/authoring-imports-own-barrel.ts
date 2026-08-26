/**
 * Not production code. Proves `checkReviewAuthoringSubBoundary` catches
 * `M4_01_INTERNAL_MODULE_IMPORTS_BARREL` (M4-35): an ordinary authoring
 * module reaching the barrel is the path by which it could otherwise pick
 * up review's re-exported types without ever naming `application/review/`
 * directly — neither of the other two rules can see this one.
 */
import { barrelValue } from '../public/index.js';

export const reachedViaBarrel = barrelValue;
