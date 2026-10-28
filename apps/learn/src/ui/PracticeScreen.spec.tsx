import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { attemptWithLogDto } from '../testing/fakes.js';
import { PROFILE, TAXONOMY } from '../testing/learning-fixtures.js';
import { PracticeScreen } from './PracticeScreen.js';
import type { ScreenContext } from './screen-context.js';

afterEach(cleanup);

const context: ScreenContext = { examProfileVersionId: PROFILE, taxonomyVersionId: TAXONOMY, lastAttemptId: null, pageKey: 'p' };
const practiceRun = (overrides = {}) => attemptWithLogDto({ attemptId: 'run-1', mode: 'practice', formId: null, sessionRef: null, shiftId: null, durationMs: null, windowClosesAt: null, state: 'in_progress', slotCount: 10, ...overrides });
const show = (read: () => Promise<ReturnType<typeof practiceRun>>) => render(<PracticeScreen assessment={{ getAttempt: read }} attemptId="run-1" context={context} />);

describe('the practice screen (M7-58)', () => {
  it('shows the run that was started and how large it is, and says that its questions cannot be shown yet', async () => {
    show(async () => practiceRun());
    expect(await screen.findByText(/10 questions chosen for you\. Your run is started\./u)).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('cannot be shown in the app yet');
    expect(screen.getByRole('link', { name: 'Back to what to do next' })).toHaveAttribute('href', `?profile=${PROFILE}&taxonomy=${TAXONOMY}`);
  });

  it('says a single question in the singular, and the state of a run that is not in progress in words', async () => {
    show(async () => practiceRun({ slotCount: 1, state: 'submitted' }));
    expect(await screen.findByText(/1 question chosen for you\. Your run is submitted\./u)).toBeInTheDocument();
  });

  it('will not call a sitting of a form a practice run', async () => {
    show(async () => practiceRun({ mode: 'mock' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not a practice run');
  });

  it('says it is opening, and says plainly when it could not', async () => {
    show(async () => {
      throw new Error('no attempt of yours with that id');
    });
    expect(screen.getByRole('status')).toHaveTextContent('Opening your run');
    expect(await screen.findByRole('alert')).toHaveTextContent('no attempt of yours');
  });

  it('has no accessibility violation', async () => {
    const view = show(async () => practiceRun());
    await screen.findByRole('note');
    expect((await axe.run(view.container)).violations.map((violation) => violation.id)).toEqual([]);
  });
});
