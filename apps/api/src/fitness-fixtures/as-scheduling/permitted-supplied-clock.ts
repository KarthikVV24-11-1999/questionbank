/** Time supplied is not time read: a Date built from a value the caller gave is fine. */
export const due = (now: Date, retryAt: number): boolean => now.getTime() >= retryAt;
export const later = (now: Date, ms: number): Date => new Date(now.getTime() + ms);
