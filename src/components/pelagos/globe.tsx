import { memo, useEffect, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import type {
  GeoJSONSource,
  Map as MapLibreMap,
  MapGeoJSONFeature,
  Marker,
  StyleSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { tileTemplate } from "@/lib/feed-client";
import { clamp, liveFix, nightPolygon, trackLeg } from "@/lib/geo";
import type { Feature, FeatureCollection } from "geojson";
import type { Group, LiveRoute, Signal } from "@/lib/ocean.types";

const COLORS: Record<Group, string> = {
  whale: "#3ee0c5",
  shark: "#ff5c45",
  dolphin: "#e2b15a",
};

const LABELS = `https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`;
const DAY = 86_400_000;
/** Tags that pinged within this window get a live marker; older ones are quiet dots. */
const LIVE_MS = 30 * DAY;

type Jump = { id: number; lat: number; lng: number; zoom: number };

type Props = {
  signals: Signal[];
  routes: LiveRoute[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  jump: Jump | null;
};

type Entry = { marker: Marker; el: HTMLButtonElement; key: string };

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

/** MapLibre zoom that shows the whole globe at ~40% of the shorter screen side. */
function fitZoom(w: number, h: number): number {
  return Math.log2((0.4 * Math.min(w, h)) / 81.5);
}

/** The app's jump zooms were written for the old renderer (radius × 1.85^z); convert them. */
function jumpZoom(base: number, legacy: number): number {
  return base + legacy * Math.log2(1.85);
}

function isLive(signal: Signal, now: number): boolean {
  if (signal.kind === "heard") return true;
  return signal.kind === "tag" && now - Date.parse(signal.observedAt) < LIVE_MS;
}

function groupColor(): unknown {
  return ["match", ["get", "group"], "whale", COLORS.whale, "dolphin", COLORS.dolphin, COLORS.shark];
}

function setNight(map: MapLibreMap, now: number) {
  const bands = [-9, -6, -3, 0, 3, 6, 9, 12].map((offset) => nightPolygon(now, offset));
  (map.getSource("night") as GeoJSONSource | undefined)?.setData({
    type: "FeatureCollection",
    features: bands,
  });
}

function buildStyle(): StyleSpecification {
  const wake = (group: Group) => ({
    id: `wake-${group}`,
    type: "line",
    source: "wakes",
    filter: ["==", ["get", "group"], group],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-width": ["interpolate", ["linear"], ["zoom"], 1, 1.2, 6, 2.6],
      "line-gradient": ["interpolate", ["linear"], ["line-progress"], 0, "rgba(0,0,0,0)", 1, COLORS[group]],
    },
  });
  const style = {
    version: 8,
    projection: { type: "globe" },
    sky: {
      "sky-color": "#071016",
      "horizon-color": "#3ee0c5",
      "fog-color": "#0d2a33",
      "sky-horizon-blend": 0.6,
      "horizon-fog-blend": 0.8,
      "fog-ground-blend": 0.9,
      "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 5, 1, 8, 0],
    },
    sources: {
      imagery: {
        type: "raster",
        tiles: [tileTemplate()],
        tileSize: 256,
        maxzoom: 16,
        attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
      },
      labels: { type: "raster", tiles: [LABELS], tileSize: 256, maxzoom: 13 },
      night: { type: "geojson", data: EMPTY },
      wakes: { type: "geojson", data: EMPTY, lineMetrics: true },
      focus: { type: "geojson", data: EMPTY },
      sightings: { type: "geojson", data: EMPTY, cluster: true, clusterRadius: 34, clusterMaxZoom: 5 },
      quiet: { type: "geojson", data: EMPTY },
    },
    layers: [
      { id: "space", type: "background", paint: { "background-color": "#071016" } },
      {
        id: "imagery",
        type: "raster",
        source: "imagery",
        paint: { "raster-saturation": -0.08, "raster-fade-duration": 200 },
      },
      {
        // Eight overlapping bands, 3° apart, stack into a soft dusk gradient.
        id: "night",
        type: "fill",
        source: "night",
        paint: {
          "fill-color": "#01060d",
          "fill-opacity": ["interpolate", ["linear"], ["zoom"], 0, 0.085, 4, 0.05, 7, 0],
          "fill-antialias": false,
        },
      },
      {
        id: "labels",
        type: "raster",
        source: "labels",
        minzoom: 3.5,
        paint: { "raster-opacity": ["interpolate", ["linear"], ["zoom"], 3.5, 0, 4.5, 0.85] },
      },
      wake("whale"),
      wake("shark"),
      wake("dolphin"),
      {
        id: "focus",
        type: "line",
        source: "focus",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#f4fff8", "line-width": 2.2, "line-opacity": 0.9 },
      },
      {
        id: "quiet",
        type: "circle",
        source: "quiet",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 2, 6, 4],
          "circle-color": groupColor(),
          "circle-opacity": 0.45,
        },
      },
      {
        id: "clusters",
        type: "circle",
        source: "sightings",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "rgba(231,244,241,0.16)",
          "circle-stroke-color": "rgba(231,244,241,0.55)",
          "circle-stroke-width": 1,
          "circle-radius": ["interpolate", ["linear"], ["get", "point_count"], 2, 6, 20, 10, 100, 15],
        },
      },
      {
        id: "sightings",
        type: "circle",
        source: "sightings",
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 2.6, 6, 5],
          "circle-color": groupColor(),
          "circle-opacity": 0.8,
          "circle-stroke-color": "rgba(7,16,22,0.8)",
          "circle-stroke-width": 1,
        },
      },
    ],
  };
  return style as unknown as StyleSpecification;
}

function point(signal: Signal): Feature {
  return {
    type: "Feature",
    properties: { id: signal.id, group: signal.group, name: signal.name, common: signal.common },
    geometry: { type: "Point", coordinates: [signal.lng, signal.lat] },
  };
}

function GlobeViewInner({ signals, routes, selectedId, onSelect, jump }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef(new Map<string, Entry>());
  const tipRef = useRef<HTMLDivElement | null>(null);
  const spinRef = useRef(true);
  const onSelectRef = useRef(onSelect);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  onSelectRef.current = onSelect;

  // Create the map once. MapLibre touches `window` on import, so load it in the browser only.
  useEffect(() => {
    let cancelled = false;
    let map: MapLibreMap | null = null;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    spinRef.current = !reduced;
    void import("maplibre-gl")
      .then(({ default: maplibregl }) => {
        const wrap = wrapRef.current;
        if (cancelled || !wrap) return;
        const base = fitZoom(wrap.clientWidth, wrap.clientHeight);
        try {
          map = new maplibregl.Map({
            container: wrap,
            style: buildStyle(),
            center: [-40, 22],
            zoom: base,
            minZoom: base - 0.6,
            maxZoom: 13,
            attributionControl: false,
            dragRotate: false,
            pitchWithRotate: false,
            touchPitch: false,
            maxPitch: 0,
            renderWorldCopies: false,
            fadeDuration: 150,
          });
        } catch (error) {
          setFailed(error instanceof Error ? error.message : "WebGL unavailable");
          return;
        }
        const m = map;
        // Credit up top, where it never sits under the dock or the animal card.
        m.addControl(new maplibregl.AttributionControl({ compact: true }), "top-right");
        m.touchZoomRotate.disableRotation();
        m.keyboard.disableRotation();
        mapRef.current = m;

        const stopSpin = () => {
          spinRef.current = false;
        };
        // Spin slowly until the first interaction, like a globe on a desk.
        const spin = () => {
          if (!spinRef.current || m.getZoom() > base + 1) return;
          const center = m.getCenter();
          center.lng -= 3;
          m.easeTo({ center, duration: 2000, easing: (n) => n });
        };
        m.on("mousedown", stopSpin);
        m.on("touchstart", stopSpin);
        m.on("wheel", stopSpin);
        m.on("moveend", spin);

        const select = (event: { features?: MapGeoJSONFeature[] }) => {
          const id = event.features?.[0]?.properties?.id;
          if (typeof id === "string") onSelectRef.current(id);
        };
        m.on("click", "sightings", select);
        m.on("click", "quiet", select);
        m.on("click", "clusters", (event) => {
          const feature = event.features?.[0];
          const source = m.getSource("sightings") as GeoJSONSource | undefined;
          const clusterId = feature?.properties?.cluster_id;
          if (!feature || !source || typeof clusterId !== "number" || feature.geometry.type !== "Point") return;
          stopSpin();
          const [lng, lat] = feature.geometry.coordinates;
          void source.getClusterExpansionZoom(clusterId).then((zoom) => {
            m.easeTo({ center: [lng, lat], zoom: Math.min(zoom + 0.3, 9), duration: 600 });
          });
        });

        // Desktop hover: name and species beside the cursor.
        const showTip = (event: { point: { x: number; y: number }; features?: MapGeoJSONFeature[] }) => {
          const tip = tipRef.current;
          const props = event.features?.[0]?.properties;
          if (!tip || !props) return;
          m.getCanvas().style.cursor = "pointer";
          tip.textContent = "";
          const name = document.createElement("strong");
          name.textContent = String(props.name ?? "");
          const sub = document.createElement("span");
          sub.textContent = String(props.common ?? "");
          tip.append(name, sub);
          tip.style.transform = `translate(${event.point.x + 14}px, ${event.point.y - 46}px)`;
          tip.hidden = false;
        };
        const hideTip = () => {
          m.getCanvas().style.cursor = "";
          if (tipRef.current) tipRef.current.hidden = true;
        };
        for (const layer of ["sightings", "quiet"]) {
          m.on("mousemove", layer, showTip);
          m.on("mouseleave", layer, hideTip);
        }
        m.on("mouseenter", "clusters", () => {
          m.getCanvas().style.cursor = "zoom-in";
        });
        m.on("mouseleave", "clusters", hideTip);

        m.on("load", () => {
          if (cancelled) return;
          setNight(m, Date.now());
          setReady(true);
          spin();
        });
      })
      .catch((error: unknown) => {
        setFailed(error instanceof Error ? error.message : "Map failed to load");
      });
    // Live markers drift with dead reckoning, and the night side moves with the sun.
    const timer = window.setInterval(() => {
      setTick((value) => value + 1);
      const m = mapRef.current;
      if (m?.isStyleLoaded()) setNight(m, Date.now());
    }, 60_000);
    const markers = markersRef.current;
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      for (const entry of markers.values()) entry.marker.remove();
      markers.clear();
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  // Push data into the map: clustered sightings, quiet tags, wakes, and DOM markers for live ones.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const now = Date.now();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const routeById = new Map(routes.map((route) => [route.id, route]));
    const sightings: Feature[] = [];
    const quiet: Feature[] = [];
    const live: Signal[] = [];
    for (const signal of signals) {
      if (signal.id === selectedId || isLive(signal, now)) live.push(signal);
      else if (signal.kind === "sighting") sightings.push(point(signal));
      else quiet.push(point(signal));
    }
    (map.getSource("sightings") as GeoJSONSource).setData({ type: "FeatureCollection", features: sightings });
    (map.getSource("quiet") as GeoJSONSource).setData({ type: "FeatureCollection", features: quiet });

    // Wakes: the last month of each live tag's path, fading toward its tail.
    const wakes: Feature[] = [];
    for (const signal of live) {
      const route = routeById.get(signal.id);
      if (!route || route.points.length < 2 || signal.id === selectedId) continue;
      const lastAt = Date.parse(route.points[route.points.length - 1].at);
      const tail = route.points.filter((p) => lastAt - Date.parse(p.at) <= LIVE_MS).slice(-24);
      if (tail.length < 2) continue;
      wakes.push({
        type: "Feature",
        properties: { group: signal.group },
        geometry: { type: "LineString", coordinates: tail.map((p) => [p.lng, p.lat]) },
      });
    }
    (map.getSource("wakes") as GeoJSONSource).setData({ type: "FeatureCollection", features: wakes });

    const focus = selectedId ? routeById.get(selectedId) : undefined;
    (map.getSource("focus") as GeoJSONSource).setData(
      focus && focus.points.length > 1
        ? {
            type: "Feature",
            properties: {},
            geometry: { type: "LineString", coordinates: focus.points.map((p) => [p.lng, p.lat]) },
          }
        : EMPTY,
    );

    // DOM markers: real buttons, crisp at any density, animated in CSS.
    let cancelled = false;
    void import("maplibre-gl").then(({ default: maplibregl }) => {
      if (cancelled) return;
      const markers = markersRef.current;
      const keep = new Set<string>();
      for (const signal of live) {
        keep.add(signal.id);
        const route = routeById.get(signal.id);
        const at = route && route.points.length > 1 ? liveFix(route.points, now, reduced) : signal;
        const leg = route ? trackLeg(route.points) : null;
        const hot = signal.kind === "tag" && now - Date.parse(signal.observedAt) < 2 * DAY;
        const hearing = signal.kind === "heard" && Boolean(signal.heard?.recent.length);
        const selected = signal.id === selectedId;
        const key = `${signal.kind}|${signal.group}|${hot}|${hearing}|${selected}|${Math.round(leg?.heading ?? -1)}|${signal.name}`;
        let entry = markers.get(signal.id);
        if (!entry) {
          const el = document.createElement("button");
          el.type = "button";
          const id = signal.id;
          el.addEventListener("click", (event) => {
            event.stopPropagation();
            spinRef.current = false;
            onSelectRef.current(id);
          });
          const marker = new maplibregl.Marker({ element: el, anchor: "center", opacityWhenCovered: "0" })
            .setLngLat([at.lng, at.lat])
            .addTo(map);
          entry = { marker, el, key: "" };
          markers.set(signal.id, entry);
        } else {
          entry.marker.setLngLat([at.lng, at.lat]);
        }
        if (entry.key === key) continue;
        entry.key = key;
        const el = entry.el;
        // Keep MapLibre's own marker classes: they position the element.
        el.className = [
          ...[...el.classList].filter((name) => name.startsWith("maplibregl-")),
          "fs-marker",
          `fs-${signal.group}`,
          `fs-kind-${signal.kind}`,
          hot || hearing ? "fs-hot" : "",
          selected ? "fs-selected" : "",
        ]
          .filter(Boolean)
          .join(" ");
        el.style.zIndex = selected ? "3" : hot || hearing ? "2" : "1";
        el.setAttribute("aria-label", `${signal.name}, ${signal.common}`);
        el.textContent = "";
        const dot = document.createElement("span");
        dot.className = "fs-dot";
        el.append(dot);
        if (leg && signal.kind === "tag") {
          const arrow = document.createElement("span");
          arrow.className = "fs-heading";
          arrow.style.transform = `rotate(${Math.round(leg.heading)}deg)`;
          el.append(arrow);
        }
        const label = document.createElement("span");
        label.className = "fs-label";
        label.textContent = signal.name.length > 22 ? `${signal.name.slice(0, 21)}…` : signal.name;
        el.append(label);
      }
      for (const [id, entry] of markers) {
        if (keep.has(id)) continue;
        entry.marker.remove();
        markers.delete(id);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [ready, signals, routes, selectedId, tick]);

  // Fly to a newly selected signal.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !selectedId) return;
    const signal = signals.find((item) => item.id === selectedId);
    if (!signal) return;
    const route = routes.find((item) => item.id === selectedId);
    const at = route && route.points.length > 1 ? liveFix(route.points, Date.now(), false) : signal;
    spinRef.current = false;
    const wrap = wrapRef.current;
    const base = wrap ? fitZoom(wrap.clientWidth, wrap.clientHeight) : 1.5;
    map.flyTo({
      center: [at.lng, clamp(at.lat, -80, 80)],
      zoom: Math.max(map.getZoom(), base + 2.6),
      speed: 1.4,
      curve: 1.5,
    });
    // Only on selection changes (and once the signal first shows up); refreshes must not
    // yank the camera back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, selectedId, Boolean(signals.find((item) => item.id === selectedId))]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !jump) return;
    spinRef.current = false;
    const wrap = wrapRef.current;
    const base = wrap ? fitZoom(wrap.clientWidth, wrap.clientHeight) : 1.5;
    map.flyTo({ center: [jump.lng, jump.lat], zoom: jumpZoom(base, jump.zoom), speed: 1.3 });
  }, [ready, jump]);

  // Names appear once the globe is close enough for them not to pile up.
  useEffect(() => {
    const map = mapRef.current;
    const wrap = wrapRef.current;
    if (!ready || !map || !wrap) return;
    const sync = () => {
      const base = fitZoom(wrap.clientWidth, wrap.clientHeight);
      wrap.classList.toggle("fs-named", map.getZoom() > base + 1.3);
    };
    sync();
    map.on("zoomend", sync);
    return () => {
      map.off("zoomend", sync);
    };
  }, [ready]);

  const zoomBy = (delta: number) => {
    spinRef.current = false;
    const map = mapRef.current;
    if (map) map.easeTo({ zoom: map.getZoom() + delta, duration: 350 });
  };

  return (
    <div className="globe-stage absolute inset-0 bg-bg">
      {/* MapLibre makes its container position: relative, so it needs an explicit full size. */}
      <div ref={wrapRef} className="pelagos-map h-full w-full" aria-label="Ocean globe" />
      <div ref={tipRef} className="fs-tip" hidden />
      {failed ? (
        <div className="absolute inset-0 grid place-items-center p-6 text-center font-mono text-sm text-muted">
          <p>
            The 3D globe needs WebGL, which this browser has turned off.
            <br />
            The Signals list still shows every animal.
          </p>
        </div>
      ) : null}
      <div className="zoom-stack">
        <button
          type="button"
          className="hud-panel grid size-11 place-items-center text-fg"
          onClick={() => zoomBy(1)}
          aria-label="Zoom in"
        >
          <Plus className="size-4" />
        </button>
        <button
          type="button"
          className="hud-panel grid size-11 place-items-center text-fg"
          onClick={() => zoomBy(-1)}
          aria-label="Zoom out"
        >
          <Minus className="size-4" />
        </button>
      </div>
    </div>
  );
}

export const GlobeView = memo(GlobeViewInner);
