import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { formPackageSchema } from '../package/types.js';
import { AttemptSession } from '../session/attempt-session.js';
import { loadRecord } from '../session/persistence.js';
import { aPackageDocument, slotIds } from '../testing/signed-package.js';
import { aRig } from '../testing/fakes.js';
import { LearnApp } from './LearnApp.js';

afterEach(cleanup);

const form = formPackageSchema.parse(aPackageDocument());
const START = { attemptId: 'att-1', deviceRef: 'd', intervalCapMs: 90_000, deadline: '2026-10-21T11:30:00.000Z', serverNow: '2026-10-21T08:30:00.000Z' };

function sitting() {
  const rig = aRig();
  const session = AttemptSession.begin(START, rig.ports);
  return { ...rig, session };
}
const events = (storage: ReturnType<typeof aRig>['storage']) => loadRecord(storage, 'att-1')!.events;

describe('the sitting is chrome-less (§7, M6-46)', () => {
  it('has no site navigation and no link out: the only way off is to submit', () => {
    const { session } = sitting();
    const { container } = render(<LearnApp session={session} form={form} />);
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(screen.queryByRole('banner', { name: /navigation/iu })).toBeNull();
    expect(screen.getByRole('button', { name: /submit paper/iu })).toBeInTheDocument();
    expect(screen.getAllByRole('navigation').map((nav) => nav.getAttribute('aria-label'))).toEqual(['Questions']);
  });

  it('opens on the first question, by visiting it — an event in the log like any other', () => {
    const { session, storage } = sitting();
    render(<LearnApp session={session} form={form} />);
    expect(screen.getByRole('region', { name: 'Question 1' })).toBeInTheDocument();
    expect(events(storage).map((event) => `${event.kind}:${event.slot}`)).toEqual([`visit:${slotIds[0]}`]);
  });
});

describe('the UI holds no attempt state (M6-47)', () => {
  it('shows an answer because the log says so: choosing it is an event, and the control is checked from the projection', async () => {
    const { session, storage } = sitting();
    render(<LearnApp session={session} form={form} />);
    await userEvent.click(screen.getByRole('radio', { name: /option b/iu }));
    expect(screen.getByRole('radio', { name: /option b/iu })).toBeChecked();
    expect(events(storage).at(-1)).toMatchObject({ kind: 'select', slot: slotIds[0], answer: 'b' });
    await userEvent.click(screen.getByRole('radio', { name: /option c/iu }));
    expect(screen.getByRole('radio', { name: /option c/iu })).toBeChecked();
    expect(screen.getByRole('radio', { name: /option b/iu })).not.toBeChecked();
    expect(events(storage).at(-1)).toMatchObject({ kind: 'change', answer: 'c' });
  });

  it('follows the engine when the engine is changed from outside the UI — it has no copy to disagree with', () => {
    const { session } = sitting();
    render(<LearnApp session={session} form={form} />);
    expect(screen.getByRole('radio', { name: /option d/iu })).not.toBeChecked();
    act(() => session.select(slotIds[0], 'd')); // not through any control
    expect(screen.getByRole('radio', { name: /option d/iu })).toBeChecked();
    act(() => session.goTo(slotIds[2]));
    expect(screen.getByRole('region', { name: 'Question 3' })).toBeInTheDocument();
    act(() => session.clear(slotIds[0]));
    act(() => session.goTo(slotIds[0]));
    expect(screen.getByRole('radio', { name: /option d/iu })).not.toBeChecked();
  });

  it('draws the same thing from two views of one session, and loses nothing when one is thrown away', async () => {
    const { session } = sitting();
    const one = render(<LearnApp session={session} form={form} />);
    await userEvent.click(screen.getByRole('radio', { name: /option a/iu }));
    one.unmount();
    render(<LearnApp session={session} form={form} />);
    expect(screen.getByRole('radio', { name: /option a/iu })).toBeChecked();
  });

  it('comes back, after the page is reloaded, to exactly what the engine held: the answers, the question, the time', async () => {
    const first = sitting();
    const view = render(<LearnApp session={first.session} form={form} />);
    await userEvent.click(screen.getByRole('radio', { name: /option b/iu }));
    await userEvent.click(screen.getByRole('button', { name: /^question 2/iu }));
    await userEvent.click(screen.getByRole('radio', { name: /option c/iu }));
    view.unmount();

    // a reload: new objects everywhere, the same disk, the server's own reading of the deadline
    const reloaded = aRig({ storage: first.storage, newId: () => `r-${Math.random()}` });
    const resumed = AttemptSession.resume({ record: loadRecord(first.storage, 'att-1')!, server: { ...(await first.transport.getAttempt()), serverNow: '2026-10-21T09:30:00.000Z' } }, reloaded.ports);
    render(<LearnApp session={resumed} form={form} />);
    expect(screen.getByRole('region', { name: 'Question 2' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /option c/iu })).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: /^question 1/iu }));
    expect(screen.getByRole('radio', { name: /option b/iu })).toBeChecked();
    expect(screen.getByRole('timer')).toHaveTextContent('2:00:00'); // two hours left of the server's deadline, not three
  });

  it('flags a question and says so in the palette, from the log', async () => {
    const { session } = sitting();
    render(<LearnApp session={session} form={form} />);
    await userEvent.click(screen.getByRole('button', { name: /flag for review/iu }));
    expect(screen.getByRole('button', { name: /question 1, not answered, flagged for review/iu })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /remove flag/iu }));
    expect(screen.getByRole('button', { name: /question 1, not answered$/iu })).toBeInTheDocument();
  });

  it('clears an answer by the log, and the palette stops calling it answered', async () => {
    const { session } = sitting();
    render(<LearnApp session={session} form={form} />);
    await userEvent.click(screen.getByRole('radio', { name: /option b/iu }));
    expect(screen.getByRole('button', { name: /question 1, answered/iu })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /clear my answer/iu }));
    expect(screen.getByRole('button', { name: /question 1, not answered/iu })).toBeInTheDocument();
  });
});

describe('the sync indicator is the engine\'s word, and calm (M6-49)', () => {
  it('says all saved, then saving, then that answers are kept and will be sent — never an alarm', async () => {
    const { session, transport, clock } = sitting();
    render(<LearnApp session={session} form={form} />);
    // the visit to question 1 is waiting to be sent
    expect(screen.getByRole('status')).toHaveTextContent(/saving your answers/iu);
    await act(() => session.pump());
    expect(screen.getByRole('status')).toHaveTextContent('All answers saved');

    transport.online = false;
    await userEvent.click(screen.getByRole('radio', { name: /option b/iu }));
    await act(() => session.pump());
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/kept on this device and will be sent when the connection is back/iu);
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByRole('alert')).toBeNull();

    transport.online = true;
    clock.advance(40_000);
    await userEvent.click(screen.getByRole('button', { name: /try now/iu }));
    expect(screen.getByRole('status')).toHaveTextContent('All answers saved');
  });

  it('asks nothing of the browser about connectivity: it reads no navigator.onLine', () => {
    // The rule is in learn-rules.ts; this checks the component against the same source text.
    // (A second notion of "online" is what this project keeps paying for.)
    expect(stripComments(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'SyncIndicator.tsx'), 'utf8'))).not.toMatch(/onLine|addEventListener\('online'/u);
  });

  it('carries on through an outage: answering is not blocked, and the queue drains after', async () => {
    const { session, transport, clock } = sitting();
    render(<LearnApp session={session} form={form} />);
    transport.online = false;
    await userEvent.click(screen.getByRole('radio', { name: /option a/iu }));
    await act(() => session.pump());
    await userEvent.click(screen.getByRole('button', { name: /^question 2/iu }));
    await userEvent.click(screen.getByRole('radio', { name: /option d/iu }));
    expect(screen.getByRole('radio', { name: /option d/iu })).toBeChecked();
    expect(transport.stored.size).toBe(0);

    transport.online = true;
    clock.advance(60_000);
    await act(() => session.pump());
    expect(screen.getByRole('status')).toHaveTextContent('All answers saved');
    expect([...transport.stored.values()].map((event) => (event as { kind: string }).kind)).toContain('select');
  });
});

describe('submitting', () => {
  it('asks first, says how many are unanswered, and submits on a yes — as the learner\'s own manual submission', async () => {
    const { session, transport } = sitting();
    render(<LearnApp session={session} form={form} />);
    await userEvent.click(screen.getByRole('radio', { name: /option b/iu }));
    await userEvent.click(screen.getByRole('button', { name: /submit paper/iu }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('2 questions are not answered');
    await userEvent.click(screen.getByRole('button', { name: /keep working/iu }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /submit paper/iu }));
    await userEvent.click(screen.getByRole('button', { name: /yes, submit/iu }));
    expect(transport.submissions).toEqual([{ reason: 'manual', key: 'submission:att-1' }]);
    expect(screen.getByRole('heading', { name: 'Submitted' })).toBeInTheDocument();
  });

  it('says one question is not answered in the singular, and says nothing when all are answered', async () => {
    const { session } = sitting();
    render(<LearnApp session={session} form={form} />);
    for (const [index, slot] of slotIds.entries()) {
      act(() => session.select(slot, 'a'));
      if (index < 1) continue;
    }
    act(() => session.clear(slotIds[2]));
    await userEvent.click(screen.getByRole('button', { name: /submit paper/iu }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('1 question is not answered');
    await userEvent.click(screen.getByRole('button', { name: /keep working/iu }));
    act(() => session.select(slotIds[2], 'a'));
    await userEvent.click(screen.getByRole('button', { name: /submit paper/iu }));
    expect(screen.getByRole('alertdialog')).not.toHaveTextContent('not answered');
  });

  it('shows the submission in progress while the answers are still being sent, and the result once it lands', async () => {
    const { session, transport } = sitting();
    render(<LearnApp session={session} form={form} />);
    transport.online = false;
    await userEvent.click(screen.getByRole('button', { name: /submit paper/iu }));
    await userEvent.click(screen.getByRole('button', { name: /yes, submit/iu }));
    expect(screen.getByText(/submitting your paper/iu)).toBeInTheDocument();
    transport.online = true;
    await act(() => session.syncNow());
    expect(screen.getByRole('heading', { name: 'Submitted' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/being marked/iu);

    transport.resultAnswer = {
      attemptId: 'att-1',
      status: 'scored',
      score: { scoreRecordId: 's', attemptId: 'att-1', generation: 1, totalRaw: '10', totalMaxAvailable: '12', computedAt: 't', sectionScores: [], itemOutcomes: [{ slotId: slotIds[0], correctness: 'correct', marksAwarded: '4', marksAvailable: '4', ruleAppliedId: 'correct' }] },
    };
    await userEvent.click(screen.getByRole('button', { name: /check again/iu }));
    expect(screen.getByRole('heading', { name: '10 out of 12' })).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: /marks by question/iu })).getByText(/correct: 4 of 4/iu)).toBeInTheDocument();
  });
});

describe('the deadline (M6-50)', () => {
  it('submits itself at the deadline, as an expiry, and shows the timer going down on the engine\'s clock', async () => {
    const { session, clock, transport } = sitting();
    render(<LearnApp session={session} form={form} />);
    expect(screen.getByRole('timer')).toHaveTextContent('3:00:00');
    clock.advance(10_800_000 - 59_000);
    await act(() => session.pump());
    expect(screen.getByRole('timer')).toHaveTextContent('00:59');
    clock.advance(59_000);
    transport.serverRemainingMs = 0;
    await act(() => session.pump());
    expect(transport.submissions).toEqual([{ reason: 'expiry', key: 'submission:att-1' }]);
    expect(screen.getByRole('heading', { name: 'Submitted' })).toBeInTheDocument();
  });
});

describe('what the shell shows of a question', () => {
  const OTHER_TYPES = {
    ...aPackageDocument(),
    sections: [
      {
        ordinal: 1,
        sectionSpecRef: 'physics',
        slots: [
          {
            slotId: 'm-1',
            ordinal: 1,
            marksAvailable: 4,
            itemVersionId: 'iv-m',
            item: {
              itemVersionId: 'iv-m',
              itemType: 'MULTIPLE_CORRECT_MCQ',
              stem: { schemaVersion: 1, blocks: [{ kind: 'PARAGRAPH', inlines: [{ kind: 'TEXT', value: 'Pick all.', marks: [] }] }] },
              options: ['a', 'b'].map((optionId, i) => ({ optionId, ordinal: i + 1, body: { schemaVersion: 1, blocks: [{ kind: 'PARAGRAPH', inlines: [{ kind: 'TEXT', value: `Multi ${optionId}`, marks: [] }] }] } })),
            },
          },
          {
            slotId: 'n-1',
            ordinal: 2,
            marksAvailable: 4,
            itemVersionId: 'iv-n',
            item: {
              itemVersionId: 'iv-n',
              itemType: 'NUMERIC',
              stem: { schemaVersion: 1, blocks: [{ kind: 'PARAGRAPH', inlines: [{ kind: 'TEXT', value: 'Give g.', marks: [] }] }] },
              numericInput: { unitCanonical: 'm/s^2', unitRequired: true, acceptedForms: ['DECIMAL'] },
            },
          },
          {
            slotId: 'x-1',
            ordinal: 3,
            marksAvailable: 4,
            itemVersionId: 'iv-x',
            item: {
              itemVersionId: 'iv-x',
              itemType: 'MATCHING',
              stem: { schemaVersion: 1, blocks: [{ kind: 'PARAGRAPH', inlines: [{ kind: 'TEXT', value: 'Match.', marks: [] }] }] },
              matchingLeft: [{ memberId: 'l1', ordinal: 1, body: { schemaVersion: 1, blocks: [{ kind: 'PARAGRAPH', inlines: [{ kind: 'TEXT', value: 'Left one', marks: [] }] }] } }],
              matchingRight: [{ memberId: 'r1', ordinal: 1, body: { schemaVersion: 1, blocks: [] } }, { memberId: 'r2', ordinal: 2, body: { schemaVersion: 1, blocks: [] } }],
            },
          },
        ],
      },
    ],
    stimuli: [],
  };
  const other = formPackageSchema.parse(OTHER_TYPES);

  it('takes several options for a multiple-answer item, a typed value for a numeric one, and pairs for matching — each as the log\'s answer', async () => {
    const { session, storage } = sitting();
    render(<LearnApp session={session} form={other} />);
    await userEvent.click(screen.getByRole('checkbox', { name: /multi a/iu }));
    await userEvent.click(screen.getByRole('checkbox', { name: /multi b/iu }));
    expect(events(storage).at(-1)).toMatchObject({ kind: 'change', answer: ['a', 'b'] });
    await userEvent.click(screen.getByRole('checkbox', { name: /multi a/iu }));
    expect(events(storage).at(-1)).toMatchObject({ answer: ['b'] });
    await userEvent.click(screen.getByRole('checkbox', { name: /multi b/iu }));
    expect(events(storage).at(-1)).toMatchObject({ kind: 'clear' });

    await userEvent.click(screen.getByRole('button', { name: /^question 2/iu }));
    expect(screen.getByLabelText(/your answer \(in m\/s\^2\)/iu)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/your answer/iu), '9.8');
    expect(events(storage).at(-1)).toMatchObject({ kind: 'change', answer: '9.8' });
    await userEvent.clear(screen.getByLabelText(/your answer/iu));
    expect(events(storage).at(-1)).toMatchObject({ kind: 'clear' });

    await userEvent.click(screen.getByRole('button', { name: /^question 3/iu }));
    await userEvent.selectOptions(screen.getByRole('combobox'), 'r2');
    expect(events(storage).at(-1)).toMatchObject({ kind: 'select', answer: ['l1:r2'] });
    await userEvent.selectOptions(screen.getByRole('combobox'), '');
    expect(events(storage).at(-1)).toMatchObject({ kind: 'clear' });
  });

  it('shows the passage a question refers to', () => {
    const { session } = sitting();
    render(<LearnApp session={session} form={form} />);
    expect(screen.getByRole('complementary', { name: 'Passage' })).toHaveTextContent('A passage that question one refers to.');
  });
});

describe('what the shell never shows (M6-47)', () => {
  it('shows no key even from a package that carries one: it draws what it was built to draw and nothing else', () => {
    const leaky = formPackageSchema.parse(aPackageDocument({ correctOptionId: 'b', answerKey: { kind: 'SINGLE_CORRECT', optionId: 'b' }, solution: 'The answer is B because…' }));
    const { session } = sitting();
    const { container } = render(<LearnApp session={session} form={leaky} />);
    for (const word of ['correctOptionId', 'answerKey', 'The answer is B', 'SINGLE_CORRECT"']) expect(container.textContent).not.toContain(word);
    expect(container.innerHTML).not.toMatch(/correct/iu);
    // a scan that could not see the leak would prove nothing: the next test shows that it can
    expect(JSON.stringify(leaky)).toContain('correctOptionId');
  });

  it('the key is in the data the shell was handed, and the same scan finds it wherever it is drawn', () => {
    const leaky = formPackageSchema.parse(aPackageDocument({ correctOptionId: 'b', answerKey: { kind: 'SINGLE_CORRECT', optionId: 'b' }, solution: 'The answer is B because…' }));
    const words = ['correctOptionId', 'answerKey', 'The answer is B', 'SINGLE_CORRECT"'];
    for (const word of words) expect(JSON.stringify(leaky)).toContain(word);
    // drawn as text, the very check the screens are held to fires on every word: it could have seen a leak, so its silence above means something
    const { container } = render(<pre>{JSON.stringify(leaky)}</pre>);
    for (const word of words) expect(container.textContent).toContain(word);
  });
});

describe('accessibility', () => {
  it('passes an axe scan, on a question and on the result', async () => {
    const { session } = sitting();
    const { container } = render(<LearnApp session={session} form={form} />);
    const clean = async () => (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations.map((violation) => `${violation.id}: ${violation.help}`);
    expect(await clean()).toEqual([]);
    await act(() => session.submit('manual'));
    expect(await clean()).toEqual([]);
  });
});

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '');
}
