import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootPractice } from '../bootstrap.js';
import { aRig, attemptWithLogDto, FakeApi } from '../testing/fakes.js';
import { aRunDocument, aSigner, encode, slotIds } from '../testing/signed-package.js';
import { PracticeScreen } from './PracticeScreen.js';
import { expectNoDomainVocabulary } from '../testing/vocabulary.js';

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
  const api = over.api ?? new FakeApi(signedRun(), key);
  if (over.api === undefined) {
    api.practicePackageResponse = signedRun();
    api.stored = RUN;
  }
  const ticks: Array<() => void> = [];
  let online: () => void = () => undefined;
  const view = render(
    <PracticeScreen
      boot={() => bootPractice({ api, ports: rig.ports, attemptId: 'run-1', deviceRef: 'phone' })}
      every={(_ms, fn) => (ticks.push(fn), () => undefined)}
      onOnline={(fn) => ((online = fn), () => undefined)}
    />,
  );
  return { view, rig, api, pump: () => act(async () => void (await Promise.all(ticks.map((tick) => tick())))), comeBack: () => act(async () => online()) };
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
