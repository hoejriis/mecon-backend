import { useState } from 'react';

/** Unlock with the stored passkey. */
export function UnlockForm({ onPasskey }: { onPasskey(): Promise<{ ok: boolean; message: string | null }> }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setMsg(null);
    const r = await onPasskey();
    setBusy(false);
    if (!r.ok) setMsg(r.message);
  };
  return (
    <div className="login-form">
      {msg && (
        <p className="notice" role="alert">
          {msg}
        </p>
      )}
      <button type="button" className="btn" disabled={busy} onClick={() => void run()}>
        {busy ? 'Unlocking…' : 'Unlock with passkey'}
      </button>
    </div>
  );
}
