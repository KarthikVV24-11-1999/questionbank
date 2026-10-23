import { describe, expect, it, vi } from 'vitest';
import { registerServiceWorker } from './register.js';

describe('registering the service worker', () => {
  it('is a no-op where the browser has none: the shell is online-only and every answer is still kept on the device', async () => {
    expect(await registerServiceWorker(undefined)).toBeNull();
  });
  it('registers at the root path by default, and hands back a way to ask for a newer shell', async () => {
    const registration = { update: vi.fn() };
    const register = vi.fn().mockResolvedValue(registration);
    expect(await registerServiceWorker({ register })).toBe(registration);
    expect(register).toHaveBeenCalledWith('/sw.js');
  });
  it('treats a refused registration as no service worker rather than as a broken page', async () => {
    expect(await registerServiceWorker({ register: () => Promise.reject(new Error('insecure')) })).toBeNull();
  });
});
