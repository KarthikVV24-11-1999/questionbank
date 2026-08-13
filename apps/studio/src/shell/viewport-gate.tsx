import type { JSX, ReactNode } from 'react';
import { MINIMUM_VIEWPORT_WIDTH } from './navigation.js';

/**
 * Below 1280 px the Studio renders an explicit "use a larger screen" gate and
 * **no authoring surface at all** (FRONTEND §2, §9).
 *
 * Not a responsive squeeze: an authoring tool on a phone is a fiction, and
 * pretending otherwise costs real engineering while producing an editor nobody
 * can use. Rendering the surface underneath a message would also mean an
 * answer key on a screen somebody is holding on a train.
 */
export interface ViewportGateProps {
  readonly width: number;
  readonly children: ReactNode;
}

export function ViewportGate(props: ViewportGateProps): JSX.Element {
  if (props.width >= MINIMUM_VIEWPORT_WIDTH) return <>{props.children}</>;

  return (
    <div className="qb-viewport-gate" role="alert">
      <h1>Use a larger screen</h1>
      <p>
        Studio needs a window at least {MINIMUM_VIEWPORT_WIDTH} pixels wide. This window is{' '}
        {props.width} pixels.
      </p>
    </div>
  );
}
