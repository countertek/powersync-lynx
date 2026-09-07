# Freeze the public JS API

Type: grilling
Status: resolved
Blocked by: 01

## Question

What exact TypeScript exports and method shapes does the Client present, matching official PowerSync JavaScript names for the destination slice?

Already locked: `PowerSyncDatabase`, `Schema`, `Table`, `column`, `connect(connector)`, `get` / `getAll` / `execute` / `writeTransaction`, `watch`, Sync Stream subscribe, `waitForFirstSync`. Apps import one module (placeholder `powersync-lynx`), which re-exports from `@powersync/common`. No ReactLynx hooks on this map.

Pin:

- Constructor / open options (`schema`, `dbFilename`, one instance per file)
- Connector (`fetchCredentials`, `uploadData`) and `disconnect` / `close`
- `watch` callback vs async iterator
- Sync Stream subscribe / unsubscribe / TTL
- Connection status (`waitForFirstSync` and whether `currentStatus` is in)
- What is **explicitly later**: `getOptional`, `executeRaw`, raw tables, attachments, ORM, hooks

HITL: `/grilling` + `/domain-modeling`. Honor [Survey whether @powersync/common can run in Lynx JS](01-survey-common-on-lynx-js.md). Output: public API list another session can implement; a short `.d.ts` sketch is allowed as an asset, not the package.

## Answer

The Client is official PowerSync JavaScript, not a Lynx-narrowed API. Apps import one module (placeholder `powersync-lynx`). The Lynx-bundle entry is `export * from '@powersync/common'` plus a platform `PowerSyncDatabase`, the same barrel as official Web/RN.

**Class.** `PowerSyncDatabase` is a Lynx subclass of `BasePowerSyncDatabase` (`@powersync/shared-internals`). Published instance type: `export interface PowerSyncDatabase extends CommonPowerSyncDatabase {}`. Do not ship a smaller Lynx-only interface. `AbstractPowerSyncDatabase` is a deprecated alias — do not use. There is no class named `Connector`; the object type is `PowerSyncBackendConnector`.

**Constructor (app path).** One instance per file. `init()` is automatic.

```ts
new PowerSyncDatabase({
  schema: AppSchema,
  database: { dbFilename: 'app.db', dbLocation?: string }
});
```

`schema` is required. `database.dbFilename` is the documented open path; `dbLocation` is optional and must already exist. Official `logger`, `debugMode`, and `factory` / `opened` (`DatabaseSource`) stay on the type. Web VFS / workers / multi-tab are not constructor keys on this class ([Lock the Lynx-for-Web Host helper](09-lock-web-host-helper.md)). Encryption / SQLCipher is out of this map. Default `connect` `connectionMethod` is [Lock the native Adapter and Native Module contract](08-lock-native-adapter-contract.md).

**Schema.** `new Schema({ lists: new Table({ name: column.text, … }, { indexes, localOnly?, insertOnly? }) })`. `column.text` / `.integer` / `.real` only. `id` is implicit text.

**Lifecycle.** `connect(connector, options?: SyncOptions)`, `disconnect()`, `close()`, `disconnectAndClear()` (official logout wipe). Connector: `fetchCredentials(): Promise<PowerSyncCredentials | null>` (fresh credentials; `null` if signed out) and `uploadData(database)`. Optional official `postCheckpointRequest` stays on the type. Inside `uploadData`: `getNextCrudTransaction`, `getCrudBatch`, `.complete()`, `getClientId`.

**SQL.** Official `get` / `getAll` / `getOptional` / `execute` / `executeRaw` / `writeTransaction` / `readTransaction` (and the rest of `CommonPowerSyncDatabase`).

**`watch`.** Both official `db.watch` overloads (callback `{ onResult, onError? }` and async iterator of `QueryResult`). `db.query().watch()` is on the type (official 2.x). Spec examples may show the callback form. `AbortController` is a Client polyfill, not a reason to drop the iterator. Destination name is `watch`.

**Sync Streams.** `const sub = await db.syncStream(name, params?).subscribe({ ttl?, priority? })`; `sub.unsubscribe()`; `sub.waitForFirstSync()`. `ttl` is seconds after the last unsubscribe; omit it for the service default (documented 24h) — do not invent a Client default. `unsubscribeAll()` exists on the stream handle (official: dangerous). `auto_subscribe` is service-side, not a second client API.

**Status.** `currentStatus`, `db.waitForFirstSync()`, `subscription.waitForFirstSync()`, `registerListener({ statusChanged })`, `waitForStatus`.

**Exports.** Main entry: `export * from '@powersync/common'` + `PowerSyncDatabase`. Apps use named imports so unused `common` exports can tree-shake. Carve-outs vs official RN/Web barrels: do not re-export `@powersync/react`; do not export Native Module / Adapter / Host-helper types from the Lynx-bundle entry; Host helper is a subpath on [Lock the Lynx-for-Web Host helper](09-lock-web-host-helper.md).

**Later (products, not a second interface).** Attachments, raw tables as a product, Drizzle/Kysely, ReactLynx hooks, encryption, `NativeModules`, Host-helper types. They may still appear at runtime/types because we subclass official `BasePowerSyncDatabase` and star-export `common`. This map does not design or promise them.

Sketch (asset, not the package): [assets/public-js-api.d.ts](../assets/public-js-api.d.ts).


## Comments

2026-09-07: claimed to grill and lock the public JS API. Planning only — no package, no native contract, no Host helper.

2026-09-07 grilling round 1: user asked to align with official PowerSync JavaScript for most decisions (names, constructor, Connector, watch, streams, status). Next round only the remaining forks (full CommonPowerSyncDatabase vs subset; export * vs named).

2026-09-07 grilling round 2: Q1 A (full `CommonPowerSyncDatabase`, no Lynx-only interface) and Q2 A (`export *` from `common` + `PowerSyncDatabase`; no `@powersync/react`; attachments/ORM/hooks not documented as product). Frontier empty; freeze recorded.
