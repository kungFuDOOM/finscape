import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, RefreshCw, Search } from "lucide-react";
import { getLiveRoutes, getSignals, getTrack } from "@/lib/ocean.functions";
import type { Feed, Group, Kind, LiveRoute, Signal, Track, TrackPoint } from "@/lib/ocean.types";
import { GlobeView, trackLeg } from "./globe";

type WindowKey = "48h" | "30d" | "90d" | "all";

const WINDOWS: { id: WindowKey; label: string; ms: number | null }[] = [
  { id: "48h", label: "48h", ms: 48 * 3_600_000 },
  { id: "30d", label: "30d", ms: 30 * 86_400_000 },
  { id: "90d", label: "90d", ms: 90 * 86_400_000 },
  { id: "all", label: "All", ms: null },
];

const GROUPS: { id: Group; label: string }[] = [
  { id: "whale", label: "Whales" },
  { id: "shark", label: "Sharks" },
  { id: "dolphin", label: "Dolphins" },
];

const OCEANS = [
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
  return `${Math.floor(days / 30)}mo ago`;
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

export function PelagosApp() {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState<Record<Group, boolean>>({ whale: true, shark: true, dolphin: true });
  const [windowKey, setWindowKey] = useState<WindowKey>("all");
  const [kind, setKind] = useState<Kind | "all">("tag");
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [track, setTrack] = useState<Track | null>(null);
  const [trackState, setTrackState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [now, setNow] = useState<number | null>(null);
  const [routes, setRoutes] = useState<LiveRoute[]>([]);
  const [jump, setJump] = useState<{ id: number; lat: number; lng: number; zoom: number } | null>(null);
  const jumpN = useRef(0);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async (fresh: boolean) => {
    try {
      const next = await getSignals({ data: { fresh } });
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
      void getLiveRoutes({ data: { fresh } })
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

  const visible = useMemo(() => {
    const signals = thinSightings(feed?.signals ?? []);
    const span = WINDOWS.find((item) => item.id === windowKey)?.ms ?? null;
    const parsed = Date.parse(feed?.fetchedAt ?? "");
    const stamp = now ?? (Number.isFinite(parsed) ? parsed : Date.now());
    return signals.filter((signal) => {
      if (!groups[signal.group]) return false;
      if (kind !== "all" && signal.kind !== kind) return false;
      if (span !== null) {
        const at = Date.parse(signal.observedAt);
        if (!Number.isFinite(at) || stamp - at > span) return false;
      }
      return true;
    });
  }, [feed, groups, windowKey, kind, now]);

  const counts = useMemo(() => {
    const tally = { whale: 0, shark: 0, dolphin: 0, hot: 0 };
    const stamp = now ?? Date.now();
    for (const signal of visible) {
      tally[signal.group] += 1;
      if (stamp - Date.parse(signal.observedAt) < 48 * 3_600_000) tally.hot += 1;
    }
    return tally;
  }, [visible, now]);

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
      void getTrack({ data: { id: selected.tagId! } })
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
        `${signal.name} ${signal.common} ${signal.scientific} ${signal.place ?? ""}`.toLowerCase().includes(q),
      )
    : visible;
  const list = [...matched]
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "tag" ? -1 : 1;
      return a.observedAt < b.observedAt ? 1 : -1;
    })
    .slice(0, 160);
  const movingCount = globeRoutes.length;
  const recentTags = useMemo(() => {
    const stamp = now ?? Date.now();
    return visible.filter(
      (signal) => signal.kind === "tag" && stamp - Date.parse(signal.observedAt) < 90 * 86_400_000,
    ).length;
  }, [visible, now]);

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
                <ChevronDown className={`size-4 text-phosphor ${menuOpen ? "rotate-180" : ""}`} />
              </button>
            </div>
            <div className="pointer-events-none flex shrink-0 items-start gap-2">
              <div className="hud-panel hidden items-center gap-4 px-4 py-3 md:flex">
                <Count n={counts.whale} label="whales" />
                <Count n={counts.shark} label="sharks" />
                <Count n={counts.dolphin} label="dolphins" />
              </div>
              <Clock />
            </div>
          </div>
          <div className="oceans" role="group" aria-label="Jump to an ocean">
            {OCEANS.map((ocean) => (
              <button key={ocean.id} type="button" className="hud-panel" onClick={() => goOcean(ocean)}>
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
                kind={kind}
                query={query}
                loading={loading}
                error={error}
                now={now}
                selectedId={selectedId}
                motion={motion}
                onQuery={setQuery}
                onGroup={(id) => setGroups((prev) => ({ ...prev, [id]: !prev[id] }))}
                onWindow={setWindowKey}
                onKind={setKind}
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
            track={track}
            trackState={trackState}
            moving={globeRoutes.some((route) => route.id === selected.id)}
            now={now}
            onRelease={() => setSelectedId(null)}
          />
        </aside>
      ) : (
        <div className="dock">
          <Layers kind={kind} onKind={setKind} />
          <div className="legend hud-panel pointer-events-none px-3 py-2 font-mono text-xs text-fg">
            <span className="inline-flex items-center gap-1">
              <i className="size-2.5 rounded-full bg-whale" /> Whales
            </span>
            <span className="inline-flex items-center gap-1">
              <i className="size-2.5 rounded-full bg-shark" /> Sharks
            </span>
            <span className="inline-flex items-center gap-1">
              <i className="size-2.5 rounded-full bg-dolphin" /> Dolphins
            </span>
            <span className="text-muted">
              {movingCount
                ? `${movingCount} tags · ${recentTags} pinged lately`
                : "Loading tracks"}
            </span>
          </div>
        </div>
      )}
    </main>
  );
}

function Layers({ kind, onKind }: { kind: Kind | "all"; onKind: (id: Kind | "all") => void }) {
  const items: { id: Kind | "all"; label: string }[] = [
    { id: "tag", label: "Live" },
    { id: "all", label: "All" },
    { id: "sighting", label: "Seen" },
  ];
  return (
    <div className="layer-switch hud-panel" role="group" aria-label="Map layers">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-pressed={kind === item.id}
          onClick={() => onKind(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
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
      return dLat < 0.4 && dLng < 0.4 && Math.abs(Date.parse(other.observedAt) - at) < 36 * 3_600_000;
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
  kind,
  query,
  loading,
  error,
  now,
  selectedId,
  motion,
  onQuery,
  onGroup,
  onWindow,
  onKind,
  onSelect,
  onRefresh,
}: {
  list: Signal[];
  total: number;
  groups: Record<Group, boolean>;
  windowKey: WindowKey;
  kind: Kind | "all";
  query: string;
  loading: boolean;
  error: string | null;
  now: number | null;
  selectedId: string | null;
  motion: Map<string, { kmh: number; dir: string }>;
  onQuery: (value: string) => void;
  onGroup: (id: Group) => void;
  onWindow: (id: WindowKey) => void;
  onKind: (id: Kind | "all") => void;
  onSelect: (id: string) => void;
  onRefresh: () => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <p className="font-mono text-xs text-muted">
          {loading ? "Sweeping the basins…" : `${total} signals`}
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
          {(["all", "tag", "sighting"] as const).map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={kind === item}
              onClick={() => onKind(item)}
              className={`min-h-11 rounded-full border px-3 font-mono text-xs ${
                kind === item ? "border-line bg-surface-2 text-fg" : "border-line text-muted"
              }`}
            >
              {item === "all" ? "All" : item === "tag" ? "Live" : "Seen"}
            </button>
          ))}
        </div>
        <label className="mt-3 flex min-h-11 items-center gap-2 rounded-full border border-line px-3">
          <Search className="size-4 shrink-0 text-muted" aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="Name, species, place"
            className="w-full bg-transparent font-mono text-sm text-fg outline-none placeholder:text-muted"
            type="search"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? <p className="px-3 py-3 font-mono text-xs text-shark">{error}</p> : null}
        {!loading && list.length === 0 ? (
          <p className="px-3 py-6 font-mono text-sm text-muted">Nothing in this window.</p>
        ) : (
          <ul>
            {list.map((signal) => {
              const hot = now !== null && now - Date.parse(signal.observedAt) < 48 * 3_600_000;
              const leg = motion.get(signal.id);
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
                      }`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate font-display text-base text-fg">{signal.name}</span>
                        <span className="shrink-0 font-mono text-xs text-muted">
                          {signal.kind === "tag" ? "TAG" : "SEEN"}
                        </span>
                      </span>
                      <span className="block truncate font-mono text-xs text-muted">
                        {signal.common}
                        {signal.scientific ? ` · ${signal.scientific}` : ""}
                      </span>
                      <span className="block truncate font-mono text-xs text-muted">
                        {now ? ageLabel(signal.observedAt, now) : formatUtc(signal.observedAt)}
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
      </div>
    </>
  );
});

function Dossier({
  signal,
  track,
  trackState,
  moving,
  now,
  onRelease,
}: {
  signal: Signal;
  track: Track | null;
  trackState: "idle" | "loading" | "ready" | "error";
  moving: boolean;
  now: number | null;
  onRelease: () => void;
}) {
  const points = track?.points ?? [];
  const km = points.length > 1 ? Math.round(pathKm(points)) : null;
  const leg = trackLeg(points);
  return (
    <div>
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <p className="font-mono text-xs tracking-widest text-phosphor">LOCK</p>
        <button type="button" className="min-h-11 font-mono text-xs text-muted hover:text-fg" onClick={onRelease}>
          Release
        </button>
      </div>
      <div className="space-y-3 px-4 py-3">
        <div>
          <p className="font-mono text-xs uppercase tracking-widest text-muted">
            {signal.group} · {signal.kind === "tag" ? "satellite tag" : "sighting"}
          </p>
          <h2 className="mt-1 font-display text-3xl leading-none text-fg">{signal.name}</h2>
          <p className="mt-2 font-mono text-sm text-muted">
            {signal.common}
            {signal.scientific ? ` · ${signal.scientific}` : ""}
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-3 font-mono text-xs">
          <Fact label="Last signal" value={now ? ageLabel(signal.observedAt, now) : formatUtc(signal.observedAt)} />
          <Fact label="When" value={formatUtc(signal.observedAt)} />
          {leg ? <Fact label="Course" value={pace(leg)} /> : null}
          {leg ? <Fact label="Heading" value={`${Math.round(leg.heading)}°`} /> : null}
          <Fact label="Latitude" value={signal.lat.toFixed(3)} />
          <Fact label="Longitude" value={signal.lng.toFixed(3)} />
          {signal.sex ? <Fact label="Sex" value={signal.sex} /> : null}
          {signal.length ? <Fact label="Length" value={signal.length} /> : null}
          {signal.place ? <Fact label={signal.kind === "tag" ? "Tagged" : "Place"} value={signal.place} /> : null}
        </dl>
        <p className="font-mono text-xs text-muted">
          {signal.kind === "tag"
            ? trackState === "loading"
              ? "Pulling the ping history…"
              : moving
                ? `${points.length || "Recorded"} pings${km !== null ? ` · ${km.toLocaleString("en-US")} km` : ""}. The dot follows the latest pings.`
                : track?.error
                  ? track.error
                  : "No stored path for this tag."
            : "A sighting, not a tag. It stays where it was recorded."}
        </p>
        {signal.url ? (
          <a
            href={signal.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center font-mono text-xs text-phosphor"
          >
            {signal.source === "ocearch" ? "Open on OCEARCH" : "Open on iNaturalist"}
          </a>
        ) : null}
      </div>
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
