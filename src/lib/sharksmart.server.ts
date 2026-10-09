import { asRecord, fetchJson, num, str } from "./net.server";
import type { Signal, SourceStatus } from "./ocean.types";

/**
 * SharkSmart WA: the Western Australian government's shark activity feed. Satellite-linked
 * receivers report acoustically tagged sharks swimming past, and Surf Life Saving WA and the
 * Water Police log verified sightings. `date_range=03` asks for the last 30 days.
 */

const FEED = "https://www.sharksmart.com.au/shark-activity/detection-feed?date_range=03";
const PAGE = "https://www.sharksmart.com.au/shark-activity/";
const TTL_MS = 5 * 60_000;

const SPECIES: Record<string, { common: string; scientific: string }> = {
  white: { common: "White shark", scientific: "Carcharodon carcharias" },
  "bronze whaler": { common: "Bronze whaler shark", scientific: "Carcharhinus brachyurus" },
  tiger: { common: "Tiger shark", scientific: "Galeocerdo cuvier" },
  bull: { common: "Bull shark", scientific: "Carcharhinus leucas" },
  hammerhead: { common: "Hammerhead shark", scientific: "Sphyrnidae" },
  blacktip: { common: "Blacktip shark", scientific: "Carcharhinus limbatus" },
  mako: { common: "Mako shark", scientific: "Isurus oxyrinchus" },
  dusky: { common: "Dusky shark", scientific: "Carcharhinus obscurus" },
  "unknown sp.": { common: "Shark, species unknown", scientific: "" },
};

let cache: { at: number; data: { signals: Signal[]; status: SourceStatus } } | null = null;

export async function loadSharkSmart(): Promise<{ signals: Signal[]; status: SourceStatus }> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  const status: SourceStatus = {
    id: "sharksmart",
    label: "SharkSmart WA detections & sightings",
    ok: false,
    count: 0,
    note: null,
  };
  try {
    const feed = asRecord(await fetchJson(FEED, 15_000))?.feed;
    const signals = (Array.isArray(feed) ? feed : []).flatMap(readPlace);
    const sightings = signals.filter((signal) => signal.kind === "sighting").length;
    const receivers = new Set(
      signals.filter((signal) => signal.kind === "tag").map((signal) => signal.place),
    ).size;
    status.ok = true;
    status.count = signals.length;
    status.note = `Last 30 days off Western Australia: ${receivers} receivers heard tagged sharks, plus ${sightings} logged sightings.`;
    cache = { at: Date.now(), data: { signals, status } };
    return cache.data;
  } catch (error) {
    if (cache) return cache.data;
    status.note = error instanceof Error ? error.message : "SharkSmart unreachable";
    return { signals: [], status };
  }
}

type Report = { text: string; at: number; species: string };

function readPlace(value: unknown): Signal[] {
  const row = asRecord(value);
  const lat = num(row?.latitude);
  const lng = num(row?.longitude);
  const location = str(row?.location);
  const type = str(row?.type);
  if (
    !row ||
    lat === null ||
    lng === null ||
    !location ||
    (type !== "detection" && type !== "sighting")
  )
    return [];
  const reports: Report[] = [];
  for (const item of Array.isArray(row.list) ? row.list : []) {
    if (!Array.isArray(item)) continue;
    const meta = asRecord(item[1]);
    const at = num(meta?.timestamp);
    const species = str(meta?.species)?.toLowerCase();
    if (at === null || !species || !SPECIES[species]) continue;
    reports.push({ text: str(item[0]) ?? "", at, species });
  }
  if (type === "sighting") return reports.map((report) => sighting(report, location, lat, lng));
  // A receiver logs every pass; fold them into one marker per species at that receiver.
  const bySpecies = new Map<string, Report[]>();
  for (const report of reports)
    bySpecies.set(report.species, [...(bySpecies.get(report.species) ?? []), report]);
  return [...bySpecies.entries()].map(([species, passes]) =>
    detection(species, passes, location, lat, lng),
  );
}

function base(species: string, lat: number, lng: number, at: number) {
  const known = SPECIES[species];
  return {
    group: "shark" as const,
    common: known.common,
    scientific: known.scientific,
    lat,
    lng,
    observedAt: new Date(at * 1000).toISOString(),
    source: "sharksmart" as const,
    sex: null,
    length: null,
    weight: null,
    stage: null,
    image: null,
    url: PAGE,
    tagId: null,
  };
}

function sighting(report: Report, location: string, lat: number, lng: number): Signal {
  const size = report.text.match(/(\d+(?:\.\d+)?)\s*m\b/)?.[1];
  const known = SPECIES[report.species];
  return {
    ...base(report.species, lat, lng, report.at),
    id: `sharksmart:sighting:${location}:${report.at}:${report.species}`,
    name: `${known.common.replace(/, species unknown$/, "")} sighting`,
    kind: "sighting",
    place: location,
    length: size ? `${size} m (estimated)` : null,
    note: report.text || null,
  };
}

function detection(
  species: string,
  passes: Report[],
  location: string,
  lat: number,
  lng: number,
): Signal {
  const latest = passes.reduce((a, b) => (b.at > a.at ? b : a));
  const known = SPECIES[species];
  return {
    ...base(species, lat, lng, latest.at),
    id: `sharksmart:receiver:${location}:${species}`,
    name: `Tagged ${known.common.toLowerCase().replace(/, species unknown$/, "")}`,
    kind: "tag",
    place: `${location} receiver`,
    note: `${passes.length} pass${passes.length === 1 ? "" : "es"} logged by the ${location} receiver in the last 30 days. The receiver hears tagged sharks within about 500 m.`,
  };
}
