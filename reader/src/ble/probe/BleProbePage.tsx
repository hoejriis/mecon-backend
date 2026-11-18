import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Header } from '../../components/Header';
import { SkipLink } from '../../components/SkipLink';
import { WebBluetoothTransport, detectSupport } from '../webBluetoothTransport';
import { collectEnvironment, freshSteps, runProbe, sanitizeReport, type Environment, type RawProbe, type Step, type StepStatus } from './probeCore';

const STATUS_TEXT: Record<StepStatus, string> = {
  pending: 'Not started',
  running: 'Running',
  pass: 'Pass',
  fail: 'Fail',
  unsupported: 'Unsupported',
  unknown: 'Unknown',
};

function StepRow({ s }: { s: Step }) {
  return (
    <li className="probe-step" data-step={s.id} data-status={s.status}>
      <span className="probe-step-label">{s.label}</span>
      <strong className={`probe-status probe-${s.status}`}>{STATUS_TEXT[s.status]}</strong>
      {s.ms !== null && <span className="state-body"> {s.ms} ms</span>}
      {s.note && <span className="state-body probe-note">{s.note}</span>}
      {s.error && (
        <span className="state-body probe-note">
          Error {s.error.name}
          {s.error.code ? ` (${s.error.code})` : ''}: {s.error.message}
        </span>
      )}
    </li>
  );
}

export default function BleProbePage() {
  const envRef = useRef<Environment | null>(null);
  const [steps, setSteps] = useState<Step[]>(freshSteps);
  const [running, setRunning] = useState(false);
  const [raw, setRaw] = useState<RawProbe | null>(null);
  const [report, setReport] = useState('');
  const [copyMsg, setCopyMsg] = useState('');

  useEffect(() => {
    void collectEnvironment().then((e) => {
      envRef.current = e;
    });
  }, []);

  // Called straight from the click: nothing is awaited before runProbe() asks for the chooser.
  const start = () => {
    const env: Environment = envRef.current ?? {
      userAgent: navigator.userAgent,
      bluetoothPresent: detectSupport() === 'supported',
      availability: 'not_available',
    };
    setRunning(true);
    setCopyMsg('');
    setReport('');
    const p = runProbe({
      transport: new WebBluetoothTransport(),
      env,
      onUpdate: (r) => setSteps(r.steps),
    });
    void p.then(
      (r) => {
        setRaw(r);
        setSteps(r.steps);
        setReport(JSON.stringify(sanitizeReport(r), null, 2));
        setRunning(false);
      },
      () => setRunning(false),
    );
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setCopyMsg('Report copied.');
    } catch {
      setCopyMsg('Copy was blocked. Select the text in the box and copy it by hand.');
    }
  };

  return (
    <div className="shell">
      <SkipLink />
      <Header />
      <main className="content" id="main" tabIndex={-1}>
        <section className="pane probe" aria-labelledby="probe-h">
          <h1 id="probe-h">Bluetooth diagnostics</h1>
          <p>
            This page checks whether this browser can talk to a MeshCore Companion over Bluetooth. It only <strong>reads</strong>: it
            connects, asks the Companion who it is (the MECON device-interface hello, then the Companion device query), and disconnects.
          </p>
          <p className="notice">
            Nothing is transmitted over radio. No message, advert or setting is sent or changed, and nothing is stored. You do not need to sign in.
          </p>
          <button type="button" className="btn probe-btn" onClick={start} disabled={running}>
            {running ? 'Running...' : raw ? 'Run again' : 'Connect and run probe'}
          </button>
          <h2>Steps</h2>
          <ol className="probe-steps" aria-live="polite">
            {steps.map((s) => (
              <StepRow key={s.id} s={s} />
            ))}
          </ol>
          <h2>Detected device</h2>
          <p className="state-body" data-testid="probe-detected">
            {raw?.detected ? raw.detected.summary : 'Not identified yet.'}
          </p>
          <p className="state-body">
            A browser cannot see the Bluetooth PIN, so this link counts as unknown trust: the probe sends read requests only, and a device
            on a default PIN may refuse even the hello.
          </p>
          <h2>Report</h2>
          <p className="state-body">
            The report holds no device name, node name, keys, location, Bluetooth id or PIN. Copy it and post it on the tracking Issue.
          </p>
          <label htmlFor="probe-report" className="probe-label">
            Sanitized report (JSON)
          </label>
          <textarea id="probe-report" className="probe-report" readOnly rows={12} value={report} placeholder="The report appears here when the run ends." />
          <button type="button" className="btn probe-btn" onClick={() => void copy()} disabled={!report}>
            Copy report
          </button>
          <p role="status" className="state-body">
            {copyMsg}
          </p>
          <h2>If the chooser is empty</h2>
          <ul className="probe-help">
            <li>Make sure the Companion is powered on and Bluetooth is on in the phone.</li>
            <li>Disconnect any other app (phone Bluetooth settings or another client) from the Companion: it accepts one connection at a time.</li>
            <li>Move the phone close to the Companion and tap Run again.</li>
            <li>On iPhone and iPad use the Bluefy browser; Safari has no Web Bluetooth.</li>
            <li>If the Companion shows a PIN, enter it when the phone asks.</li>
          </ul>
          <p>
            <Link to="/settings">Back to Settings</Link>
          </p>
        </section>
      </main>
    </div>
  );
}
