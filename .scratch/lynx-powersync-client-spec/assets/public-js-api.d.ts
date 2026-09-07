/**
 * Sketch of the Lynx Client public JS API (placeholder package `powersync-lynx`).
 *
 * Not a package, not a second TypeScript surface. The runtime class is a Lynx
 * platform subclass of official `BasePowerSyncDatabase` (`@powersync/shared-internals`).
 * The published instance type is official `CommonPowerSyncDatabase`.
 *
 * Main entry (Lynx bundle), same barrel as official Web/RN:
 *   export * from '@powersync/common';
 *   plus `PowerSyncDatabase`.
 *
 * Carve-outs vs official RN/Web barrels:
 *   - do not re-export `@powersync/react`
 *   - do not export Native Module / Adapter / Host-helper types from this entry
 *   - Host helper is `powersync-lynx/web-host` ([Lock the Lynx-for-Web Host helper]), not this module
 *
 * Apps should keep named imports so unused `common` exports (including
 * attachments) can tree-shake. Do not document attachments, Drizzle/Kysely,
 * or hooks as this Client’s product.
 *
 * Pin `@powersync/common` major at package-layout time. Shapes below match
 * common 2.2 / RN+Web 2.x — copy official names; do not invent Lynx aliases.
 */

import type {
  BasePowerSyncDatabaseOptions,
  CommonPowerSyncDatabase,
  DatabaseSource,
  PowerSyncDatabaseConstructor,
  SQLOpenOptions
} from '@powersync/common';

export * from '@powersync/common';

/**
 * Constructor options for the Lynx-bundle `PowerSyncDatabase`.
 *
 * App path (document this):
 *   new PowerSyncDatabase({
 *     schema: AppSchema,
 *     database: { dbFilename: 'app.db', dbLocation?: string }
 *   })
 *
 * Official `DatabaseSource` also allows `factory` | `opened` (Adapter-testing
 * seams) and `BasePowerSyncDatabaseOptions.logger`. Those stay on the type.
 *
 * One instance per file. `init()` is automatic.
 *
 * Not on this class (Host helper / Adapter tickets, or out of this map):
 * Web VFS / workers / multi-tab, SQLCipher, `NativeModules`.
 */
export type LynxPowerSyncDatabaseOptions = BasePowerSyncDatabaseOptions & DatabaseSource<SQLOpenOptions>;

export const PowerSyncDatabase: PowerSyncDatabaseConstructor<LynxPowerSyncDatabaseOptions>;
export interface PowerSyncDatabase extends CommonPowerSyncDatabase {}

/*
App-path cheatsheet (all official names; full list is CommonPowerSyncDatabase):

  Schema / Table / column.text|integer|real
  PowerSyncBackendConnector { fetchCredentials, uploadData }
  PowerSyncCredentials { endpoint, token, expiresAt? }

  connect(connector, options?: SyncOptions)          // default connectionMethod: HTTP
  disconnect()
  disconnectAndClear(options?)
  close(options?)

  get / getAll / getOptional / execute / writeTransaction / readTransaction
  getNextCrudTransaction / getCrudBatch / getClientId
  CrudBatch.complete / CrudTransaction.complete

  watch(sql, params?, handler, options?)           // callback: onResult, onError?
  watch(sql, params?, options?): AsyncIterable     // iterator
  query(...).watch()                               // official 2.x; on the type

  syncStream(name, params?).subscribe({ ttl?, priority? })
  SyncStreamSubscription.unsubscribe()
  SyncStreamSubscription.waitForFirstSync()
  // omit ttl → PowerSync Service default (documented 24h). No Client default.
  // unsubscribeAll() exists on SyncStream (official: dangerous).

  currentStatus: SyncStatus
  waitForFirstSync()                               // on db and on subscription
  registerListener({ statusChanged })
  waitForStatus(predicate)

Later as products (not designed on this map; may still exist via export * /
the subclass): attachments, raw tables as a product, Drizzle/Kysely,
ReactLynx hooks, encryption, NativeModules, Host-helper types.
*/
