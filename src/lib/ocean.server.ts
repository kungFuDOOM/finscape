import type { Feed, Group, LiveRoute, Signal, SourceStatus, Track, TrackPoint } from "./ocean.types";
import { loadAcoustic } from "./whoi.server";

const UA = "FinScape/1.0 (educational live ocean map)";
const MAP_ID = 3413;
const MAPOTIC = `https://www.mapotic.com/api/v1/maps/${MAP_ID}`;
const TTL_MS = 75_000;
// A forced refresh still waits this long, so many open tabs share one upstream pull.
const FRESH_FLOOR_MS = 30_000;
// Research-grade sightings change slowly and cost ~24 iNaturalist calls per pull.
const SIGHTING_TTL_MS = 15 * 60_000;
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

// Either fixed iNaturalist taxon ids, or taxon names resolved to ids once at runtime.
const TAXA: Array<{ group: Group; taxon?: string; names?: string[] }> = [
  { group: "whale", taxon: "424321,41434,41401,41457" },
  { group: "dolphin", taxon: "41479" },
  { group: "shark", taxon: "551307" },
  { group: "turtle", names: ["Cheloniidae", "Dermochelyidae"] },
  { group: "seal", names: ["Phocidae", "Otariidae", "Odobenidae"] },
];
const resolvedTaxa = new Map<Group, string>();

type Cache = { at: number; data: Feed };
let cache: Cache | null = null;
let inflight: Promise<Feed> | null = null;
let sightingCache: { at: number; data: InatResult } | null = null;
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
  const byId = new Map<string, LiveRoute>();
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
  if (!Array.isArray(value)) return [];
  const points: TrackPoint[] = [];
  for (const row of value) {
    const item = asRecord(row);
    const point = asRecord(item?.point);
    const coords = Array.isArray(point?.coordinates) ? point.coordinates : [];
    const lng = num(coords[0]);
    const lat = num(coords[1]);
    const at = str(item?.dt_move);
    if (lng === null || lat === null || !at) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    points.push({ lat, lng, at });
  }
  points.sort((a, b) => (a.at < b.at ? -1 : 1));
  return downsample(points, 56);
}

export function loadSignals(fresh = false): Promise<Feed> {
  const age = cache ? Date.now() - cache.at : Infinity;
  if (cache && age < (fresh ? FRESH_FLOOR_MS : TTL_MS)) return Promise.resolve(cache.data);
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
            id: "inaturalist",
            label: "iNaturalist research-grade sightings",
            ok: false,
            count: 0,
            note,
          },
          { id: "whoi", label: "WHOI whale-listening buoys", ok: false, count: 0, note },
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
  const [tags, sightings, heard] = await Promise.all([fetchOcearch(), loadSightings(since), loadAcoustic()]);
  const signals = [...tags.signals, ...sightings.signals, ...heard.signals].sort((a, b) =>
    a.observedAt < b.observedAt ? 1 : -1,
  );
  return {
    fetchedAt: new Date().toISOString(),
    signals,
    sources: [tags.status, sightings.status, heard.status],
  };
}

async function loadSightings(since: string): Promise<InatResult> {
  if (sightingCache && Date.now() - sightingCache.at < SIGHTING_TTL_MS) return sightingCache.data;
  const next = await fetchInat(since);
  if (next.status.ok) {
    sightingCache = { at: Date.now(), data: next };
    return next;
  }
  // Keep the last good batch when iNaturalist stumbles, and retry in ~2 minutes, not every pull.
  const retryAt = Date.now() - SIGHTING_TTL_MS + 2 * 60_000;
  sightingCache = { at: retryAt, data: sightingCache?.data ?? next };
  return sightingCache.data;
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "application/json", "Accept-Language": "en", "User-Agent": UA },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
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
      : "No published marine tags in the feed.";
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
    url: slug ? `https://www.ocearch.org/tracker/detail/${slug}` : "https://www.ocearch.org/tracker/",
    tagId: id,
    credit: "OCEARCH",
    note: null,
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
  if (/turtle|ridley|loggerhead|leatherback|hawksbill/.test(blob)) return "turtle";
  if (/\bseals?\b|sea lion|walrus/.test(blob)) return "seal";
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
  const taxonIds = new Map<Group, string>();
  await Promise.all(
    TAXA.map(async (taxa) => {
      const id = taxa.taxon ?? (await resolveTaxa(taxa.group, taxa.names ?? []));
      if (id) taxonIds.set(taxa.group, id);
    }),
  );
  const jobs: Array<{ group: Group; theater: string }> = [];
  for (const group of taxonIds.keys()) {
    for (const theater of THEATERS) jobs.push({ group, theater: theater[0] });
  }
  let failed = 0;
  const seen = new Set<string>();
  const signals: Signal[] = [];
  const rows = await pool(jobs, 8, async (job) => {
    const taxon = taxonIds.get(job.group);
    const box = THEATERS.find((item) => item[0] === job.theater);
    if (!taxon || !box) return [];
    try {
      return await fetchInatBox(job.group, taxon, box, since);
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
  status.ok = jobs.length > 0 && (signals.length > 0 || failed < jobs.length);
  status.count = signals.length;
  status.note =
    !jobs.length || failed === jobs.length
      ? "iNaturalist did not answer."
      : failed > 0
        ? `${failed} ocean sectors timed out. Showing the rest. Obscured coordinates are dropped.`
        : "Latest research-grade, non-obscured sightings in each ocean, refreshed from the public API.";
  if (failed === jobs.length) status.ok = false;
  return { signals, status };
}

/** Looks up iNaturalist ids for taxon names (exact, active matches only); remembered once found. */
async function resolveTaxa(group: Group, names: string[]): Promise<string | null> {
  const known = resolvedTaxa.get(group);
  if (known) return known;
  const ids: number[] = [];
  await Promise.all(
    names.map(async (name) => {
      try {
        const params = new URLSearchParams({ q: name, is_active: "true", per_page: "10" });
        const data = await fetchJson(`https://api.inaturalist.org/v1/taxa?${params}`, 10_000);
        const results = Array.isArray(asRecord(data)?.results) ? (asRecord(data)!.results as unknown[]) : [];
        for (const result of results) {
          const row = asRecord(result);
          const id = num(row?.id);
          if (id !== null && str(row?.name)?.toLowerCase() === name.toLowerCase()) {
            ids.push(id);
            break;
          }
        }
      } catch {
        /* that family stays out until the next pull */
      }
    }),
  );
  if (!ids.length) return null;
  const joined = ids.sort((a, b) => a - b).join(",");
  // Only remember a complete lookup, so a partial one is retried.
  if (ids.length === names.length) resolvedTaxa.set(group, joined);
  return joined;
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
      "id,species_guess,location,observed_on,time_observed_at,place_guess,uri,obscured,geoprivacy,taxon.name,taxon.preferred_common_name,photos.url,user.login",
  });
  const data = await fetchJson(`https://api.inaturalist.org/v2/observations?${params}`, 12_000);
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
  const observedAt = str(row.time_observed_at) ?? (str(row.observed_on) ? `${str(row.observed_on)}T00:00:00Z` : null);
  if (!observedAt) return null;
  const photos = Array.isArray(row.photos) ? row.photos : [];
  const thumb = str(asRecord(photos[0])?.url);
  // iNaturalist hands back the square thumbnail; the medium size suits the dossier.
  const image = thumb ? thumb.replace("/square.", "/medium.") : null;
  const login = str(asRecord(row.user)?.login);
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
    image,
    url: str(row.uri) ?? `https://www.inaturalist.org/observations/${id}`,
    tagId: null,
    credit: login ? `@${login} on iNaturalist` : "iNaturalist",
    note: null,
  };
}

async function fetchTrack(tagId: number): Promise<Track> {
  try {
    const data = await fetchJson(`${MAPOTIC}/pois/${tagId}/motion/with-meta/`, 20_000);
    const root = asRecord(data);
    const motion = Array.isArray(root?.motion) ? root.motion : [];
    const points: TrackPoint[] = [];
    for (const row of motion) {
      const item = asRecord(row);
      const point = asRecord(item?.point);
      const coords = Array.isArray(point?.coordinates) ? point.coordinates : [];
      const lng = num(coords[0]);
      const lat = num(coords[1]);
      const at = str(item?.dt_move);
      if (lng === null || lat === null || !at) continue;
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
      points.push({ lat, lng, at });
    }
    points.sort((a, b) => (a.at < b.at ? -1 : 1));
    return { tagId, points: downsample(points, 420), error: null };
  } catch (error) {
    return {
      tagId,
      points: [],
      error: error instanceof Error ? error.message : "Track unavailable",
    };
  }
}

function downsample(points: TrackPoint[], max: number): TrackPoint[] {
  if (points.length <= max) return points;
  const tailCount = Math.min(12, Math.floor(max / 3));
  const tail = points.slice(-tailCount);
  const head = points.slice(0, -tailCount);
  const budget = Math.max(1, max - tail.length);
  if (head.length <= budget) return [...head, ...tail];
  const step = Math.ceil(head.length / budget);
  const kept = head.filter((_, index) => index % step === 0);
  return [...kept, ...tail];
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await fn(items[index]);
    }
  }
  const workers = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}
