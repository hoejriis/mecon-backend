import { useId, useState, type FormEvent } from 'react';
import { MIN_PIN_LENGTH, type UnlockMethod } from './unlock';

/** Unlock with the stored method: a passkey button, or a PIN field. */
export function UnlockForm({
  method,
  onPin,
  onPasskey,
}: {
  method: UnlockMethod;
  onPin(pin: string): Promise<{ ok: boolean; message: string | null }>;
  onPasskey(): Promise<{ ok: boolean; message: string | null }>;
}) {
  const id = useId();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (f: () => Promise<{ ok: boolean; message: string | null }>) => {
    setBusy(true);
    setMsg(null);
    const r = await f();
    setBusy(false);
    if (!r.ok) setMsg(r.message);
    setPin('');
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(() => onPin(pin));
  };
  return (
    <div className="login-form">
      {msg && (
        <p className="notice" role="alert">
          {msg}
        </p>
      )}
      {method === 'passkey' ? (
        <button type="button" className="btn" disabled={busy} onClick={() => void run(onPasskey)}>
          {busy ? 'Unlocking…' : 'Unlock with passkey'}
        </button>
      ) : (
        <form onSubmit={submit} className="login-form">
          <label htmlFor={id}>Offline PIN</label>
          <input
            id={id}
            type="password"
            autoComplete="off"
            minLength={MIN_PIN_LENGTH}
            required
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
          <button type="submit" className="btn" disabled={busy || pin.length < MIN_PIN_LENGTH}>
            {busy ? 'Unlocking…' : 'Unlock'}
          </button>
        </form>
      )}
    </div>
  );
}
