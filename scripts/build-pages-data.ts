// Writes the JSON snapshots the GitHub Pages build reads (see src/lib/ocean.static.ts).
// Runs in the Pages workflow with the same server code the full app uses.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadLiveRoutes, loadSignals, loadTrack } from "../src/lib/ocean.server";

const out = process.argv[2] ?? "dist-pages/data";
const YEAR_MS = 365 * 86_400_000;

const feed = await loadSignals(false);
for (const source of feed.sources) {
  console.log(`${source.ok ? "ok  " : "FAIL"} ${source.label}: ${source.count}${source.note ? ` (${source.note})` : ""}`);
}
// Never publish an empty map over a good one: failing here keeps the previous deploy live.
if (!feed.signals.length) {
  console.error("No signals from any source; keeping the last published snapshot.");
  process.exit(1);
}

const now = Date.now();
const routes = (await loadLiveRoutes(false)).filter((route) => {
  const last = route.points.at(-1);
  return last && now - Date.parse(last.at) < YEAR_MS;
});
const active = feed.signals.filter(
  (signal) => signal.kind === "tag" && signal.tagId && now - Date.parse(signal.observedAt) < YEAR_MS,
);

await mkdir(join(out, "tracks"), { recursive: true });
let tracks = 0;
for (let i = 0; i < active.length; i += 4) {
  await Promise.all(
    active.slice(i, i + 4).map(async (signal) => {
      const track = await loadTrack(signal.tagId!);
      if (!track.points.length) return;
      await writeFile(join(out, "tracks", `${signal.tagId}.json`), JSON.stringify(track));
      tracks += 1;
    }),
  );
}
await writeFile(join(out, "feed.json"), JSON.stringify(feed));
await writeFile(join(out, "routes.json"), JSON.stringify(routes));
console.log(`Wrote ${feed.signals.length} signals, ${routes.length} routes and ${tracks} track histories to ${out}.`);
