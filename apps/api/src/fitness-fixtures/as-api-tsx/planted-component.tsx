import type { JSX } from 'react';

/**
 * Stands in for someone authoring a component in the backend instead of
 * type-checking one imported from the renderer package (ADR-0016). The
 * `jsx` compiler option in `apps/api/tsconfig.json` exists for the second
 * reason only; this fixture is what the first would look like.
 */
export function PlantedComponent(): JSX.Element {
  return <div>should never exist under apps/api/src</div>;
}
