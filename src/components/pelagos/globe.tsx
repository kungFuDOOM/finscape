import { memo, useEffect, useRef } from "react";
import { Minus, Plus } from "lucide-react";
import type { Group, LiveRoute, Signal, TrackPoint } from "@/lib/ocean.types";

const COLORS: Record<Group, string> = {
  whale: "#3ee0c5",
  shark: "#ff5c45",
  dolphin: "#e2b15a",
};

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const ZOOM_MIN = 0;
const ZOOM_MAX = 7.2;

type Dot = {
  id: string;
  lat: number;
  lng: number;
  group: Group;
  moving: boolean;
  kind: Signal["kind"];
  name: string;
  heading: number | null;
  fresh: boolean;
};
type Hit = { id: string; x: number; y: number };
type View = { zoom: number; lng: number; lat: number };
type Jump = { id: number; lat: number; lng: number; zoom: number };
type Basis = {
  fx: number;
  fy: number;
  fz: number;
  rx: number;
  ry: number;
  rz: number;
  ux: number;
  uy: number;
  uz: number;
};
type TileEntry = {
  img: HTMLImageElement;
  ready: boolean;
  pixels: Uint8ClampedArray | null;
  w: number;
  h: number;
};

type Props = {
  signals: Signal[];
  routes: LiveRoute[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  jump: Jump | null;
};

function wrapLng(lng: number): number {
  let value = lng;
  while (value > 180) value -= 360;
  while (value < -180) value += 360;
  return value;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function deltaLng(from: number, to: number): number {
  let d = to - from;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

function along(points: TrackPoint[], t: number): { lat: number; lng: number } {
  if (points.length === 1) return points[0];
  const scaled = t * (points.length - 1);
  const index = Math.min(points.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = points[index];
  const b = points[index + 1];
  let dLng = b.lng - a.lng;
  if (dLng > 180) dLng -= 360;
  if (dLng < -180) dLng += 360;
  return { lat: a.lat + (b.lat - a.lat) * mix, lng: wrapLng(a.lng + dLng * mix) };
}

function kmBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = (b.lat - a.lat) * 111;
  const dLng = deltaLng(a.lng, b.lng) * 111 * Math.cos(((a.lat + b.lat) / 2) * D2R);
  return Math.hypot(dLat, dLng);
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

export function trackLeg(points: TrackPoint[]): { kmh: number; heading: number; dir: string } | null {
  if (points.length < 2) return null;
  const a = points[points.length - 2];
  const b = points[points.length - 1];
  const hop = Date.parse(b.at) - Date.parse(a.at);
  if (!Number.isFinite(hop) || hop < 60_000 || hop > 36 * 3_600_000) return null;
  const km = kmBetween(a, b);
  const kmh = km / (hop / 3_600_000);
  if (km < 0.4 || kmh < 0.15 || kmh > 40) return null;
  const dLng = deltaLng(a.lng, b.lng) * D2R;
  const φ1 = a.lat * D2R;
  const φ2 = b.lat * D2R;
  const y = Math.sin(dLng) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dLng);
  const heading = (Math.atan2(y, x) * R2D + 360) % 360;
  return { kmh, heading, dir: COMPASS[Math.round(heading / 45) % 8] };
}

function destination(lat: number, lng: number, heading: number, km: number) {
  const d = km / 6371;
  const br = heading * D2R;
  const φ1 = lat * D2R;
  const λ1 = lng * D2R;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(br));
  const λ2 =
    λ1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(φ1), Math.cos(d) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: (φ2 * R2D), lng: wrapLng((λ2 * R2D)) };
}

function liveFix(points: TrackPoint[], now: number, hold: boolean): { lat: number; lng: number } {
  const last = points[points.length - 1];
  if (points.length < 2) return last;
  const lastAt = Date.parse(last.at);
  if (!Number.isFinite(lastAt)) return last;
  if (now < lastAt) {
    for (let i = 1; i < points.length; i += 1) {
      const t0 = Date.parse(points[i - 1].at);
      const t1 = Date.parse(points[i].at);
      if (!Number.isFinite(t0) || !Number.isFinite(t1) || now > t1) continue;
      const span = t1 - t0;
      const mix = span > 0 ? clamp((now - t0) / span, 0, 1) : 1;
      return along([points[i - 1], points[i]], mix);
    }
    return last;
  }
  if (hold) return last;
  const prev = points[points.length - 2];
  const prevAt = Date.parse(prev.at);
  const hop = lastAt - prevAt;
  const km = kmBetween(prev, last);
  if (!Number.isFinite(prevAt) || hop < 60_000 || hop > 36 * 3_600_000) return last;
  const kmh = km / (hop / 3_600_000);
  if (km < 0.4 || kmh < 0.15 || kmh > 25) return last;
  const age = now - lastAt;
  if (age > 8 * 3_600_000) return last;
  const extraKm = Math.min(kmh * (age / 3_600_000), 40);
  const frac = extraKm / km;
  return {
    lat: clamp(last.lat + (last.lat - prev.lat) * frac, -85, 85),
    lng: wrapLng(last.lng + deltaLng(prev.lng, last.lng) * frac),
  };
}

function radiusFor(zoom: number, w: number, h: number): number {
  return Math.min(w, h) * 0.4 * Math.pow(1.85, zoom);
}

function basis(lat: number, lng: number): Basis {
  const φ = lat * D2R;
  const λ = lng * D2R;
  const cφ = Math.cos(φ);
  const sφ = Math.sin(φ);
  const cλ = Math.cos(λ);
  const sλ = Math.sin(λ);
  const fx = cφ * cλ;
  const fy = cφ * sλ;
  const fz = sφ;
  let rx = -fy;
  let ry = fx;
  const rl = Math.hypot(rx, ry) || 1;
  rx /= rl;
  ry /= rl;
  const rz = 0;
  const ux = fy * rz - fz * ry;
  const uy = fz * rx - fx * rz;
  const uz = fx * ry - fy * rx;
  return { fx, fy, fz, rx, ry, rz, ux, uy, uz };
}

function project(
  lat: number,
  lng: number,
  b: Basis,
  cx: number,
  cy: number,
  radius: number,
): { x: number; y: number } | null {
  const φ = lat * D2R;
  const λ = lng * D2R;
  const cφ = Math.cos(φ);
  const x = cφ * Math.cos(λ);
  const y = cφ * Math.sin(λ);
  const z = Math.sin(φ);
  const nz = x * b.fx + y * b.fy + z * b.fz;
  if (nz < 0.04) return null;
  const nx = x * b.rx + y * b.ry + z * b.rz;
  const ny = x * b.ux + y * b.uy + z * b.uz;
  return { x: cx + nx * radius, y: cy - ny * radius };
}

function tileX(lng: number, z: number): number {
  return ((lng + 180) / 360) * 2 ** z;
}

function tileY(lat: number, z: number): number {
  const s = Math.sin(clamp(lat, -85, 85) * D2R);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z;
}

function GlobeViewInner({ signals, routes, selectedId, onSelect, jump }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const signalsRef = useRef(signals);
  const routesRef = useRef(routes);
  const selectedRef = useRef(selectedId);
  const onSelectRef = useRef(onSelect);
  const jumpRef = useRef(jump);
  const viewRef = useRef<View>({ zoom: 0, lng: -40, lat: 18 });
  const targetRef = useRef<View>({ zoom: 0, lng: -40, lat: 18 });
  const hitsRef = useRef<Hit[]>([]);
  signalsRef.current = signals;
  routesRef.current = routes;
  selectedRef.current = selectedId;
  onSelectRef.current = onSelect;
  jumpRef.current = jump;

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const earth = new Image();
    earth.src = "/earth.jpg";
    let earthPx: Uint8ClampedArray | null = null;
    let earthW = 0;
    let earthH = 0;
    earth.onload = () => {
      const scratch = document.createElement("canvas");
      scratch.width = earth.width;
      scratch.height = earth.height;
      const ictx = scratch.getContext("2d", { willReadFrequently: true });
      if (!ictx) return;
      ictx.drawImage(earth, 0, 0);
      const data = ictx.getImageData(0, 0, scratch.width, scratch.height);
      earthPx = data.data;
      earthW = scratch.width;
      earthH = scratch.height;
      dirty = true;
    };

    const tiles = new Map<string, TileEntry>();
    let dirty = true;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const pointers = new Map<number, { x: number; y: number }>();
    let frame = 0;
    let dragged = 0;
    let spin = false;
    let velLat = 0;
    let velLng = 0;
    let filtDx = 0;
    let filtDy = 0;
    let lastGesture = 0;
    let prevFrame = performance.now();
    let pinchDist = 0;
    let pinchX = 0;
    let pinchY = 0;
    let lastTap = 0;
    let lastTapX = 0;
    let lastTapY = 0;
    let lastSelected: string | null = null;
    let seenJump = 0;
    let seenKey = "";
    let tileClock = 0;
    const shown = new Map<string, { lat: number; lng: number }>();
    let terrain: HTMLCanvasElement | null = null;
    let terrainCtx: CanvasRenderingContext2D | null = null;
    let buf: ImageData | null = null;

    const lookupTile = (z: number, x: number, y: number): TileEntry | null => {
      const n = 2 ** z;
      if (y < 0 || y >= n) return null;
      const wrapped = ((x % n) + n) % n;
      return tiles.get(`${z}/${y}/${wrapped}`) ?? null;
    };

    const requestTile = (z: number, x: number, y: number) => {
      const n = 2 ** z;
      if (y < 0 || y >= n || z < 0 || z > 10) return;
      const wrapped = ((x % n) + n) % n;
      const key = `${z}/${y}/${wrapped}`;
      if (tiles.has(key)) return;
      const img = new Image();
      const created: TileEntry = { img, ready: false, pixels: null, w: 0, h: 0 };
      img.onload = () => {
        const scratch = document.createElement("canvas");
        scratch.width = img.width;
        scratch.height = img.height;
        const ictx = scratch.getContext("2d", { willReadFrequently: true });
        if (!ictx) return;
        ictx.drawImage(img, 0, 0);
        created.pixels = ictx.getImageData(0, 0, scratch.width, scratch.height).data;
        created.w = scratch.width;
        created.h = scratch.height;
        created.ready = true;
        tileClock = performance.now();
        dirty = true;
      };
      img.src = `/api/sat/${z}/${y}/${wrapped}`;
      tiles.set(key, created);
      if (tiles.size > 180) {
        const oldest = tiles.keys().next().value;
        if (oldest) tiles.delete(oldest);
      }
    };

    const sample = (lat: number, lng: number, z: number): [number, number, number] => {
      for (let level = z; level >= 3; level -= 1) {
        const tx = tileX(lng, level);
        const ty = tileY(lat, level);
        const ix = Math.floor(tx);
        const iy = Math.floor(ty);
        const entry = lookupTile(level, ix, iy);
        if (!entry?.pixels) continue;
        const u = clamp(Math.floor((tx - ix) * entry.w), 0, entry.w - 1);
        const v = clamp(Math.floor((ty - iy) * entry.h), 0, entry.h - 1);
        const i = (v * entry.w + u) * 4;
        return [entry.pixels[i], entry.pixels[i + 1], entry.pixels[i + 2]];
      }
      if (earthPx) {
        let u = ((lng + 180) / 360) * earthW;
        u = ((u % earthW) + earthW) % earthW;
        const v = clamp(((90 - lat) / 180) * earthH, 0, earthH - 1);
        const i = (Math.floor(v) * earthW + Math.floor(u)) * 4;
        return [earthPx[i], earthPx[i + 1], earthPx[i + 2]];
      }
      return [14, 92, 122];
    };

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = wrap.clientWidth || window.innerWidth;
      const h = wrap.clientHeight || window.innerHeight;
      canvas.width = Math.max(2, Math.floor(w * dpr));
      canvas.height = Math.max(2, Math.floor(h * dpr));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      dirty = true;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);

    const screenPoint = (clientX: number, clientY: number, b: Basis, radius: number, w: number, h: number) => {
      const rect = canvas.getBoundingClientRect();
      const sx = clientX - rect.left;
      const sy = clientY - rect.top;
      const nx = (sx - w / 2) / radius;
      const ny = (h / 2 - sy) / radius;
      const r2 = nx * nx + ny * ny;
      if (r2 > 1) return null;
      const nz = Math.sqrt(1 - r2);
      const wx = nx * b.rx + ny * b.ux + nz * b.fx;
      const wy = nx * b.ry + ny * b.uy + nz * b.fy;
      const wz = nx * b.rz + ny * b.uz + nz * b.fz;
      return {
        lat: Math.asin(clamp(wz, -1, 1)) * R2D,
        lng: Math.atan2(wy, wx) * R2D,
      };
    };

    const zoomAbout = (clientX: number, clientY: number, before: number) => {
      const aim = targetRef.current;
      const shown = viewRef.current;
      const w = wrap.clientWidth || window.innerWidth;
      const h = wrap.clientHeight || window.innerHeight;
      const r0 = radiusFor(before, w, h);
      const r1 = radiusFor(aim.zoom, w, h);
      const pull = clamp(1 - r0 / r1, -0.82, 0.82);
      if (Math.abs(pull) < 0.001) return;
      const spot = screenPoint(clientX, clientY, basis(shown.lat, shown.lng), radiusFor(shown.zoom, w, h), w, h);
      if (!spot) return;
      aim.lat = clamp(aim.lat + (spot.lat - aim.lat) * pull, -85, 85);
      aim.lng = wrapLng(aim.lng + deltaLng(aim.lng, spot.lng) * pull);
    };

    const applyDrag = (dx: number, dy: number, dtMs: number) => {
      filtDx = filtDx * 0.22 + dx * 0.78;
      filtDy = filtDy * 0.22 + dy * 0.78;
      const aim = targetRef.current;
      const w = wrap.clientWidth || window.innerWidth;
      const h = wrap.clientHeight || window.innerHeight;
      const radius = Math.max(80, radiusFor(aim.zoom, w, h));
      const dLat = (filtDy / radius) * R2D;
      const cos = Math.max(0.22, Math.cos(aim.lat * D2R));
      const dLng = -(filtDx / (radius * cos)) * R2D;
      aim.lat = clamp(aim.lat + dLat, -85, 85);
      aim.lng = wrapLng(aim.lng + dLng);
      const perFrame = 16.67 / Math.max(8, Math.min(48, dtMs));
      velLat = dLat * perFrame;
      velLng = dLng * perFrame;
      spin = false;
    };

    const paint = (now: number) => {
      const w = wrap.clientWidth || window.innerWidth;
      const h = wrap.clientHeight || window.innerHeight;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) resize();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const view = viewRef.current;
      const aim = targetRef.current;
      const dt = Math.min(48, Math.max(1, now - prevFrame));
      prevFrame = now;
      const interacting = pointers.size > 0;
      if (!interacting && !reduced && (Math.abs(velLat) > 0.004 || Math.abs(velLng) > 0.004)) {
        const step = dt / 16.67;
        aim.lat = clamp(aim.lat + velLat * step, -85, 85);
        aim.lng = wrapLng(aim.lng + velLng * step);
        const friction = Math.exp(-dt / 340);
        velLat *= friction;
        velLng *= friction;
      } else if (!interacting) {
        velLat = 0;
        velLng = 0;
      }
      if (spin && !interacting && !reduced && aim.zoom < 0.25 && Math.abs(velLng) < 0.01) {
        aim.lng = wrapLng(aim.lng + 0.07 * (dt / 16.67));
      }
      if (selectedRef.current !== lastSelected) {
        lastSelected = selectedRef.current;
        const picked = signalsRef.current.find((signal) => signal.id === lastSelected);
        if (picked) {
          const route = routesRef.current.find((item) => item.id === picked.id);
          const fix = route && route.points.length > 1 ? liveFix(route.points, Date.now(), reduced) : null;
          aim.lng = fix?.lng ?? picked.lng;
          aim.lat = clamp(fix?.lat ?? picked.lat, -85, 85);
          aim.zoom = Math.max(aim.zoom, 3.1);
          spin = false;
          velLat = 0;
          velLng = 0;
        }
      }
      const nextJump = jumpRef.current;
      if (nextJump && nextJump.id !== seenJump) {
        seenJump = nextJump.id;
        aim.lat = clamp(nextJump.lat, -85, 85);
        aim.lng = wrapLng(nextJump.lng);
        aim.zoom = clamp(nextJump.zoom, ZOOM_MIN, ZOOM_MAX);
        spin = false;
        velLat = 0;
        velLng = 0;
      }
      const tau = reduced ? 1 : interacting ? 28 : 88;
      const follow = reduced ? 1 : 1 - Math.exp(-dt / tau);
      const gapLat = aim.lat - view.lat;
      const gapLng = deltaLng(view.lng, aim.lng);
      const gapZoom = aim.zoom - view.zoom;
      if (Math.abs(gapLat) > 0.0005 || Math.abs(gapLng) > 0.0005 || Math.abs(gapZoom) > 0.0005) {
        view.lat = clamp(view.lat + gapLat * follow, -85, 85);
        view.lng = wrapLng(view.lng + gapLng * follow);
        view.zoom = clamp(view.zoom + gapZoom * follow, ZOOM_MIN, ZOOM_MAX);
        dirty = true;
      }
      const gliding =
        Math.abs(aim.lat - view.lat) > 0.02 ||
        Math.abs(deltaLng(view.lng, aim.lng)) > 0.02 ||
        Math.abs(aim.zoom - view.zoom) > 0.012;

      const radius = radiusFor(view.zoom, w, h);
      const b = basis(view.lat, view.lng);
      const movingCamera = interacting || gliding || Math.abs(velLat) > 0.004 || Math.abs(velLng) > 0.004 || spin;
      const settling = performance.now() - tileClock < 220;
      const stride = movingCamera || settling ? (w * h > 900000 ? 3 : 2) : 1;
      const bw = Math.max(2, Math.ceil(w / stride));
      const bh = Math.max(2, Math.ceil(h / stride));
      if (!terrain || terrain.width !== bw || terrain.height !== bh) {
        terrain = document.createElement("canvas");
        terrain.width = bw;
        terrain.height = bh;
        terrainCtx = terrain.getContext("2d", { willReadFrequently: true });
        buf = null;
        dirty = true;
      }
      const viewKey = `${view.lat.toFixed(2)}|${view.lng.toFixed(2)}|${view.zoom.toFixed(2)}|${bw}|${bh}`;
      if (viewKey !== seenKey) {
        seenKey = viewKey;
        dirty = true;
      }
      if (dirty && terrainCtx && terrain) {
        if (!buf || buf.width !== bw || buf.height !== bh) buf = terrainCtx.createImageData(bw, bh);
        const pix = buf.data;
        const cx = w / 2;
        const cy = h / 2;
        const detail =
          radius > Math.min(w, h) * 0.72
            ? clamp(Math.round(Math.log2(((radius * Math.PI) / 180) * (360 / 256))), 3, 10)
            : 0;
        if (detail >= 3) {
          const tilePx = ((360 / 2 ** detail) * radius * Math.PI) / 180;
          const step = Math.max(36, Math.min(tilePx * 0.75, 240));
          for (let sy = 0; sy <= h; sy += step) {
            for (let sx = 0; sx <= w; sx += step) {
              const nnx = (sx - w / 2) / radius;
              const nny = (h / 2 - sy) / radius;
              const rr = nnx * nnx + nny * nny;
              if (rr > 1) continue;
              const nnz = Math.sqrt(1 - rr);
              const wwx = nnx * b.rx + nny * b.ux + nnz * b.fx;
              const wwy = nnx * b.ry + nny * b.uy + nnz * b.fy;
              const wwz = nnx * b.rz + nny * b.uz + nnz * b.fz;
              const plat = Math.asin(clamp(wwz, -1, 1)) * R2D;
              const plng = Math.atan2(wwy, wwx) * R2D;
              requestTile(detail, Math.floor(tileX(plng, detail)), Math.floor(tileY(plat, detail)));
              if (detail > 4) {
                requestTile(
                  detail - 1,
                  Math.floor(tileX(plng, detail - 1)),
                  Math.floor(tileY(plat, detail - 1)),
                );
              }
            }
          }
        }
        for (let y = 0; y < bh; y += 1) {
          const ny = (cy - (y + 0.5) * stride) / radius;
          const row = y * bw;
          for (let x = 0; x < bw; x += 1) {
            const nx = ((x + 0.5) * stride - cx) / radius;
            const i = (row + x) * 4;
            const r2 = nx * nx + ny * ny;
            if (r2 > 1) {
              pix[i + 3] = 0;
              continue;
            }
            const nz = Math.sqrt(1 - r2);
            const wx = nx * b.rx + ny * b.ux + nz * b.fx;
            const wy = nx * b.ry + ny * b.uy + nz * b.fy;
            const wz = nx * b.rz + ny * b.uz + nz * b.fz;
            const lat = Math.asin(clamp(wz, -1, 1)) * R2D;
            const lng = Math.atan2(wy, wx) * R2D;
            const color = sample(lat, lng, detail);
            const light = 0.78 + 0.22 * nz;
            pix[i] = color[0] * light;
            pix[i + 1] = color[1] * light;
            pix[i + 2] = color[2] * light;
            pix[i + 3] = 255;
          }
        }
        terrainCtx.putImageData(buf, 0, 0);
        dirty = false;
      }

      ctx.fillStyle = "#071016";
      ctx.fillRect(0, 0, w, h);
      if (radius < Math.min(w, h) * 0.72) {
        const glow = ctx.createRadialGradient(w / 2, h / 2, radius * 0.92, w / 2, h / 2, radius * 1.14);
        glow.addColorStop(0, "rgba(62,224,197,0)");
        glow.addColorStop(1, "rgba(62,224,197,0.22)");
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(w / 2, h / 2, radius * 1.14, 0, Math.PI * 2);
        ctx.fill();
      }
      if (terrain) {
        ctx.imageSmoothingEnabled = stride > 1;
        ctx.drawImage(terrain, 0, 0, w, h);
      }
      if (radius < Math.hypot(w, h) * 0.55) {
        ctx.beginPath();
        ctx.arc(w / 2, h / 2, radius, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(62,224,197,0.7)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      const wall = Date.now();
      const moving = new Map<string, { lat: number; lng: number }>();
      const legs = new Map<string, { heading: number }>();
      for (const route of routesRef.current) {
        if (route.points.length < 2) continue;
        moving.set(route.id, liveFix(route.points, wall, reduced));
        const leg = trackLeg(route.points);
        if (leg) legs.set(route.id, leg);
      }
      const dotFollow = reduced ? 1 : 1 - Math.exp(-dt / 1600);
      const dots: Dot[] = signalsRef.current.map((signal) => {
        const live = moving.get(signal.id);
        const targetLat = live?.lat ?? signal.lat;
        const targetLng = live?.lng ?? signal.lng;
        const prev = shown.get(signal.id);
        let lat = targetLat;
        let lng = targetLng;
        if (prev && kmBetween(prev, { lat: targetLat, lng: targetLng }) < 250) {
          lat = prev.lat + (targetLat - prev.lat) * dotFollow;
          lng = wrapLng(prev.lng + deltaLng(prev.lng, targetLng) * dotFollow);
        }
        shown.set(signal.id, { lat, lng });
        return {
          id: signal.id,
          lat,
          lng,
          group: signal.group,
          moving: Boolean(live),
          kind: signal.kind,
          name: signal.name,
          heading: legs.get(signal.id)?.heading ?? null,
          fresh: Date.now() - Date.parse(signal.observedAt) < 120 * 86_400_000,
        };
      });
      dots.sort((a, b) => Number(a.kind === "tag") - Number(b.kind === "tag"));
      const focus = routesRef.current.find((route) => route.id === selectedRef.current)?.points ?? null;
      const hits: Hit[] = [];
      const put = (lat: number, lng: number) => project(lat, lng, b, w / 2, h / 2, radius);

      if (focus && focus.length > 1) {
        ctx.beginPath();
        let started = false;
        for (const point of focus) {
          const p = put(point.lat, point.lng);
          if (!p) {
            started = false;
            continue;
          }
          if (!started) {
            ctx.moveTo(p.x, p.y);
            started = true;
          } else ctx.lineTo(p.x, p.y);
        }
        ctx.strokeStyle = "rgba(244,255,248,0.9)";
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      const dotScale = clamp(0.85 + view.zoom * 0.12, 0.85, 2.4);
      for (const dot of dots) {
        const p = put(dot.lat, dot.lng);
        if (!p || p.x < -24 || p.y < -24 || p.x > w + 24 || p.y > h + 24) continue;
        const sighting = dot.kind === "sighting";
        const quiet = dot.kind === "tag" && !dot.fresh;
        const size =
          (dot.id === selectedRef.current ? 7 : dot.fresh && dot.moving ? 4.6 : quiet ? 2 : sighting ? 2.2 : 3.2) *
          dotScale;
        if (!sighting && !quiet) {
          ctx.beginPath();
          ctx.fillStyle = COLORS[dot.group];
          ctx.globalAlpha = 0.32;
          ctx.arc(p.x, p.y, size * 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = quiet ? 0.45 : sighting ? 0.62 : 1;
        ctx.beginPath();
        ctx.fillStyle = COLORS[dot.group];
        ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        if (dot.heading !== null && dot.fresh && dot.kind === "tag") {
          const tip = destination(dot.lat, dot.lng, dot.heading, 70);
          const q = put(tip.lat, tip.lng);
          if (q) {
            ctx.beginPath();
            ctx.strokeStyle = COLORS[dot.group];
            ctx.lineWidth = 1.5;
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(q.x, q.y);
            ctx.stroke();
          }
        }
        if (dot.id === selectedRef.current) {
          ctx.beginPath();
          ctx.strokeStyle = "#f4fff8";
          ctx.lineWidth = 1.5;
          ctx.arc(p.x, p.y, size + 5, 0, Math.PI * 2);
          ctx.stroke();
        }
        hits.push({ id: dot.id, x: p.x, y: p.y });
      }
      const labeled: { x: number; y: number }[] = [];
      ctx.font = "600 12px IBM Plex Mono, ui-monospace, monospace";
      ctx.textBaseline = "middle";
      const named = [
        ...dots.filter((dot) => dot.kind === "tag" && dot.id !== selectedRef.current),
        ...dots.filter((dot) => dot.id === selectedRef.current),
      ];
      for (const dot of named) {
        if (dot.kind !== "tag") continue;
        const picked = dot.id === selectedRef.current;
        if (!picked && (!dot.fresh || view.zoom < 1.15)) continue;
        const p = put(dot.lat, dot.lng);
        if (!p) continue;
        if (!picked && labeled.some((item) => Math.hypot(item.x - p.x, item.y - p.y) < 108)) continue;
        const text = dot.name.length > 18 ? `${dot.name.slice(0, 17)}…` : dot.name;
        const tw = ctx.measureText(text).width;
        let left = p.x + 12;
        if (left + tw > w - 8) left = p.x - tw - 16;
        ctx.fillStyle = "rgba(7,16,22,0.82)";
        ctx.fillRect(left - 4, p.y - 9, tw + 8, 18);
        ctx.fillStyle = "#e7f4f1";
        ctx.fillText(text, left, p.y);
        labeled.push(p);
      }
      hitsRef.current = hits;
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);

    const pinchPair = () => {
      const pts = [...pointers.values()];
      if (pts.length < 2) return null;
      return {
        dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
        x: (pts[0].x + pts[1].x) / 2,
        y: (pts[0].y + pts[1].y) / 2,
      };
    };

    const down = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest("button")) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      velLat = 0;
      velLng = 0;
      filtDx = 0;
      filtDy = 0;
      lastGesture = performance.now();
      spin = false;
      if (pointers.size === 1) dragged = 0;
      else dragged = 40;
      const pair = pinchPair();
      if (pair) {
        pinchDist = pair.dist;
        pinchX = pair.x;
        pinchY = pair.y;
      }
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        /* pointer already gone */
      }
    };
    const move = (event: PointerEvent) => {
      const prev = pointers.get(event.pointerId);
      if (!prev) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (event.cancelable) event.preventDefault();
      const pair = pinchPair();
      const gestureNow = performance.now();
      const gestureDt = lastGesture ? gestureNow - lastGesture : 16;
      lastGesture = gestureNow;
      if (pair && pinchDist > 8) {
        const aim = targetRef.current;
        const before = aim.zoom;
        const grow = pair.dist / pinchDist;
        aim.zoom = clamp(aim.zoom + Math.log(grow) / Math.log(1.85), ZOOM_MIN, ZOOM_MAX);
        zoomAbout(pair.x, pair.y, before);
        applyDrag(pair.x - pinchX, pair.y - pinchY, gestureDt);
        pinchDist = pair.dist;
        pinchX = pair.x;
        pinchY = pair.y;
        dragged += 4;
        return;
      }
      const dx = event.clientX - prev.x;
      const dy = event.clientY - prev.y;
      dragged += Math.abs(dx) + Math.abs(dy);
      applyDrag(dx, dy, gestureDt);
    };
    const up = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      if (pointers.size < 2) pinchDist = 0;
      if (pointers.size === 0 && performance.now() - lastGesture > 80) {
        velLat = 0;
        velLng = 0;
      }
      if (pointers.size === 0 && dragged < 8) {
        const t = performance.now();
        if (t - lastTap < 280 && Math.hypot(event.clientX - lastTapX, event.clientY - lastTapY) < 28) {
          const aim = targetRef.current;
          const before = aim.zoom;
          aim.zoom = clamp(aim.zoom + 1.05, ZOOM_MIN, ZOOM_MAX);
          zoomAbout(event.clientX, event.clientY, before);
          velLat = 0;
          velLng = 0;
          dragged = 40;
        }
        lastTap = t;
        lastTapX = event.clientX;
        lastTapY = event.clientY;
      }
    };
    const click = (event: MouseEvent) => {
      if (dragged > 8) return;
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      let best: Hit | null = null;
      let bestD = 28;
      for (const hit of hitsRef.current) {
        const d = Math.hypot(hit.x - x, hit.y - y);
        if (d < bestD) {
          best = hit;
          bestD = d;
        }
      }
      if (best) onSelectRef.current(best.id);
    };
    const wheel = (event: WheelEvent) => {
      if (event.target instanceof Element && event.target.closest("button")) return;
      event.preventDefault();
      const aim = targetRef.current;
      const before = aim.zoom;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      const raw = event.ctrlKey ? -event.deltaY * unit * 0.012 : -event.deltaY * unit * 0.0015;
      aim.zoom = clamp(aim.zoom + clamp(raw, -1.15, 1.15), ZOOM_MIN, ZOOM_MAX);
      zoomAbout(event.clientX, event.clientY, before);
      spin = false;
      velLat = 0;
      velLng = 0;
    };

    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move, { passive: false });
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("click", click);
    wrap.addEventListener("wheel", wheel, { passive: false });

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.removeEventListener("click", click);
      wrap.removeEventListener("wheel", wheel);
    };
  }, []);

  const zoomBy = (delta: number) => {
    const aim = targetRef.current;
    aim.zoom = clamp(aim.zoom + delta, ZOOM_MIN, ZOOM_MAX);
  };

  return (
    <div ref={wrapRef} className="globe-stage absolute inset-0 bg-bg">
      <canvas ref={canvasRef} className="block h-full w-full cursor-grab touch-none active:cursor-grabbing" aria-label="Ocean globe" />
      <div className="zoom-stack">
        <button type="button" className="hud-panel grid size-11 place-items-center text-fg" onClick={() => zoomBy(0.65)} aria-label="Zoom in">
          <Plus className="size-4" />
        </button>
        <button type="button" className="hud-panel grid size-11 place-items-center text-fg" onClick={() => zoomBy(-0.65)} aria-label="Zoom out">
          <Minus className="size-4" />
        </button>
      </div>
    </div>
  );
}

export const GlobeView = memo(GlobeViewInner);
