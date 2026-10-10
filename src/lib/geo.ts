import type { Feature, MultiPolygon } from "geojson";
import type { TrackPoint } from "./ocean.types";

/** Pure geometry for the globe: headings, dead reckoning and the day/night line. */

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function wrapLng(lng: number): number {
  let value = lng;
  while (value > 180) value -= 360;
  while (value < -180) value += 360;
  return value;
}

export function deltaLng(from: number, to: number): number {
  let d = to - from;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

type LatLng = { lat: number; lng: number };

export function kmBetween(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * 111;
  const dLng = deltaLng(a.lng, b.lng) * 111 * Math.cos(((a.lat + b.lat) / 2) * D2R);
  return Math.hypot(dLat, dLng);
}

function along(a: LatLng, b: LatLng, t: number): LatLng {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: wrapLng(a.lng + deltaLng(a.lng, b.lng) * t) };
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

/** Speed and heading over the last two fixes, when they are close enough in time to mean anything. */
export function trackLeg(
  points: TrackPoint[],
): { kmh: number; heading: number; dir: string } | null {
  if (points.length < 2) return null;
  const a = points[points.length - 2];
  const b = points[points.length - 1];
  const hop = Date.parse(b.at) - Date.parse(a.at);
  if (!Number.isFinite(hop) || hop < 60_000 || hop > 36 * 3_600_000) return null;
  const km = kmBetween(a, b);
  const kmh = km / (hop / 3_600_000);
  if (km < 0.4 || kmh < 0.15 || kmh > 40) return null;
  const dLng = deltaLng(a.lng, b.lng) * D2R;
  const φ1 = a.lat * D2R;
  const φ2 = b.lat * D2R;
  const y = Math.sin(dLng) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dLng);
  const heading = (Math.atan2(y, x) * R2D + 360) % 360;
  return { kmh, heading, dir: COMPASS[Math.round(heading / 45) % 8] };
}

/**
 * Where a tagged animal probably is now: the latest fix, nudged along its last heading for up
 * to 8 hours (at most 40 km), so live tags drift instead of sitting frozen between pings.
 */
export function liveFix(points: TrackPoint[], now: number, hold: boolean): LatLng {
  const last = points[points.length - 1];
  if (points.length < 2 || hold) return last;
  const lastAt = Date.parse(last.at);
  const prev = points[points.length - 2];
  const prevAt = Date.parse(prev.at);
  if (!Number.isFinite(lastAt) || !Number.isFinite(prevAt) || now < lastAt) return last;
  const hop = lastAt - prevAt;
  const km = kmBetween(prev, last);
  if (hop < 60_000 || hop > 36 * 3_600_000) return last;
  const kmh = km / (hop / 3_600_000);
  if (km < 0.4 || kmh < 0.15 || kmh > 25) return last;
  const age = now - lastAt;
  if (age > 8 * 3_600_000) return last;
  const extraKm = Math.min(kmh * (age / 3_600_000), 40);
  const next = along(prev, last, 1 + extraKm / km);
  return { lat: clamp(next.lat, -85, 85), lng: next.lng };
}

/** The point on Earth where the sun is overhead (low-precision solar position). */
export function subsolarPoint(at: number): LatLng {
  const date = new Date(at);
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const day = (at - start) / 86_400_000;
  const lat = -23.44 * Math.cos(((2 * Math.PI) / 365) * (day + 10));
  const hours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  return { lat, lng: wrapLng(-(hours - 12) * 15) };
}

/**
 * The night side of the Earth as GeoJSON: one narrow strip per 2° of longitude, from the
 * terminator to the dark pole. A single polygon spanning the dateline and the pole does not
 * render on MapLibre's globe; small strips do. `offset` (degrees) moves the line into the dark,
 * for a twilight band.
 */
export function nightPolygon(at: number, offset = 0): Feature<MultiPolygon> {
  const sun = subsolarPoint(at);
  // Keep the declination off zero so the terminator latitude stays finite near the equinoxes.
  const decl = (Math.abs(sun.lat) < 0.2 ? (sun.lat < 0 ? -0.2 : 0.2) : sun.lat) * D2R;
  // Night is the hemisphere around the pole facing away from the sun.
  const pole = decl > 0 ? -85 : 85;
  const edge = (lng: number) => {
    const ha = (lng - sun.lng) * D2R;
    // Points where the sun's elevation is -offset degrees.
    let lat = Math.atan(-Math.cos(ha) / Math.tan(decl)) * R2D;
    lat += (decl > 0 ? -offset : offset) * Math.abs(Math.cos(ha));
    return clamp(lat, -85, 85);
  };
  const strips: [number, number][][][] = [];
  for (let lng = -180; lng < 180; lng += 2) {
    const a = edge(lng);
    const b = edge(lng + 2);
    strips.push([
      [
        [lng, a],
        [lng + 2, b],
        [lng + 2, pole],
        [lng, pole],
        [lng, a],
      ],
    ]);
  }
  return { type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates: strips } };
}
