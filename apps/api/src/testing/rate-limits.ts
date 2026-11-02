import { BoundedWork } from '../platform/concurrency/bounded-work.js';
import { DEFAULT_ABUSE_LIMITS } from '../platform/config/config.js';
import type { RateLimiter } from '../platform/rate-limit/rate-limiter.js';
import { systemTimers } from '../platform/scheduling/system-timers.js';

/** A limiter that admits everything, for the tests whose subject is something else and which would otherwise ask from one address, on a frozen clock, hundreds of times. */
export const unlimited: RateLimiter = { hit: () => Promise.resolve({ allowed: true }) };

/** The abuse-related dependencies identity's composition asks for, with the defaults and no limiting. */
export const identityAbuseDeps = {
  limiter: unlimited,
  limits: {
    login: DEFAULT_ABUSE_LIMITS.rateLimitLogin,
    register: DEFAULT_ABUSE_LIMITS.rateLimitRegister,
    recovery: DEFAULT_ABUSE_LIMITS.rateLimitRecovery,
    reset: DEFAULT_ABUSE_LIMITS.rateLimitReset,
    verification: DEFAULT_ABUSE_LIMITS.rateLimitVerification,
    passwordChange: DEFAULT_ABUSE_LIMITS.rateLimitPasswordChange,
  },
  hashBound: new BoundedWork({ concurrency: DEFAULT_ABUSE_LIMITS.passwordHashConcurrency, queueLimit: DEFAULT_ABUSE_LIMITS.passwordHashQueue, waitMs: DEFAULT_ABUSE_LIMITS.passwordHashWaitMs, timers: systemTimers }),
} as const;
