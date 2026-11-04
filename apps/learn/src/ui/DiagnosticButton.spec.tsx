import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NO_ANALYTICS } from '../analytics/emitter.js';
import { FakeApi } from '../testing/fakes.js';
import { DiagnosticButton } from './DiagnosticButton.js';

afterEach(cleanup);

describe('the tap that starts the diagnostic (M8-32)', () => {
  it('says to choose an exam, and does not try, when the learner has none', () => {
    const assessment = new FakeApi({} as never, new Error('no key'));
    render(<DiagnosticButton exam={null} assessment={assessment} context={{ lastAttemptId: null, pageKey: 'p', analytics: NO_ANALYTICS }} onOpen={vi.fn()} />);
    expect(screen.getByRole('note')).toHaveTextContent('Choose your exam first.');
    expect(screen.getByRole('link', { name: 'Choose it now' })).toHaveAttribute('href', '?onboarding=1');
    expect(screen.queryByRole('button')).toBeNull();
    expect(assessment.calls).toEqual([]);
  });
});
