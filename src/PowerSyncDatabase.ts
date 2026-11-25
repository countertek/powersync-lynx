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
import { TabCoordinator } from "./tabs.ts";

export type LynxPowerSyncDatabaseOptions = BasePowerSyncDatabaseOptions &
  DatabaseSource<SQLOpenOptions>;

class LynxPowerSyncDatabase extends BasePowerSyncDatabase<LynxPowerSyncDatabaseOptions> {
  // Assigned in `openDBAdapter()`, which `super(options)` calls before subclass field initializers.
  declare private tabs: TabCoordinator | undefined;

  constructor(options: LynxPowerSyncDatabaseOptions) {
    super(options);
  }

  protected async _initialize(): Promise<void> {}

  protected openDBAdapter() {
    return openDatabase(this.options, (database) => {
      const openOptions = {
        name: database.dbFilename,
        dbLocation: database.dbLocation,
      };
      const tabs = new TabCoordinator(openOptions);
      this.tabs = tabs;
      return new LynxDBAdapter(openOptions, tabs);
    });
  }

  protected generateSyncStreamImplementation(
    connector: PowerSyncBackendConnector,
    options: CreateSyncImplementationOptions,
  ) {
    const remote = new LynxRemote(connector, this.logger);
    return new LynxStreamingSyncImplementation(
      {
        ...this.commonSyncOptions(connector, options),
        remote,
      },
      this.tabs,
    );
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
