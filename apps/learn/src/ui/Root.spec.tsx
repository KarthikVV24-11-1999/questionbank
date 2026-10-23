import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BootResult } from '../bootstrap.js';
import { AttemptSession } from '../session/attempt-session.js';
import { formPackageSchema } from '../package/types.js';
import { aPackageDocument } from '../testing/signed-package.js';
import { aRig } from '../testing/fakes.js';
import { Root } from './Root.js';

afterEach(cleanup);

const START = { attemptId: 'att-1', deviceRef: 'd', intervalCapMs: 90_000, deadline: '2026-10-21T11:30:00.000Z', serverNow: '2026-10-21T08:30:00.000Z' };
const form = formPackageSchema.parse(aPackageDocument());
const hooks = () => {
  const ticks: Array<() => void> = [];
  const stops = { every: vi.fn(), online: vi.fn() };
  let onlineFn: () => void = () => undefined;
  return {
    ticks,
    stops,
    fire: () => onlineFn(),
    every: (_ms: number, fn: () => void) => {
      ticks.push(fn);
      return stops.every;
    },
    onOnline: (fn: () => void) => {
      onlineFn = fn;
      return stops.online;
    },
  };
};

describe('the root', () => {
  it('opens the sitting once booted, and drives the engine\'s ticks and the network\'s return from the host', async () => {
    const rig = aRig();
    const session = AttemptSession.begin(START, rig.ports);
    const pump = vi.spyOn(session, 'pump');
    const sync = vi.spyOn(session, 'syncNow');
    const host = hooks();
    const view = render(<Root boot={async () => ({ kind: 'ready', session, form })} every={host.every} onOnline={host.onOnline} />);
    expect(screen.getByRole('status')).toHaveTextContent('Opening your paper');
    expect(await screen.findByRole('region', { name: 'Question 1' })).toBeInTheDocument();
    await act(async () => host.ticks[0]!());
    host.fire();
    expect(pump).toHaveBeenCalled();
    expect(sync).toHaveBeenCalled();
    view.unmount();
    expect(host.stops.every).toHaveBeenCalled();
    expect(host.stops.online).toHaveBeenCalled();
  });

  it('opens no item for a package that was refused, and says so without alarm words about the learner', async () => {
    const host = hooks();
    const update = vi.fn();
    const boot = async (): Promise<BootResult> => ({ kind: 'package-refused', refusal: 'SIGNATURE_DOES_NOT_VERIFY' });
    render(<Root boot={boot} every={host.every} onOnline={host.onOnline} onUpdateWanted={update} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('did not pass its check');
    expect(screen.queryByRole('region')).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it('asks for a newer shell when the paper is one this build does not understand', async () => {
    const host = hooks();
    const update = vi.fn();
    render(<Root boot={async () => ({ kind: 'package-refused', refusal: 'NOT_A_PACKAGE_THIS_BUILD_UNDERSTANDS' })} every={host.every} onOnline={host.onOnline} onUpdateWanted={update} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('newer version');
    expect(update).toHaveBeenCalledOnce();
  });

  it('says the same thing for a missing signature as for a missing key — none of it opens an item', async () => {
    const host = hooks();
    render(<Root boot={async () => ({ kind: 'package-refused', refusal: 'SIGNATURE_MISSING' })} every={host.every} onOnline={host.onOnline} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be checked');
  });

  it('reports an attempt that could not start, and a boot that threw', async () => {
    const host = hooks();
    const one = render(<Root boot={async () => ({ kind: 'cannot-start', reason: 'window closed' })} every={host.every} onOnline={host.onOnline} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('window closed');
    one.unmount();
    const two = render(<Root boot={() => Promise.reject(new Error('offline'))} every={host.every} onOnline={host.onOnline} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
    two.unmount();
    render(<Root boot={() => Promise.reject('x')} every={host.every} onOnline={host.onOnline} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
  });

  it('ignores a boot that lands after the page is gone', async () => {
    const host = hooks();
    let resolveBoot: (value: BootResult) => void = () => undefined;
    const view = render(<Root boot={() => new Promise<BootResult>((resolve) => (resolveBoot = resolve))} every={host.every} onOnline={host.onOnline} />);
    view.unmount();
    resolveBoot({ kind: 'cannot-start', reason: 'late' });
    await Promise.resolve();
    expect(host.ticks).toHaveLength(0);
  });
});
