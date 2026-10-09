// Where the globe's imagery comes from. The full app proxies satellite tiles through its own
// server; the static GitHub Pages build has no server, so it loads them straight from Esri.
const STATIC_SITE = import.meta.env.VITE_STATIC_SITE === "1";
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile";

export const EARTH_URL = `${import.meta.env.BASE_URL}earth.jpg`;
/** Cross-origin tiles must be requested with CORS so the globe can read their pixels. */
export const TILES_CROSS_ORIGIN = STATIC_SITE;

export function tileUrl(z: number, y: number, x: number): string {
  return STATIC_SITE ? `${ESRI}/${z}/${y}/${x}` : `/api/sat/${z}/${y}/${x}`;
}
