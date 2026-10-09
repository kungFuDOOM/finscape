import { readTrack, trackUrl } from "./motion";
import type { Feed, LiveRoute, Track } from "./ocean.types";

/**
 * The GitHub Pages data layer. A scheduled workflow collects every source into
 * `data/feed.json` and `data/routes.json` next to the page; full OCEARCH tracks and
 * satellite tiles allow cross-origin reads, so the browser fetches those directly.
 */

const DATA = `${import.meta.env.BASE_URL}data/`;

async function snapshot<T>(name: string): Promise<T> {
  // `no-cache` revalidates, so a fresh snapshot shows up on the next poll.
  const res = await fetch(`${DATA}${name}`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Snapshot ${name}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function loadFeed(): Promise<Feed> {
  return snapshot<Feed>("feed.json");
}

export function loadRoutes(): Promise<LiveRoute[]> {
  return snapshot<LiveRoute[]>("routes.json");
}

export async function loadTrack(id: number): Promise<Track> {
  try {
    const res = await fetch(trackUrl(id), { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return readTrack(id, await res.json());
  } catch (error) {
    return {
      tagId: id,
      points: [],
      error: error instanceof Error ? error.message : "Track unavailable",
    };
  }
}

export function tileUrl(z: number, y: number, x: number): string {
  return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
}
