import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Static build for GitHub Pages: no server, so the data layer reads the snapshots that
 * .github/workflows/pages.yml collects (src/lib/feed-client.static.ts).
 *
 *   PAGES_BASE=/finscape/ npx vite build --config vite.pages.config.ts
 */
const src = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  root: "pages",
  base: process.env.PAGES_BASE ?? "/",
  publicDir: "../public",
  envDir: "..",
  resolve: {
    alias: [
      { find: "@/lib/feed-client", replacement: `${src}/lib/feed-client.static.ts` },
      { find: "@", replacement: src },
    ],
  },
  build: {
    outDir: "../dist-pages",
    emptyOutDir: true,
  },
  plugins: [tailwindcss(), viteReact()],
});
