import { useState } from 'react';

/** The erosion itself: a component that keeps its own copy of the pick. */
export function Pick() {
  const [picked, setPicked] = useState<string | null>(null);
  return <button onClick={() => setPicked('a')}>{picked}</button>;
}
