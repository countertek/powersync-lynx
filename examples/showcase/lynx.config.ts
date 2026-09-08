import path from "node:path";
import { fileURLToPath } from "node:url";

import { pluginReactLynx } from "@lynx-js/react-rsbuild-plugin";
import { defineConfig } from "@lynx-js/rspeedy";
import { pluginTypeCheck } from "@rsbuild/plugin-type-check";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [pluginReactLynx(), pluginTypeCheck()],
  environments: {
    web: {},
    lynx: {},
  },
  source: {
    // Spec: compile @powersync/common and @powersync/shared-internals for ES2021
    // (e.g. ??=) that PrimJS does not accept untransformed. Also compile the
    // TypeScript-only Client sources when consumed via file:.
    include: [
      /node_modules[\\/]powersync-lynx[\\/]/,
      /node_modules[\\/]@powersync[\\/]common[\\/]/,
      /node_modules[\\/]@powersync[\\/]shared-internals[\\/]/,
      path.join(here, "../../src"),
    ],
  },
  output: {
    distPath: {
      root: "lynx-dist",
    },
  },
});
