import { useEffect } from 'react';
import { useAuth } from '../auth/AuthContext';
import type { CapabilityState, Device } from '../api/types';
import { BUILD_COMMIT } from '../buildInfo';
import type { TabDef } from '../tabs';

const CAP_COPY: Record<Exclude<CapabilityState, 'available'>, [string, string]> = {
  unavailable: ['Not available', 'This Backend does not provide this yet.'],
  forbidden: ['Not permitted', 'Your account does not have access to this.'],
};

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty" role="status">
      <p className="empty-title">{title}</p>
      {body && <p className="empty-body">{body}</p>}
    </div>
  );
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
          <p className="empty-body">
            {d.role} · {d.reachability} · battery {batteryText(d.battery_pct)}
          </p>
        </li>
      ))}
    </ul>
  );
}

function NodesBody({ state }: { state: CapabilityState }) {
  const { devices, loadDevices } = useAuth();
  useEffect(() => {
    if (state === 'available') void loadDevices();
  }, [state, loadDevices]);
  if (state !== 'available') return <Empty title={CAP_COPY[state][0]} body={CAP_COPY[state][1]} />;
  if (devices.status === 'error') return <Empty title="Could not load nodes" body={devices.message} />;
  if (devices.status !== 'ready') return <Empty title="Loading nodes…" body="" />;
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
      <button type="button" className="btn" onClick={() => void signOut()}>
        Sign out
      </button>
      <p className="empty-body build-stamp">
        Build: {BUILD_COMMIT ? BUILD_COMMIT.slice(0, 12) : 'local'}
      </p>
    </div>
  );
}

export function TabPage({ tab }: { tab: TabDef }) {
  const { session } = useAuth();
  const state: CapabilityState | null =
    tab.capability && session ? session.capabilities[tab.capability] ?? 'unavailable' : null;

  let body;
  if (tab.id === 'settings') body = <SettingsBody />;
  else if (tab.id === 'nodes' && state) body = <NodesBody state={state} />;
  else if (state && state !== 'available') body = <Empty title={CAP_COPY[state][0]} body={CAP_COPY[state][1]} />;
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
      <div className="pane pane-detail" aria-label={`${tab.label} detail`}>
        <p className="empty-body">Nothing selected.</p>
      </div>
    </section>
  );
}
