export { downsample } from "./motion";

const UA = "FinScape/1.0 (educational live ocean map)";

async function fetchOk<T>(
  url: string,
  timeoutMs: number,
  accept: string,
  read: (res: Response) => Promise<T>,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: accept, "Accept-Language": "en", "User-Agent": UA },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // The body read stays inside the timeout so a stalled stream still aborts.
    return await read(res);
  } finally {
    clearTimeout(timer);
  }
}

export function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  return fetchOk(url, timeoutMs, "application/json", (res) => res.json());
}

export function fetchText(url: string, timeoutMs: number): Promise<string> {
  return fetchOk(url, timeoutMs, "text/html,*/*", (res) => res.text());
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Sorts newest first by parsed time; ISO strings with mixed offsets do not sort as text. */
export function byNewest<T extends { observedAt: string }>(a: T, b: T): number {
  return (Date.parse(b.observedAt) || 0) - (Date.parse(a.observedAt) || 0);
}

export async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
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

/** Retries a flaky upstream call with a short, growing pause; the last error is rethrown. */
export async function retry<T>(attempts: number, fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (attempt < attempts) await new Promise((done) => setTimeout(done, 1_500 * attempt));
    }
  }
  throw last;
}
