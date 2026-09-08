import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

import { lynxWebCoreRuntimeAssets } from "./lynx-web-core-assets.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const showcaseRoot = path.resolve(here, "..");
const repoRoot = path.resolve(here, "../../..");

export default defineConfig({
  root: here,
  publicDir: path.join(showcaseRoot, "lynx-dist"),
  appType: "spa",
  plugins: [lynxWebCoreRuntimeAssets(showcaseRoot)],
  resolve: {
    alias: {
      "powersync-lynx/web-host": path.join(repoRoot, "src/web-host/index.ts"),
      "powersync-lynx": path.join(repoRoot, "src/index.ts"),
      "@powersync/web": path.join(showcaseRoot, "node_modules/@powersync/web"),
    },
  },
  optimizeDeps: {
    exclude: ["@powersync/web", "powersync-lynx", "@lynx-js/web-core"],
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
