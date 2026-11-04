import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootPractice } from '../bootstrap.js';
import { aRig, attemptWithLogDto, FakeApi } from '../testing/fakes.js';
import { aRunDocument, aSigner, encode, slotIds } from '../testing/signed-package.js';
import { PracticeScreen } from './PracticeScreen.js';
import { expectNoDomainVocabulary } from '../testing/vocabulary.js';
import { analyticsRig, expectConforming } from '../testing/analytics-rig.js';
import { createVerdictReporter } from '../practice/verdict-events.js';
import { QUESTIONS_ADDED } from './PracticeScreen.js';
import { GaveUpWaiting } from '../api/within-time.js';

afterEach(cleanup);

const signer = aSigner();
const key = { keyId: signer.keyId, publicKey: signer.publicKey };
const signedRun = () => {
  const bytes = encode(aRunDocument());
  return { bytes, ...signer.sign(bytes), keyId: signer.keyId };
};
const RUN = attemptWithLogDto({ attemptId: 'run-1', mode: 'practice', formId: null, sessionRef: null, shiftId: null, durationMs: null, windowClosesAt: null, deadline: null, state: 'in_progress', slotCount: 3 });

function sit(over: { api?: FakeApi } = {}) {
  const rig = aRig();
  const events = analyticsRig();
  const opened = vi.fn();
  let booted: Awaited<ReturnType<typeof bootPractice>> | null = null;
  const api = over.api ?? new FakeApi(signedRun(), key);
  if (over.api === undefined) {
    api.practicePackageResponse = signedRun();
    api.stored = RUN;
  }
  const ticks: Array<() => void> = [];
  let online: () => void = () => undefined;
  const view = render(
    <PracticeScreen
      boot={async () => (booted = await bootPractice({ api, ports: rig.ports, attemptId: 'run-1', deviceRef: 'phone' }))}
      every={(_ms, fn) => (ticks.push(fn), () => undefined)}
      onOnline={(fn) => ((online = fn), () => undefined)}
      assessment={api}
      attemptId="run-1"
      told={createVerdictReporter(events.analytics, 'run-1')}
      onOpen={opened}
    />,
  );
  return { view, rig, api, events, opened, session: () => (booted as Extract<NonNullable<typeof booted>, { kind: 'ready' }>).session, pump: () => act(async () => void (await Promise.all(ticks.map((tick) => tick())))), comeBack: () => act(async () => online()) };
}

describe('the practice run is sat (M8-24, D87)', () => {
  it('shows the first question of the run, with no clock and a way to put the run down', async () => {
    sit();
    expect(await screen.findByRole('region', { name: 'Question 1' })).toBeInTheDocument();
    expect(screen.queryByRole('timer')).toBeNull();
    expect(screen.getByRole('link', { name: 'Put this run down' })).toHaveAttribute('href', '?');
    expect(screen.queryByText(/cannot be shown in the app yet/u)).toBeNull();
    expect(screen.getByRole('button', { name: 'Finish run' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /submit paper/iu })).toBeNull();
  });

  it('puts an answer into the response log the paper\'s go into, and sends it through the attempt routes', async () => {
    const { rig, pump } = sit();
    await userEvent.click(await screen.findByRole('radio', { name: /option b/iu }));
    await rig.records.settle();
    const row = [...(rig.records.rows.get('run-1')?.values() ?? [])].find((entry) => entry.event.kind === 'select');
    expect(row?.event).toMatchObject({ slot: slotIds[0], answer: 'b' });
    expect(rig.records.peek('run-1')).toMatchObject({ attemptId: 'run-1', deadline: null, formId: null });
    await pump();
    expect([...rig.transport.stored.values()].some((event) => (event as { answer?: string }).answer === 'b')).toBe(true);
  });

  it('is finished through the attempt routes after a confirmation, and says it is over and where to go', async () => {
    const { rig } = sit();
    await userEvent.click(await screen.findByRole('radio', { name: /option b/iu }));
    await userEvent.click(screen.getByRole('button', { name: 'Finish run' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('2 questions are not answered');
    await userEvent.click(screen.getByRole('button', { name: 'Yes, submit' }));
    await vi.waitFor(() => expect(rig.transport.submissions).toEqual([{ reason: 'manual', key: 'submission:run-1' }]));
    expect(await screen.findByRole('link', { name: 'Back to what to do next' })).toHaveAttribute('href', '?');
  });

  it('loses no answer when the run is begun online and finished with the connection gone: the answers are on the device and the send waits', async () => {
    const { rig, pump, comeBack } = sit();
    await screen.findByRole('region', { name: 'Question 1' });
    rig.transport.online = false;
    await userEvent.click(screen.getByRole('radio', { name: /option b/iu }));
    await userEvent.click(screen.getByRole('button', { name: /^Question 2/u }));
    await userEvent.click(screen.getByRole('radio', { name: /option c/iu }));
    await rig.records.settle();
    await pump();
    expect(rig.transport.stored.size).toBe(0);
    // on the device, committed
    const held = [...(rig.records.rows.get('run-1')?.values() ?? [])].map((row) => row.event).filter((event) => event.kind === 'select');
    expect(held.map((event) => [event.slot, event.answer])).toEqual([[slotIds[0], 'b'], [slotIds[1], 'c']]);

    rig.transport.online = true;
    await comeBack();
    await pump();
    const sent = [...rig.transport.stored.values()].filter((event) => (event as { kind: string }).kind === 'select').map((event) => (event as { answer: string }).answer);
    expect(sent.sort()).toEqual(['b', 'c']);
  });

  it('says why when it cannot be opened: a package that does not verify, a run that is not the learner\'s', async () => {
    const api = new FakeApi(signedRun(), key);
    const response = signedRun();
    const tampered = Uint8Array.from(response.bytes);
    tampered[30] = tampered[30]! ^ 0x01;
    api.practicePackageResponse = { ...response, bytes: tampered, digest: aSigner().sign(tampered).digest };
    sit({ api });
    expect(await screen.findByRole('alert')).toHaveTextContent('did not pass its check');
    cleanup();

    const gone = new FakeApi(signedRun(), key);
    gone.practicePackageResponse = Object.assign(new Error('no attempt of yours with that id'), { problem: { status: 404 } });
    sit({ api: gone });
    expect(await screen.findByRole('alert')).toHaveTextContent('no attempt of yours');
  });

  it('has no accessibility violation sat', async () => {
    sit();
    await screen.findByRole('region', { name: 'Question 1' });
    const result = await axe.run(document.body);
    expect(result.violations.map((violation) => violation.id)).toEqual([]);
  });

  it('shows a learner nothing in our vocabulary: the question, the palette, the confirmation and the end', async () => {
    const { view } = sit();
    await screen.findByRole('region', { name: 'Question 1' });
    expectNoDomainVocabulary(view.container);
    await userEvent.click(screen.getByRole('button', { name: 'Finish run' }));
    expectNoDomainVocabulary(view.container);
    await userEvent.click(screen.getByRole('button', { name: 'Yes, submit' }));
    await screen.findByRole('link', { name: 'Back to what to do next' });
    expectNoDomainVocabulary(view.container);
  });
});

describe('the learner is told how an answer came out, and can add questions (M8-33, closes D111)', () => {
  const answerFirst = async (kit: ReturnType<typeof sit>, option = /option b/iu) => {
    await userEvent.click(await screen.findByRole('radio', { name: option }));
    await kit.rig.records.settle();
  };

  it('says right or wrong, the one word the server gave, once the answer has been sent, and nothing about marks or the key', async () => {
    const kit = sit();
    kit.api.verdicts.set(slotIds[0]!, 'correct');
    await answerFirst(kit);
    await kit.pump();
    expect(await screen.findByText('Right')).toBeInTheDocument();
    expect(kit.api.feedbackAsked).toEqual([`run-1:${slotIds[0]}`]);
    expect(screen.queryByText(/mark|\+4|correct answer|solution/iu)).toBeNull();
    cleanup();

    const wrong = sit();
    wrong.api.verdicts.set(slotIds[0]!, 'incorrect');
    await answerFirst(wrong);
    await wrong.pump();
    expect(await screen.findByText('Wrong')).toBeInTheDocument();
  });

  it('does not ask about an answer the server has not got: it says the answer is saved on this device, and asks when it has been sent', async () => {
    const kit = sit();
    await answerFirst(kit);
    expect(await screen.findByText('Your answer is saved on this device. It is marked once it has been sent.')).toBeInTheDocument();
    expect(kit.api.feedbackAsked).toEqual([]);
    await kit.pump();
    expect(await screen.findByText('Right')).toBeInTheDocument();
    expect(kit.api.feedbackAsked).toHaveLength(1);
  });

  it('with the network refused, says the answer is saved and will be marked, never a verdict, and the run stays usable', async () => {
    const kit = sit();
    kit.rig.transport.online = false;
    kit.api.feedbackFailure = new TypeError('Failed to fetch');
    await answerFirst(kit);
    await kit.pump();
    expect(screen.queryByText('Right')).toBeNull();
    expect(screen.queryByText('Wrong')).toBeNull();
    expect(screen.queryByText('Checking your answer…')).toBeNull();
    expect(screen.getByRole('note')).toHaveTextContent('saved');
    // and the learner can go on: another question, another answer, and the end
    await userEvent.click(screen.getByRole('button', { name: /^Question 2/u }));
    await userEvent.click(await screen.findByRole('radio', { name: /option c/iu }));
    await kit.rig.records.settle();
    expect(await screen.findByRole('button', { name: 'Finish run' })).toBeEnabled();
  });

  it('with the verdict refused after the answer was sent, says the same, in the same words, and does not wait', async () => {
    const kit = sit();
    kit.api.feedbackFailure = new TypeError('Failed to fetch');
    await answerFirst(kit);
    await kit.pump();
    expect(await screen.findByText('Your answer is saved. It is marked when you are back online, and in your result when you finish.')).toBeInTheDocument();
    expect(screen.queryByText('Checking your answer…')).toBeNull();
    expect(screen.getByRole('radio', { name: /option b/iu })).toBeEnabled();
  });

  it('says an answer the server could not judge is marked when the run is scored, and says nothing for an answer that was cleared', async () => {
    const kit = sit();
    kit.api.verdicts.set(slotIds[0]!, 'indeterminate');
    await answerFirst(kit);
    await kit.pump();
    expect(await screen.findByText('This one is marked when the run is scored.')).toBeInTheDocument();
    cleanup();

    const none = sit();
    none.api.verdicts.set(slotIds[0]!, 'unattempted');
    await answerFirst(none);
    await none.pump();
    await vi.waitFor(() => expect(none.api.feedbackAsked).toHaveLength(1));
    expect(screen.queryByText('Right')).toBeNull();
    expect(screen.queryByText('Wrong')).toBeNull();
    expect(screen.queryByText('This one is marked when the run is scored.')).toBeNull();
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('says nothing, and asks nothing, about an answer that was cleared', async () => {
    const kit = sit();
    await answerFirst(kit);
    await kit.pump();
    await screen.findByText('Right');
    act(() => kit.session().clear(slotIds[0]!));
    await kit.pump();
    expect(screen.queryByText('Right')).toBeNull();
    expect(screen.queryByRole('note')).toBeNull();
    expect(kit.api.feedbackAsked).toHaveLength(1);
  });

  it('asks again when the answer changes and not when the learner comes back to the question', async () => {
    const kit = sit();
    await answerFirst(kit);
    await kit.pump();
    await screen.findByText('Right');
    await userEvent.click(screen.getByRole('button', { name: /^Question 2/u }));
    await userEvent.click(screen.getByRole('button', { name: /^Question 1/u }));
    await kit.pump();
    await screen.findByText('Right');
    expect(kit.api.feedbackAsked).toHaveLength(2);
    kit.api.verdicts.set(slotIds[0]!, 'incorrect');
    await userEvent.click(screen.getByRole('radio', { name: /option c/iu }));
    await kit.rig.records.settle();
    await kit.pump();
    await screen.findByText('Wrong');
    expect(kit.api.feedbackAsked.length).toBeGreaterThanOrEqual(3);
  });

  it('shows a learner nothing in our vocabulary while it tells them, and has no accessibility violation', async () => {
    const kit = sit();
    await answerFirst(kit);
    await kit.pump();
    await screen.findByText('Right');
    expectNoDomainVocabulary(kit.view.container);
    expect((await axe.run(document.body)).violations.map((violation) => violation.id)).toEqual([]);
  });

  describe('what it says happened (M8-34, D112)', () => {
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    it('says an item was answered when the learner is told how it came out, with the outcome and what the session knows of the answer', async () => {
      const kit = sit();
      kit.api.verdicts.set(slotIds[0]!, 'incorrect');
      await answerFirst(kit);
      await kit.pump();
      await screen.findByText('Wrong');
      await settle();
      expect(kit.events.sent.map((event) => event.event_name)).toEqual(['practice.item_answered']);
      expect(kit.events.sent[0]).toMatchObject({ payload: { outcome: 'incorrect', answer_changes: 0, was_flagged: false }, context: { attempt_id: 'run-1' } });
      expect(typeof kit.events.sent[0]!.payload['time_on_item_ms']).toBe('number');
      expectConforming(kit.events.sent);
    });

    it('says it once for an answer, though the learner comes back to the question and is told again', async () => {
      const kit = sit();
      await answerFirst(kit);
      await kit.pump();
      await screen.findByText('Right');
      await userEvent.click(screen.getByRole('button', { name: /^Question 2/u }));
      await userEvent.click(screen.getByRole('button', { name: /^Question 1/u }));
      await kit.pump();
      await screen.findByText('Right');
      await settle();
      expect(kit.events.sent.filter((event) => event.event_name === 'practice.item_answered')).toHaveLength(1);
    });

    it('says nothing for an answer it could not be told the outcome of: it does not invent one', async () => {
      const kit = sit();
      kit.api.feedbackFailure = new TypeError('Failed to fetch');
      await answerFirst(kit);
      await kit.pump();
      await screen.findByText(/It is marked when you are back online/u);
      await settle();
      expect(kit.events.sent).toEqual([]);
    });

    it('says nothing for an answer the server could not judge', async () => {
      const kit = sit();
      kit.api.verdicts.set(slotIds[0]!, 'indeterminate');
      await answerFirst(kit);
      await kit.pump();
      await screen.findByText('This one is marked when the run is scored.');
      await settle();
      expect(kit.events.sent).toEqual([]);
    });
  });

  describe('adding questions to the run', () => {
    it('asks the server for more, then brings the run up again, which fetches the package it now has', async () => {
      const kit = sit();
      await userEvent.click(await screen.findByRole('button', { name: 'Add more questions' }));
      await vi.waitFor(() => expect(kit.opened).toHaveBeenCalledWith('?practice=run-1'));
      expect(kit.api.grown).toEqual([{ attemptId: 'run-1', count: 5 }]);
      expect(QUESTIONS_ADDED).toBe(5);
    });

    it('says in words when it cannot, because there is no connection, and the run is as it was and goes on', async () => {
      const kit = sit();
      kit.api.growFailure = new TypeError('Failed to fetch');
      await userEvent.click(await screen.findByRole('button', { name: 'Add more questions' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('More questions need a connection. Your run is as it was.');
      expect(kit.opened).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Add more questions' })).toBeEnabled();
      await userEvent.click(screen.getByRole('radio', { name: /option b/iu }));
      await kit.rig.records.settle();
    });

    it('says the same when the server was given up on as slow, which is the connection\'s doing too', async () => {
      const kit = sit();
      kit.api.growFailure = new GaveUpWaiting();
      await userEvent.click(await screen.findByRole('button', { name: 'Add more questions' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('More questions need a connection. Your run is as it was.');
    });

    it('gives the server\'s own words when it refused, and does not ask the learner to find a connection', async () => {
      const kit = sit();
      kit.api.growFailure = Object.assign(new Error('there are no more questions to add'), { problem: { status: 422 } });
      await userEvent.click(await screen.findByRole('button', { name: 'Add more questions' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('there are no more questions to add');
      expect(kit.opened).not.toHaveBeenCalled();
    });

    it('is not offered once the run is over', async () => {
      const kit = sit();
      await userEvent.click(await screen.findByRole('button', { name: 'Finish run' }));
      await userEvent.click(screen.getByRole('button', { name: 'Yes, submit' }));
      await screen.findByRole('link', { name: 'Back to what to do next' });
      expect(screen.queryByRole('button', { name: 'Add more questions' })).toBeNull();
    });
  });
});
