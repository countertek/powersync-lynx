import { PowerSyncDatabase } from "powersync-lynx";

import { AppSchema } from "./schema.ts";

/** One instance per file, matching the locked constructor path. */
export const db = new PowerSyncDatabase({
  schema: AppSchema,
  database: { dbFilename: "powersync-lynx-showcase.db" },
});
