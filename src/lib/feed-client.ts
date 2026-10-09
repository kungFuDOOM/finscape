import { getLiveRoutes, getSignals, getTrack } from "./ocean.functions";
import type { Feed, LiveRoute, Track } from "./ocean.types";

/**
 * Where the globe gets its data. This version calls the app's server functions; the static
 * GitHub Pages build swaps in `feed-client.static.ts` (see vite.pages.config.ts).
 */

export function loadFeed(fresh: boolean): Promise<Feed> {
  return getSignals({ data: { fresh } });
}

export function loadRoutes(fresh: boolean): Promise<LiveRoute[]> {
  return getLiveRoutes({ data: { fresh } });
}

export function loadTrack(id: number): Promise<Track> {
  return getTrack({ data: { id } });
}

/** Satellite tiles go through the app's own proxy route. */
export function tileUrl(z: number, y: number, x: number): string {
  return `/api/sat/${z}/${y}/${x}`;
}
