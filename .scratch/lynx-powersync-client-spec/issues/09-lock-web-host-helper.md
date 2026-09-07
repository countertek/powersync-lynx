# Lock the Lynx-for-Web Host helper

Type: grilling
Status: resolved
Blocked by: 05, 07

## Question

What does the host page import and wire so Lynx-for-Web apps use the same Client API as native?

Already locked: `@powersync/web` cannot run inside the Lynx bundle; the Host helper lives in the host page; same npm package (subpath or documented helper); Autolink does not wire Web.

Pin:

- Export path (e.g. `powersync-lynx/web-host`)
- How to attach it (`nativeModulesMap` / `onNativeModulesCall`)
- Worker / WASM asset rules (`copy-assets` or equivalent)
- Default VFS and multi-tab stance for this Client
- What the Lynx bundle still constructs (`new PowerSyncDatabase({ schema, database: { dbFilename } })`)

HITL: `/grilling` + `/domain-modeling`. Output: host-integration section the spec can include.

## Answer

Host helper is SQL RPC on host-page `WASQLiteOpenFactory`, not a second `PowerSyncDatabase`. Same public API as native; app code never calls `NativeModules`. Cite: [assets/web-host-helper.md](../assets/web-host-helper.md). ADR: [docs/adr/0002-host-helper-is-wasqlite-sql-rpc.md](../../../docs/adr/0002-host-helper-is-wasqlite-sql-rpc.md). Native wire: [Lock the native Adapter and Native Module contract](08-lock-native-adapter-contract.md). Native Module export name and `package.json` `exports` are [Lock package layout, Autolink, and version floors](10-lock-package-layout.md).

**Lynx bundle.** Unchanged: `new PowerSyncDatabase({ schema, database: { dbFilename, dbLocation? } })`. Connector + `/sync/stream` stay in Lynx JS. Web VFS / workers / multi-tab are not constructor keys.

**Export.** Host page: `import { attach } from 'powersync-lynx/web-host'`. Not the Lynx-bundle barrel. `@powersync/web` is imported only here. Hosts that override `vfs` import `WASQLiteVFS` from `@powersync/web`.

**Attach.** `const { detach } = attach(lynxView, options?)`. One call **merges** `nativeModulesMap` and **wraps** `onNativeModulesCall` (dispatch on our moduleName; others fall through). Factory URL is bundler `new URL('./…js', import.meta.url)`, not a Blob. Assign before the bundle calls `NativeModules`. `detach()` unwraps and drops our map key; it does not close databases.

**Options / VFS / workers.** `options` is official `WASQLiteOpenFactory` / `WebSpecificOpenOptions` except `encryptionKey`. Omit → official defaults: `IDBBatchAtomicVFS`, `useWebWorker: true`, `enableMultiTabs` where `SharedWorker` exists and UA is not Android/iOS/Safari. Bundler-rewritten `import.meta.url` worker, or `npx @powersync/web copy-assets` → `{output}/@powersync/worker.js` and `worker: '/@powersync/worker.js'`. Same-origin. `enableMultiTabs` is WASQLite SharedWorker sharing, not official Web’s shared sync worker.

**Mapping.** One official factory per `dbFilename` (+ `dbLocation`) on the page. JS Adapter still `open`s 1 write + 5 read; those `dbId`s refcount the same adapter; `readOnly` routes when the VFS has readers. Last `close` tears the factory down. lynx-bg factory encodes `ArrayBuffer` / `bigint` as Cloneable (`{ __psAb, u8 }` / `{ __psBig, v }`) so the Adapter stays native-shaped. Page handler never throws for this module (`{ ok: false, message, code? }`).

## Comments

2026-09-07: claimed to grill and lock the Lynx-for-Web Host helper. Planning only — no package, no implementation. Honor [Freeze the public JS API](07-freeze-public-js-api.md) and [Lock the native Adapter and Native Module contract](08-lock-native-adapter-contract.md): same public API as native; Host helper implements Native Module method names `open` / `close` / `execute` / `executeBatch` on `@powersync/web`. App code never calls NativeModules.

2026-09-07 grilling round 1: official `@powersync/web` defaults locked (VFS, multi-tab, workers, bundle constructor). Frontier is Lynx-only forks: export path, `nativeModulesMap` / `onNativeModulesCall` attach, where official web open options live.

2026-09-07 grilling round 1 answers: Q1 A (`powersync-lynx/web-host`); Q2 A (`attach(lynxView, options?)` sets `nativeModulesMap` + `onNativeModulesCall`); Q3 A (official web open options on `attach` second arg; Lynx constructor unchanged).

2026-09-07 grilling round 2: Lynx-only mapping left — Native Module 1+5 `open`s onto one WASQLite factory; ArrayBuffer vs Lynx `Cloneable`; `attach` compose/detach. Native Module export name stays [Lock package layout, Autolink, and version floors](10-lock-package-layout.md).

2026-09-07 grilling round 2 answers: Q1 A (one factory per filename; 1+5 `dbId`s refcount it); Q2 A (factory encodes `ArrayBuffer` / `bigint` as Cloneable; no Adapter Web branch); Q3 A (`attach` merges/wraps and returns `{ detach() }`). Frontier empty; freeze recorded.
