import type { Track, TrackPoint } from "./ocean.types";

/**
 * Track helpers with no server dependencies, shared by the server feed and the static
 * GitHub Pages build, which fetches OCEARCH tracks straight from the browser.
 */

export const MAPOTIC = "https://www.mapotic.com/api/v1/maps/3413";

export function trackUrl(tagId: number): string {
  return `${MAPOTIC}/pois/${tagId}/motion/with-meta/`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function coord(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Mapotic motion rows (`{ point: { coordinates: [lng, lat] }, dt_move }`), oldest first. */
export function motionPoints(value: unknown): TrackPoint[] {
  if (!Array.isArray(value)) return [];
  const points: TrackPoint[] = [];
  for (const row of value) {
    const item = record(row);
    const coords = record(item?.point)?.coordinates;
    const lng = Array.isArray(coords) ? coord(coords[0]) : null;
    const lat = Array.isArray(coords) ? coord(coords[1]) : null;
    const at = typeof item?.dt_move === "string" ? item.dt_move.trim() : "";
    if (lng === null || lat === null || !at) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    points.push({ lat, lng, at });
  }
  return points.sort((a, b) => (a.at < b.at ? -1 : 1));
}

/** A full OCEARCH track from the `with-meta` response. */
export function readTrack(tagId: number, data: unknown): Track {
  return { tagId, points: downsample(motionPoints(record(data)?.motion), 420), error: null };
}

export function downsample(points: TrackPoint[], max: number): TrackPoint[] {
  if (points.length <= max) return points;
  const tailCount = Math.min(12, Math.floor(max / 3));
  const tail = points.slice(-tailCount);
  const head = points.slice(0, -tailCount);
  const budget = Math.max(1, max - tail.length);
  if (head.length <= budget) return [...head, ...tail];
  const step = Math.ceil(head.length / budget);
  const kept = head.filter((_, index) => index % step === 0);
  return [...kept, ...tail];
}
