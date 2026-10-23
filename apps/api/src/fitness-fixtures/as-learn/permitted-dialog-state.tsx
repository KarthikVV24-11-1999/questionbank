import { useState } from 'react';

/** Whether a dialog is open is the view's own business. */
export function Confirm() {
  const [confirming, setConfirming] = useState(false);
  return <button onClick={() => setConfirming(!confirming)}>{String(confirming)}</button>;
}
