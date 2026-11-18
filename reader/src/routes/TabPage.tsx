import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import type { CapabilityState, Device } from '../api/types';
import { BUILD_COMMIT } from '../buildInfo';
import type { TabDef } from '../tabs';
import { OfflineSettings } from '../offline/OfflineSettings';
import { Empty, ErrorState, Forbidden, Loading, Offline, Unavailable, useOnline } from '../components/States';

function CapState({ state }: { state: Exclude<CapabilityState, 'available'> }) {
  return state === 'forbidden' ? <Forbidden /> : <Unavailable />;
}

function batteryText(pct: number | null | undefined): string {
  return pct === null || pct === undefined ? 'unknown' : `${pct}%`;
}

function NodeList({ items }: { items: Device[] }) {
  if (items.length === 0) return <Empty title="No nodes" body="No devices are assigned to your account." />;
  return (
    <ul className="node-list">
      {items.map((d) => (
        <li key={d.id} className="node">
          <p className="node-label">{d.label}</p>
          <p className="state-body">
            {d.role} · {d.reachability} · battery {batteryText(d.battery_pct)}
          </p>
        </li>
      ))}
    </ul>
  );
}

function NodesBody({ state }: { state: CapabilityState }) {
  const { devices, loadDevices } = useAuth();
  const online = useOnline();
  useEffect(() => {
    if (state === 'available') void loadDevices();
  }, [state, loadDevices]);
  if (state !== 'available') return <CapState state={state} />;
  if (devices.status === 'error') return online ? <ErrorState title="Could not load nodes" body={devices.message} /> : <Offline />;
  if (devices.status !== 'ready') return online ? <Loading label="Loading nodes" /> : <Offline />;
  return <NodeList items={devices.items} />;
}

function SettingsBody() {
  const { session, signOut, signOutError } = useAuth();
  if (!session) return null;
  const caps = Object.entries(session.capabilities);
  return (
    <div className="settings">
      <p>
        Signed in as <strong>{session.user.display_name}</strong>
      </p>
      <h2>Capabilities</h2>
      <ul className="cap-list">
        {caps.map(([name, state]) => (
          <li key={name}>
            <span>{name}</span> <span className={`cap cap-${state}`}>{state}</span>
          </li>
        ))}
      </ul>
      {signOutError && (
        <p className="notice" role="alert">
          {signOutError}
        </p>
      )}
      <OfflineSettings />
      <button type="button" className="btn" onClick={() => void signOut()}>
        Sign out
      </button>
      <p>
        <Link to="/probe/ble">Bluetooth diagnostics</Link>
      </p>
      <p>
        <Link to="/probe/usb">USB diagnostics</Link>
      </p>
      <p className="state-body build-stamp">
        Build: {BUILD_COMMIT ? BUILD_COMMIT.slice(0, 12) : 'local'}
      </p>
    </div>
  );
}

export function TabPage({ tab }: { tab: TabDef }) {
  const { session } = useAuth();
  const state: CapabilityState | null =
    tab.capability && session ? session.capabilities[tab.capability] ?? 'unavailable' : null;

  const online = useOnline();
  let body;
  if (tab.id === 'settings') body = <SettingsBody />;
  else if (tab.id === 'nodes' && state) body = <NodesBody state={state} />;
  else if (state && state !== 'available') body = <CapState state={state} />;
  else if (state === 'available' && !online) body = <Offline />;
  else if (state === 'available') {
    body = (
      <Empty
        title={`${tab.label} is not built yet`}
        body="The Backend offers this, but the Reader does not show it yet."
      />
    );
  } else body = <Empty title={tab.emptyTitle} body={tab.emptyBody} />;

  return (
    <section className="split" aria-labelledby={`h-${tab.id}`}>
      <div className="pane pane-list">
        <h1 id={`h-${tab.id}`}>{tab.listTitle}</h1>
        {body}
      </div>
      <section className="pane pane-detail" aria-label={`${tab.label} detail`}>
        <p className="state-body">Nothing selected.</p>
      </section>
    </section>
  );
}
