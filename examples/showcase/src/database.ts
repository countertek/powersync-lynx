import { PowerSyncDatabase } from "powersync-lynx";

import { runExclusive } from "./boot.ts";
import { AppSchema } from "./schema.ts";
import { deviceId } from "./util.ts";

/** One instance per file, matching the locked constructor path. */
export const db = new PowerSyncDatabase({
  schema: AppSchema,
  database: { dbFilename: `powersync-lynx-todo-${deviceId()}.db` },
});

/** Coalesce Strict-mode / overlapping first-load waitForReady calls. */
export const waitForDemoReady = runExclusive(async () => {
  await db.waitForReady();
});
