// Planted violation for frontend-rules.spec.ts (F26): a framework import
// inside a package standing in for packages/attempt-engine, which does not
// exist yet (M6's) and must import no framework when it does.
import { useState } from 'react';

export function useAttemptState() {
  return useState(0);
}
