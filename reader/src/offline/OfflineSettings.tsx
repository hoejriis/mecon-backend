import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { UnlockForm } from './UnlockForm';
import { useOffline } from './OfflineContext';
import { PASSKEY_REQUIRED_NOTE } from './unlock';

/** Settings panel: set up, unlock and lock the encrypted offline cache. */
export function OfflineSettings() {
  const { session } = useAuth();
  const off = useOffline();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!session) return null;
  const uid = session.user.id;
  const mine = off.profiles.find((p) => p.userId === uid);
  const unlocked = off.unlockedUserId === uid;

  const setup = async () => {
    setBusy(true);
    const r = await off.setup(uid);
    setBusy(false);
    setMsg(r.message);
  };

  return (
    <section aria-labelledby="offline-h" className="offline-settings">
      <h2 id="offline-h">Offline access</h2>
      {!off.available ? (
        <p className="state-body">Offline access is not available in this browser, so nothing is kept on this device.</p>
      ) : unlocked ? (
        <>
          <p role="status">
            Unlocked with a passkey. An encrypted, bounded copy of your recent messages is kept on this device.
          </p>
          {off.lease && <p className="state-body">{off.lease.message}</p>}
          {off.warnings.includes('storage-full') && (
            <p className="notice" role="alert">
              This device is out of storage. Your drafts and unsent messages are kept; older cached messages were dropped.
            </p>
          )}
          <button type="button" className="btn btn-secondary" onClick={off.lock}>
            Lock offline data
          </button>
        </>
      ) : mine ? (
        <>
          <p className="state-body">Offline data is locked on this device.</p>
          <UnlockForm onPasskey={() => off.unlockPasskey(uid)} />
        </>
      ) : !off.passkeyPossible ? (
        <p className="state-body">{PASSKEY_REQUIRED_NOTE}</p>
      ) : (
        <>
          <p className="state-body">
            Keep an encrypted, bounded copy of your messages on this device so you can read them without a connection.
            It is locked with a passkey and never leaves this device.
          </p>
          {msg && (
            <p className="notice" role="status">
              {msg}
            </p>
          )}
          <button type="button" className="btn" disabled={busy} onClick={() => void setup()}>
            Set up with a passkey
          </button>
        </>
      )}
    </section>
  );
}
