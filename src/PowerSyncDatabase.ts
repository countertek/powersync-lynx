import { SyncStreamConnectionMethod } from "@powersync/common";
import type {
  BasePowerSyncDatabaseOptions,
  CommonPowerSyncDatabase,
  DatabaseSource,
  PowerSyncBackendConnector,
  PowerSyncDatabaseConstructor,
  SQLOpenOptions,
} from "@powersync/common";
import { BasePowerSyncDatabase, openDatabase } from "@powersync/shared-internals";
import type { CreateSyncImplementationOptions } from "@powersync/shared-internals";
import { LynxDBAdapter } from "./adapter/LynxDBAdapter.ts";
import { LynxRemote } from "./sync/LynxRemote.ts";
import { LynxStreamingSyncImplementation } from "./sync/LynxStreamingSyncImplementation.ts";

export type LynxPowerSyncDatabaseOptions = BasePowerSyncDatabaseOptions &
  DatabaseSource<SQLOpenOptions>;

class LynxPowerSyncDatabase extends BasePowerSyncDatabase<LynxPowerSyncDatabaseOptions> {
  constructor(options: LynxPowerSyncDatabaseOptions) {
    super(options);
  }

  protected async _initialize(): Promise<void> {}

  protected openDBAdapter() {
    return openDatabase(this.options, (database) => {
      return new LynxDBAdapter({
        name: database.dbFilename,
        dbLocation: database.dbLocation,
      });
    });
  }

  protected generateSyncStreamImplementation(
    connector: PowerSyncBackendConnector,
    options: CreateSyncImplementationOptions,
  ) {
    const remote = new LynxRemote(connector, this.logger);
    return new LynxStreamingSyncImplementation({
      ...this.commonSyncOptions(connector, options),
      remote,
    });
  }

  protected get defaultConnectionMethod() {
    return SyncStreamConnectionMethod.HTTP;
  }
}

/**
 * A PowerSync database which provides SQLite functionality
 * which is automatically synced.
 *
 * @example
 * ```typescript
 * export const db = new PowerSyncDatabase({
 *  schema: AppSchema,
 *  database: {
 *    dbFilename: 'example.db'
 *  }
 * });
 * ```
 */
export const PowerSyncDatabase: PowerSyncDatabaseConstructor<LynxPowerSyncDatabaseOptions> =
  LynxPowerSyncDatabase;
export interface PowerSyncDatabase extends CommonPowerSyncDatabase {}
