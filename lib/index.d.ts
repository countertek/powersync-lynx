export * from '@powersync/common';
import type {
  BasePowerSyncDatabaseOptions,
  CommonPowerSyncDatabase,
  DatabaseSource,
  PowerSyncDatabaseConstructor,
  SQLOpenOptions
} from '@powersync/common';

export type LynxPowerSyncDatabaseOptions = BasePowerSyncDatabaseOptions & DatabaseSource<SQLOpenOptions>;

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
export declare const PowerSyncDatabase: PowerSyncDatabaseConstructor<LynxPowerSyncDatabaseOptions>;
export interface PowerSyncDatabase extends CommonPowerSyncDatabase {}
