import type { Signal, SourceStatus } from "./ocean.types";

// WHOI's Robots4Whales buoys and gliders listen for baleen whale calls; analysts review each
// 15-minute period and publish the results as plain HTML, usually within a day.
const HOME = "https://robots4whales.whoi.edu/";
const UA = "FinScape/1.0 (educational live ocean map)";
const PLATFORMS_TTL_MS = 6 * 3_600_000;
const DETECTIONS_TTL_MS = 30 * 60_000;
// A platform counts as live when its newest analyst review is this recent.
const ACTIVE_WITHIN_MS = 4 * 86_400_000;
// Calls heard within this window become map markers.
const HEARD_WITHIN_DAYS = 3;

const SCIENTIFIC: Record<string, string> = {
  "sei whale": "Balaenoptera borealis",
  "fin whale": "Balaenoptera physalus",
  "right whale": "Eubalaena glacialis",
  "humpback whale": "Megaptera novaeangliae",
  "blue whale": "Balaenoptera musculus",
  "minke whale": "Balaenoptera acutorostrata",
  "bowhead whale": "Balaena mysticetus",
};

type Result = { signals: Signal[]; status: SourceStatus };
let platformCache: { at: number; urls: string[] } | null = null;
let cache: { at: number; data: Result } | null = null;
let inflight: Promise<Result> | null = null;

export function loadAcoustic(): Promise<Result> {
  if (cache && Date.now() - cache.at < DETECTIONS_TTL_MS) return Promise.resolve(cache.data);
  if (inflight) return inflight;
  inflight = buildAcoustic()
    .catch((error: unknown): Result => ({
      signals: cache?.data.signals ?? [],
      status: {
        ...STATUS,
        ok: false,
        note: error instanceof Error ? error.message : "WHOI did not answer.",
      },
    }))
    .then((data) => {
      // Failures retry in ~5 minutes instead of on every pull.
      cache = { at: data.status.ok ? Date.now() : Date.now() - DETECTIONS_TTL_MS + 5 * 60_000, data };
      inflight = null;
      return data;
    });
  return inflight;
}

const STATUS: SourceStatus = {
  id: "whoi",
  label: "WHOI whale-listening buoys",
  ok: false,
  count: 0,
  note: null,
};

async function buildAcoustic(): Promise<Result> {
  const urls = await platformUrls();
  const now = Date.now();
  const recent = urls.filter((url) => {
    const stamp = deploymentStamp(url);
    return stamp !== null && now - stamp < 15 * 30 * 86_400_000;
  });
  const signals: Signal[] = [];
  let live = 0;
  await pool(recent, 4, async (url) => {
    try {
      const page = await fetchText(url, 15_000);
      const summary = parsePlatform(page);
      if (!summary || now - summary.latest > ACTIVE_WITHIN_MS) return;
      live += 1;
      for (const heard of summary.heard) {
        if (now - heard.day > HEARD_WITHIN_DAYS * 86_400_000) continue;
        const table = await fetchText(heard.table, 15_000).catch(() => null);
        const hit = table ? latestDetection(table, heard.species) : null;
        if (!hit) continue;
        signals.push(toSignal(url, summary.title, heard.species, hit));
      }
    } catch {
      /* one platform failing should not drop the rest */
    }
  });
  return {
    signals,
    status: {
      ...STATUS,
      ok: recent.length > 0,
      count: signals.length,
      note: `${live} platforms listening now. Analyst-reviewed calls from the last ${HEARD_WITHIN_DAYS} days, placed at the listening platform.`,
    },
  };
}

async function platformUrls(): Promise<string[]> {
  if (platformCache && Date.now() - platformCache.at < PLATFORMS_TTL_MS) return platformCache.urls;
  const html = await fetchText(HOME, 15_000);
  const urls = [
    ...new Set([...html.matchAll(/https:\/\/dcs\.whoi\.edu\/[a-z]+\d{4}\/[a-z0-9_]+\.shtml/gi)].map((m) => m[0])),
  ];
  if (!urls.length) throw new Error("No WHOI platforms listed");
  platformCache = { at: Date.now(), urls };
  return urls;
}

/** "maca2606" → June 2026 deployment, as a timestamp. */
export function deploymentStamp(url: string): number | null {
  const m = url.match(/dcs\.whoi\.edu\/[a-z]+(\d{2})(\d{2})\//i);
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return Date.UTC(2000 + Number(m[1]), month - 1, 1);
}

type Heard = { species: string; day: number; table: string; level: "Detected" | "Possibly detected" };

/** Reads a platform page: its title, newest review date, and species heard per recent day. */
export function parsePlatform(html: string): { title: string; latest: number; heard: Heard[] } | null {
  const raw = html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim() ?? "WHOI platform";
  // Glider titles end with their deployment date ("…, Canada, September 2026"); drop it.
  const title = raw.replace(/,?\s*(?:[A-Z][a-z]+)\s+\d{4}$/, "").trim() || raw;
  const start = html.indexOf("Daily analyst review");
  if (start < 0) return null;
  const table = html.slice(start, html.indexOf("</table>", start));
  const species = [...table.matchAll(/<th[^>]*>([^<]+)<\/th>/gi)].map((m) => m[1].trim()).slice(1);
  const rows = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]);
  const heard = new Map<string, Heard>();
  let latest = 0;
  for (const row of rows) {
    const link = row.match(/href="([^"]+manual_analysis_table_(\d{4})(\d{2})(\d{2})\.html)"/i);
    if (!link) continue;
    const day = Date.UTC(Number(link[2]), Number(link[3]) - 1, Number(link[4]));
    latest = Math.max(latest, day);
    const cells = [...row.matchAll(/<td style="background-color:\s*([a-z]+)/gi)].map((m) => m[1].toLowerCase());
    cells.forEach((color, index) => {
      const name = species[index];
      if (!name || (color !== "red" && color !== "yellow")) return;
      const level = color === "red" ? "Detected" : "Possibly detected";
      const prev = heard.get(name);
      // Keep the newest day; on the same day a firm detection beats a possible one.
      if (!prev || day > prev.day || (day === prev.day && level === "Detected")) {
        heard.set(name, { species: name, day, table: link[1], level });
      }
    });
  }
  if (!latest) return null;
  return { title, latest, heard: [...heard.values()] };
}

type Detection = { at: string; lat: number; lng: number; level: string; count: number };

/** Newest detection of one species in a daily table; times come from the UTC stamp in each link. */
export function latestDetection(html: string, species: string): Detection | null {
  const sections = html.split(/<b>([^<]+):<\/b>/i);
  for (let i = 1; i < sections.length; i += 2) {
    if (sections[i].trim().toLowerCase() !== species.toLowerCase()) continue;
    const rows = [
      ...sections[i + 1].matchAll(
        /_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.html"[^<]*<\/a><\/td>\s*<td[^>]*>(Detected|Possibly detected)<\/td>\s*<td[^>]*>(-?[\d.]+)<\/td>\s*<td[^>]*>(-?[\d.]+)<\/td>/gi,
      ),
    ];
    if (!rows.length) return null;
    const firm = rows.filter((m) => m[7] === "Detected");
    const last = (firm.length ? firm : rows).at(-1)!;
    const lat = Number(last[8]);
    const lng = Number(last[9]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return {
      at: `${last[1]}-${last[2]}-${last[3]}T${last[4]}:${last[5]}:${last[6]}Z`,
      lat,
      lng,
      level: last[7],
      count: rows.length,
    };
  }
  return null;
}

function toSignal(url: string, platform: string, species: string, hit: Detection): Signal {
  const slug = url.replace(/^.*\/([^/]+)\.shtml$/, "$1");
  const common = species.charAt(0).toUpperCase() + species.slice(1).toLowerCase();
  const periods = `${hit.count} fifteen-minute period${hit.count === 1 ? "" : "s"} that day`;
  return {
    id: `whoi:${slug}-${species.toLowerCase().replace(/[^a-z]+/g, "-")}`,
    name: `${common} calls`,
    group: "whale",
    common,
    scientific: SCIENTIFIC[species.toLowerCase()] ?? "",
    lat: hit.lat,
    lng: hit.lng,
    observedAt: hit.at,
    source: "whoi",
    kind: "sighting",
    place: platform,
    sex: null,
    length: null,
    weight: null,
    stage: null,
    image: null,
    url,
    tagId: null,
    credit: "WHOI Robots4Whales",
    note: `${hit.level} · ${periods}`,
  };
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: "text/html", "User-Agent": UA },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
