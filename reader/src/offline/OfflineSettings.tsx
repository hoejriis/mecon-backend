import { useId, useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { UnlockForm } from './UnlockForm';
import { useOffline } from './OfflineContext';
import { MIN_PIN_LENGTH } from './unlock';

/** Settings panel: set up, unlock and lock the encrypted offline cache. */
export function OfflineSettings() {
  const { session } = useAuth();
  const off = useOffline();
  const pinId = useId();
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!session) return null;
  const uid = session.user.id;
  const mine = off.profiles.find((p) => p.userId === uid);
  const unlocked = off.unlockedUserId === uid;

  const setup = async (preferPasskey: boolean, withPin?: string) => {
    setBusy(true);
    const r = await off.setup(uid, { preferPasskey, pin: withPin });
    setBusy(false);
    setMsg(r.message);
    if (r.ok) setPin('');
  };
  const onPin = (e: FormEvent) => {
    e.preventDefault();
    void setup(false, pin);
  };

  return (
    <section aria-labelledby="offline-h" className="offline-settings">
      <h2 id="offline-h">Offline access</h2>
      {!off.available ? (
        <p className="state-body">Offline access is not available in this browser, so nothing is kept on this device.</p>
      ) : unlocked ? (
        <>
          <p role="status">
            Unlocked with {off.method === 'passkey' ? 'a passkey' : 'your PIN'}. An encrypted, bounded copy of your recent messages is kept on this device.
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
          <UnlockForm method={mine.method} onPin={(p) => off.unlockPin(uid, p)} onPasskey={() => off.unlockPasskey(uid)} />
        </>
      ) : (
        <>
          <p className="state-body">
            Keep an encrypted, bounded copy of your messages on this device so you can read them without a connection.
            It is locked with a passkey (where this browser supports it) or a PIN, and never leaves this device.
          </p>
          {msg && (
            <p className="notice" role="status">
              {msg}
            </p>
          )}
          {off.passkeyPossible && (
            <button type="button" className="btn" disabled={busy} onClick={() => void setup(true)}>
              Set up with a passkey
            </button>
          )}
          <form onSubmit={onPin} className="login-form">
            <label htmlFor={pinId}>Offline PIN (at least {MIN_PIN_LENGTH} characters)</label>
            <input id={pinId} type="password" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} />
            <button type="submit" className="btn btn-secondary" disabled={busy || pin.length < MIN_PIN_LENGTH}>
              Set up with a PIN
            </button>
          </form>
        </>
      )}
    </section>
  );
}
