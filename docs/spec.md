# Lynx PowerSync Client

This is the locked spec a later session implements. It is normative. Honor this file; do not reopen the public API, Adapter, Host helper, or package layout.

The **Client** is official PowerSync JavaScript on Lynx: one Autolink npm, one JavaScript surface. Apps construct `PowerSyncDatabase`. `@powersync/common` and `@powersync/shared-internals` run in Lynx background JS. Native hosts (iOS, Android, Windows, macOS) use a Native Module as async SQL RPC. Lynx-for-Web uses a Host helper that maps that same RPC onto host-page WASQLite. Connector and `/sync/stream` stay in Lynx JS on every host.

Placeholder npm name: `powersync-lynx`. License: Apache-2.0. Lynx **4.0+**. The real npm scope is a later publish decision, not this spec.

Glossary: [`CONTEXT.md`](../CONTEXT.md). Why the Native Module, Host helper, and native sync HTTP look this way: [ADR 0001](adr/0001-native-module-is-async-sql-rpc.md), [ADR 0002](adr/0002-host-helper-is-wasqlite-sql-rpc.md), [ADR 0003](adr/0003-native-module-http-is-streaming-fallback.md).

---

## Product

ReactLynx apps import `powersync-lynx` and use official JavaScript names for this slice: open a DB, declare a Schema, `connect` with a Connector, `get` / `getAll` / `execute` / `writeTransaction`, `watch`, Sync Stream subscribe, `waitForFirstSync`.

| Surface | What the app sees |
|---|---|
| Lynx bundle | `export *` from `@powersync/common` plus Lynx `PowerSyncDatabase` (published type `CommonPowerSyncDatabase`) |
| Host page (Lynx-for-Web only) | `import { attach } from 'powersync-lynx/web-host'` |
| Autolink (not app code) | `pluginLynxtron()` loads `powersync-lynx/lynxtron`; native lookup `NativePowerSyncModule` |

App code never calls `NativeModules`. There is no class named `Connector`; the object type is `PowerSyncBackendConnector`. There is no second `PowerSyncDatabase` on the host page.

**Platforms in:** iOS, Android, Lynx-for-Web, native Windows, native macOS.

**Platforms out:** HarmonyOS, Linux as a Lynx host.

---

## Public JavaScript API

The Client is official PowerSync JavaScript, not a Lynx-narrowed API. The Lynx-bundle entry is the same barrel as official Web/RN: `export * from '@powersync/common'` plus a platform `PowerSyncDatabase`.

### Class

`PowerSyncDatabase` is a Lynx subclass of `BasePowerSyncDatabase` (`@powersync/shared-internals`). Published instance type:

```ts
export interface PowerSyncDatabase extends CommonPowerSyncDatabase {}
```

Do not ship a smaller Lynx-only interface. `AbstractPowerSyncDatabase` is a deprecated alias — do not use.

Carve-outs vs official RN/Web barrels:

- Do not re-export `@powersync/react`.
- Do not export Client-specific Native Module, Adapter, or Host-helper types from the Lynx-bundle entry. Official `DBAdapter` and related public types remain available through `export * from '@powersync/common'`.
- Host helper types live on `powersync-lynx/web-host`.

Apps should keep named imports so unused `common` exports (including attachments) can tree-shake.

### Constructor (app path)

One instance per file. `init()` is automatic.

Pseudocode (`?` marks optional fields):

```text
new PowerSyncDatabase({
  schema: AppSchema,
  database: { dbFilename: 'app.db', dbLocation?: string }
});
```

`schema` is required. `database.dbFilename` is the documented open path; `dbLocation` is optional and must already exist. Official `logger`, `debugMode`, and `factory` / `opened` (`DatabaseSource`) stay on the type. Web VFS / workers / multi-tab are **not** constructor keys on this class. Encryption / SQLCipher is out of this spec.

### Schema

Pseudocode (`?` marks optional fields):

```text
new Schema({
  lists: new Table(
    { name: column.text /* , … */ },
    { indexes, localOnly?, insertOnly? }
  )
});
```

`column.text` / `.integer` / `.real` only. `id` is implicit text. Schema is client-side SQLite views applied at open, not a migration and not the Postgres schema.

### Lifecycle

- `connect(connector, options?: SyncOptions)` — default `connectionMethod` is **HTTP**
- `disconnect()`
- `close()`
- `disconnectAndClear()` — official logout wipe

Connector (`PowerSyncBackendConnector`):

- `fetchCredentials(): Promise<PowerSyncCredentials | null>` — always a fresh token; `null` if signed out. Shape: `{ endpoint, token, expiresAt? }`.
- `uploadData(database)` — `getNextCrudTransaction` / `getCrudBatch`, POST mutations to the **app backend** (not PowerSync Service), then `.complete()`. Ordinary JSON `fetch`. Throw only for transient errors.
- Optional official `postCheckpointRequest` stays on the type.

Inside `uploadData` the app also has `getClientId`.

### SQL

Official `get` / `getAll` / `getOptional` / `execute` / `executeRaw` / `writeTransaction` / `readTransaction` (and the rest of `CommonPowerSyncDatabase`).

### `watch`

Both official `db.watch` overloads: callback `{ onResult, onError? }` and async iterator of `QueryResult`. `db.query().watch()` is on the type (official 2.x). Spec examples may show the callback form. Destination name is `watch`.

`AbortController` is a Client polyfill (see [Lynx JavaScript runtime](#lynx-javascript-runtime)), not a reason to drop the iterator.

### Sync Streams

Pseudocode (`?` marks optional arguments or fields):

```text
const sub = await db.syncStream(name, params?).subscribe({ ttl?, priority? });
sub.unsubscribe();
await sub.waitForFirstSync();
```

`ttl` is seconds after the last unsubscribe. Omit it for the PowerSync Service default (documented 24h). Do not invent a Client default. `unsubscribeAll()` exists on the stream handle (official: dangerous). `auto_subscribe` is service-side, not a second client API.

### Status

`currentStatus`, `db.waitForFirstSync()`, `subscription.waitForFirstSync()`, `registerListener({ statusChanged })`, `waitForStatus`.

### Type sketch

Shapes match `@powersync/common` 2.2 / official 2.x. Copy official names; do not invent Lynx aliases.

```ts
import type {
  BasePowerSyncDatabaseOptions,
  CommonPowerSyncDatabase,
  DatabaseSource,
  PowerSyncDatabaseConstructor,
  SQLOpenOptions
} from '@powersync/common';

export * from '@powersync/common';

export type LynxPowerSyncDatabaseOptions =
  BasePowerSyncDatabaseOptions & DatabaseSource<SQLOpenOptions>;

export const PowerSyncDatabase: PowerSyncDatabaseConstructor<LynxPowerSyncDatabaseOptions>;
export interface PowerSyncDatabase extends CommonPowerSyncDatabase {}
```

### Later products (not this spec)

Attachments, raw tables as a product, Drizzle/Kysely, ReactLynx hooks, encryption, `NativeModules`, Host-helper types. They may still appear at runtime/types because the Client subclasses official `BasePowerSyncDatabase` and star-exports `common`. This spec does not design or promise them.

---

## Lynx JavaScript runtime

Do not vendor `@powersync/common`. Do not wrap Kotlin/Swift as the JavaScript runtime. The 2.x sync loop is `@powersync/shared-internals` in the same Lynx background JS, the same seam as official Web and React Native.

The platform package supplies a `DBAdapter` and an `AbstractRemote` (LynxRemote + LynxStreamingSyncImplementation), the RN/Web/Node pattern.

### Globals the Client must supply

Lynx’s iOS polyfill list does **not** include `AbortController` or `TextDecoder`. PrimJS has no `TextEncoder` / `TextDecoder`.

| Gap | Client fix |
|---|---|
| `AbortController` | Polyfill in the Client. Used by sync, mutex timeout, and `watch` — not only attachments. |
| `TextDecoder` | Override `AbstractRemote.createTextDecoder` with Lynx `TextCodecHelper` (UTF-8). Do not bundle a decoder into `common`. |
| `??=` and other ES2021 in `node_modules` | Bundler must compile `@powersync/common` **and** `@powersync/shared-internals` (Rspeedy `source.include`, or equivalent). That is a compile include, not a vendor. |

`fetch`, timers, and `NativeModules` are background-thread only. Native Module methods must return immediately so `/sync/stream` and overlapping reads can proceed.

### Sync transport

Default `connect` `connectionMethod`: **HTTP** (`BasePowerSyncDatabase` default). Do not default `WEB_SOCKET` — there is no documented Lynx application `WebSocket`.

`/sync/stream` is selected in JS by `SyncStreamTransport` ([ADR 0003](adr/0003-native-module-http-is-streaming-fallback.md)):

| Host | Streaming download | Connector JSON (`fetchCredentials` / `uploadData`) |
|---|---|---|
| iOS / Android | Native Module HTTP (`httpFetch` + `streamingId` / GlobalEventEmitter). Idle-complete UTF-8 body is fallback when no event sender is reachable. Stock Lynx fetch is not the live NDJSON path. | Ordinary JSON `fetch` (host HTTP Service). Does not need streaming. |
| Windows / macOS | Identifier `fetch` (host `LynxHttpService`). Desktop N-API is SQL-only — no Native Module HTTP. Streaming is undocumented and unverified. | Ordinary JSON `fetch`. |
| Lynx-for-Web | Browser `fetch` in the Lynx bundle (CORS applies). No Native Module HTTP. | Browser `fetch`. |

Mobile hosts still register a Lynx HTTP Service for Connector traffic: iOS `LynxService` `Http` subspec; Android `org.lynxsdk.lynx:lynx-service-http` + `LynxServiceCenter`. Native Module Autolink does not replace that.

**Native Module HTTP** (iOS/Android Autolink, same lookup name as SQL RPC, separate sub-interface):

1. One-shot callback returns HTTP status + `streamingId` with an empty body (Lynx Callback is one-shot).
2. Chunks are UTF-8 strings on GlobalEventEmitter. Terminal sequence after headers: **`onData*` → `onError?` → `onEnd`**. JS waits for `onEnd`; `onError` records failure.
3. `httpFetchAbort(streamingId)` cancels the native request.
4. Idle-complete (2.5 s quiet window after bytes, UTF-8 `body` / `bodyBase64`, `idleComplete: true`) runs only when streaming cannot be started. It is not the primary realtime path.

Presence-only gate: pick native-http when `httpFetch` is present (not `typeof === "function"`). Desktop SQL modules without `httpFetch` use identifier `fetch`.

---

## Adapter and Native Module

[ADR 0001](adr/0001-native-module-is-async-sql-rpc.md): the Native Module is async SQL RPC, not `DBAdapter`. Lynx cannot pass a live `sqlite3*` or a `Promise`. Official React Native still implements `DBAdapter` in JavaScript (1 write + 5 read, JS locks, `powersync_update_hooks`, async execute so `watch` can overlap sync apply). The Lynx split is that same split.

This section is iOS, Android, Windows, and macOS. The Host helper presents the **same method names** so one JS Adapter can call them.

Lookup string on every host: **`NativePowerSyncModule`**. Not public API.

Wire types are the Lynx Native Module table: primitives, `BigInt`, `ArrayBuffer`, objects/arrays, `function` callbacks. Not a live `sqlite3*`. `Promise` and `Error` are not runtime wire types.

### Split

**JS Adapter** implements official `DBAdapter` (`@powersync/common`), same behavior as official `OPSQLiteDBAdapter`:

- `name`, `close`, `refreshSchema`
- `readLock` / `writeLock` / `timeoutMs` (official `Semaphore` + abort/`timeoutMs`)
- `LockContext.executeRaw` → Native Module `execute`
- `readTransaction` / `writeTransaction` (`BEGIN IMMEDIATE` in JS)
- `tablesUpdated({ tables })` for `watch`
- After write lock: `SELECT powersync_update_hooks('get')`, `JSON.parse`, notify listeners
- On the write connection at open: `SELECT powersync_update_hooks('install')`
- `Uint8Array` / `number[]` blobs → `ArrayBuffer` on the way in; `ArrayBuffer` → `Uint8Array` on the way out
- Throws a JS `Error` when the envelope is a failure, so `@powersync/common` sees a normal throw
- Never calls `loadExtension`

**Native Module** holds `dbId → sqlite3*`. Methods:

| Method | Arguments | Callback envelope (success) |
|---|---|---|
| `open` | `{ dbFilename, dbLocation?, readOnly? }` | `{ ok: true, dbId }` (`dbId` is an opaque string) |
| `close` | `dbId` | `{ ok: true }` |
| `execute` | `dbId, sql, params` | `{ ok: true, insertId, rowsAffected, columnNames, rawRows }` (`QueryResult` cells) |
| `executeBatch` | `dbId, sql, params` | same as `execute` — official RN shape: **one SQL, many parameter rows** (`params: BindValue[][]`) |

`BindValue` / cells: `string | number | bigint | ArrayBuffer | null`.

Failure (every method): `{ ok: false, message: string, code?: number }` (`sqlite3_errmsg` / `sqlite3_extended_errcode`). Native does not throw across the wire.

Last argument is a `function` callback that receives the envelope. The Native Module method itself returns immediately (`void`). SQLite work runs **off** the background JS thread. Concurrent `execute` on **different** `dbId`s may run at the same time; the same `dbId` is serialized natively as well as by JS locks.

Native `open` opens SQLite **and** loads `powersync-sqlite-core` (entry `sqlite3_powersync_init`).

SQL RPC has no `/sync/stream`, no `readLock`/`writeLock`, no `onTablesUpdated` callback. Native Module HTTP (`httpFetch` / `httpFetchAbort`) is a separate sub-interface on the iOS/Android Autolink class — see [Sync transport](#sync-transport) and [ADR 0003](adr/0003-native-module-http-is-streaming-fallback.md). Desktop N-API does not implement it.

### Connections (official RN)

Per open file, the JS Adapter opens **1 write + 5 read** connections (WAL). Native is only the `dbId` map — Autolink is app-wide, so many files are many `dbId`s.

After each `open`, JS issues the official OP-SQLite PRAGMAs via `execute` (defaults from `DEFAULT_SQLITE_OPTIONS`, no encryption):

- all connections: `busy_timeout = 30000`, `cache_size = -51200`, `temp_store = memory`
- write connection only: `journal_mode = WAL`, `journal_size_limit = 6MiB`, `synchronous = NORMAL`, `powersync_update_hooks('install')`

`refreshSchema`: write lock, then every read connection (same as official RN).

Do not ship RN’s `NativePowerSyncHelper` path migration (no React Native Quick SQLite history on Lynx). User-supplied SQLite extensions are later.

### `powersync-sqlite-core` load

Apache-2.0 core. Entry `sqlite3_powersync_init`. SQLite **3.44+**, **never** Apple system SQLite. Not OP-SQLite. Core version **0.5.3**.

| Host | SQLite | Core |
|---|---|---|
| iOS | Client-bundled 3.44+ | CocoaPods/SPM XCFramework + `sqlite3_auto_extension` |
| macOS | same as iOS | same static auto-extension |
| Android | bundled SQLite | Maven AAR `com.powersync:powersync-sqlite-core` → `libpowersync.so` + `loadExtension(..., "sqlite3_powersync_init")` |
| Windows | bundled SQLite with `ENABLE_LOAD_EXTENSION` | GitHub loadable `powersync_{x64,x86,aarch64}.dll` + `loadExtension` |

JS never calls `loadExtension`.

### Registration

Supported path: Autolink `lynx.lib.json` on Android 4.0 + iOS 4.0, and Lynxtron `pluginLynxtron()` when that host is the desktop. Lookup name **`NativePowerSyncModule`**.

Manual `registerModule` / `LynxEnv.RegisterNativeModule("NativePowerSyncModule", …)` is the documented fallback for CMake embedders and missing Autolink tooling — not a second product floor. Web is the Host helper, not `registerModule`.

---

## Host helper

[ADR 0002](adr/0002-host-helper-is-wasqlite-sql-rpc.md): the Host helper is WASQLite SQL RPC, not a second `PowerSyncDatabase`. Lynx-for-Web has no Autolink. `@powersync/web` needs `window`, workers, and IndexedDB/OPFS, so it cannot run in the Lynx bundle.

The Lynx bundle still constructs the same public type as native:

Pseudocode (`?` marks optional fields):

```text
new PowerSyncDatabase({
  schema: AppSchema,
  database: { dbFilename: 'app.db', dbLocation?: string }
});
```

Web VFS / workers / multi-tab are **not** constructor keys. Connector + `/sync/stream` stay in Lynx JS.

Native method names, arguments, callback envelopes, and BindValue cells are the Adapter section above. One JS Adapter calls them on every host. `attach` uses the same map key: **`NativePowerSyncModule`**.

### Export

Host page only (not the Lynx-bundle barrel):

```ts
import { attach } from 'powersync-lynx/web-host';
```

Named export: `attach`. Types for `attach` / `detach` / attach options live on this subpath. Do not export Host-helper types from `powersync-lynx`. Do not re-export `WASQLiteVFS` — hosts that override `vfs` import it from `@powersync/web`.

`@powersync/web` is imported only by this entry, never by the Lynx bundle.

### `attach`

Lynx 4.0 `<lynx-view>` needs both:

1. `nativeModulesMap[name] = esmUrl` — default export `(NativeModules, NativeModulesCall) => { open, close, execute, executeBatch }`. Runs in `lynx-bg`. The factory assigns those methods onto the `NativeModules` bag and the lynx-bg `NativeModules` global so bundle lookup of `NativeModules.NativePowerSyncModule` succeeds. Each method hops `NativeModulesCall` then invokes the Adapter’s `function` callback with the native envelope.
2. `onNativeModulesCall(name, data, moduleName)` — host page. Owns `WASQLiteOpenFactory` / execute. Returns `{ ok: true, … }` or `{ ok: false, message, code? }`. Does not throw for this module.

Autolink does not assign those properties. The host page calls `attach` to wire them for one `<lynx-view>`.

Pseudocode (`?` marks an optional argument):

```text
const { detach } = attach(lynxView, options?);
```

- **Merges** `nativeModulesMap` (keeps other keys). Factory URL is `new URL('./factory.js', import.meta.url)` of private `lib/web-host/factory.js` — not `URL.createObjectURL(new Blob(…))`.
- **Wraps** `onNativeModulesCall`: dispatch on our `moduleName`; every other name falls through to the previous handler.
- Assign both **before** the bundle calls `NativeModules` (set them before `url` / start). Lynx queues `onNativeModulesCall` until a handler exists; `nativeModulesMap` is loaded when `lynx-bg` starts.
- Returns `{ detach() }`: unwraps our handler if it is still the current one; drops our map key; leaves other keys. Does not revoke a Blob URL. Does not `close()` open databases — that remains `PowerSyncDatabase.close()`. Detach in reverse attach order if the page wrapped again after us.

Call `attach` once per `<lynx-view>` that runs this Client.

### Attach options (official web open options)

Second argument is official `WASQLiteOpenFactory` / `WebSpecificOpenOptions` fields except `encryptionKey`. Omit any field → official `@powersync/web` default.

| Field | Official default |
|---|---|
| `vfs` | `IDBBatchAtomicVFS` |
| `useWebWorker` | `true` (OPFS VFS requires workers) |
| `enableMultiTabs` | `true` where `SharedWorker` exists and UA is not Android / iOS / Safari; else `false` |
| `worker` | bundler-rewritten `new URL('./worker.js', import.meta.url)` |
| `additionalReaders` | `1` (only `OPFSWriteAheadVFS` opens extra readers) |

Also pass-through when set: `temporaryStorage`, `cacheSizeKb`, `databaseWorkerLogLevel`, `disableSSRWarning`. Do not take `ssrMode` from the host — attach runs in the browser.

Safari / iOS multi-tab: host passes `vfs: WASQLiteVFS.OPFSCoopSyncVFS` from `@powersync/web`. Chromium parallel reads: `vfs: WASQLiteVFS.OPFSWriteAheadVFS` and optional `additionalReaders`. Experimental `InMemoryWriteAheadLogPool` / COOP / COEP headers are not this spec.

`enableMultiTabs` is official WASQLite SharedWorker sharing for that filename. It is **not** official Web’s shared sync worker: Connector and `/sync/stream` stay in each Lynx bundle. One `PowerSyncDatabase` per file still holds, including across `<lynx-view>`s on one page.

### Workers / WASM assets

Same as official Web / RN-web:

- **Host bundler rewrites `import.meta.url`** (Rsbuild / Rspack / Vite / webpack): default worker spawn. No `copy-assets`.
- **It does not** (Metro, Turbopack, static HTML): `npx @powersync/web copy-assets` (optional `-o <dir>`, default `public`) → `{output}/@powersync/worker.js` plus WA-SQLite / VFS chunks. Pass `worker: '/@powersync/worker.js'` on `attach`. Gitignore the generated `@powersync/` tree.

Worker scripts must be same-origin. CDN-hosted Lynx or PowerSync workers: Lynx’s `import 'remote-web-worker'` before `@lynx-js/web-core/client`, and/or an explicit same-origin `worker` URL.

`useWebWorker: false` is not recommended; OPFS VFS throws if workers are off.

### Page mapping (one factory per file)

`WASQLiteOpenFactory.openDB()` is **one** official adapter per filename. The JS Adapter still `open`s 1 write + 5 read Native Module connections.

On the host page, keyed by `dbFilename` + optional `dbLocation`:

- First `open` constructs `new WASQLiteOpenFactory({ dbFilename, dbLocation, …attachOptions }).openDB()`, mints `dbId`.
- Later `open`s of that key mint more `dbId`s onto the **same** adapter (refcount). `readOnly` is a routing hint when the VFS actually has readers (`OPFSWriteAheadVFS`); on the default VFS those reads serialize inside WASQLite.
- `execute` / `executeBatch` on a `dbId` run on that adapter (`readLock` + `executeRaw` vs `writeLock` + `executeRaw` / `executeBatch` according to `readOnly`). Map WASQLite `QueryResult` onto the native envelope (`insertId`, `rowsAffected`, `columnNames`, `rawRows`).
- Last `close` for that key `adapter.close()`s and drops the entry.

Do not construct six factories on one IndexedDB/OPFS file. Do not construct `WebPowerSyncDatabase`. WASQLite WASM already loads PowerSync sqlite-core; JS never calls `loadExtension`.

`dbLocation` is official `SQLOpenOptions.dbLocation` (directory must already exist). First open of a key binds attach options; a second `<lynx-view>` that opens the same file reuses that factory (one instance per file).

The JS Adapter still issues official OP-SQLite PRAGMAs and `powersync_update_hooks('install'|'get')` via `execute`. WASQLite `writeLock` can consume update-hook names before that follow-up `get`; the Host helper stashes table names at lock release and returns the merged list on `powersync_update_hooks('get')` so `watch` still refreshes.

### Web hop (`Cloneable`)

Native BindValue includes `ArrayBuffer` and `bigint`. Lynx-for-Web `NativeModulesCall` data is typed `Cloneable` (primitives, objects, arrays) — not those two.

The **lynx-bg factory** (and the matching page handler) converts them to a tagged Cloneable envelope and back. The JS Adapter still sees `ArrayBuffer` / `bigint`. No Web branch in the Adapter.

| Runtime value | Envelope on the hop |
|---|---|
| `ArrayBuffer` | `{ __psAb: true, u8: number[] }` (byte values 0–255) |
| `bigint` | `{ __psBig: true, v: string }` (decimal) |

Encode on the way in (params) and on the way out (`rawRows`). Do not throw across the hop: catch page-side and return `{ ok: false, message, code? }`.

---

## Package, Autolink, and version floors

One Autolink npm (`powersync-lynx`). `"type": "module"`. Lynxtron Autolink is the **supported desktop path**. CMake `LynxEnv.RegisterNativeModule("NativePowerSyncModule", …)` is the documented fallback, not a second product. `@powersync/node` is not the desktop Client.

### Native Module export name

| Surface | Uses |
|---|---|
| JS Adapter | `NativeModules.NativePowerSyncModule` |
| Android | `@LynxNativeModule(name = "NativePowerSyncModule")` in `com.powersync.lynx`; fallback `LynxEnv.registerModule("NativePowerSyncModule", …)` |
| iOS | `@LynxNativeModule("NativePowerSyncModule")`; fallback `[globalConfig registerModule:…]` |
| Lynxtron | `LYNX_REGISTER_NATIVE_MODULE("NativePowerSyncModule", …)` after `./lynxtron` loads the `.node` |
| CMake `LynxView` | `LynxEnv.RegisterNativeModule("NativePowerSyncModule", …)` |
| Host helper `attach` | `nativeModulesMap.NativePowerSyncModule` |

Must not collide with the public class `PowerSyncDatabase`.

Lynx 4.0 Autolink pages cover Android/iOS only; desktop Autolink keys and `pluginLynxtron()` are `/next`. This Client still ships those keys so Windows/macOS have a supported Autolink path.

### `package.json` (sketch, not published)

```json
{
  "name": "powersync-lynx",
  "type": "module",
  "license": "Apache-2.0",
  "main": "./lib/index.js",
  "types": "./lib/index.d.ts",
  "exports": {
    ".": {
      "types": "./lib/index.d.ts",
      "default": "./lib/index.js"
    },
    "./web-host": {
      "types": "./lib/web-host/index.d.ts",
      "default": "./lib/web-host/index.js"
    },
    "./lynxtron": "./lynxtron/index.cjs",
    "./package.json": "./package.json"
  },
  "files": [
    "lib",
    "lynxtron",
    "android",
    "ios",
    "shared",
    "dist",
    "lynx.lib.json"
  ],
  "dependencies": {
    "@powersync/common": "^2.2.0",
    "@powersync/shared-internals": "^1.2.0"
  },
  "peerDependencies": {
    "@powersync/common": "^2.2.0",
    "@powersync/web": "^2.3.0"
  },
  "peerDependenciesMeta": {
    "@powersync/web": { "optional": true }
  }
}
```

- `.` is ESM-only (`default`), same as `@powersync/common` / `@powersync/web` 2.x. No dual CJS on `.`.
- `./web-host` is the only public Host-helper subpath. Named export `attach`.
- Factory ESM is **private** `lib/web-host/factory.js`. `attach` sets `nativeModulesMap.NativePowerSyncModule` to `new URL('./factory.js', import.meta.url)`. Not a public export. Not a Blob URL.
- `./lynxtron` is CJS because `pluginLynxtron()` `require`s it. It loads `dist/<host>/<arch>/powersync-lynx.node` so static `LYNX_REGISTER_NATIVE_MODULE` runs. Not app API.
- `@powersync/web` is an **optional peer** (needed only for `./web-host`). Native installs do not pull WASM.
- No `@lynx-js/react` peer — the barrel does not import React. The floor is Lynx **4.0+** in the host build (Android Autolink Gradle plugins 4.0+, iOS `cocoapods-lynx-library`, Lynxtron `pluginLynxtron()`).

### `lynx.lib.json`

No `harmony`.

```json
{
  "platforms": {
    "android": {
      "packageName": "com.powersync.lynx",
      "sourceDir": "android"
    },
    "ios": {
      "sourceDir": "ios"
    },
    "lynxtron": {
      "path": "dist"
    },
    "macos": {
      "sourceDir": "shared"
    },
    "windows": {
      "sourceDir": "shared"
    }
  }
}
```

iOS `podspecPath` is Autolink’s default: first `.podspec` under `ios/`.

### On disk

```
powersync-lynx/
  package.json
  lynx.lib.json
  lib/
    index.js              # Lynx-bundle barrel
    index.d.ts
    web-host/
      index.js            # attach
      index.d.ts
      factory.js          # private lynx-bg factory
  lynxtron/
    index.cjs
  android/                # com.powersync.lynx
  ios/
  shared/                 # desktop N-API / C++ (macos + windows)
  dist/
    macos/arm64/powersync-lynx.node
    windows/x64/powersync-lynx.node
```

Documented Autolink artifact layout is `macos/arm64` and `windows/x64`. Extra arches may ship when `powersync-sqlite-core` binaries exist (e.g. `macos/x64`, `windows/arm64`).

### Version matrix

PowerSync all-SDK floors; Lynx 4.0 does not raise them.

| Floor | Version |
|---|---|
| Lynx host SDK | **4.0+** |
| Node | **>= 22.18** |
| iOS | **15.0** |
| Android | **API 24** |
| macOS | **14.0** |
| Windows | **10** |
| `@powersync/common` | **^2.2.0** (peer + runtime dep) |
| `@powersync/shared-internals` | **^1.2.0** (runtime dep; official 2.x loop) |
| `@powersync/web` | **^2.3.0** (optional peer; Host helper only) |
| `powersync-sqlite-core` | **0.5.3** |
| SQLite | **3.44+**, never Apple system SQLite |

---

## Out of scope

- Implementing the npm package — this spec is the handoff
- CI, release, and the real npm scope
- Full official-SDK parity: attachments, Drizzle, Kysely
- A later ReactLynx hooks package (`@powersync/react` will not run as-is)
- HarmonyOS (Lynx Harmony modules are ArkTS; PowerSync Kotlin has no Harmony target)
- Linux as a Lynx host
- Wrapping Kotlin/Swift SDKs as the JavaScript runtime
- Landing in `powersync-ja/powersync-js` / `@powersync/*` as this destination
- nijika-os PMS domain (Stay, Folio, Organization)
- Encryption / SQLCipher
- PowerSync Service / Open Edition ops (that is the consumer app)
- Desktop Native Module HTTP (N-API stays SQL-only; identifier `fetch` is the desktop stream path)
- User-supplied SQLite extensions
- Experimental WASQLite `InMemoryWriteAheadLogPool` / COOP / COEP

---

## Provenance (informative)

This file is the source of truth. Wayfinder ticket history under `.scratch/lynx-powersync-client-spec/` is not a second spec.

Research notes under [`docs/research/`](research/) are facts that fed the locks; they are not normative. ADRs 0001–0003 record *why* SQL RPC, the Host helper, and native sync HTTP split this way.
