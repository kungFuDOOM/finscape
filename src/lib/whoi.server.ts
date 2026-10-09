import { fetchText, pool } from "./net.server";
import type { CallStatus, Heard, HeardDay, Signal, SourceStatus } from "./ocean.types";

/**
 * WHOI Robots4Whales: moored buoys and Slocum gliders with DMON hydrophones. Analysts
 * review the automated call detections every day and publish one table per platform on
 * dcs.whoi.edu. There is no JSON feed, so this reads those tables.
 */

const INDEX = "https://robots4whales.whoi.edu/";
const TTL_MS = 10 * 60_000;
const DAYS_KEPT = 21;

type Platform = { url: string; name: string; operator: string | null };

/** Used when the Robots4Whales index cannot be read; the platform pages still live on dcs. */
const FALLBACK: Platform[] = [
  ["dal2609/dal2609_shad", "Laurentian Channel (Zone B) Slocum glider"],
  ["dal2606/dal2606_sable", "Laurentian Channel (Zone A) Slocum glider"],
  ["dal2606/dal2606_peggy", "Laurentian Channel (Zone C) Slocum glider"],
  ["gom2606/gom2606_we03", "Gulf of Maine Summer Slocum glider"],
  ["maca2606/maca2606_maca", "Cape Ann buoy"],
  ["maccb2606/maccb2606_maccb", "Cape Cod Bay buoy"],
  ["nybnw2602/nybnw2602_nybnw", "New York Bight NW buoy"],
  ["nybse2608/nybse2608_nybse", "New York Bight SE buoy"],
  ["vacc2607/vacc2607_vacc", "Cape Charles buoy"],
  ["gasv2609/gasv2609_gasv", "Savannah buoy"],
].map(([path, name]) => ({ url: `https://dcs.whoi.edu/${path}.shtml`, name, operator: null }));

let cache: { at: number; data: { signals: Signal[]; status: SourceStatus } } | null = null;
let inflight: Promise<{ signals: Signal[]; status: SourceStatus }> | null = null;

export function loadWhoi(): Promise<{ signals: Signal[]; status: SourceStatus }> {
  if (cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.data);
  if (inflight) return inflight;
  inflight = buildWhoi()
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

async function buildWhoi(): Promise<{ signals: Signal[]; status: SourceStatus }> {
  const status: SourceStatus = {
    id: "whoi",
    label: "WHOI Robots4Whales listening platforms",
    ok: false,
    count: 0,
    note: null,
  };
  let platforms: Platform[] = [];
  try {
    platforms = parseIndex(await fetchText(INDEX, 12_000));
  } catch {
    /* fall through to the known deployments */
  }
  if (!platforms.length) platforms = FALLBACK;
  let failed = 0;
  const rows = await pool(platforms, 5, async (platform) => {
    try {
      return await readPlatform(platform);
    } catch {
      failed += 1;
      return null;
    }
  });
  const signals = rows.filter((row): row is Signal => row !== null);
  status.ok = signals.length > 0;
  status.count = signals.length;
  status.note = !signals.length
    ? "The WHOI platform pages did not answer."
    : `${signals.length} hydrophones reviewed daily by analysts${failed ? `, ${failed} unreachable` : ""}. Calls place a whale near the platform, not at an exact spot.`;
  return { signals, status };
}

function decode(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#8217;|&rsquo;/g, "’")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

function parseIndex(html: string): Platform[] {
  const start = html.indexOf("Latest Whale Detections");
  if (start < 0) return [];
  const end = html.indexOf("</table>", start);
  const table = html.slice(start, end < 0 ? undefined : end);
  const out: Platform[] = [];
  const seen = new Set<string>();
  for (const row of table.match(/<tr>[\s\S]*?<\/tr>/g) ?? []) {
    const link = row.match(/href="(https:\/\/dcs\.whoi\.edu\/[^"]+\.shtml)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link || seen.has(link[1])) continue;
    seen.add(link[1]);
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => decode(cell[1]));
    out.push({ url: link[1], name: decode(link[2]), operator: cells[2] || null });
  }
  return out;
}

function statusFor(cell: string): CallStatus {
  const color = cell.match(/background-color:\s*([a-z#0-9]+)/i)?.[1]?.toLowerCase();
  if (color === "red") return "detected";
  if (color === "yellow") return "possible";
  return "none";
}

function isoDay(us: string): string | null {
  const match = us.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return match ? `${match[3]}-${match[1]}-${match[2]}` : null;
}

async function readPlatform(platform: Platform): Promise<Signal | null> {
  const html = await fetchText(platform.url, 12_000);
  const review = html.indexOf("Daily analyst review");
  if (review < 0) return null;
  const tableEnd = html.indexOf("</table>", review);
  const table = html.slice(review, tableEnd < 0 ? undefined : tableEnd);
  const header = table.match(/<tr>\s*<th[\s\S]*?<\/tr>/)?.[0] ?? "";
  const species = [...header.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)]
    .map((cell) => decode(cell[1]))
    .slice(1);
  if (!species.length) return null;

  const days: (HeardDay & { link: string })[] = [];
  for (const row of table.match(/<tr>\s*<td[\s\S]*?<\/tr>/g) ?? []) {
    const link = row.match(/href="([^"]+)"[^>]*>\s*(\d{2}\/\d{2}\/\d{4})\s*<\/a>/);
    const date = link ? isoDay(link[2]) : null;
    if (!link || !date) continue;
    const cells = [...row.matchAll(/<td([^>]*)>/g)].slice(1).map((cell) => statusFor(cell[1]));
    days.push({ date, link: link[1], calls: species.map((_, index) => cells[index] ?? "none") });
    if (days.length >= DAYS_KEPT) break;
  }
  if (!days.length) return null;

  let fix: { lat: number; lng: number } | null = null;
  for (const day of days.slice(0, 4)) {
    try {
      fix = lastPosition(await fetchText(day.link, 12_000));
    } catch {
      fix = null;
    }
    if (fix) break;
  }
  if (!fix) return null;

  const lately = (status: CallStatus) =>
    species.filter((_, index) => days.slice(0, 3).some((day) => day.calls[index] === status));
  const recent = lately("detected");
  const maybe = lately("possible").filter((name) => !recent.includes(name));
  const lastCall = days.find((day) => day.calls.some((call) => call !== "none"));
  const observedAt = `${(lastCall ?? days[0]).date}T12:00:00Z`;
  const glider = /glider/i.test(platform.name);
  const heard: Heard = {
    platform: glider ? "glider" : "buoy",
    species,
    recent,
    days: days.map(({ date, calls }) => ({ date, calls })),
  };
  const slug = platform.url.split("/").pop()?.replace(".shtml", "") ?? platform.name;
  return {
    id: `whoi:${slug}`,
    name: platform.name.replace(/\s+Slocum glider$/i, " glider"),
    group: "whale",
    common: recent.length
      ? `${listSpecies(recent)} calls`
      : maybe.length
        ? `Possible ${listSpecies(maybe).toLowerCase()} calls`
        : "Listening · no calls in 3 days",
    scientific: "",
    lat: fix.lat,
    lng: fix.lng,
    observedAt,
    source: "whoi",
    kind: "heard",
    place: platform.operator,
    sex: null,
    length: null,
    weight: null,
    stage: null,
    image: null,
    url: platform.url,
    tagId: null,
    heard,
  };
}

/** "Fin whale", "Blue whale" → "Fin & blue whale". */
function listSpecies(names: string[]): string {
  const short = names.map((name) => name.replace(/\s+whales?$/i, ""));
  if (short.length === 1) return `${short[0]} whale`;
  const head = short.slice(0, -1).join(", ");
  const tail = short[short.length - 1].toLowerCase();
  return `${head} & ${tail} whale`.replace(/^(.)/, (c) => c.toUpperCase());
}

/** The daily analysis log lists each reviewed period with the platform's latitude and longitude. */
function lastPosition(html: string): { lat: number; lng: number } | null {
  let found: { lat: number; lng: number } | null = null;
  for (const row of html.match(/<tr[\s\S]*?<\/tr>/g) ?? []) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => decode(cell[1]));
    for (let i = 0; i < cells.length - 1; i += 1) {
      if (!/^-?\d{1,2}\.\d+$/.test(cells[i]) || !/^-?\d{1,3}\.\d+$/.test(cells[i + 1])) continue;
      const lat = Number(cells[i]);
      const lng = Number(cells[i + 1]);
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat !== 0 || lng !== 0))
        found = { lat, lng };
      break;
    }
  }
  return found;
}
