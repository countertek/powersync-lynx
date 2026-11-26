import { defineConfig } from "@rsbuild/core";
import { pluginLynxtron } from "@lynx-js/lynxtron-dev-plugins/rsbuild";

export default defineConfig({
  environments: {
    desktop: {
      source: {
        entry: {
          main: "./src/main.ts",
        },
      },
      output: {
        target: "node",
        distPath: {
          root: "./dist/desktop",
        },
      },
      dev: {
        writeToDisk: true,
      },
      plugins: [pluginLynxtron()],
    },
  },
});
