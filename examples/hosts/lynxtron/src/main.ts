import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, LynxWindow } from "@lynx-js/lynxtron";

import { resolveHostConfig, toGlobalProps } from "./config.ts";

const entryDir =
  typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
const config = resolveHostConfig(process.argv.slice(2), process.env, entryDir);

let mainWindow: LynxWindow | null = null;
let exitPollTimer: ReturnType<typeof setInterval> | null = null;

function createWindow(): void {
  if (!fs.existsSync(config.bundlePath)) {
    console.error(
      `[powersync-lynxtron] Showcase bundle not found at ${config.bundlePath}.\n` +
        "Build it first from the repository root:\n" +
        "  pnpm --dir examples/showcase install && pnpm --dir examples/showcase build",
    );
    app.exit(1);
    return;
  }

  const globalProps = toGlobalProps(config);
  console.log(
    `[powersync-lynxtron] launching device=${globalProps.device} demoApiUrl=${globalProps.demoApiUrl} powersyncUrl=${globalProps.powersyncUrl} windowless=${config.windowless}`,
  );
  console.log(`[powersync-lynxtron] bundle=${config.bundlePath}`);

  const win = new LynxWindow({
    width: 620,
    height: 860,
    minWidth: 420,
    minHeight: 560,
    title: `PowerSync Lynx TODO (${globalProps.device})`,
    backgroundColor: "#050910",
    windowless: config.windowless,
  });
  mainWindow = win;

  win.on("closed", () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  // Forward Lynx runtime errors (if emitted by LynxWindow) to stderr for diagnostics.
  (win as unknown as NodeJS.EventEmitter).on("--lynx-error", (...args: unknown[]) => {
    console.error("[powersync-lynxtron] --lynx-error:", ...args);
  });

  const accepted = win.loadFile(config.bundlePath, { globalProps });
  if (!accepted) {
    console.error(`[powersync-lynxtron] LynxWindow.loadFile rejected ${config.bundlePath}`);
    app.exit(1);
    return;
  }

  if (config.exitFile != null && exitPollTimer == null) {
    const exitFile = config.exitFile;
    exitPollTimer = setInterval(() => {
      if (fs.existsSync(exitFile)) {
        if (exitPollTimer != null) {
          clearInterval(exitPollTimer);
          exitPollTimer = null;
        }
        try {
          mainWindow?.close();
        } catch {
          // ignore close errors on windowless shutdown
        }
        app.quit();
      }
    }, 200);
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (LynxWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || config.windowless) {
    app.quit();
  }
});
