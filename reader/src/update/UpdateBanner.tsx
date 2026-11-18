import { useSyncExternalStore } from 'react';
import type { Blockers } from './guards';
import type { UpdateController } from './updateController';

function Consequences({ b }: { b: Blockers }) {
  return (
    <ul className="update-list">
      {b.drafts > 0 && (
        <li>
          {b.drafts} unsent {b.drafts === 1 ? 'draft' : 'drafts'} would be lost. Drafts are kept in memory only.
        </li>
      )}
      {b.uncertainAttempts > 0 && (
        <li>
          {b.uncertainAttempts} send {b.uncertainAttempts === 1 ? 'attempt has' : 'attempts have'} no final outcome yet.
          They keep their identity on the Backend and will not be sent again.
        </li>
      )}
      {b.bleConnected && <li>The Bluetooth connection to your Companion would be closed.</li>}
    </ul>
  );
}

const noState = { waiting: false, updatedElsewhere: false, repairPending: false, activating: false, confirm: null };
const noop = () => () => undefined;

export function UpdateBanner({ controller }: { controller: UpdateController | null }) {
  const s = useSyncExternalStore(controller ? controller.subscribe : noop, controller ? controller.getState : () => noState);
  if (!controller) return null;
  const { confirm } = s;
  if (!s.waiting && !s.updatedElsewhere && !s.repairPending) return null;

  if (confirm) {
    return (
      <section className="update-banner update-confirm" role="alertdialog" aria-labelledby="update-confirm-title">
        <h2 id="update-confirm-title" className="update-title">
          {confirm.mode === 'activate' ? 'Update now?' : 'Reload now?'}
        </h2>
        <p className="update-text">This would interrupt work in progress:</p>
        <Consequences b={confirm.blockers} />
        <p className="update-text">Nothing is sent automatically during or after the update.</p>
        <div className="update-actions">
          <button type="button" className="btn" onClick={() => controller.confirmUpdate()}>
            {confirm.mode === 'activate' ? 'Update anyway' : 'Reload anyway'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => controller.cancelConfirm()}>
            Not now
          </button>
        </div>
      </section>
    );
  }

  const elsewhere = s.updatedElsewhere;
  return (
    <section className="update-banner" role="status" aria-label="Update">
      <p className="update-text">
        {elsewhere ? 'Updated in another tab — reload when ready' : 'Update available'}
      </p>
      <button type="button" className="btn" disabled={s.activating} onClick={() => controller.requestUpdate()}>
        {elsewhere ? 'Reload' : 'Update now'}
      </button>
    </section>
  );
}
