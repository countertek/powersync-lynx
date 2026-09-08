import './abort-controller.js';
import { SyncStreamConnectionMethod } from '@powersync/common';
import { BasePowerSyncDatabase, openDatabase } from '@powersync/shared-internals';
import { LynxDBAdapter } from './adapter/LynxDBAdapter.js';
import { LynxRemote } from './sync/LynxRemote.js';
import { LynxStreamingSyncImplementation } from './sync/LynxStreamingSyncImplementation.js';

class LynxPowerSyncDatabase extends BasePowerSyncDatabase {
  constructor(options) {
    super(options);
  }

  async _initialize() {}

  openDBAdapter() {
    return openDatabase(this.options, (database) => {
      return new LynxDBAdapter({
        name: database.dbFilename,
        dbLocation: database.dbLocation
      });
    });
  }

  generateSyncStreamImplementation(connector, options) {
    const remote = new LynxRemote(connector, this.logger);
    return new LynxStreamingSyncImplementation({
      ...this.commonSyncOptions(connector, options),
      remote
    });
  }

  get defaultConnectionMethod() {
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
export const PowerSyncDatabase = LynxPowerSyncDatabase;
