import type { JSX } from 'react';
import { TOKENS } from '../tokens.js';

/** A minute or less changes the colour and nothing else: no flashing, no sound. */
const LAST_MINUTE_MS = 60_000;

export function formatRemaining(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const two = (value: number) => value.toString().padStart(2, '0');
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${two(minutes)}:${two(seconds)}`;
}

export function TimerBadge({ remainingMs }: { readonly remainingMs: number }): JSX.Element {
  return (
    <span role="timer" aria-label={`Time left ${formatRemaining(remainingMs)}`} style={{ color: remainingMs <= LAST_MINUTE_MS ? TOKENS.feedbackWarning : TOKENS.textPrimary }}>
      {formatRemaining(remainingMs)}
    </span>
  );
}
