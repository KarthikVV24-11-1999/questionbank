/** A relay or scheduler that reads the clock itself: a lease or a back-off that cannot be tested without waiting. */
export const due = (retryAt: number): boolean => Date.now() >= retryAt;
export const stamp = (): Date => new Date();
