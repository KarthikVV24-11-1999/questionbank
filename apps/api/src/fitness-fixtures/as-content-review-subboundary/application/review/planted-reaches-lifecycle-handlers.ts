/**
 * Not production code. The other half of proving the M4-27 exemption stayed
 * narrow — review plumbing reaching `application/handlers/lifecycle-handlers.ts`
 * must still fail.
 */
import { fakeRecordItemReviewDecisionHandler } from '../handlers/lifecycle-handlers.js';

export const smuggledHandler = fakeRecordItemReviewDecisionHandler;
