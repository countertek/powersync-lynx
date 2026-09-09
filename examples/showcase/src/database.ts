import type { PowerSyncLogger } from "powersync-lynx";
import { PowerSyncDatabase } from "powersync-lynx";

import { runExclusive } from "./boot.ts";
import { AppSchema } from "./schema.ts";
import { deviceId } from "./util.ts";

type LogFn = (message: string) => void;

let instance: PowerSyncDatabase | undefined;
let logFn: LogFn = () => {};

/** Forward Client logger lines (e.g. `/sync/stream via <transport>`) into the showcase log. */
export function setClientLog(fn: LogFn): void {
  logFn = fn;
}

const demoLogger: PowerSyncLogger = {
  log(record) {
    if (record.message.includes("/sync/stream via")) {
      logFn(record.message);
    }
  },
};

/**
 * One instance, created lazily on first use. The bundle's module scope is
 * evaluated in both the main-thread (MTS) realm and the background (BTS)
 * worker, but only BTS registers NativePowerSyncModule. Constructing eagerly
 * at module scope made the MTS copy fail its version probe with an unhandled
 * "NativePowerSyncModule is not registered" rejection on every page load.
 * Every call site runs inside an effect or event handler, which only ever
 * executes in BTS, so deferring construction keeps the MTS realm inert.
 */
export function getDb(): PowerSyncDatabase {
  instance ??= new PowerSyncDatabase({
    schema: AppSchema,
    database: { dbFilename: `powersync-lynx-todo-${deviceId()}.db` },
    logger: demoLogger,
  });
  return instance;
}

/** Coalesce Strict-mode / overlapping first-load waitForReady calls. */
export const waitForDemoReady = runExclusive(async () => {
  await getDb().waitForReady();
});
