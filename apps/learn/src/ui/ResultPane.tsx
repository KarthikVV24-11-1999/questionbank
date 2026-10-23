import type { JSX } from 'react';
import type { ResultDto } from '../api/schemas.js';
import { TOKENS } from '../tokens.js';

/** The result as the server gave it: a number, and the rule behind each mark. It names no answer, because it was never given one. */
export function ResultPane({ result, onRefresh }: { readonly result: ResultDto | null; readonly onRefresh: () => void }): JSX.Element {
  if (result === null || result.status === 'pending' || result.score === undefined) {
    return (
      <section aria-label="Result" style={{ padding: TOKENS.spaceMedium }}>
        <h1>Submitted</h1>
        <p role="status">Your paper is being marked. This can take a moment.</p>
        <button type="button" onClick={onRefresh}>
          Check again
        </button>
      </section>
    );
  }
  return (
    <section aria-label="Result" style={{ padding: TOKENS.spaceMedium }}>
      <h1>
        {result.score.totalRaw} out of {result.score.totalMaxAvailable}
      </h1>
      <ol aria-label="Marks by question">
        {result.score.itemOutcomes.map((outcome) => (
          <li key={outcome.slotId}>
            {outcome.correctness}: {outcome.marksAwarded} of {outcome.marksAvailable}
          </li>
        ))}
      </ol>
    </section>
  );
}
