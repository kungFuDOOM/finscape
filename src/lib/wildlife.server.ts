import { asRecord, downsample, num, pool, retry, str } from "./net.server";
import type { LiveRoute, Signal, SourceStatus, TrackPoint } from "./ocean.types";

/**
 * Whale tags on Wildlife Computers' public live maps. Research groups share these maps from
 * the tag maker's portal; each one answers a POST with every deployment and its Argos fixes.
 */

const ENDPOINT = "https://my.wildlifecomputers.com/data/map/data/";
const TTL_MS = 15 * 60_000;
const UA = "FinScape/1.0 (educational live ocean map)";

type Project = {
  map: string;
  label: string;
  common: string;
  scientific: string;
  url: string;
};

const SIGUIENDO = "https://siguiendoballenas.org/en/home/";
const FALKLANDS_RIGHT = "https://falklandsconservation.com/southern-right-whale-tracking-2024/";
const FALKLANDS_RIGHT_2022 = "https://falklandsconservation.com/southern-right-whale-tracking/";
const FALKLANDS_SEI = "https://falklandsconservation.com/sei-whale-tracking/";
const RIGHT = { common: "Southern right whale", scientific: "Eubalaena australis" };
const SEI = { common: "Sei whale", scientific: "Balaenoptera borealis" };
const AUCKLAND = "https://www.auckland.ac.nz/en/news/2020/09/22/whale-watching-by-satellite.html";

const PROJECTS: Project[] = [
  {
    map: "68bd7aabb9096e3826037813",
    label: "Siguiendo Ballenas, Península Valdés",
    url: SIGUIENDO,
    ...RIGHT,
  },
  {
    map: "6a39b79dabaa093aeb0d5faa",
    label: "Falklands Conservation, 2026",
    url: FALKLANDS_RIGHT,
    ...RIGHT,
  },
  {
    map: "68710ce8b83ea1fedd0f9395",
    label: "Falklands Conservation, 2025",
    url: FALKLANDS_RIGHT,
    ...RIGHT,
  },
  {
    map: "6679b5370abb7c76700530b3",
    label: "Falklands Conservation, 2024",
    url: FALKLANDS_RIGHT,
    ...RIGHT,
  },
  {
    map: "62c6c4de2c72b05682056671",
    label: "Falklands Conservation, 2022",
    url: FALKLANDS_RIGHT_2022,
    ...RIGHT,
  },
  {
    map: "62d010762c72b00279709493",
    label: "Falklands Conservation, 2022",
    url: FALKLANDS_RIGHT_2022,
    ...RIGHT,
  },
  {
    map: "62c7145a2c72b065f25850d9",
    label: "Falklands Conservation, 2022",
    url: FALKLANDS_SEI,
    ...SEI,
  },
  {
    map: "640b101531af5906fb66f3c7",
    label: "Falklands Conservation, 2023",
    url: FALKLANDS_SEI,
    ...SEI,
  },
  // Tagged at Port Ross, Auckland Islands, in July 2021: the tohorā winter calving ground.
  {
    map: "6122b0b331af59632b69ac3c",
    label: "Auckland Islands tohorā, 2021",
    url: AUCKLAND,
    ...RIGHT,
  },
];

export type WhaleTags = { signals: Signal[]; routes: LiveRoute[]; status: SourceStatus };

let cache: { at: number; data: WhaleTags } | null = null;
let inflight: Promise<WhaleTags> | null = null;

export function loadWhaleTags(): Promise<WhaleTags> {
  if (cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.data);
  if (inflight) return inflight;
  inflight = buildWhaleTags()
    .then((data) => {
      // Keep the last good read when a refresh comes back empty.
      if (data.signals.length || !cache) cache = { at: Date.now(), data };
      return cache.data;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

async function readMap(id: string): Promise<unknown[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45_000);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": UA,
      },
      body: `data=${encodeURIComponent(JSON.stringify({ id }))}`,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const deployments = asRecord(await res.json())?.deployments;
    return Array.isArray(deployments) ? deployments : [];
  } finally {
    clearTimeout(timer);
  }
}

async function buildWhaleTags(): Promise<WhaleTags> {
  const status: SourceStatus = {
    id: "wildlife",
    label: "Whale satellite tags (Wildlife Computers)",
    ok: false,
    count: 0,
    note: null,
  };
  let failed = 0;
  let reason = "";
  const maps = await pool(PROJECTS, 3, async (project) => {
    try {
      return { project, deployments: await retry(3, () => readMap(project.map)) };
    } catch (error) {
      failed += 1;
      reason ||= error instanceof Error ? error.message : String(error);
      return { project, deployments: [] as unknown[] };
    }
  });
  const signals: Signal[] = [];
  const routes: LiveRoute[] = [];
  const seen = new Set<string>();
  for (const { project, deployments } of maps) {
    for (const deployment of deployments) {
      const whale = readDeployment(project, deployment);
      if (!whale || seen.has(whale.signal.id)) continue;
      seen.add(whale.signal.id);
      signals.push(whale.signal);
      if (whale.route.points.length > 1) routes.push(whale.route);
    }
  }
  const live = signals.filter(
    (signal) => Date.now() - Date.parse(signal.observedAt) < 2 * 86_400_000,
  ).length;
  status.ok = signals.length > 0;
  status.count = signals.length;
  status.note = signals.length
    ? `Southern right and sei whales tagged off Argentina, the Falklands and New Zealand; ${live} uplinked in the last 2 days${failed ? `, ${failed} maps unreachable (${reason})` : ""}. Argos fixes can be off by several km.`
    : "The tag maps did not answer.";
  return { signals, routes, status };
}

/** Argos class Z fixes are unusable; class B is rough, so drop it when better fixes exist. */
function goodFixes(rows: unknown[]): TrackPoint[] {
  const all: (TrackPoint & { rough: boolean })[] = [];
  for (const row of rows) {
    const fix = asRecord(row);
    const lat = num(fix?.latitude);
    const lng = num(fix?.longitude);
    const seconds = num(fix?.date);
    const notes = str(fix?.notes) ?? "";
    if (lat === null || lng === null || seconds === null || /class z/i.test(notes)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) continue;
    all.push({
      lat,
      lng,
      at: new Date(seconds * 1000).toISOString(),
      rough: /class b/i.test(notes),
    });
  }
  const firm = all.filter((point) => !point.rough);
  const kept = firm.length >= 10 ? firm : all;
  return kept.map(({ lat, lng, at }) => ({ lat, lng, at })).sort((a, b) => (a.at < b.at ? -1 : 1));
}

function readDeployment(
  project: Project,
  value: unknown,
): { signal: Signal; route: LiveRoute } | null {
  const row = asRecord(value);
  const oid = str(asRecord(row?.["_id"])?.["$oid"]);
  if (!row || !oid) return null;
  const points = goodFixes(Array.isArray(row.locations) ? row.locations : []);
  if (!points.length) return null;
  const last = points[points.length - 1];
  const name = (str(row.title) ?? "Unnamed").replace(/^(Name|Deploy Id):\s*/i, "");
  const id = `wildlife:${oid}`;
  const signal: Signal = {
    id,
    name,
    group: "whale",
    common: project.common,
    scientific: project.scientific,
    lat: last.lat,
    lng: last.lng,
    observedAt: last.at,
    source: "wildlife",
    kind: "tag",
    place: project.label,
    sex: null,
    length: null,
    weight: null,
    stage: null,
    image: null,
    url: project.url,
    tagId: null,
  };
  return { signal, route: { id, name, group: "whale", points: downsample(points, 240) } };
}
