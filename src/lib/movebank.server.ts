import { asRecord, downsample, num, pool, str, fetchJson } from "./net.server";
import type { LiveRoute, Signal, SourceStatus, TrackPoint } from "./ocean.types";

/**
 * Movebank public tracks. Only studies whose owners allow anonymous track downloads answer
 * the public JSON service; the marine ones among them are finished studies, so these are
 * archived tracks, not live tags.
 */

const BASE = "https://www.movebank.org/movebank/service/public/json";
const TTL_MS = 6 * 3_600_000;
const PER_REQUEST = 8;

type Study = {
  id: number;
  label: string;
  sensor: "gps" | "argos-doppler-shift";
  /** Most recent individuals to read; large studies list hundreds of animals with no fixes. */
  take: number;
  fallbackTaxon: string;
};

const STUDIES: Study[] = [
  {
    id: 1606812667,
    label: "Hawksbill & green turtles, Chagos Archipelago",
    sensor: "gps",
    take: 40,
    fallbackTaxon: "Eretmochelys imbricata",
  },
  {
    id: 5831945257,
    label: "Atlantic walrus, Foxe Basin",
    sensor: "argos-doppler-shift",
    take: 40,
    fallbackTaxon: "Odobenus rosmarus",
  },
  {
    id: 1420256397,
    label: "Pacific walrus, USGS Alaska Science Center",
    sensor: "argos-doppler-shift",
    take: 32,
    fallbackTaxon: "Odobenus rosmarus",
  },
];

const COMMON: Record<string, string> = {
  "Eretmochelys imbricata": "Hawksbill turtle",
  "Chelonia mydas": "Green turtle",
  "Odobenus rosmarus": "Walrus",
};

export type MovebankData = { signals: Signal[]; routes: LiveRoute[]; status: SourceStatus };

let cache: { at: number; data: MovebankData } | null = null;
let inflight: Promise<MovebankData> | null = null;

export function loadMovebank(): Promise<MovebankData> {
  if (cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.data);
  if (inflight) return inflight;
  inflight = buildMovebank()
    .then((data) => {
      if (data.signals.length || !cache) cache = { at: Date.now(), data };
      return cache.data;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Whatever is cached right now, without waiting on Movebank. */
export function cachedMovebank(): MovebankData | null {
  return cache?.data ?? null;
}

async function buildMovebank(): Promise<MovebankData> {
  const status: SourceStatus = {
    id: "movebank",
    label: "Movebank archived study tracks",
    ok: false,
    count: 0,
    note: null,
  };
  const signals: Signal[] = [];
  const routes: LiveRoute[] = [];
  let failed = 0;
  for (const study of STUDIES) {
    try {
      const found = await readStudy(study);
      signals.push(...found.signals);
      routes.push(...found.routes);
    } catch {
      failed += 1;
    }
  }
  status.ok = signals.length > 0;
  status.count = signals.length;
  status.note = signals.length
    ? `Finished studies shared publicly on Movebank${failed ? ` (${failed} unreachable)` : ""}. These animals are no longer transmitting.`
    : "Movebank did not answer.";
  return { signals, routes, status };
}

async function readStudy(study: Study): Promise<{ signals: Signal[]; routes: LiveRoute[] }> {
  const listed = await fetchJson(`${BASE}?entity_type=individual&study_id=${study.id}`, 30_000);
  const ids = (Array.isArray(listed) ? listed : [])
    .map((row) => str(asRecord(row)?.local_identifier))
    .filter((id): id is string => id !== null)
    .slice(-study.take);
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += PER_REQUEST) chunks.push(ids.slice(index, index + PER_REQUEST));
  const batches = await pool(chunks, 3, async (chunk) => {
    const params = new URLSearchParams({ study_id: String(study.id), sensor_type: study.sensor });
    for (const id of chunk) params.append("individual_local_identifiers", id);
    try {
      return asRecord(await fetchJson(`${BASE}?${params}`, 40_000))?.individuals;
    } catch {
      return null;
    }
  });
  const signals: Signal[] = [];
  const routes: LiveRoute[] = [];
  for (const batch of batches) {
    for (const row of Array.isArray(batch) ? batch : []) {
      const animal = readIndividual(study, row);
      if (!animal) continue;
      signals.push(animal.signal);
      routes.push(animal.route);
    }
  }
  return { signals, routes };
}

function readIndividual(study: Study, value: unknown): { signal: Signal; route: LiveRoute } | null {
  const row = asRecord(value);
  const localId = str(row?.individual_local_identifier);
  const individualId = num(row?.individual_id);
  if (!row || !localId || individualId === null) return null;
  const points: TrackPoint[] = [];
  for (const item of Array.isArray(row.locations) ? row.locations : []) {
    const fix = asRecord(item);
    const lat = num(fix?.location_lat);
    const lng = num(fix?.location_long);
    const ms = num(fix?.timestamp);
    if (lat === null || lng === null || ms === null) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) continue;
    points.push({ lat, lng, at: new Date(ms).toISOString() });
  }
  if (!points.length) return null;
  points.sort((a, b) => (a.at < b.at ? -1 : 1));
  const last = points[points.length - 1];
  const scientific = str(row.individual_taxon_canonical_name) ?? study.fallbackTaxon;
  const common = COMMON[scientific] ?? scientific;
  const id = `movebank:${individualId}`;
  const signal: Signal = {
    id,
    name: `${common.split(" ")[0]} ${localId}`,
    group: "other",
    common,
    scientific,
    lat: last.lat,
    lng: last.lng,
    observedAt: last.at,
    source: "movebank",
    kind: "tag",
    place: study.label,
    sex: null,
    length: null,
    weight: null,
    stage: null,
    image: null,
    url: `https://www.movebank.org/cms/webapp?gwt_fragment=page=studies,path=study${study.id}`,
    tagId: null,
    archive: true,
  };
  return { signal, route: { id, name: signal.name, group: "other", points: downsample(points, 56) } };
}
