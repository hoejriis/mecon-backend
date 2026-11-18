import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { BleAdapter, newId, type AttemptFacts } from './adapter';
import { WebBluetoothTransport } from './webBluetoothTransport';

/**
 * Developer harness for the BLE adapter, reachable only at /dev/ble in a dev
 * build. It is not part of the product UI and is not in production bundles.
 */
function yn(v: boolean): string {
  return v ? 'yes' : 'not observed';
}

function AttemptRow({ a }: { a: AttemptFacts }) {
  return (
    <li className="ble-attempt" data-attempt-id={a.clientAttemptId}>
      <div>
        <strong>{a.kind}</strong> to {a.target} (draft {a.clientDraftId}, attempt {a.clientAttemptId})
      </div>
      <div>
        device accepted: <span data-fact="deviceAccepted">{yn(a.deviceAccepted)}</span>; RF transmitted:{' '}
        <span data-fact="rfTransmitted">{yn(a.rfTransmitted)}</span>; DM ACK: <span data-fact="dmAck">{yn(a.dmAck)}</span>; unknown:{' '}
        <span data-fact="unknown">{a.unknown ? 'yes' : 'no'}</span>; not sent: <span data-fact="notSent">{a.notSent ? 'yes' : 'no'}</span>
        {a.ackTimedOut ? '; ACK window passed' : ''}
        {a.deviceError ? `; device error: ${a.deviceError.name}` : ''}
      </div>
    </li>
  );
}

export default function BleDevPage() {
  const adapter = useMemo(() => {
    // Test seam for the simulation suite (dev route only): short timeouts.
    const o = (window as unknown as { __BLE_DEV_OPTS?: { responseTimeoutMs?: number; connectTimeoutMs?: number } }).__BLE_DEV_OPTS ?? {};
    return new BleAdapter({ transport: new WebBluetoothTransport(), ...o });
  }, []);
  useEffect(() => {
    // Not disposed on cleanup: StrictMode runs the cleanup once on mount and the adapter lives for the page.
    (window as unknown as { __bleAdapter?: BleAdapter }).__bleAdapter = adapter;
  }, [adapter]);
  const s = useSyncExternalStore(adapter.subscribe, adapter.getSnapshot);
  const [text, setText] = useState('hello');
  const [draft, setDraft] = useState(() => newId('draft'));
  const [error, setError] = useState<string | null>(null);

  const first = s.contacts[0];
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'error');
    }
  };

  return (
    <section className="pane ble-dev" aria-label="BLE developer harness">
      <h1>BLE adapter (dev only)</h1>
      <p>
        BLE connection: <strong data-testid="ble-conn">{s.bleConnection}</strong>; hello:{' '}
        <span data-testid="ble-hello">{s.helloComplete ? 'complete' : 'no'}</span>; last error:{' '}
        <span data-testid="ble-last-error">{s.lastError ?? 'none'}</span>
      </p>
      {s.bleConnection === 'unsupported' && <p role="status">Web Bluetooth is not available in this browser. Messaging through the Backend is unaffected.</p>}
      <p>
        <button type="button" onClick={() => void adapter.connect()}>Connect Companion</button>{' '}
        <button type="button" onClick={() => void adapter.reconnect()}>Reconnect</button>{' '}
        <button type="button" onClick={() => void adapter.disconnect()}>Disconnect</button>
      </p>
      <p>
        Device: <span data-testid="ble-device">{s.device?.name ?? 'none'}</span>; self: <span data-testid="ble-self">{s.selfInfo?.name ?? 'unknown'}</span>
      </p>
      <h2>Contacts</h2>
      <ul data-testid="ble-contacts">
        {s.contacts.map((c) => (
          <li key={c.publicKey}>{c.name}</li>
        ))}
      </ul>
      <h2>Send</h2>
      <label>
        Text <input value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <p>
        <button
          type="button"
          disabled={!first}
          onClick={() =>
            void run(async () => {
              await adapter.sendDirect({ clientDraftId: draft, clientAttemptId: newId('attempt'), contactKey: first!.publicKey, text });
            })
          }
        >
          Send DM to first contact
        </button>{' '}
        <button
          type="button"
          onClick={() =>
            void run(async () => {
              await adapter.sendChannel({ clientDraftId: draft, clientAttemptId: newId('attempt'), channelIndex: 0, text });
            })
          }
        >
          Send to channel 0
        </button>{' '}
        <button type="button" onClick={() => setDraft(newId('draft'))}>New draft</button>
      </p>
      {error && <p role="alert">{error}</p>}
      <h2>Attempts</h2>
      <ul data-testid="ble-attempts">
        {s.attempts.map((a) => (
          <AttemptRow key={a.clientAttemptId} a={a} />
        ))}
      </ul>
      <h2>Inbox</h2>
      <ul data-testid="ble-inbox">
        {s.inbox.map((m, i) => (
          <li key={i}>{m.message.text}</li>
        ))}
      </ul>
    </section>
  );
}
