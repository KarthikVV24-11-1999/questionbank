import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOT_KEPT, SyncIndicator } from './SyncIndicator.js';

afterEach(cleanup);

const show = (props: Partial<Parameters<typeof SyncIndicator>[0]> = {}) => render(<SyncIndicator status="idle" pending={0} onRetry={() => undefined} {...props} />);

describe('what the indicator says about the disk (M8-15)', () => {
  it('says all saved when the engine is idle and nothing is waiting for the disk', () => {
    show();
    expect(screen.getByRole('status')).toHaveTextContent('All answers saved');
  });

  it('says saving, not all saved, while answers are waiting for the disk and the engine has nothing to send', () => {
    show({ unsaved: 3 });
    expect(screen.getByRole('status')).toHaveTextContent('Saving your answers…');
    expect(screen.getByRole('status')).not.toHaveTextContent('All answers saved');
  });

  it('says what the engine says about the connection when it is not idle, whatever is waiting for the disk', () => {
    show({ status: 'backing_off', pending: 2, unsaved: 3 });
    expect(screen.getByRole('status')).toHaveTextContent(/kept on this device and will be sent when the connection is back/iu);
    expect(screen.getByRole('status')).toHaveTextContent('(2 waiting)');
  });

  it('tells the learner what to do when the device is not keeping the answers, ahead of anything else, and without an alarm', () => {
    show({ status: 'backing_off', pending: 2, unsaved: 3, storageError: 'full' });
    expect(screen.getByRole('status')).toHaveTextContent(NOT_KEPT);
    expect(screen.getByRole('status')).not.toHaveTextContent(/connection is back/iu);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(NOT_KEPT).toMatch(/keep this page open/iu);
  });

  it('puts the failure to keep the answers ahead of the wait for the disk too, when the engine is idle', () => {
    show({ status: 'idle', unsaved: 3, storageError: 'full' });
    expect(screen.getByRole('status')).toHaveTextContent(NOT_KEPT);
    expect(screen.getByRole('status')).not.toHaveTextContent('Saving your answers');
  });

  it('offers to try again when sending has backed off or stopped, and not when it has not', async () => {
    const retry = vi.fn();
    const { unmount } = show({ status: 'suspended', onRetry: retry });
    await userEvent.click(screen.getByRole('button', { name: /try now/iu }));
    expect(retry).toHaveBeenCalledTimes(1);
    unmount();
    show({ status: 'idle' });
    expect(screen.queryByRole('button')).toBeNull();
  });
});
