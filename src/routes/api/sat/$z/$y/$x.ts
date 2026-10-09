import { createFileRoute } from "@tanstack/react-router";

const TILE = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile";

export const Route = createFileRoute("/api/sat/$z/$y/$x")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const z = Number(params.z);
        const y = Number(params.y);
        const x = Number(params.x);
        const span = 2 ** z;
        if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) {
          return new Response("Bad tile", { status: 400 });
        }
        if (z < 0 || z > 10 || x < 0 || y < 0 || x >= span || y >= span) {
          return new Response("Bad tile", { status: 400 });
        }
        const upstream = await fetch(`${TILE}/${z}/${y}/${x}`, {
          headers: { "User-Agent": "FinScape/1.0" },
        });
        if (!upstream.ok) return new Response("Tile missing", { status: 502 });
        return new Response(await upstream.arrayBuffer(), {
          headers: {
            "content-type": upstream.headers.get("content-type") || "image/jpeg",
            "cache-control": "public, max-age=86400",
          },
        });
      },
    },
  },
});
