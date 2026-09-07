# Native Adapter and Native Module contract

Asset of [Lock the native Adapter and Native Module contract](../issues/08-lock-native-adapter-contract.md). Not a package, not public API.

App code never calls `NativeModules`. The published type is official `CommonPowerSyncDatabase` ([Freeze the public JS API](../issues/07-freeze-public-js-api.md)). Lynx-for-Web is [Lock the Lynx-for-Web Host helper](../issues/09-lock-web-host-helper.md) / [web-host-helper.md](web-host-helper.md). This contract is iOS, Android, Windows, and macOS. The Host helper presents the **same method names** so one JS Adapter can call them.

The Native Module export name is **`NativePowerSyncModule`** ([Lock package layout, Autolink, and version floors](../issues/10-lock-package-layout.md) / [package-layout.md](package-layout.md)).

Wire types are the Lynx Native Module table: primitives, `BigInt`, `ArrayBuffer`, objects/arrays, `function` callbacks. Not a live `sqlite3*`. `Promise` and `Error` are not runtime wire types.

---

## Split

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

**Native Module** holds `dbId → sqlite3*`. Methods:

| Method | Arguments | Callback envelope (success) |
|---|---|---|
| `open` | `{ dbFilename, dbLocation?, readOnly? }` | `{ ok: true, dbId }` (`dbId` is an opaque string) |
| `close` | `dbId` | `{ ok: true }` |
| `execute` | `dbId, sql, params` | `{ ok: true, insertId, rowsAffected, columnNames, rawRows }` (`QueryResult` cells) |
| `executeBatch` | `dbId, sql, params` | same as `execute` — official RN shape: **one SQL, many parameter rows** (`params: BindValue[][]`) |

`BindValue` / cells: `string | number | bigint | ArrayBuffer | null`.

Failure (every method): `{ ok: false, message: string, code?: number }` (`sqlite3_errmsg` / `sqlite3_extended_errcode`). Native does not throw across the wire.

Last argument is a `function` callback that receives the envelope. The Native Module method itself returns immediately (`void`). SQLite work runs **off** the background JS thread so `/sync/stream` `fetch` and overlapping reads can proceed. Concurrent `execute` on **different** `dbId`s may run at the same time; the same `dbId` is serialized natively as well as by JS locks.

JS never calls `loadExtension`. Native `open` opens SQLite **and** loads `powersync-sqlite-core` (entry `sqlite3_powersync_init`).

There is no Native Module HTTP, no `/sync/stream`, no `readLock`/`writeLock`, no `onTablesUpdated` callback.

---

## Connections (official RN)

Per open file, the JS Adapter opens **1 write + 5 read** connections (WAL). Native is only the `dbId` map — Autolink is app-wide, so many files are many `dbId`s.

After each `open`, JS issues the official OP-SQLite PRAGMAs via `execute` (defaults from `DEFAULT_SQLITE_OPTIONS`, no encryption):

- all connections: `busy_timeout = 30000`, `cache_size = -51200`, `temp_store = memory`
- write connection only: `journal_mode = WAL`, `journal_size_limit = 6MiB`, `synchronous = NORMAL`, `powersync_update_hooks('install')`

`refreshSchema`: write lock, then every read connection (same as official RN).

Do not ship RN’s `NativePowerSyncHelper` path migration (no React Native Quick SQLite history on Lynx). Encryption / SQLCipher is out of this map. User-supplied SQLite extensions are later.

---

## `powersync-sqlite-core` load

Apache-2.0 core. Entry `sqlite3_powersync_init`. SQLite **3.44+**, **never** Apple system SQLite. Not OP-SQLite. Core version **0.5.3** ([package-layout.md](package-layout.md)).

| Host | SQLite | Core |
|---|---|---|
| iOS | Client-bundled 3.44+ | CocoaPods/SPM XCFramework + `sqlite3_auto_extension` |
| macOS | same as iOS | same static auto-extension |
| Android | bundled SQLite | Maven AAR `com.powersync:powersync-sqlite-core` → `libpowersync.so` + `loadExtension(..., "sqlite3_powersync_init")` |
| Windows | bundled SQLite with `ENABLE_LOAD_EXTENSION` | GitHub loadable `powersync_{x64,x86,aarch64}.dll` + `loadExtension` |

---

## Sync transport (not the Native Module)

Platform Remote in Lynx JS, same seam as official Web/Expo/Node.

- Default `connect` `connectionMethod`: **HTTP** (`BasePowerSyncDatabase` default).
- Override `createTextDecoder` with Lynx `TextCodecHelper` (PrimJS has no `TextDecoder`).
- iOS/Android host requirement: PageConfig `enableFetchAPIStandardStreaming = true`.
- Connector `fetchCredentials` / `uploadData` are ordinary JSON `fetch` in app JS.
- Do not default `WEB_SOCKET` (no documented Lynx app `WebSocket`).
- Native HTTP is a later flag if a host’s `fetch` cannot stream — not this contract.

---

## Registration

Supported path: Autolink `lynx.lib.json` on Android 4.0 + iOS 4.0, and Lynxtron `pluginLynxtron()` when that host is the desktop. Lookup name **`NativePowerSyncModule`**. Manual `registerModule` / `LynxEnv.RegisterNativeModule("NativePowerSyncModule", …)` is the documented fallback for CMake embedders and missing Autolink tooling — not a second product floor. Web is the Host helper, not `registerModule`.
