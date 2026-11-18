import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { QuarantineNotice } from '../storage/QuarantineNotice';
import { NO_BLOCKERS, type Blockers } from './guards';
import { UpdateBanner } from './UpdateBanner';
import { UpdateController, type UpdateDeps } from './updateController';

function make(blockers: Blockers, waiting = true) {
  const posted: unknown[] = [];
  const handlers: Record<string, () => void> = {};
  const reload = vi.fn();
  const deps = {
    container: { controller: {}, addEventListener: (t: string, cb: () => void) => void (handlers[t] = cb), removeEventListener() {} },
    registration: {
      waiting: waiting ? { postMessage: (m: unknown) => posted.push(m) } : null,
      installing: null,
      addEventListener() {},
      removeEventListener() {},
    },
    channel: null,
    getBlockers: () => blockers,
    reload,
  } as unknown as UpdateDeps;
  const c = new UpdateController(deps);
  c.start();
  return { c, posted, reload, handlers };
}

describe('UpdateBanner', () => {
  it('shows nothing without a waiting version', () => {
    const { c } = make(NO_BLOCKERS, false);
    const { container } = render(<UpdateBanner controller={c} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is a non-blocking status with one button; nothing activates until the tap', async () => {
    const t = make(NO_BLOCKERS);
    render(<UpdateBanner controller={t.c} />);
    expect(screen.getByRole('status')).toHaveTextContent('Update available');
    expect(t.posted).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Update now' }));
    expect(t.posted).toEqual([{ type: 'SKIP_WAITING' }]);
  });

  it('with drafts and an uncertain attempt it explains the loss and needs an explicit confirm', async () => {
    const t = make({ drafts: 2, uncertainAttempts: 1, bleConnected: true });
    render(<UpdateBanner controller={t.c} />);
    await userEvent.click(screen.getByRole('button', { name: 'Update now' }));
    const dlg = screen.getByRole('alertdialog');
    expect(dlg).toHaveTextContent('2 unsent drafts would be lost');
    expect(dlg).toHaveTextContent('in memory only');
    expect(dlg).toHaveTextContent('1 send attempt has no final outcome');
    expect(dlg).toHaveTextContent('will not be sent again');
    expect(dlg).toHaveTextContent('Bluetooth connection');
    expect(t.posted).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(t.posted).toEqual([]);
    expect(screen.getByRole('status')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Update now' }));
    await userEvent.click(screen.getByRole('button', { name: 'Update anyway' }));
    expect(t.posted).toEqual([{ type: 'SKIP_WAITING' }]);
  });

  it('another tab updated: shows the reload notice and does not reload', () => {
    const t = make({ ...NO_BLOCKERS, drafts: 1 });
    render(<UpdateBanner controller={t.c} />);
    act(() => t.handlers.controllerchange!());
    expect(screen.getByRole('status')).toHaveTextContent('Updated in another tab — reload when ready');
    expect(t.reload).not.toHaveBeenCalled();
  });
});

describe('QuarantineNotice', () => {
  it('says nothing was deleted and gives rollback guidance', () => {
    render(<QuarantineNotice />);
    expect(screen.getByRole('alert')).toHaveTextContent("This version can't read your local data; nothing was deleted.");
    expect(screen.getByRole('alert')).toHaveTextContent('Go back to the Reader version');
  });
});
