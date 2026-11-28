import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { newId, type AttemptFacts } from '../ble/adapter';
import { DeviceSession, type SessionOptions } from './session';
import { WebSerialTransport } from './webSerialTransport';

/**
 * Developer harness for the USB device session, reachable only at /dev/usb in a
 * dev build. Not part of the product UI and not in production bundles.
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

export default function UsbDevPage() {
  const session = useMemo(() => {
    const o = (window as unknown as { __USB_DEV_OPTS?: SessionOptions }).__USB_DEV_OPTS ?? {};
    return new DeviceSession(new WebSerialTransport(), o);
  }, []);
  useEffect(() => {
    (window as unknown as { __usbSession?: DeviceSession }).__usbSession = session;
  }, [session]);
  const s = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [draft, setDraft] = useState(() => newId('draft'));
  const [error, setError] = useState<string | null>(null);
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
    <section className="pane ble-dev" aria-label="USB developer harness">
      <h1>USB device (dev only)</h1>
      <p>
        Link: <strong data-testid="usb-link">{s.link}</strong>; phase: <span data-testid="usb-phase">{s.phase}</span>; last error: <span data-testid="usb-last-error">{s.lastError ?? 'none'}</span>
      </p>
      {s.link === 'unsupported' && <p role="status">Web Serial is not available in this browser. Messaging through the Backend is unaffected.</p>}
      <p>
        <button type="button" onClick={() => void session.connect()}>Connect device</button>{' '}
        <button type="button" onClick={() => void session.reconnect()}>Reconnect</button>{' '}
        <button type="button" onClick={() => void session.disconnect()}>Disconnect</button>
      </p>
      <p>
        Detected: <span data-testid="usb-summary">{s.detected?.summary ?? 'not yet'}</span>
      </p>
      <p>
        Role: <span data-testid="usb-role">{s.detected?.role ?? 'unknown'}</span>; capabilities: <span data-testid="usb-caps">{caps.join(',') || 'none'}</span>
      </p>
      <h2>Contacts</h2>
      <p data-testid="usb-contacts-state">contacts: {s.companion?.contactsState === 'failed' ? 'could not be read (list incomplete, not shown)' : (s.companion?.contactsState ?? 'idle')}</p>
      <ul data-testid="usb-contacts">
        {(s.companion?.contacts ?? []).map((c) => (
          <li key={c.publicKey}>{c.name}</li>
        ))}
      </ul>
      <h2>Send</h2>
      <p>
        <button type="button" disabled={!session.can('message.send.direct') || !first} onClick={() => void run(() => {
          // The dev page maps like the Reader does: by the contact's key prefix, refusing when it is not unique.
          const m = session.mapDestination({ kind: 'contact', targetId: 'dev', prefix: first!.publicKey.slice(0, 12) });
          if (!m.ok) throw new Error(m.reason);
          return session.sendDirect({ clientDraftId: draft, clientAttemptId: newId('attempt'), text: 'hello dm', mapping: m.token, auth: { op: 'send.direct', identityId: 'dev', deviceId: 'dev', targetId: 'dev', identityKeyPrefix: s.companion?.selfInfo?.publicKey.slice(0, 8) ?? '' } });
        })}>
          Send DM to first contact
        </button>{' '}
        <button type="button" onClick={() => setDraft(newId('draft'))}>New draft</button>
      </p>
      {error && <p role="alert">{error}</p>}
      <h2>Attempts</h2>
      <ul data-testid="usb-attempts">
        {(s.companion?.attempts ?? []).map((a) => (
          <AttemptRow key={a.clientAttemptId} a={a} />
        ))}
      </ul>
    </section>
  );
}
