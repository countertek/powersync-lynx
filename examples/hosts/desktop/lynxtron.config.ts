/**
 * Desktop host wiring sketch. pluginLynxtron() is the supported Autolink path
 * (Lynx 4.0 /next). This file is not built in this environment.
 */
import { defineConfig } from "@lynx-js/rspeedy";

export default defineConfig({
  plugins: [
    // Call pluginLynxtron() here so powersync-lynx/lynxtron loads
    // dist/<host>/<arch>/powersync-lynx.node and registers NativePowerSyncModule.
  ],
});
