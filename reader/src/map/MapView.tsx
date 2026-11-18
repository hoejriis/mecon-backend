import { useAuth } from '../auth/AuthContext';
import { Empty, ErrorState, Forbidden, Loading } from '../components/States';
import type { Observer } from '../api/types';
import { clockText, FRESHNESS_TEXT, MAP_H, MAP_W, projectPins, type Pin } from './projection';
import { useObservations, type Highlight } from './useObservations';

function pinLabel(o: Observer, hl: Highlight | undefined): string {
  const f = o.freshness;
  const heard = f.last_heard_at ? `last heard ${clockText(f.last_heard_at)}` : 'never heard';
  return `${o.label}, ${FRESHNESS_TEXT[f.state].toLowerCase()}, ${heard}${hl ? `, heard a packet at ${clockText(hl.at)}` : ''}`;
}

/**
 * Observer pins on a plain SVG canvas. Only circles and text: there is no
 * line, path or polygon here, because the Reader never draws a route between
 * observers and never places a transmitter.
 */
function PinCanvas({ pins, highlights }: { pins: Pin[]; highlights: Record<string, Highlight> }) {
  return (
    <svg
      className="obs-map"
      viewBox={`0 0 ${MAP_W} ${MAP_H}`}
      role="group"
      aria-label="Observer locations on a simplified map"
    >
      <rect className="obs-map-bg" x="0" y="0" width={MAP_W} height={MAP_H} />
      {pins.map(({ observer: o, x, y }) => {
        const hl = highlights[o.observer_id];
        return (
          <g key={o.observer_id} className={`obs-pin obs-${o.freshness.state}${hl ? ' obs-active' : ''}`} data-observer={o.observer_id}>
            {hl && <circle className="obs-pulse" cx={x} cy={y} r="20" aria-hidden="true" />}
            <circle className="obs-dot" cx={x} cy={y} r="9" role="img" aria-label={pinLabel(o, hl)} />
            <text className="obs-pin-label" x={x} y={y + 26} textAnchor="middle" aria-hidden="true">
              {o.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function ObserverRow({ o, last, hl }: { o: Observer; last: string | undefined; hl: Highlight | undefined }) {
  const f = o.freshness;
  return (
    <li className={`node obs-row${hl ? ' obs-row-active' : ''}`} data-observer={o.observer_id}>
      <p className="node-label">{o.label}</p>
      <p className="state-body">
        <span className={`cap obs-chip obs-chip-${f.state}`}>{FRESHNESS_TEXT[f.state]}</span>{' '}
        Last heard {clockText(f.last_heard_at)}
      </p>
      <p className="state-body">
        {o.location ? `Location shared (within about ${Math.round(o.location.precision_m)} m)` : 'Location not shared'}
      </p>
      {last && <p className="state-body">Latest reception {clockText(last)}</p>}
      {hl && <p className="obs-heard">Heard a packet at {clockText(hl.at)}</p>}
    </li>
  );
}

export function MapView() {
  const { api, refreshSession } = useAuth();
  const { state, retry } = useObservations(api, refreshSession);

  if (state.status === 'loading') return <Loading label="Loading observers" />;
  if (state.status === 'revoked') {
    return (
      <Forbidden title="Access withdrawn" body="Your access to observations ended. Nothing from this view is kept.">
        <button type="button" className="btn btn-secondary" onClick={retry}>
          Check again
        </button>
      </Forbidden>
    );
  }
  if (state.status === 'error') {
    return (
      <ErrorState title="Could not load observers" body={state.error ?? undefined} requestId={state.requestId}>
        <button type="button" className="btn btn-secondary" onClick={retry}>
          Try again
        </button>
      </ErrorState>
    );
  }
  if (state.observers.length === 0) {
    return <Empty title="No observers" body="No observers are visible to your account yet." />;
  }

  const pins = projectPins(state.observers);
  const unplaced = state.observers.length - pins.length;
  const active = Object.entries(state.highlights).sort((a, b) => b[1].until - a[1].until)[0];
  const activeLabel = active && state.observers.find((o) => o.observer_id === active[0])?.label;

  return (
    <div className="obs">
      <p className="state-body">
        Observer positions only. This view never shows where a packet came from or how it travelled.
        {state.stream !== 'live' && ' Live updates are not connected right now.'}
      </p>
      <p className="sr-only" role="status" aria-live="polite">
        {active && activeLabel ? `${activeLabel} heard a packet at ${clockText(active[1].at)}` : ''}
      </p>
      {pins.length > 0 ? (
        <>
          <PinCanvas pins={pins} highlights={state.highlights} />
          <p className="state-body obs-note">
            Simplified map without base-map tiles; positions are approximate and not to scale.
            {unplaced > 0 && ` ${unplaced} observer${unplaced === 1 ? '' : 's'} without a shared location ${unplaced === 1 ? 'is' : 'are'} listed below but not drawn.`}
          </p>
        </>
      ) : (
        <Empty title="No observer locations shared" body="Observers are listed below; none has shared a location, so nothing is drawn." />
      )}
      <h2>Observers</h2>
      {/* Focusable so the scrolling page is reachable by keyboard (the map is not otherwise interactive). */}
      <ul className="node-list" aria-label="Observers" tabIndex={0}>
        {state.observers.map((o) => (
          <ObserverRow key={o.observer_id} o={o} last={state.lastReception[o.observer_id]} hl={state.highlights[o.observer_id]} />
        ))}
      </ul>
    </div>
  );
}
