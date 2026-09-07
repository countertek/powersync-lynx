# Lynx-for-Web Host helper

Asset of [Lock the Lynx-for-Web Host helper](../issues/09-lock-web-host-helper.md). Not a package. Host-integration section the spec can include.

App code never calls `NativeModules`. The Lynx bundle still constructs the same public type as native ([Freeze the public JS API](../issues/07-freeze-public-js-api.md)):

```ts
new PowerSyncDatabase({
  schema: AppSchema,
  database: { dbFilename: 'app.db', dbLocation?: string }
});
```

Web VFS / workers / multi-tab are **not** constructor keys on that class. Connector + `/sync/stream` stay in Lynx JS. The Host helper is SQL RPC, not a second `PowerSyncDatabase`.

Native method names, arguments, callback envelopes, and BindValue cells are [Lock the native Adapter and Native Module contract](../issues/08-lock-native-adapter-contract.md) / [native-adapter-contract.md](native-adapter-contract.md). One JS Adapter calls them on every host.

The Native Module export name is **`NativePowerSyncModule`**. `attach` uses that same map key. `package.json` `exports` are [Lock package layout, Autolink, and version floors](../issues/10-lock-package-layout.md) / [package-layout.md](package-layout.md).

ADR: [docs/adr/0002-host-helper-is-wasqlite-sql-rpc.md](../../../docs/adr/0002-host-helper-is-wasqlite-sql-rpc.md).

---

## Export

Host page only (not the Lynx-bundle barrel):

```ts
import { attach } from 'powersync-lynx/web-host';
```

Named export: `attach`. Types for `attach` / `detach` / attach options live on this subpath. Do not export Host-helper types from `powersync-lynx`. Do not re-export `WASQLiteVFS` — hosts that override `vfs` import it from `@powersync/web`.

`@powersync/web` is imported only by this entry, never by the Lynx bundle.

---

## `attach`

Lynx 4.0 `<lynx-view>` needs both:

1. `nativeModulesMap[name] = esmUrl` — default export `(NativeModules, NativeModulesCall) => { open, close, execute, executeBatch }`. Runs in `lynx-bg`. Each method hops `NativeModulesCall` then invokes the Adapter’s `function` callback with the native envelope.
2. `onNativeModulesCall(name, data, moduleName)` — host page. Owns `WASQLiteOpenFactory` / execute. Returns `{ ok: true, … }` or `{ ok: false, message, code? }`. Does not throw for this module.

Autolink does not assign those properties. `attach` is the Web equivalent of Autolink:

```ts
const { detach } = attach(lynxView, options?);
```

- **Merges** `nativeModulesMap` (keeps other keys). Factory URL is `new URL('./factory.js', import.meta.url)` of private `lib/web-host/factory.js` — not `URL.createObjectURL(new Blob(…))`.
- **Wraps** `onNativeModulesCall`: dispatch on our `moduleName`; every other name falls through to the previous handler.
- Assign both **before** the bundle calls `NativeModules` (set them before `url` / start). Lynx queues `onNativeModulesCall` until a handler exists; `nativeModulesMap` is loaded when `lynx-bg` starts.
- Returns `{ detach() }`: unwraps our handler if it is still the current one; drops our map key; leaves other keys. Does not revoke a Blob URL. Does not `close()` open databases — that remains `PowerSyncDatabase.close()`. Detach in reverse attach order if the page wrapped again after us.

Call `attach` once per `<lynx-view>` that runs this Client.

---

## Attach options (official web open options)

Second argument is official `WASQLiteOpenFactory` / `WebSpecificOpenOptions` fields except `encryptionKey` (encryption is out of this map). Omit any field → official `@powersync/web` default.

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

---

## Workers / WASM assets

Same as official Web / RN-web:

- **Host bundler rewrites `import.meta.url`** (Rsbuild / Rspack / Vite / webpack): default worker spawn. No `copy-assets`.
- **It does not** (Metro, Turbopack, static HTML): `npx @powersync/web copy-assets` (optional `-o <dir>`, default `public`) → `{output}/@powersync/worker.js` plus WA-SQLite / VFS chunks. Pass `worker: '/@powersync/worker.js'` on `attach` (official load path for both database and sync workers; this Client only needs the database worker). Gitignore the generated `@powersync/` tree.

Worker scripts must be same-origin. CDN-hosted Lynx or PowerSync workers: Lynx’s `import 'remote-web-worker'` before `@lynx-js/web-core/client`, and/or an explicit same-origin `worker` URL.

`useWebWorker: false` is not recommended; OPFS VFS throws if workers are off.

---

## Page mapping (one factory per file)

`WASQLiteOpenFactory.openDB()` is **one** official adapter per filename. The JS Adapter still `open`s 1 write + 5 read Native Module connections.

On the host page, keyed by `dbFilename` + optional `dbLocation`:

- First `open` constructs `new WASQLiteOpenFactory({ dbFilename, dbLocation, …attachOptions }).openDB()`, mints `dbId`.
- Later `open`s of that key mint more `dbId`s onto the **same** adapter (refcount). `readOnly` is a routing hint when the VFS actually has readers (`OPFSWriteAheadVFS`); on the default VFS those reads serialize inside WASQLite.
- `execute` / `executeBatch` on a `dbId` run on that adapter (`readLock` + `executeRaw` vs `writeLock` + `executeRaw` / `executeBatch` according to `readOnly`). Map WASQLite `QueryResult` onto the native envelope (`insertId`, `rowsAffected`, `columnNames`, `rawRows`).
- Last `close` for that key `adapter.close()`s and drops the entry.

Do not construct six factories on one IndexedDB/OPFS file. Do not construct `WebPowerSyncDatabase`. WASQLite WASM already loads PowerSync sqlite-core; JS never calls `loadExtension`.

`dbLocation` is official `SQLOpenOptions.dbLocation` (directory must already exist). First open of a key binds attach options; a second `<lynx-view>` that opens the same file reuses that factory (one instance per file).

The JS Adapter still issues official OP-SQLite PRAGMAs and `powersync_update_hooks('install'|'get')` via `execute`.

---

## Web hop (`Cloneable`)

Native BindValue includes `ArrayBuffer` and `bigint`. Lynx-for-Web `NativeModulesCall` data is typed `Cloneable` (primitives, objects, arrays) — not those two.

The **lynx-bg factory** (and the matching page handler) converts them to a tagged Cloneable envelope and back. The JS Adapter still sees `ArrayBuffer` / `bigint`. No Web branch in the Adapter.

| Runtime value | Envelope on the hop |
|---|---|
| `ArrayBuffer` | `{ __psAb: true, u8: number[] }` (byte values 0–255) |
| `bigint` | `{ __psBig: true, v: string }` (decimal) |

Encode on the way in (params) and on the way out (`rawRows`). Do not throw across the hop: catch page-side and return `{ ok: false, message, code? }`.
