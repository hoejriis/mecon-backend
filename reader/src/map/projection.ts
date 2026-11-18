import type { Observer } from '../api/types';

/** Drawing area of the SVG canvas, in its own user units. */
export const MAP_W = 640;
export const MAP_H = 400;
const PAD = 56;
/** Smallest span shown, in degrees of latitude, so one pin (or a tight cluster) is not blown up. */
const MIN_SPAN_DEG = 0.02;

export interface Pin {
  observer: Observer;
  x: number;
  y: number;
}

/**
 * Equirectangular projection, auto-fitted to the observers that have a
 * location. Observers whose location is null are never returned: the Reader
 * does not guess a place for them. Longitude is scaled by cos(mean latitude)
 * so the aspect is roughly right. The result is a schematic, not a survey.
 */
export function projectPins(observers: readonly Observer[]): Pin[] {
  const located = observers.filter(
    (o): o is Observer & { location: NonNullable<Observer['location']> } => o.location !== null,
  );
  if (located.length === 0) return [];
  const lats = located.map((o) => o.location.lat);
  const lons = located.map((o) => o.location.lon);
  const latMid = (Math.min(...lats) + Math.max(...lats)) / 2;
  const lonMid = (Math.min(...lons) + Math.max(...lons)) / 2;
  const k = Math.cos((latMid * Math.PI) / 180);
  const spanX = Math.max((Math.max(...lons) - Math.min(...lons)) * k, MIN_SPAN_DEG);
  const spanY = Math.max(Math.max(...lats) - Math.min(...lats), MIN_SPAN_DEG);
  const scale = Math.min((MAP_W - 2 * PAD) / spanX, (MAP_H - 2 * PAD) / spanY);
  return located.map((o) => ({
    observer: o,
    x: round(MAP_W / 2 + (o.location.lon - lonMid) * k * scale),
    y: round(MAP_H / 2 - (o.location.lat - latMid) * scale),
  }));
}

const round = (n: number) => Math.round(n * 10) / 10;

export function clockText(ts: string | null | undefined): string {
  if (!ts) return 'never';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? 'unknown' : `${d.toISOString().slice(11, 19)} UTC`;
}

export const FRESHNESS_TEXT = { live: 'Live', stale: 'Stale', offline: 'Offline' } as const;
