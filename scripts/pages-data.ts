/**
 * Collect every live source into static JSON for the GitHub Pages build.
 *
 *   npx tsx scripts/pages-data.ts dist-pages
 *
 * Writes <out>/data/feed.json and <out>/data/routes.json. The scheduled workflow runs this
 * every 30 minutes, so the snapshot on the site is never older than about half an hour.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadLiveRoutes, loadSignals } from "../src/lib/ocean.server";
import type { TrackPoint } from "../src/lib/ocean.types";

const out = join(process.argv[2] ?? "dist-pages", "data");

/** Five decimals is about a metre; the raw feeds carry far more than the globe can show. */
function trim(points: TrackPoint[]): TrackPoint[] {
  return points.map((p) => ({
    lat: Math.round(p.lat * 1e5) / 1e5,
    lng: Math.round(p.lng * 1e5) / 1e5,
    at: p.at,
  }));
}

const started = Date.now();
const feed = await loadSignals(true);
const routes = (await loadLiveRoutes(true)).map((route) => ({
  ...route,
  points: trim(route.points),
}));

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "feed.json"), JSON.stringify(feed));
writeFileSync(join(out, "routes.json"), JSON.stringify(routes));

for (const source of feed.sources) {
  console.log(
    `${source.ok ? "ok  " : "DOWN"} ${source.id.padEnd(12)} ${String(source.count).padStart(5)}  ${source.note ?? ""}`,
  );
}
console.log(
  `${feed.signals.length} signals, ${routes.length} routes in ${((Date.now() - started) / 1000).toFixed(1)}s -> ${out}`,
);

// A run where every source failed would publish an empty globe; fail the job instead.
if (!feed.sources.some((source) => source.ok)) {
  console.error("Every source failed; keeping the last published snapshot.");
  process.exit(1);
}
