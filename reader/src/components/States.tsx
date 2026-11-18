import { useEffect, useState, type ReactNode } from 'react';

/** Reactive navigator.onLine. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

interface StateProps {
  title: string;
  body?: string;
  children?: ReactNode;
}

function StateBox({ kind, title, body, children, role = 'status' }: StateProps & { kind: string; role?: 'status' | 'alert' }) {
  return (
    <div className={`state state-${kind}`} role={role}>
      <p className="state-title">{title}</p>
      {body && <p className="state-body">{body}</p>}
      {children}
    </div>
  );
}

/** Nothing to show, and nothing is wrong. */
export function Empty({ title, body, children }: StateProps) {
  return (
    <StateBox kind="empty" title={title} body={body}>
      {children}
    </StateBox>
  );
}

/** The Backend does not provide this capability (yet). */
export function Unavailable({ title = 'Not available', body = 'This Backend does not provide this yet.' }: Partial<StateProps>) {
  return <StateBox kind="unavailable" title={title} body={body} />;
}

/** The capability exists, but this account may not use it. */
export function Forbidden({ title = 'Not permitted', body = 'Your account does not have access to this.', children }: Partial<StateProps>) {
  return (
    <StateBox kind="forbidden" title={title} body={body}>
      {children}
    </StateBox>
  );
}

/** The browser reports no network. */
export function Offline({ body = 'You are offline. This will load again when you reconnect.' }: { body?: string }) {
  return <StateBox kind="offline" title="You are offline" body={body} />;
}

/** A request failed. request_id, when the Backend sent one, is shown small for support. */
export function ErrorState({ title = 'Something went wrong', body, requestId, children }: { title?: string; body?: string; requestId?: string | null; children?: ReactNode }) {
  return (
    <StateBox kind="error" title={title} body={body} role="alert">
      {requestId && <p className="state-meta">Request ID: {requestId}</p>}
      {children}
    </StateBox>
  );
}

/** Skeleton placeholder. Animation is disabled under prefers-reduced-motion (app.css). */
export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="state state-loading" role="status" aria-busy="true">
      <span className="sr-only">{label}…</span>
      <div className="skeleton" aria-hidden="true" />
      <div className="skeleton skeleton-short" aria-hidden="true" />
      <div className="skeleton" aria-hidden="true" />
    </div>
  );
}
