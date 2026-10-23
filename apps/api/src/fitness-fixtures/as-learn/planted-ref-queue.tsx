import { useRef } from 'react';

/** A queue held in a ref: the engine's sync queue, copied. */
export function Sender() {
  const queue = useRef<string[]>([]);
  return <span>{queue.current.length}</span>;
}
