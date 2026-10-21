// Planted violation for frontend-rules.spec.ts (F26): the attempt engine
// sending its own events. Something outside decides how to send.
export async function flush(body: string): Promise<void> {
  await fetch('/events', { method: 'POST', body });
}
