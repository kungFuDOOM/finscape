import { loadAcartia } from "./acartia.server";
import { loadGhri } from "./ghri.server";
import { downsample, MAPOTIC, motionPoints, readTrack, trackUrl } from "./motion";
import { asRecord, byNewest, fetchJson, num, pool, retry, str } from "./net.server";
import type {
  Feed,
  Group,
  LiveRoute,
  Signal,
  SourceStatus,
  Track,
  TrackPoint,
} from "./ocean.types";
import { loadWhoi } from "./whoi.server";
import { loadSharkSmart } from "./sharksmart.server";
import { loadWhaleTags } from "./wildlife.server";

const TTL_MS = 75_000;
const INAT_PAGE = 60;

const THEATERS: Array<[string, number, number, number, number]> = [
  ["ne-pacific", 18, -179, 66, -120],
  ["central-pacific", -25, -179, 22, -130],
  ["se-pacific", -56, -160, 18, -68],
  ["nw-atlantic", 22, -98, 66, -40],
  ["sw-atlantic", -55, -68, 22, 18],
  ["ne-atlantic", 34, -28, 72, 40],
  ["indian", -42, 18, 28, 100],
  ["west-pacific", -48, 100, 45, 179],
];

const TAXA: Array<{ group: Group; taxon: string }> = [
  { group: "whale", taxon: "424321,41434,41401,41457" },
  { group: "dolphin", taxon: "41479" },
  { group: "shark", taxon: "551307" },
];

type Cache = { at: number; data: Feed };
let cache: Cache | null = null;
let inflight: Promise<Feed> | null = null;
const trackCache = new Map<number, { at: number; data: Track }>();
let routeCache: { at: number; data: LiveRoute[] } | null = null;
let routeInflight: Promise<LiveRoute[]> | null = null;
let archiveRoutes: { at: number; data: LiveRoute[] } | null = null;

export function loadLiveRoutes(fresh = false): Promise<LiveRoute[]> {
  const age = routeCache ? Date.now() - routeCache.at : Infinity;
  if (routeCache && age < (fresh ? 20_000 : 40_000)) return Promise.resolve(routeCache.data);
  if (routeInflight) return routeInflight;
  routeInflight = buildLiveRoutes()
    .then((data) => {
      routeCache = { at: Date.now(), data };
      routeInflight = null;
      return data;
    })
    .catch(() => {
      routeInflight = null;
      return routeCache?.data ?? [];
    });
  return routeInflight;
}

async function buildLiveRoutes(): Promise<LiveRoute[]> {
  const feed = await loadSignals(false);
  const tags = feed.signals.filter((signal) => signal.kind === "tag" && signal.tagId);
  const cutoff = Date.now() - 120 * 86_400_000;
  const recent = tags.filter((signal) => Date.parse(signal.observedAt) >= cutoff);
  const older = tags.filter((signal) => Date.parse(signal.observedAt) < cutoff);
  const recentRoutes = await fetchMotionRoutes(recent);
  let olderRoutes: LiveRoute[] = [];
  if (archiveRoutes && Date.now() - archiveRoutes.at < 30 * 60_000) {
    olderRoutes = archiveRoutes.data;
  } else {
    olderRoutes = await fetchMotionRoutes(older);
    archiveRoutes = { at: Date.now(), data: olderRoutes };
  }
  const [whales, makos] = await Promise.all([
    loadWhaleTags().catch(() => null),
    loadGhri().catch(() => null),
  ]);
  const byId = new Map<string, LiveRoute>();
  for (const route of [...(whales?.routes ?? []), ...(makos?.routes ?? [])])
    byId.set(route.id, route);
  for (const route of olderRoutes) byId.set(route.id, route);
  for (const route of recentRoutes) byId.set(route.id, route);
  return [...byId.values()];
}

async function fetchMotionRoutes(tags: Signal[]): Promise<LiveRoute[]> {
  if (!tags.length) return [];
  const chunks: Signal[][] = [];
  for (let index = 0; index < tags.length; index += 20) chunks.push(tags.slice(index, index + 20));
  const routes: LiveRoute[] = [];
  await pool(chunks, 4, async (slice) => {
    const ids = slice.map((signal) => signal.tagId).join(",");
    try {
      const data = await fetchJson(`${MAPOTIC}/pois/motions/?poi=${ids}`, 20_000);
      const root = asRecord(data);
      if (!root) return;
      for (const signal of slice) {
        const id = signal.tagId;
        if (!id) continue;
        const points = parseMotion(root[String(id)]);
        if (points.length < 2) continue;
        routes.push({ id: signal.id, name: signal.name, group: signal.group, points });
      }
    } catch {
      /* one batch failing should not drop the rest */
    }
  });
  return routes;
}

function parseMotion(value: unknown): TrackPoint[] {
  return downsample(motionPoints(value), 56);
}

export function loadSignals(fresh = false): Promise<Feed> {
  if (!fresh && cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.data);
  if (inflight) return inflight;
  inflight = buildFeed()
    .then((data) => {
      cache = { at: Date.now(), data };
      inflight = null;
      return data;
    })
    .catch((error: unknown) => {
      inflight = null;
      const note = error instanceof Error ? error.message : "Feed failed";
      const empty: Feed = {
        fetchedAt: new Date().toISOString(),
        signals: [],
        sources: [
          { id: "ocearch", label: "OCEARCH satellite tags", ok: false, count: 0, note },
          {
            id: "wildlife",
            label: "Whale satellite tags (Wildlife Computers)",
            ok: false,
            count: 0,
            note,
          },
          {
            id: "ghri",
            label: "Guy Harvey Research Institute shark tags",
            ok: false,
            count: 0,
            note,
          },
          {
            id: "sharksmart",
            label: "SharkSmart WA detections & sightings",
            ok: false,
            count: 0,
            note,
          },
          {
            id: "acartia",
            label: "Acartia live sightings (Pacific Northwest)",
            ok: false,
            count: 0,
            note,
          },
          {
            id: "whoi",
            label: "WHOI Robots4Whales listening platforms",
            ok: false,
            count: 0,
            note,
          },
          {
            id: "inaturalist",
            label: "iNaturalist research-grade sightings",
            ok: false,
            count: 0,
            note,
          },
        ],
      };
      return empty;
    });
  return inflight;
}

export async function loadTrack(tagId: number): Promise<Track> {
  const hit = trackCache.get(tagId);
  if (hit && Date.now() - hit.at < 40_000) return hit.data;
  const track = await fetchTrack(tagId);
  trackCache.set(tagId, { at: Date.now(), data: track });
  if (trackCache.size > 24) {
    const oldest = [...trackCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) trackCache.delete(oldest[0]);
  }
  return track;
}

async function buildFeed(): Promise<Feed> {
  const since = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);
  const [tags, whales, makos, wa, live, sightings, heard] = await Promise.all([
    fetchOcearch(),
    settle("wildlife", "Whale satellite tags (Wildlife Computers)", loadWhaleTags()),
    settle("ghri", "Guy Harvey Research Institute shark tags", loadGhri()),
    settle("sharksmart", "SharkSmart WA detections & sightings", loadSharkSmart()),
    settle("acartia", "Acartia live sightings (Pacific Northwest)", loadAcartia()),
    fetchInat(since),
    settle("whoi", "WHOI Robots4Whales listening platforms", loadWhoi()),
  ]);
  const parts = [tags, whales, makos, wa, heard, live, sightings];
  return {
    fetchedAt: new Date().toISOString(),
    signals: parts.flatMap((part) => part.signals).sort(byNewest),
    sources: parts.map((part) => part.status),
  };
}

/** A source that throws still reports itself, empty and marked down, instead of sinking the feed. */
function settle(
  id: SourceStatus["id"],
  label: string,
  load: Promise<{ signals: Signal[]; status: SourceStatus }>,
): Promise<{ signals: Signal[]; status: SourceStatus }> {
  return load.catch((error: unknown) => ({
    signals: [],
    status: {
      id,
      label,
      ok: false,
      count: 0,
      note: error instanceof Error ? error.message : `${label} unreachable`,
    },
  }));
}

async function fetchOcearch(): Promise<{ signals: Signal[]; status: SourceStatus }> {
  const status: SourceStatus = {
    id: "ocearch",
    label: "OCEARCH satellite tags",
    ok: false,
    count: 0,
    note: null,
  };
  try {
    const data = await fetchJson(`${MAPOTIC}/pois.geojson/`, 18_000);
    const root = asRecord(data);
    const features = Array.isArray(root?.features) ? root.features : [];
    const signals: Signal[] = [];
    for (const feature of features) {
      const signal = ocearchFeature(feature);
      if (signal) signals.push(signal);
    }
    status.ok = true;
    status.count = signals.length;
    status.note = signals.length
      ? "Pings when a tag breaks the surface. Positions are last known, not a continuous fix."
      : "No published shark or dolphin tags in the feed.";
    return { signals, status };
  } catch (error) {
    status.note = error instanceof Error ? error.message : "OCEARCH unreachable";
    return { signals: [], status };
  }
}

function ocearchFeature(feature: unknown): Signal | null {
  const row = asRecord(feature);
  const geometry = asRecord(row?.geometry);
  const props = asRecord(row?.properties);
  if (!row || !geometry || !props || props.is_published === false) return null;
  const coords = Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
  const lng = num(coords[0]);
  const lat = num(coords[1]);
  if (lng === null || lat === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const category = categoryName(props.category_name);
  const speciesRaw = str(props.species) ?? "";
  const group = classifyOcearch(category, speciesRaw);
  if (!group) return null;
  const { common, scientific } = splitSpecies(speciesRaw || category);
  const id = num(props.id);
  if (id === null) return null;
  const observedAt = str(props.last_move_datetime) ?? str(props.zping_datetime);
  if (!observedAt) return null;
  const slug = str(props.slug);
  return {
    id: `ocearch:${id}`,
    name: str(props.name) ?? common,
    group,
    common,
    scientific,
    lat,
    lng,
    observedAt,
    source: "ocearch",
    kind: "tag",
    place: str(props.tag_location),
    sex: str(props.gender),
    length: str(props.length),
    weight: str(props.weight),
    stage: str(props.stage_of_life),
    image: str(props.image),
    url: slug
      ? `https://www.ocearch.org/tracker/detail/${slug}`
      : "https://www.ocearch.org/tracker/",
    tagId: id,
  };
}

function categoryName(value: unknown): string {
  if (typeof value === "string") return value;
  const row = asRecord(value);
  return str(row?.en) ?? "";
}

function classifyOcearch(category: string, species: string): Group | null {
  const blob = `${category} ${species}`.toLowerCase();
  if (blob.includes("whale shark")) return "shark";
  if (
    blob.includes("dolphin") ||
    blob.includes("pilot whale") ||
    blob.includes("orca") ||
    blob.includes("porpoise")
  ) {
    return "dolphin";
  }
  if (blob.includes("shark")) return "shark";
  if (blob.includes("whale")) return "whale";
  return null;
}

function splitSpecies(raw: string): { common: string; scientific: string } {
  const match = raw.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (match) return { common: match[1].trim(), scientific: match[2].trim() };
  return { common: raw.trim() || "Unknown", scientific: "" };
}

type InatResult = {
  signals: Signal[];
  status: SourceStatus;
};

async function fetchInat(since: string): Promise<InatResult> {
  const status: SourceStatus = {
    id: "inaturalist",
    label: "iNaturalist research-grade sightings",
    ok: false,
    count: 0,
    note: null,
  };
  const jobs: Array<{ group: Group; theater: string }> = [];
  for (const taxa of TAXA) {
    for (const theater of THEATERS) jobs.push({ group: taxa.group, theater: theater[0] });
  }
  let failed = 0;
  const seen = new Set<string>();
  const signals: Signal[] = [];
  // iNaturalist asks for about one request a second; four at a time with retries stays polite.
  const rows = await pool(jobs, 4, async (job) => {
    const taxa = TAXA.find((item) => item.group === job.group);
    const box = THEATERS.find((item) => item[0] === job.theater);
    if (!taxa || !box) return [];
    try {
      return await retry(2, () => fetchInatBox(taxa.group, taxa.taxon, box, since));
    } catch {
      failed += 1;
      return [];
    }
  });
  for (const batch of rows) {
    for (const signal of batch) {
      if (seen.has(signal.id)) continue;
      seen.add(signal.id);
      signals.push(signal);
    }
  }
  status.ok = signals.length > 0 || failed < jobs.length;
  status.count = signals.length;
  status.note =
    failed === jobs.length
      ? "iNaturalist did not answer."
      : failed > 0
        ? `${failed} ocean sectors timed out. Showing the rest. Obscured coordinates are dropped.`
        : "Latest research-grade, non-obscured sightings in each ocean, refreshed from the public API.";
  if (failed === jobs.length) status.ok = false;
  return { signals, status };
}

async function fetchInatBox(
  group: Group,
  taxon: string,
  box: [string, number, number, number, number],
  since: string,
): Promise<Signal[]> {
  const params = new URLSearchParams({
    taxon_id: taxon,
    geo: "true",
    captive: "false",
    quality_grade: "research",
    per_page: String(INAT_PAGE),
    order_by: "observed_on",
    order: "desc",
    d1: since,
    swlat: String(box[1]),
    swlng: String(box[2]),
    nelat: String(box[3]),
    nelng: String(box[4]),
    fields:
      "id,species_guess,location,observed_on,time_observed_at,place_guess,uri,obscured,geoprivacy,taxon.name,taxon.preferred_common_name",
  });
  const data = await fetchJson(`https://api.inaturalist.org/v2/observations?${params}`, 20_000);
  const root = asRecord(data);
  const results = Array.isArray(root?.results) ? root.results : [];
  const signals: Signal[] = [];
  for (const result of results) {
    const signal = inatObservation(group, result);
    if (signal) signals.push(signal);
  }
  return signals;
}

function inatObservation(group: Group, value: unknown): Signal | null {
  const row = asRecord(value);
  if (!row || row.obscured === true) return null;
  const privacy = str(row.geoprivacy);
  if (privacy === "obscured" || privacy === "private") return null;
  const id = num(row.id);
  const location = str(row.location);
  if (id === null || !location) return null;
  const [latRaw, lngRaw] = location.split(",");
  const lat = num(latRaw);
  const lng = num(lngRaw);
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (lat === 0 && lng === 0) return null;
  const taxon = asRecord(row.taxon);
  const scientific = str(taxon?.name) ?? "";
  const common =
    str(taxon?.preferred_common_name) ?? str(row.species_guess) ?? (scientific || "Unknown");
  const observedAt =
    str(row.time_observed_at) ??
    (str(row.observed_on) ? `${str(row.observed_on)}T00:00:00Z` : null);
  if (!observedAt) return null;
  return {
    id: `inat:${id}`,
    name: common,
    group,
    common,
    scientific,
    lat,
    lng,
    observedAt,
    source: "inaturalist",
    kind: "sighting",
    place: str(row.place_guess),
    sex: null,
    length: null,
    weight: null,
    stage: null,
    image: null,
    url: str(row.uri) ?? `https://www.inaturalist.org/observations/${id}`,
    tagId: null,
  };
}

async function fetchTrack(tagId: number): Promise<Track> {
  try {
    return readTrack(tagId, await fetchJson(trackUrl(tagId), 20_000));
  } catch (error) {
    return {
      tagId,
      points: [],
      error: error instanceof Error ? error.message : "Track unavailable",
    };
  }
}
