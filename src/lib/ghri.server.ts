import { downsample, fetchText, pool } from "./net.server";
import type { LiveRoute, Signal, SourceStatus, TrackPoint } from "./ocean.types";

/**
 * Guy Harvey Research Institute (Nova Southeastern University) shark tracker. Each project on
 * ghritracking.org is a CSV of SPOT tag fixes. Only the mako projects still reach the last few
 * years; sharks whose last fix is older than CUTOFF stay off the globe.
 */

const BASE = "https://www.ghritracking.org/sharkmap/controlfiles/";
const SITE = "https://www.ghritracking.org/";
const TTL_MS = 3 * 3_600_000;
const CUTOFF = Date.UTC(2021, 0, 1);

const FILES: Array<{ file: string; label: string }> = [
  { file: "makosharksmexico", label: "GHRI, Western North Atlantic makos" },
  { file: "caribbeanmakosharks", label: "GHRI, Caribbean & Gulf of Mexico makos" },
];

const COMMON: Record<string, string> = {
  "Isurus oxyrinchus": "Shortfin mako shark",
  "Galeocerdo cuvier": "Tiger shark",
  "Carcharhinus longimanus": "Oceanic whitetip shark",
  "Sphyrna zygaena": "Smooth hammerhead",
  "Carcharias taurus": "Sand tiger shark",
};

export type GhriData = { signals: Signal[]; routes: LiveRoute[]; status: SourceStatus };

let cache: { at: number; data: GhriData } | null = null;
let inflight: Promise<GhriData> | null = null;

export function loadGhri(): Promise<GhriData> {
  if (cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.data);
  if (inflight) return inflight;
  inflight = buildGhri()
    .then((data) => {
      if (data.signals.length || !cache) cache = { at: Date.now(), data };
      return cache.data;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

async function buildGhri(): Promise<GhriData> {
  const status: SourceStatus = {
    id: "ghri",
    label: "Guy Harvey Research Institute shark tags",
    ok: false,
    count: 0,
    note: null,
  };
  let failed = 0;
  const parsed = await pool(FILES, 2, async ({ file, label }) => {
    try {
      return readProject(parseCsv(await fetchText(`${BASE}${file}.csv`, 30_000)), label);
    } catch {
      failed += 1;
      return { signals: [], routes: [] };
    }
  });
  const signals = parsed.flatMap((item) => item.signals);
  const routes = parsed.flatMap((item) => item.routes);
  status.ok = signals.length > 0;
  status.count = signals.length;
  status.note = signals.length
    ? `Mako sharks with satellite fixes since 2021${failed ? ` (${failed} projects unreachable)` : ""}. Tags report when the fin breaks the surface.`
    : "The GHRI tracker did not answer.";
  return { signals, routes, status };
}

/** RFC 4180-style CSV: quoted fields, doubled quotes, newlines inside quotes. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift()?.map((name) => name.trim()) ?? [];
  return rows.map((cells) =>
    Object.fromEntries(header.map((name, index) => [name, (cells[index] ?? "").trim()])),
  );
}

/** "4/22/2016 12:00:00 AM" plus an optional "11:03:00" time column, read as UTC. */
function fixTime(date: string, time: string): number | null {
  const day = date.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!day) return null;
  const clock = time.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  const ms = Date.UTC(
    Number(day[3]),
    Number(day[1]) - 1,
    Number(day[2]),
    clock ? Number(clock[1]) : 12,
    clock ? Number(clock[2]) : 0,
    clock?.[3] ? Number(clock[3]) : 0,
  );
  return Number.isFinite(ms) ? ms : null;
}

function readProject(
  rows: Record<string, string>[],
  label: string,
): { signals: Signal[]; routes: LiveRoute[] } {
  const bySharks = new Map<string, Record<string, string>[]>();
  for (const row of rows) {
    if (!row.shark) continue;
    bySharks.set(row.shark, [...(bySharks.get(row.shark) ?? []), row]);
  }
  const signals: Signal[] = [];
  const routes: LiveRoute[] = [];
  for (const [shark, fixes] of bySharks) {
    const points: (TrackPoint & { rough: boolean })[] = [];
    for (const row of fixes) {
      const lat = Number(row.latitude);
      const lng = Number(row.longitude);
      const ms = fixTime(row.date, row.time);
      const lc = row.LC.toUpperCase();
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || ms === null || lc === "Z") continue;
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) continue;
      points.push({ lat, lng, at: new Date(ms).toISOString(), rough: lc === "B" });
    }
    const firm = points.filter((point) => !point.rough);
    const kept = (firm.length >= 10 ? firm : points)
      .map(({ lat, lng, at }) => ({ lat, lng, at }))
      .sort((a, b) => (a.at < b.at ? -1 : 1));
    const last = kept[kept.length - 1];
    if (!last || Date.parse(last.at) < CUTOFF) continue;
    const first = fixes[0];
    const scientific = first.species || "Isurus oxyrinchus";
    const id = `ghri:${shark}`;
    const name = /^\d+$/.test(shark) ? `Tag ${shark}` : shark;
    signals.push({
      id,
      name,
      group: "shark",
      common: COMMON[scientific] ?? scientific,
      scientific,
      lat: last.lat,
      lng: last.lng,
      observedAt: last.at,
      source: "ghri",
      kind: "tag",
      place: label,
      sex: first.sex || null,
      length: first.size || null,
      weight: null,
      stage: null,
      image: null,
      url: first.url || SITE,
      tagId: null,
    });
    if (kept.length > 1) routes.push({ id, name, group: "shark", points: downsample(kept, 240) });
  }
  return { signals, routes };
}
