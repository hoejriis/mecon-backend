import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { newId, type AttemptFacts } from './adapter';
import { DeviceSession, type SessionOptions } from '../device/session';
import { WebBluetoothTransport } from './webBluetoothTransport';

/**
 * Developer harness for the shared device session over Bluetooth, reachable only at
 * /dev/ble-session in a dev build. Not part of the product UI and not in production bundles.
 * The same DeviceSession as the USB harness, on a Web Bluetooth link.
 */
const yn = (v: boolean) => (v ? 'yes' : 'not observed');

function AttemptRow({ a }: { a: AttemptFacts }) {
  return (
    <li className="ble-attempt" data-attempt-id={a.clientAttemptId}>
      <div>
        <strong>{a.kind}</strong> to {a.target} via <span data-fact="path">{a.path}</span> (draft {a.clientDraftId}, attempt {a.clientAttemptId})
      </div>
      <div>
        device accepted: <span data-fact="deviceAccepted">{yn(a.deviceAccepted)}</span>; RF transmitted: <span data-fact="rfTransmitted">{yn(a.rfTransmitted)}</span>; DM ACK:{' '}
        <span data-fact="dmAck">{yn(a.dmAck)}</span>; unknown: <span data-fact="unknown">{a.unknown ? 'yes' : 'no'}</span>; not sent: <span data-fact="notSent">{a.notSent ? 'yes' : 'no'}</span>
      </div>
    </li>
  );
}

export default function BleSessionDevPage() {
  const session = useMemo(() => {
    const o = (window as unknown as { __BLE_SESSION_OPTS?: SessionOptions }).__BLE_SESSION_OPTS ?? {};
    return new DeviceSession(new WebBluetoothTransport(), o);
  }, []);
  useEffect(() => {
    (window as unknown as { __bleSession?: DeviceSession }).__bleSession = session;
  }, [session]);
  const s = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [draft, setDraft] = useState(() => newId('draft'));
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const first = s.companion?.contacts[0];
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'error');
    }
  };
  const caps = s.detected?.capabilities ?? [];

  return (
    <section className="pane ble-dev" aria-label="Bluetooth device session harness">
      <h1>Bluetooth device session (dev only)</h1>
      <p>
        Link: <strong data-testid="bs-link">{s.link}</strong>; phase: <span data-testid="bs-phase">{s.phase}</span>; trust: <span data-testid="bs-trust">{s.trust}</span>; last error:{' '}
        <span data-testid="bs-last-error">{s.lastError ?? 'none'}</span>
      </p>
      {s.link === 'unsupported' && <p role="status">Web Bluetooth is not available in this browser. Messaging through the Backend is unaffected.</p>}
      <p>
        <button type="button" onClick={() => void session.connect()}>Connect device</button>{' '}
        <button type="button" onClick={() => void session.reconnect()}>Reconnect</button>{' '}
        <button type="button" onClick={() => void session.disconnect()}>Disconnect</button>
      </p>
      <p>
        Detected: <span data-testid="bs-summary">{s.detected?.summary ?? 'not yet'}</span>
      </p>
      <p>
        Firmware: <span data-testid="bs-firmware">{s.detected?.firmware ?? 'unknown'}</span>; role: <span data-testid="bs-role">{s.detected?.role ?? 'unknown'}</span>; transport:{' '}
        <span data-testid="bs-transport">{s.detected?.transport ?? 'none'}</span>; capabilities: <span data-testid="bs-caps">{caps.join(',') || 'none'}</span>
      </p>
      <p>
        <button type="button" onClick={() => void run(async () => setReply(JSON.stringify((await session.request('status.get')).status)))}>Request status.get</button>{' '}
        <button type="button" onClick={() => void run(() => session.request('config.apply'))}>Request config.apply</button> <span data-testid="bs-reply">{reply}</span>
      </p>
      <h2>Contacts</h2>
      <ul data-testid="bs-contacts">
        {(s.companion?.contacts ?? []).map((c) => (
          <li key={c.publicKey}>{c.name}</li>
        ))}
      </ul>
      <h2>Send</h2>
      <p>
        <button type="button" disabled={!session.can('message.send.direct') || !first} onClick={() => void run(() => session.sendDirect({ clientDraftId: draft, clientAttemptId: newId('attempt'), contactKey: first!.publicKey, text: 'hello dm' }))}>
          Send DM to first contact
        </button>{' '}
        <button type="button" onClick={() => setDraft(newId('draft'))}>New draft</button>
      </p>
      {error && <p role="alert">{error}</p>}
      <h2>Attempts</h2>
      <ul data-testid="bs-attempts">
        {(s.companion?.attempts ?? []).map((a) => (
          <AttemptRow key={a.clientAttemptId} a={a} />
        ))}
      </ul>
    </section>
  );
}
