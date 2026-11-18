import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Header } from '../../components/Header';
import { SkipLink } from '../../components/SkipLink';
import { WebSerialTransport } from '../webSerialTransport';
import { collectUsbEnvironment, freshUsbSteps, runUsbProbe, sanitizeUsbReport, type RawUsbProbe, type UsbStep, type UsbStepStatus } from './usbProbeCore';

const STATUS_TEXT: Record<UsbStepStatus, string> = { pending: 'Not started', running: 'Running', pass: 'Pass', fail: 'Fail', unsupported: 'Unsupported', unknown: 'Unknown' };

function StepRow({ s }: { s: UsbStep }) {
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

export default function UsbProbePage() {
  const [steps, setSteps] = useState<UsbStep[]>(freshUsbSteps);
  const [running, setRunning] = useState(false);
  const [raw, setRaw] = useState<RawUsbProbe | null>(null);
  const [report, setReport] = useState('');
  const [copyMsg, setCopyMsg] = useState('');
  const supported = useRef(collectUsbEnvironment().serialPresent);

  useEffect(() => {
    supported.current = collectUsbEnvironment().serialPresent;
  }, []);

  // Called straight from the click: nothing is awaited before runUsbProbe() asks for the chooser.
  const start = () => {
    setRunning(true);
    setCopyMsg('');
    setReport('');
    const p = runUsbProbe({ transport: new WebSerialTransport(), env: collectUsbEnvironment(), onUpdate: (r) => setSteps(r.steps) });
    void p.then(
      (r) => {
        setRaw(r);
        setSteps(r.steps);
        setReport(JSON.stringify(sanitizeUsbReport(r), null, 2));
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
          <h1 id="probe-h">USB diagnostics</h1>
          <p>
            This page checks whether this browser can talk to a MeshCore device (Companion, Repeater, Room server or other) over a USB cable. It only <strong>reads</strong>: it
            opens the port you choose, asks the device who it is, and closes the port.
          </p>
          <p className="notice">
            Nothing is transmitted over radio. No message, advert or setting is sent or changed, and nothing is stored. You do not need to sign in. Needs desktop Chrome, Edge or Opera.
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
          <h2>Report</h2>
          <p className="state-body">The report holds no keys, device ids, names, coordinates or passwords. Copy it and post it on the tracking Issue.</p>
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
            <li>Plug the device in with a data cable (some cables only charge) and wait a few seconds.</li>
            <li>Close other tabs and programs that use the serial port (a serial monitor, a flasher, another Reader tab): a port can be open in one place only.</li>
            <li>Use desktop Chrome, Edge or Opera. Safari and Firefox have no Web Serial.</li>
            <li>If the port opens but nothing answers, wait for the device to finish starting and run again.</li>
          </ul>
          <p>
            <Link to="/settings">Back to Settings</Link>
          </p>
        </section>
      </main>
    </div>
  );
}
