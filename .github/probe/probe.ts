// One-off probe: how much lands on the California coast with the new iNaturalist boxes.
import { loadSignals } from "../../src/lib/ocean.server";

const feed = await loadSignals(false);
for (const s of feed.sources) console.log(`${s.ok ? "ok  " : "DOWN"} ${s.id.padEnd(12)} ${String(s.count).padStart(5)}  ${s.note ?? ""}`);
const now = Date.now();
const regions: Array<[string, number, number, number, number]> = [
  ["California coast", 32, -125, 42, -116.5],
  ["SoCal (Pt Conception to Mexico)", 32, -121, 34.6, -116.5],
  ["Baja + Gulf of California", 22, -118, 32, -105],
  ["Pacific Northwest", 42.5, -132, 51, -122],
];
for (const [name, s, w, n, e] of regions) {
  const inside = feed.signals.filter((x) => x.lat >= s && x.lat <= n && x.lng >= w && x.lng <= e);
  const recent = inside.filter((x) => now - Date.parse(x.observedAt) < 90 * 86_400_000);
  const table: Record<string, number> = {};
  for (const x of recent) table[`${x.source}:${x.kind}:${x.group}`] = (table[`${x.source}:${x.kind}:${x.group}`] ?? 0) + 1;
  console.log(`\n${name}: ${inside.length} total, ${recent.length} in the last 90 days`, table);
  for (const x of recent.slice(0, 6)) console.log(`   ${x.observedAt.slice(0, 10)} ${x.kind} ${x.common} @ ${x.place ?? ""}`);
}
