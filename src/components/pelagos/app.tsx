import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Check, ChevronDown, Dices, Link2, RefreshCw, Search, X } from "lucide-react";
import { loadFeed, loadRoutes, loadTrack } from "@/lib/feed-client";
import type {
  CallStatus,
  Feed,
  Group,
  Heard,
  Kind,
  LiveRoute,
  Signal,
  SourceId,
  SourceStatus,
  Track,
  TrackPoint,
} from "@/lib/ocean.types";
import { GlobeView, trackLeg } from "./globe";

type WindowKey = "48h" | "30d" | "90d" | "all";

const WINDOWS: { id: WindowKey; label: string; ms: number | null }[] = [
  { id: "48h", label: "48h", ms: 48 * 3_600_000 },
  { id: "30d", label: "30d", ms: 30 * 86_400_000 },
  { id: "90d", label: "90d", ms: 90 * 86_400_000 },
  { id: "all", label: "All", ms: null },
];

const GROUPS: { id: Group; label: string; count: string }[] = [
  { id: "whale", label: "Whales", count: "whales" },
  { id: "shark", label: "Sharks", count: "sharks" },
  { id: "dolphin", label: "Dolphins", count: "dolphins" },
];

const LAYERS: { id: Kind; label: string; tag: string }[] = [
  { id: "tag", label: "Tags", tag: "TAG" },
  { id: "heard", label: "Heard", tag: "HEARD" },
  { id: "sighting", label: "Seen", tag: "SEEN" },
];

/** Hydrophones first: there are only a handful, and hundreds of quiet tags would bury them. */
const KIND_ORDER: Record<Kind, number> = { heard: 0, tag: 1, sighting: 2 };

const SOURCE_LINK: Record<SourceId, string> = {
  ocearch: "Open on OCEARCH",
  wildlife: "Open the tracking project",
  ghri: "Open on the GHRI shark tracker",
  sharksmart: "Open SharkSmart WA",
  acartia: "Open Acartia",
  whoi: "Open the WHOI platform page",
  inaturalist: "Open on iNaturalist",
};

const DAY_MS = 86_400_000;

const OCEANS = [
  { id: "patagonia", label: "Patagonia", lat: -44, lng: -58, zoom: 2.1 },
  { id: "salish", label: "Salish Sea", lat: 48.4, lng: -123.4, zoom: 3.6 },
  { id: "wa", label: "W. Australia", lat: -32.8, lng: 116.5, zoom: 3 },
  { id: "california", label: "California", lat: 34.5, lng: -121, zoom: 2.3 },
  { id: "atlantic", label: "Atlantic", lat: 38, lng: -60, zoom: 1.55 },
  { id: "gulf", label: "Gulf", lat: 26, lng: -86, zoom: 2 },
  { id: "pacific", label: "Pacific", lat: 28, lng: -155, zoom: 1.3 },
  { id: "cape", label: "Cape", lat: -34, lng: 22, zoom: 2 },
  { id: "australia", label: "Australia", lat: -30, lng: 153, zoom: 1.7 },
];

function pace(leg: { kmh: number; dir: string }): string {
  return `${(leg.kmh / 1.852).toFixed(1)} kn ${leg.dir}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  const day = date.getUTCDate();
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const mins = String(date.getUTCMinutes()).padStart(2, "0");
  return `${day} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} · ${hours}:${mins} UTC`;
}

function ageLabel(iso: string, now: number): string {
  const delta = Math.max(0, now - Date.parse(iso));
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days}d ago`;
  if (days < 730) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** WHOI publishes one review per calendar day, so its signals read in days, not hours. */
function dayLabel(iso: string, now: number): string {
  const day = Date.UTC(
    new Date(iso).getUTCFullYear(),
    new Date(iso).getUTCMonth(),
    new Date(iso).getUTCDate(),
  );
  const today = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate(),
  );
  const days = Math.round((today - day) / DAY_MS);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

function whenLabel(signal: Signal, now: number | null): string {
  if (now === null) return formatUtc(signal.observedAt);
  return signal.kind === "heard"
    ? dayLabel(signal.observedAt, now)
    : ageLabel(signal.observedAt, now);
}

/** Tags that pinged in the last 3 days and platforms that heard a whale in the last 3 reviews. */
function isLive(signal: Signal, now: number): boolean {
  if (signal.kind === "heard") return Boolean(signal.heard?.recent.length);
  if (signal.kind !== "tag") return false;
  return now - Date.parse(signal.observedAt) < 3 * DAY_MS;
}

function pipClass(group: Group): string {
  if (group === "whale") return "bg-whale text-whale";
  if (group === "dolphin") return "bg-dolphin text-dolphin";
  return "bg-shark text-shark";
}

function pathKm(points: TrackPoint[]): number {
  const rad = Math.PI / 180;
  let sum = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const dLat = (b.lat - a.lat) * rad;
    const dLng = (b.lng - a.lng) * rad;
    const lat1 = a.lat * rad;
    const lat2 = b.lat * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    sum += 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  return sum;
}

export function PelagosApp({
  focusId = null,
  onFocusChange,
}: {
  /** Signal to open on load, from a shared `?a=` link. */
  focusId?: string | null;
  onFocusChange?: (id: string | null) => void;
}) {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState<Record<Group, boolean>>({
    whale: true,
    shark: true,
    dolphin: true,
  });
  // Most tags went quiet long ago; open on recent activity and keep the archive one tap away.
  const [windowKey, setWindowKey] = useState<WindowKey>("90d");
  const [layers, setLayers] = useState<Record<Kind, boolean>>({
    tag: true,
    heard: true,
    sighting: false,
  });
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(focusId);
  const [track, setTrack] = useState<Track | null>(null);
  const [trackState, setTrackState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [now, setNow] = useState<number | null>(null);
  const [routes, setRoutes] = useState<LiveRoute[]>([]);
  const [jump, setJump] = useState<{ id: number; lat: number; lng: number; zoom: number } | null>(
    null,
  );
  const jumpN = useRef(0);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async (fresh: boolean) => {
    try {
      const next = await loadFeed(fresh);
      setFeed(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The feed dropped");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancel = false;
    const pull = (fresh: boolean) => {
      if (fresh && document.hidden) return;
      void load(fresh);
      void loadRoutes(fresh)
        .then((next) => {
          if (!cancel) setRoutes(next);
        })
        .catch(() => undefined);
    };
    pull(false);
    const timer = window.setInterval(() => pull(true), 45_000);
    const onShow = () => {
      if (!document.hidden) pull(true);
    };
    document.addEventListener("visibilitychange", onShow);
    return () => {
      cancel = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [load]);

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menuOpen]);

  useEffect(() => {
    if (selectedId !== focusId) onFocusChange?.(selectedId);
    // focusId mirrors selectedId through the URL; only the local choice drives this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.closest("input, textarea, [contenteditable='true']");
      if (event.key === "Escape") {
        if (menuOpen) setMenuOpen(false);
        else setSelectedId(null);
        if (typing) target?.blur();
        return;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "/") {
        event.preventDefault();
        setMenuOpen(true);
        window.setTimeout(() => searchRef.current?.focus(), 0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const visible = useMemo(() => {
    const signals = thinSightings(feed?.signals ?? []);
    const span = WINDOWS.find((item) => item.id === windowKey)?.ms ?? null;
    const parsed = Date.parse(feed?.fetchedAt ?? "");
    const stamp = now ?? (Number.isFinite(parsed) ? parsed : Date.now());
    return signals.filter((signal) => {
      if (!groups[signal.group]) return false;
      if (!layers[signal.kind]) return false;
      if (span !== null) {
        const at = Date.parse(signal.observedAt);
        if (!Number.isFinite(at) || stamp - at > span) return false;
      }
      return true;
    });
  }, [feed, groups, windowKey, layers, now]);

  const counts = useMemo(() => {
    // Hydrophones count on their own: ten buoys are not ten whales.
    const tally: Record<Group, number> = { whale: 0, shark: 0, dolphin: 0 };
    let heard = 0;
    for (const signal of visible) {
      if (signal.kind === "heard") heard += 1;
      else tally[signal.group] += 1;
    }
    return { ...tally, heard };
  }, [visible]);

  /** Newest live events across every source, regardless of the layer toggles. */
  const pulse = useMemo(() => {
    if (now === null) return [];
    return (feed?.signals ?? [])
      .filter((signal) => groups[signal.group] && isLive(signal, now))
      .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))
      .slice(0, 8);
  }, [feed, groups, now]);

  const selected = (feed?.signals ?? []).find((signal) => signal.id === selectedId) ?? null;
  const mapSignals = useMemo(() => {
    if (!selected || visible.some((signal) => signal.id === selected.id)) return visible;
    return [selected, ...visible];
  }, [visible, selected]);

  const globeRoutes = useMemo(() => {
    if (!selected || selected.kind !== "tag" || !track || track.points.length < 2) return routes;
    if (routes.some((route) => route.id === selected.id)) return routes;
    return [
      ...routes,
      { id: selected.id, name: selected.name, group: selected.group, points: track.points },
    ];
  }, [routes, selected, track]);

  useEffect(() => {
    if (!selected?.tagId) {
      setTrack(null);
      setTrackState("idle");
      return;
    }
    let cancel = false;
    const pull = () => {
      void loadTrack(selected.tagId!)
        .then((next) => {
          if (cancel) return;
          setTrack(next);
          setTrackState(next.error ? "error" : "ready");
        })
        .catch(() => {
          if (!cancel) setTrackState("error");
        });
    };
    setTrackState("loading");
    pull();
    const timer = window.setInterval(pull, 45_000);
    return () => {
      cancel = true;
      window.clearInterval(timer);
    };
  }, [selected?.id, selected?.tagId]);

  const choose = useCallback((id: string) => {
    setSelectedId(id);
    setMenuOpen(false);
  }, []);

  /** Fly to a random recently active tag, preferring ones with a moving track. */
  const surprise = useCallback(() => {
    const live = new Set(routes.map((route) => route.id));
    const stamp = Date.now();
    const candidates = (feed?.signals ?? []).filter(
      (signal) =>
        signal.kind === "tag" &&
        groups[signal.group] &&
        signal.id !== selectedId &&
        stamp - Date.parse(signal.observedAt) < 120 * DAY_MS,
    );
    const moving = candidates.filter((signal) => live.has(signal.id));
    const picks = moving.length ? moving : candidates;
    if (!picks.length) return;
    setSelectedId(picks[Math.floor(Math.random() * picks.length)].id);
    setMenuOpen(false);
  }, [feed, routes, groups, selectedId]);

  const goOcean = useCallback((ocean: (typeof OCEANS)[number]) => {
    jumpN.current += 1;
    setJump({ id: jumpN.current, lat: ocean.lat, lng: ocean.lng, zoom: ocean.zoom });
    setSelectedId(null);
    setMenuOpen(false);
  }, []);

  const motion = useMemo(() => {
    const map = new Map<string, { kmh: number; dir: string }>();
    for (const route of globeRoutes) {
      const leg = trackLeg(route.points);
      if (leg) map.set(route.id, leg);
    }
    return map;
  }, [globeRoutes]);

  const q = query.trim().toLowerCase();
  const matched = q
    ? visible.filter((signal) =>
        `${signal.name} ${signal.common} ${signal.scientific} ${signal.place ?? ""}`
          .toLowerCase()
          .includes(q),
      )
    : visible;
  const stamp = now ?? Date.now();
  const list = [...matched]
    .sort((a, b) => {
      const live = Number(isLive(b, stamp)) - Number(isLive(a, stamp));
      if (live) return live;
      if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
      return Date.parse(b.observedAt) - Date.parse(a.observedAt);
    })
    .slice(0, 160);
  const summary = useMemo(() => {
    const stamp = now ?? Date.now();
    let pinged = 0;
    let hearing = 0;
    for (const signal of feed?.signals ?? []) {
      if (signal.kind === "tag" && stamp - Date.parse(signal.observedAt) < 7 * DAY_MS) pinged += 1;
      if (signal.kind === "heard" && signal.heard?.recent.length) hearing += 1;
    }
    return { pinged, hearing };
  }, [feed, now]);
  const selectedRoute = selected
    ? (globeRoutes.find((route) => route.id === selected.id) ?? null)
    : null;
  const feedsDown =
    !loading &&
    !feed?.signals.length &&
    (Boolean(error) || (feed?.sources ?? []).every((source) => !source.ok));

  return (
    <main className={`relative h-dvh overflow-hidden bg-bg text-fg${selected ? " has-lock" : ""}`}>
      <GlobeView
        signals={mapSignals}
        routes={globeRoutes}
        selectedId={selected?.id ?? null}
        jump={jump}
        onSelect={choose}
      />

      <header className="pointer-events-none absolute inset-x-0 top-0 z-40 flex flex-col p-3 md:p-4">
        <div ref={menuRef} className="pointer-events-auto relative">
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-start gap-2">
              <div className="brand-lockup hud-panel flex items-center gap-3 px-3 py-2">
                <div className="reticle shrink-0" aria-hidden="true">
                  <span className="reticle-sweep" />
                </div>
                <p className="brand-name font-display text-xl leading-none text-fg">FinScape</p>
              </div>
              <button
                type="button"
                className="signal-toggle hud-panel inline-flex min-h-11 items-center gap-2 px-4 font-mono text-sm text-fg"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
              >
                Signals
                {feed ? (
                  <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted tabular-nums">
                    {visible.length}
                  </span>
                ) : null}
                <ChevronDown className={`size-4 text-phosphor ${menuOpen ? "rotate-180" : ""}`} />
              </button>
            </div>
            <div className="pointer-events-none flex shrink-0 items-start gap-2">
              <div className="hud-panel hidden items-center gap-4 px-4 py-3 lg:flex">
                {GROUPS.map((group) => (
                  <Count key={group.id} n={counts[group.id]} label={group.count} />
                ))}
                {layers.heard ? <Count n={counts.heard} label="hydrophones" /> : null}
              </div>
              <Clock />
            </div>
          </div>
          <div className="oceans" role="group" aria-label="Jump to an ocean">
            {OCEANS.map((ocean) => (
              <button
                key={ocean.id}
                type="button"
                className="hud-panel"
                onClick={() => goOcean(ocean)}
              >
                {ocean.label}
              </button>
            ))}
          </div>
          {menuOpen ? (
            <div className="menu-drop hud-panel">
              <ListPane
                list={list}
                total={matched.length}
                groups={groups}
                windowKey={windowKey}
                layers={layers}
                query={query}
                loading={loading}
                error={error}
                now={now}
                fetchedAt={feed?.fetchedAt ?? null}
                sources={feed?.sources ?? []}
                searchRef={searchRef}
                selectedId={selectedId}
                motion={motion}
                onQuery={setQuery}
                onGroup={(id) => setGroups((prev) => ({ ...prev, [id]: !prev[id] }))}
                onWindow={setWindowKey}
                onLayer={(id) => setLayers((prev) => ({ ...prev, [id]: !prev[id] }))}
                onSelect={choose}
                onRefresh={() => void load(true)}
              />
            </div>
          ) : null}
        </div>
      </header>

      {selected ? (
        <aside className="lock-card hud-panel">
          <Dossier
            signal={selected}
            points={selected.tagId ? (track?.points ?? []) : (selectedRoute?.points ?? [])}
            trackError={track?.error ?? null}
            trackState={selected.tagId ? trackState : "ready"}
            moving={Boolean(selectedRoute)}
            now={now}
            onNext={surprise}
            onRelease={() => setSelectedId(null)}
          />
        </aside>
      ) : (
        <div className="dock">
          <Pulse items={pulse} now={now} onSelect={choose} />
          <div className="dock-row">
            <Layers
              layers={layers}
              onLayer={(id) => setLayers((prev) => ({ ...prev, [id]: !prev[id] }))}
            />
            <button
              type="button"
              className="surprise hud-panel"
              onClick={surprise}
              disabled={!feed?.signals.some((signal) => signal.kind === "tag")}
              aria-label="Fly to a random tagged animal"
            >
              <Dices className="size-4" aria-hidden="true" />
              <span>Random</span>
            </button>
          </div>
          <div className="legend hud-panel pointer-events-none px-3 py-2 font-mono text-xs text-fg">
            {GROUPS.map((group) => (
              <span key={group.id} className="inline-flex items-center gap-1">
                <i className={`size-2.5 rounded-full ${pipClass(group.id)}`} /> {group.label}
              </span>
            ))}
            <span className="inline-flex items-center gap-1">
              <i className="heard-ring" /> Hydrophone
            </span>
            <span className={feedsDown ? "text-shark" : "text-muted"}>
              {loading
                ? "Sweeping the basins…"
                : feedsDown
                  ? "Feeds unreachable · retrying"
                  : `${summary.pinged} tags pinged this week · ${summary.hearing} hydrophones hearing whales`}
            </span>
          </div>
        </div>
      )}
    </main>
  );
}

function Layers({
  layers,
  onLayer,
}: {
  layers: Record<Kind, boolean>;
  onLayer: (id: Kind) => void;
}) {
  return (
    <div className="layer-switch hud-panel" role="group" aria-label="Map layers">
      {LAYERS.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-pressed={layers[item.id]}
          onClick={() => onLayer(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** A rotating ticker of the newest live events; tapping one locks onto it. */
function Pulse({
  items,
  now,
  onSelect,
}: {
  items: Signal[];
  now: number | null;
  onSelect: (id: string) => void;
}) {
  const [index, setIndex] = useState(0);
  const count = items.length;
  useEffect(() => {
    if (count < 2) return;
    const timer = window.setInterval(() => setIndex((value) => (value + 1) % count), 5_000);
    return () => window.clearInterval(timer);
  }, [count]);
  const item = count ? items[index % count] : null;
  if (!item) return null;
  const verb = item.kind === "heard" ? "heard" : "pinged";
  return (
    <button type="button" className="pulse hud-panel" onClick={() => onSelect(item.id)}>
      <span className={`pulse-pip live-pip ${pipClass(item.group)}`} aria-hidden="true" />
      <span className="pulse-tag">Live</span>
      <span key={item.id} className="pulse-text">
        <span className="text-fg">{item.name}</span>
        <span className="text-muted">
          {" "}
          · {item.common} · {verb} {now !== null ? whenLabel(item, now) : ""}
        </span>
      </span>
      <span className="pulse-count tabular-nums">
        {(index % count) + 1}/{count}
      </span>
    </button>
  );
}

function thinSightings(signals: Signal[]): Signal[] {
  const kept: Signal[] = [];
  const sightings: Signal[] = [];
  for (const signal of signals) {
    if (signal.kind !== "sighting") {
      kept.push(signal);
      continue;
    }
    const at = Date.parse(signal.observedAt);
    const duplicate = sightings.some((other) => {
      if (other.common !== signal.common || other.group !== signal.group) return false;
      const dLat = Math.abs(other.lat - signal.lat);
      let dLng = Math.abs(other.lng - signal.lng);
      if (dLng > 180) dLng = 360 - dLng;
      return (
        dLat < 0.4 && dLng < 0.4 && Math.abs(Date.parse(other.observedAt) - at) < 36 * 3_600_000
      );
    });
    if (duplicate) continue;
    sightings.push(signal);
    kept.push(signal);
  }
  return kept;
}

function Count({ n, label }: { n: number; label: string }) {
  return (
    <p className="text-center">
      <span className="block font-mono text-lg leading-none text-fg tabular-nums">{n}</span>
      <span className="mt-1 block font-mono text-xs text-muted">{label}</span>
    </p>
  );
}

function Clock() {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => setLabel(new Date().toISOString().slice(11, 19));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <p className="clock-chip hud-panel px-3 py-2 font-mono text-xs text-muted tabular-nums">
      <span>{label ?? "——:——:——"}</span>
      <span className="clock-zone"> UTC</span>
    </p>
  );
}

const ListPane = memo(function ListPane({
  list,
  total,
  groups,
  windowKey,
  layers,
  query,
  loading,
  error,
  now,
  fetchedAt,
  sources,
  searchRef,
  selectedId,
  motion,
  onQuery,
  onGroup,
  onWindow,
  onLayer,
  onSelect,
  onRefresh,
}: {
  list: Signal[];
  total: number;
  groups: Record<Group, boolean>;
  windowKey: WindowKey;
  layers: Record<Kind, boolean>;
  query: string;
  loading: boolean;
  error: string | null;
  now: number | null;
  fetchedAt: string | null;
  sources: SourceStatus[];
  searchRef: RefObject<HTMLInputElement | null>;
  selectedId: string | null;
  motion: Map<string, { kmh: number; dir: string }>;
  onQuery: (value: string) => void;
  onGroup: (id: Group) => void;
  onWindow: (id: WindowKey) => void;
  onLayer: (id: Kind) => void;
  onSelect: (id: string) => void;
  onRefresh: () => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <p className="font-mono text-xs text-muted">
          {loading
            ? "Sweeping the basins…"
            : `${total} signals${fetchedAt && now !== null ? ` · updated ${ageLabel(fetchedAt, now)}` : ""}`}
        </p>
        <button
          type="button"
          className="inline-flex min-h-11 min-w-11 items-center justify-center text-muted hover:text-fg"
          onClick={onRefresh}
          aria-label="Refresh signals"
        >
          <RefreshCw className="size-4" />
        </button>
      </div>
      <div className="border-b border-line px-3 py-3">
        <div className="flex flex-wrap gap-2">
          {GROUPS.map((group) => (
            <button
              key={group.id}
              type="button"
              aria-pressed={groups[group.id]}
              onClick={() => onGroup(group.id)}
              className={`min-h-11 rounded-full border px-3 font-mono text-xs ${
                groups[group.id] ? "border-phosphor bg-surface-2 text-fg" : "border-line text-muted"
              }`}
            >
              <span className={`mr-2 inline-block size-2 rounded-full ${pipClass(group.id)}`} />
              {group.label}
            </button>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {WINDOWS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={windowKey === item.id}
              onClick={() => onWindow(item.id)}
              className={`min-h-11 rounded-full border px-3 font-mono text-xs ${
                windowKey === item.id ? "border-phosphor text-phosphor" : "border-line text-muted"
              }`}
            >
              {item.label}
            </button>
          ))}
          {LAYERS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={layers[item.id]}
              onClick={() => onLayer(item.id)}
              className={`min-h-11 rounded-full border px-3 font-mono text-xs ${
                layers[item.id] ? "border-line bg-surface-2 text-fg" : "border-line text-muted"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <label className="mt-3 flex min-h-11 items-center gap-2 rounded-full border border-line px-3">
          <Search className="size-4 shrink-0 text-muted" aria-hidden="true" />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="Name, species, place"
            className="w-full bg-transparent font-mono text-sm text-fg outline-none placeholder:text-muted"
            type="search"
            aria-label="Search signals"
          />
          {query ? (
            <button
              type="button"
              className="grid size-8 shrink-0 place-items-center text-muted hover:text-fg"
              onClick={() => onQuery("")}
              aria-label="Clear search"
            >
              <X className="size-4" />
            </button>
          ) : (
            <kbd className="hidden shrink-0 rounded border border-line px-1.5 text-xs text-muted md:inline">
              /
            </kbd>
          )}
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? <p className="px-3 py-3 font-mono text-xs text-shark">{error}</p> : null}
        {!loading && list.length === 0 ? (
          <p className="px-3 py-6 font-mono text-sm text-muted">
            {query
              ? `Nothing matches “${query.trim()}”. Try a species or a place.`
              : sources.length && sources.every((source) => !source.ok)
                ? "The tracking feeds are not answering right now. FinScape retries every 45 seconds."
                : "Nothing in this window. Widen the time range or switch layers on."}
          </p>
        ) : (
          <ul>
            {list.map((signal) => {
              const hot = now !== null && isLive(signal, now);
              const leg = motion.get(signal.id);
              const label = LAYERS.find((item) => item.id === signal.kind)?.tag ?? "";
              return (
                <li key={signal.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(signal.id)}
                    className={`flex w-full items-start gap-3 px-3 py-3 text-left ${
                      signal.id === selectedId ? "bg-surface-2" : "hover:bg-surface-2"
                    }`}
                  >
                    <span
                      className={`mt-1.5 size-2.5 shrink-0 rounded-full ${pipClass(signal.group)} ${
                        hot ? "live-pip" : ""
                      } ${signal.kind === "heard" ? "heard-pip" : ""}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate font-display text-base text-fg">
                          {signal.name}
                        </span>
                        <span
                          className={`shrink-0 font-mono text-xs ${hot ? "text-phosphor" : "text-muted"}`}
                        >
                          {label}
                        </span>
                      </span>
                      <span className="block truncate font-mono text-xs text-muted">
                        {signal.common}
                        {signal.scientific ? ` · ${signal.scientific}` : ""}
                      </span>
                      <span className="block truncate font-mono text-xs text-muted">
                        {whenLabel(signal, now)}
                        {leg ? ` · ${pace(leg)}` : ""}
                        {signal.place ? ` · ${signal.place}` : ""}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <Sources sources={sources} />
      </div>
    </>
  );
});

function sourceDot(source: SourceStatus): string {
  return source.ok ? "bg-phosphor" : "bg-shark";
}

function Sources({ sources }: { sources: SourceStatus[] }) {
  if (!sources.length) return null;
  return (
    <details className="sources border-t border-line px-3 py-2">
      <summary className="flex min-h-11 cursor-pointer items-center justify-between font-mono text-xs text-muted">
        <span>Data sources</span>
        <span className="flex gap-1.5" aria-hidden="true">
          {sources.map((source) => (
            <i key={source.id} className={`size-2 rounded-full ${sourceDot(source)}`} />
          ))}
        </span>
      </summary>
      <ul className="space-y-3 pb-2">
        {sources.map((source) => (
          <li key={source.id} className="font-mono text-xs">
            <p className="flex items-center justify-between gap-2 text-fg">
              <span className="inline-flex items-center gap-2">
                <i className={`size-2 shrink-0 rounded-full ${sourceDot(source)}`} />
                {source.label}
              </span>
              <span className="tabular-nums text-muted">{source.count}</span>
            </p>
            {source.note ? <p className="mt-1 pl-4 text-muted">{source.note}</p> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

function Dossier({
  signal,
  points,
  trackError,
  trackState,
  moving,
  now,
  onNext,
  onRelease,
}: {
  signal: Signal;
  points: TrackPoint[];
  trackError: string | null;
  trackState: "idle" | "loading" | "ready" | "error";
  moving: boolean;
  now: number | null;
  onNext: () => void;
  onRelease: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [photoOk, setPhotoOk] = useState(true);
  useEffect(() => {
    setCopied(false);
    setPhotoOk(true);
  }, [signal.id]);
  const share = async () => {
    const url = window.location.href;
    try {
      if (navigator.share && window.matchMedia("(pointer: coarse)").matches) {
        await navigator.share({ title: `${signal.name} on FinScape`, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* share sheet dismissed or clipboard blocked */
    }
  };
  const photo = photoOk && signal.image && /^https?:\/\//.test(signal.image) ? signal.image : null;
  const km = points.length > 1 ? Math.round(pathKm(points)) : null;
  // A heading from a fix weeks old says nothing about where the animal is going now.
  const stale = now !== null && now - Date.parse(signal.observedAt) > 7 * DAY_MS;
  const leg = stale ? null : trackLeg(points);
  const spanDays =
    points.length > 1
      ? Math.max(
          1,
          Math.round(
            (Date.parse(points[points.length - 1].at) - Date.parse(points[0].at)) / DAY_MS,
          ),
        )
      : null;
  const groupLabel = GROUPS.find((group) => group.id === signal.group)?.label ?? signal.group;
  const kindLabel =
    signal.kind === "heard"
      ? `${signal.heard?.platform ?? "listening"} hydrophone`
      : signal.kind === "sighting"
        ? "sighting"
        : signal.source === "sharksmart"
          ? "acoustic tag detection"
          : "satellite tag";
  return (
    <div>
      <div className="sticky top-0 z-10 flex items-center justify-between gap-1 border-b border-line bg-surface px-3 py-1">
        <p className="font-mono text-xs tracking-widest text-phosphor">LOCK</p>
        <div className="flex items-center">
          <button
            type="button"
            className="inline-flex min-h-11 items-center gap-1.5 px-2 font-mono text-xs text-muted hover:text-fg"
            onClick={() => void share()}
          >
            {copied ? <Check className="size-3.5 text-phosphor" /> : <Link2 className="size-3.5" />}
            {copied ? "Copied" : "Share"}
          </button>
          {signal.kind === "tag" ? (
            <button
              type="button"
              className="inline-flex min-h-11 items-center gap-1.5 px-2 font-mono text-xs text-muted hover:text-fg"
              onClick={onNext}
              aria-label="Fly to another random tag"
            >
              <Dices className="size-3.5" />
              Next
            </button>
          ) : null}
          <button
            type="button"
            className="inline-flex min-h-11 items-center gap-1.5 px-2 font-mono text-xs text-muted hover:text-fg"
            onClick={onRelease}
            aria-label="Release (Esc)"
          >
            <X className="size-3.5" />
            Release
          </button>
        </div>
      </div>
      {photo ? (
        <img
          src={photo}
          alt={`${signal.name}, ${signal.common}`}
          className="dossier-photo"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setPhotoOk(false)}
        />
      ) : null}
      <div className="space-y-3 px-4 py-3">
        <div>
          <p className="font-mono text-xs uppercase tracking-widest text-muted">
            {groupLabel} · {kindLabel}
          </p>
          <h2 className="mt-1 font-display text-3xl leading-none text-fg">{signal.name}</h2>
          <p className="mt-2 font-mono text-sm text-muted">
            {signal.common}
            {signal.scientific ? ` · ${signal.scientific}` : ""}
          </p>
        </div>
        {signal.heard ? <CallGrid heard={signal.heard} /> : null}
        <dl className="grid grid-cols-2 gap-3 font-mono text-xs">
          <Fact
            label={signal.kind === "heard" ? "Last call" : "Last signal"}
            value={whenLabel(signal, now)}
          />
          <Fact
            label="When"
            value={
              signal.kind === "heard"
                ? signal.observedAt.slice(0, 10)
                : formatUtc(signal.observedAt)
            }
          />
          {leg ? <Fact label="Course" value={pace(leg)} /> : null}
          {leg ? <Fact label="Heading" value={`${Math.round(leg.heading)}°`} /> : null}
          {signal.kind === "tag" && spanDays !== null ? (
            <Fact label="Tracked for" value={`${spanDays.toLocaleString("en-US")} days`} />
          ) : null}
          <Fact label="Latitude" value={signal.lat.toFixed(3)} />
          <Fact label="Longitude" value={signal.lng.toFixed(3)} />
          {signal.sex ? <Fact label="Sex" value={signal.sex} /> : null}
          {signal.length ? <Fact label="Length" value={signal.length} /> : null}
          {signal.weight ? <Fact label="Weight" value={signal.weight} /> : null}
          {signal.stage ? <Fact label="Life stage" value={signal.stage} /> : null}
          {signal.credit ? <Fact label="Observed by" value={signal.credit} /> : null}
          {signal.place ? (
            <Fact
              label={
                signal.kind === "heard"
                  ? "Operator"
                  : signal.source === "wildlife" || signal.source === "ghri"
                    ? "Project"
                    : signal.source === "sharksmart" && signal.kind === "tag"
                      ? "Receiver"
                      : signal.kind === "tag"
                        ? "Tagged"
                        : "Place"
              }
              value={signal.place}
            />
          ) : null}
        </dl>
        {signal.note ? <p className="report font-mono text-xs text-fg">{signal.note}</p> : null}
        <p className="font-mono text-xs text-muted">
          {signal.kind === "heard"
            ? "Analysts review the platform's recordings every day. A call means the whale was within earshot of the hydrophone, not at this dot."
            : signal.kind === "sighting"
              ? "A sighting, not a tag. It stays where it was recorded."
              : signal.source === "sharksmart"
                ? "The dot marks the receiver, not the shark's exact position."
                : trackState === "loading"
                  ? "Pulling the ping history…"
                  : moving
                    ? `${km !== null ? `About ${km.toLocaleString("en-US")} km along the plotted path. ` : ""}The dot follows the latest pings.`
                    : (trackError ?? "No stored path for this tag.")}
        </p>
        {signal.url ? (
          <a
            href={signal.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center font-mono text-xs text-phosphor"
          >
            {SOURCE_LINK[signal.source]}
          </a>
        ) : null}
      </div>
    </div>
  );
}

const CALL_LABEL: Record<CallStatus, string> = {
  detected: "detected",
  possible: "possibly detected",
  none: "not detected",
};

/** Species × day grid of analyst-reviewed calls, oldest day on the left. */
function CallGrid({ heard }: { heard: Heard }) {
  const days = heard.days.slice(0, 14).reverse();
  if (!days.length) return null;
  return (
    <div className="call-grid font-mono text-xs">
      <div
        className="call-grid-body"
        style={{ gridTemplateColumns: `5.5rem repeat(${days.length}, minmax(0, 1fr))` }}
      >
        {heard.species.map((species, row) => (
          <div key={species} className="contents">
            <span className="truncate pr-2 text-muted">{species.replace(/\s+whales?$/i, "")}</span>
            {days.map((day) => {
              const call = day.calls[row] ?? "none";
              return (
                <span
                  key={day.date}
                  className={`call-cell call-${call}`}
                  title={`${species} · ${day.date} · ${CALL_LABEL[call]}`}
                />
              );
            })}
          </div>
        ))}
      </div>
      <p className="mt-2 flex flex-wrap items-center justify-between gap-2 text-muted">
        <span>
          {days[0].date.slice(5)} → {days[days.length - 1].date.slice(5)}
        </span>
        <span className="inline-flex items-center gap-3">
          <span className="inline-flex items-center gap-1">
            <i className="call-cell call-detected inline-block size-2.5" /> heard
          </span>
          <span className="inline-flex items-center gap-1">
            <i className="call-cell call-possible inline-block size-2.5" /> maybe
          </span>
        </span>
      </p>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted">{label}</dt>
      <dd className="truncate text-fg">{value}</dd>
    </div>
  );
}
