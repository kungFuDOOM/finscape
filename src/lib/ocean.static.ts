import type { Feed, LiveRoute, Track } from "./ocean.types";

// Stand-in for ocean.functions in the GitHub Pages build: the same calls, answered from JSON
// snapshots that a scheduled GitHub Action writes with the server code (scripts/build-pages-data.ts).
const BASE = `${import.meta.env.BASE_URL}data/`;

async function json<T>(path: string): Promise<T> {
  // Pages caches for 10 minutes; revalidate so each poll sees the newest snapshot.
  const res = await fetch(`${BASE}${path}`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Snapshot unavailable (HTTP ${res.status})`);
  return (await res.json()) as T;
}

export function getSignals(_input?: { data?: { fresh?: boolean } }): Promise<Feed> {
  return json<Feed>("feed.json");
}

export function getLiveRoutes(_input?: { data?: { fresh?: boolean } }): Promise<LiveRoute[]> {
  return json<LiveRoute[]>("routes.json");
}

export async function getTrack({ data }: { data: { id: number } }): Promise<Track> {
  try {
    return await json<Track>(`tracks/${data.id}.json`);
  } catch {
    // Full histories are only published for recently active tags; fall back to the route.
    const routes = await json<LiveRoute[]>("routes.json").catch(() => [] as LiveRoute[]);
    const route = routes.find((item) => item.id === `ocearch:${data.id}`);
    return {
      tagId: data.id,
      points: route?.points ?? [],
      error: route ? null : "Path history is kept for tags active in the last year.",
    };
  }
}
