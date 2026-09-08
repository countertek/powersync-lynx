import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const showcaseRoot = path.resolve(here, "..");
const repoRoot = path.resolve(here, "../../..");

export default defineConfig({
  root: here,
  publicDir: path.join(showcaseRoot, "lynx-dist"),
  appType: "spa",
  resolve: {
    alias: {
      "powersync-lynx/web-host": path.join(repoRoot, "src/web-host/index.ts"),
      "powersync-lynx": path.join(repoRoot, "src/index.ts"),
    },
  },
  optimizeDeps: {
    exclude: ["@powersync/web", "powersync-lynx"],
  },
  worker: {
    format: "es",
  },
  build: {
    outDir: path.join(showcaseRoot, "host-dist"),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    sourcemap: true,
  },
  server: {
    port: 4173,
    fs: {
      allow: [showcaseRoot, repoRoot],
    },
  },
  preview: {
    port: 4173,
  },
});
