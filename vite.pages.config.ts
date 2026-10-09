import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Static build for GitHub Pages (https://<user>.github.io/finscape/). Server functions are
// swapped for JSON snapshots written by scripts/build-pages-data.ts in the Pages workflow.
const src = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  root: "pages",
  base: process.env.PAGES_BASE ?? "/finscape/",
  publicDir: "../public",
  define: { "import.meta.env.VITE_STATIC_SITE": JSON.stringify("1") },
  resolve: {
    alias: [
      { find: "@/lib/ocean.functions", replacement: `${src}/lib/ocean.static.ts` },
      { find: "@", replacement: src },
    ],
  },
  build: { outDir: "../dist-pages", emptyOutDir: true },
  plugins: [viteReact(), tailwindcss()],
});
