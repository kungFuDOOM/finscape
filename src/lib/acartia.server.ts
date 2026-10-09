import { asRecord, fetchJson, num, str } from "./net.server";
import type { Group, Signal, SourceStatus } from "./ocean.types";

/**
 * Acartia: the Salish Sea marine mammal data cooperative. Its public "current" feed carries
 * the last week of trusted sightings from Orca Network, Conserve.io's Spotter and partners,
 * from California to Alaska.
 */

const FEED = "https://acartia.io/api/v1/sightings/current";
const TTL_MS = 5 * 60_000;

const SPECIES: Array<{ match: RegExp; group: Group; common: string; scientific: string }> = [
  { match: /orca|killer/i, group: "dolphin", common: "Orca", scientific: "Orcinus orca" },
  { match: /dall/i, group: "dolphin", common: "Dall's porpoise", scientific: "Phocoenoides dalli" },
  {
    match: /harbou?r porpoise/i,
    group: "dolphin",
    common: "Harbor porpoise",
    scientific: "Phocoena phocoena",
  },
  { match: /porpoise/i, group: "dolphin", common: "Porpoise", scientific: "Phocoenidae" },
  {
    match: /white.?sided/i,
    group: "dolphin",
    common: "Pacific white-sided dolphin",
    scientific: "Lagenorhynchus obliquidens",
  },
  { match: /risso/i, group: "dolphin", common: "Risso's dolphin", scientific: "Grampus griseus" },
  { match: /dolphin/i, group: "dolphin", common: "Dolphin", scientific: "Delphinidae" },
  {
    match: /gr[ae]y whale/i,
    group: "whale",
    common: "Gray whale",
    scientific: "Eschrichtius robustus",
  },
  {
    match: /humpback/i,
    group: "whale",
    common: "Humpback whale",
    scientific: "Megaptera novaeangliae",
  },
  {
    match: /minke/i,
    group: "whale",
    common: "Minke whale",
    scientific: "Balaenoptera acutorostrata",
  },
  { match: /fin whale/i, group: "whale", common: "Fin whale", scientific: "Balaenoptera physalus" },
  {
    match: /blue whale/i,
    group: "whale",
    common: "Blue whale",
    scientific: "Balaenoptera musculus",
  },
  { match: /sperm/i, group: "whale", common: "Sperm whale", scientific: "Physeter macrocephalus" },
  { match: /whale/i, group: "whale", common: "Whale", scientific: "" },
];

let cache: { at: number; data: { signals: Signal[]; status: SourceStatus } } | null = null;

export async function loadAcartia(): Promise<{ signals: Signal[]; status: SourceStatus }> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  const status: SourceStatus = {
    id: "acartia",
    label: "Acartia live sightings (Pacific Northwest)",
    ok: false,
    count: 0,
    note: null,
  };
  try {
    const rows = await fetchJson(FEED, 15_000);
    const signals = (Array.isArray(rows) ? rows : [])
      .map(readSighting)
      .filter((signal): signal is Signal => signal !== null);
    status.ok = true;
    status.count = signals.length;
    status.note =
      "Trusted reports from the last week, shared through the Acartia data cooperative.";
    cache = { at: Date.now(), data: { signals, status } };
    return cache.data;
  } catch (error) {
    if (cache) return cache.data;
    status.note = error instanceof Error ? error.message : "Acartia unreachable";
    return { signals: [], status };
  }
}

function readSighting(value: unknown): Signal | null {
  const row = asRecord(value);
  if (!row || row.trusted === 0 || row.trusted === false) return null;
  const type = str(row.type) ?? "";
  const species = SPECIES.find((item) => item.match.test(type));
  const lat = num(row.latitude);
  const lng = num(row.longitude);
  const created = str(row.created);
  const id = str(row.entry_id) ?? str(row.ssemmi_id);
  if (!species || lat === null || lng === null || !created || !id) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  // Timestamps come as "YYYY-MM-DD HH:MM:SS" in UTC.
  const observedAt = new Date(`${created.replace(" ", "T")}Z`).toISOString();
  const count = num(row.no_sighted);
  const comments = str(row.data_source_comments) ?? "";
  // Keep the reporting network's name but not the observer's. Some rows lose the opening bracket.
  const tag = /^\[?([^[\]]{1,40})\]\s*/;
  const network = comments.match(tag)?.[1] ?? str(row.data_source_entity);
  const note = comments
    .replace(tag, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim();
  return {
    id: `acartia:${id}`,
    name: count && count > 1 ? `${species.common} ×${count}` : species.common,
    group: species.group,
    common: species.common,
    scientific: species.scientific,
    lat,
    lng,
    observedAt,
    source: "acartia",
    kind: "sighting",
    place: network ? `Reported via ${network}` : null,
    sex: null,
    length: null,
    weight: null,
    stage: null,
    image: null,
    url: "https://acartia.io/",
    tagId: null,
    note: note || null,
  };
}
