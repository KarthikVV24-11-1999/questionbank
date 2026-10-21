// Planted violation for frontend-rules.spec.ts (F26): a framework import
// inside a package standing in for packages/attempt-engine, which must
// import no framework.
import { useState } from 'react';

export function useAttemptState() {
  return useState(0);
}
