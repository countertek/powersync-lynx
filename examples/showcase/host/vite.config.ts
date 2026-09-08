import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite";

import { lynxWebCoreRuntimeAssets } from "./lynx-web-core-assets.ts";

const SOURCEMAP_COMMENT_RE = /\n?\/\/# sourceMappingURL=([^\n]+)\s*$/;

/**
 * Several published deps (@lynx-js/web-core, @lynx-js/web-elements,
 * @powersync/web) ship `//# sourceMappingURL=` comments without the .map
 * files. Vite dev extracts the map from the raw loaded source and logs one
 * ENOENT "Failed to load source map" stack per file, flooding the terminal.
 * Strip the comment in `load` (before vite's extraction) when the referenced
 * map does not exist on disk.
 */
function stripDanglingSourcemaps(): Plugin {
  return {
    name: "strip-dangling-sourcemaps",
    enforce: "pre",
    async load(id) {
      const file = id.split("?", 1)[0];
      if (!file.includes("node_modules") || !file.endsWith(".js")) {
        return;
      }
      let code: string;
      try {
        code = await fs.promises.readFile(file, "utf8");
      } catch {
        return;
      }
      const match = code.match(SOURCEMAP_COMMENT_RE);
      if (match == null) {
        return;
      }
      const ref = match[1].trim();
      if (ref.startsWith("data:")) {
        return;
      }
      const mapPath = path.resolve(path.dirname(file), ref);
      if (fs.existsSync(mapPath)) {
        return;
      }
      return code.replace(SOURCEMAP_COMMENT_RE, "\n");
    },
  };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const showcaseRoot = path.resolve(here, "..");
const repoRoot = path.resolve(here, "../../..");

export default defineConfig({
  root: here,
  publicDir: path.join(showcaseRoot, "lynx-dist"),
  appType: "spa",
  plugins: [stripDanglingSourcemaps(), lynxWebCoreRuntimeAssets(showcaseRoot)],
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
