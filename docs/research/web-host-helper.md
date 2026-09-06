# Lynx-for-Web Host helper on `@powersync/web`

How a host page runs `@powersync/web` and exposes it to a Lynx bundle through `<lynx-view>` `nativeModulesMap` / `onNativeModulesCall`. Survey only: no helper export design.

**Snapshot:** 2026-09-06.

**Pins (not re-decided):** `@powersync/common` in Lynx JavaScript; native `DBAdapter` over SQLite + `powersync-sqlite-core` on iOS / Android / Windows / macOS; Lynx-for-Web uses a Host helper that runs `@powersync/web` in the host page. Autolink does not generate Web integration.

**Versions at snapshot**

- `@powersync/web` **2.3.0** (npm, published 2026-09-02). Depends on `@powersync/common` 2.2.0, `@journeyapps/wa-sqlite` 2.0.3. Apache-2.0. ([registry.npmjs.org/@powersync/web/latest](https://registry.npmjs.org/@powersync/web/latest))
- `@lynx-js/web-core` **0.26.0** (npm, published 2026-09-04). Host import: `@lynx-js/web-core/client`. Browserslist production: Chrome ≥ 92, Safari ≥ 16.4. Apache-2.0. ([registry.npmjs.org/@lynx-js/web-core/latest](https://registry.npmjs.org/@lynx-js/web-core/latest), [lynx-stack `packages/web-platform/web-core/package.json`](https://github.com/lynx-family/lynx-stack/blob/main/packages/web-platform/web-core/package.json))
- Integrate-with-existing-apps currently pins host SDK **Lynx 4.0.0**. ([lynxjs.org/guide/start/integrate-with-existing-apps](https://lynxjs.org/guide/start/integrate-with-existing-apps.html))

---

## Primary sources

- https://docs.powersync.com/client-sdks/reference/javascript-web
- https://docs.powersync.com/client-sdks/frameworks/react-native-web-support
- https://docs.powersync.com/client-sdks/frameworks/next-js
- https://docs.powersync.com/resources/supported-platforms
- https://github.com/powersync-ja/powersync-js (`packages/web`)
- https://www.npmjs.com/package/@powersync/web
- https://lynxjs.org/guide/start/integrate-with-existing-apps.html (Web)
- https://lynxjs.org/api/lynx-native-api/lynx-view/lynx-view.html
- https://lynxjs.org/guide/autolink.html
- https://lynxjs.org/guide/use-native-modules.html
- https://lynxjs.org/llms.txt
- https://github.com/lynx-family/lynx-stack (`packages/web-platform/web-core`)

---

## 1. Three JavaScript environments (not one)

Lynx-for-Web is a host page that loads a Lynx **web bundle** into `<lynx-view>`. The Lynx tree is still Lynx elements, not React DOM. ([integrate-with-existing-apps Web](https://lynxjs.org/guide/start/integrate-with-existing-apps.html), [react/introduction](https://lynxjs.org/react/introduction.html))

| Where | What runs | Browser APIs |
| --- | --- | --- |
| Host page (document that owns `<lynx-view>`) | `@lynx-js/web-core/client`; `onNativeModulesCall`; **`@powersync/web`** | `window`, workers, IndexedDB, OPFS, `SharedWorker`, COOP/COEP |
| Lynx background Worker (`name: 'lynx-bg'`) | Bundle JS + `nativeModulesMap` ESM factories | Worker global. `NativeModules` is background-only. No `document` / `window` in the Lynx programming model |
| Lynx main-thread realm | First screen, layout, MTS | Not `NativeModules` |

Facts:

1. Native Modules are **background-thread only**. ([use-native-modules](https://lynxjs.org/guide/use-native-modules.html), [llms.txt §12 / appendix 18](https://lynxjs.org/llms.txt))
2. The Lynx programming model has **no `document` or `window`**. Libraries that depend on them cannot run in the bundle. Missing Web APIs are a **different Lynx API** (`lynx.*`) or **NativeModules / Custom Elements**. ([react/introduction](https://lynxjs.org/react/introduction.html), [llms.txt §16](https://lynxjs.org/llms.txt))
3. Cross-thread arguments must be JSON-serializable (`runOnMainThread` / `runOnBackground`). Background event payloads are plain JSON. ([llms.txt §3, §9](https://lynxjs.org/llms.txt))
4. Lynx-for-Web itself constructs a **module Worker** (`new Worker(new URL('../background/index.js', import.meta.url), { type: 'module', name: 'lynx-bg' })`). `nativeModulesMap` is posted into that worker as URLs. ([lynx-stack `Background.ts`](https://github.com/lynx-family/lynx-stack/blob/main/packages/web-platform/web-core/ts/client/mainthread/Background.ts))
5. `@powersync/web` is WASQLite in **web workers**, IndexedDB / OPFS VFS, optional `SharedArrayBuffer`. Default `useWebWorker: true`. OPFS VFS **must** use workers. ([javascript-web](https://docs.powersync.com/client-sdks/reference/javascript-web), [`resolveAndValidateOptions.ts`](https://github.com/powersync-ja/powersync-js/blob/main/packages/web/src/db/adapters/resolveAndValidateOptions.ts), [`WASQLiteOpenFactory.ts`](https://github.com/powersync-ja/powersync-js/blob/main/packages/web/src/db/adapters/wa-sqlite/WASQLiteOpenFactory.ts))

**Does not force a locked-architecture change.** `@powersync/web` cannot be the Lynx bundle runtime. It belongs on the host page.

[INFERENCE] Instantiating `@powersync/web` inside a `nativeModulesMap` ESM (Lynx `lynx-bg` worker) would nest PowerSync workers inside Lynx’s worker and fight SharedWorker / `navigator.locks` / OPFS defaults. Official NativeModules examples hop to the host via `NativeModulesCall`. Ticket 09 pins the hop; this note does not design it.

---

## 2. Host page: `<lynx-view>` wiring

Current host init (post `@lynx-js/web-core@0.20.0`): `import '@lynx-js/web-core/client'` only. Removed: `thread-strategy`, `customTemplateLoader`, `overrideLynxTagToHTMLTagMap`, `inject-head-links`, manual CSS / `@lynx-js/web-elements` imports. ([lynx-view](https://lynxjs.org/api/lynx-native-api/lynx-view/lynx-view.html))

Rspeedy `environments: { web: {}, lynx: {} }` emits `dist/main.web.bundle`. The host sets `url` to that artifact. ([integrate-with-existing-apps Web](https://lynxjs.org/guide/start/integrate-with-existing-apps.html))

### CSS containment

Lynx-for-Web **forces CSS Containment** on `<lynx-view>`. Internal layout is out of the host flow. Set width and height (px, `%`, `flex-grow`). `width="auto"` / `height="auto"` enable content sizing; internal layout stays independent. ([lynx-view “Width and Height”](https://lynxjs.org/api/lynx-native-api/lynx-view/lynx-view.html))

Unrelated to PowerSync storage. The host page still owns workers, headers, and static assets.

### Same-origin Workers

Lynx-for-Web Worker scripts must satisfy the browser Same-Origin Policy. CDN-hosted JS vs page origin → `Failed to construct 'Worker'`. Documented workaround: `import 'remote-web-worker'` **before** `@lynx-js/web-core/client`. ([lynx-view FAQ](https://lynxjs.org/api/lynx-native-api/lynx-view/lynx-view.html))

PowerSync workers have the same constraint (see §5).

### `nativeModulesMap`

```ts
type NativeModulesMap = Record<string, string>;
```

Key = module name the Lynx bundle sees on `NativeModules`. Value = **ESM URL**, not an object. Default export is a factory `(NativeModules, NativeModulesCall) => methods`. Blob URLs (`URL.createObjectURL`) are the documented example. ([lynx-view](https://lynxjs.org/api/lynx-native-api/lynx-view/lynx-view.html), [lynx-stack `NativeModules.ts`](https://github.com/lynx-family/lynx-stack/blob/main/packages/web-platform/web-core/ts/types/NativeModules.ts))

The background worker **dynamic-imports** each URL (`import(/* webpackIgnore: true */ moduleStr)`) and calls `module.default(nativeModules, (name, data) => nativeModulesCall(name, data, moduleName))`. ([lynx-stack `createNativeModules.ts`](https://github.com/lynx-family/lynx-stack/blob/main/packages/web-platform/web-core/ts/client/background/background-apis/createNativeModules.ts))

Built-ins already present: `bridge`, `LynxExposureModule`, `IntersectionObserverModule`. Custom keys merge on top. `NativeModules.bridge.call(name, data, callback)` maps to `onNativeModulesCall(name, data, 'bridge')`. ([same file](https://github.com/lynx-family/lynx-stack/blob/main/packages/web-platform/web-core/ts/client/background/background-apis/createNativeModules.ts), [lynx-view `onNativeModulesCall` example](https://lynxjs.org/api/lynx-native-api/lynx-view/lynx-view.html))

A `LynxConsoleModule` factory that returns a Console-like object supplies the lexical `console` for that view’s background bundles. ([LynxView.d.ts](https://unpkg.com/@lynx-js/web-core@0.26.0/dist/client/mainthread/LynxView.d.ts))

### `onNativeModulesCall`

```ts
(name: string, data: any, moduleName: string) => Promise<any> | any
```

Runs on the **host page** (registered on `LynxViewElement` / `parentDom`). Return value is callback data. Calls made before the handler is assigned are **queued**. Handler `data` is typed `Cloneable` on the RPC path (JSON-ish primitives / objects / arrays — not a live SQLite handle). ([lynx-view](https://lynxjs.org/api/lynx-native-api/lynx-view/lynx-view.html), [`registerNativeModulesCallHandler.ts`](https://github.com/lynx-family/lynx-stack/blob/main/packages/web-platform/web-core/ts/client/mainthread/crossThreadHandlers/registerNativeModulesCallHandler.ts), [`LynxView.ts` cache](https://github.com/lynx-family/lynx-stack/blob/main/packages/web-platform/web-core/ts/client/mainthread/LynxView.ts))

Native type-mapping table (iOS/Android/Harmony) includes `ArrayBuffer` / callbacks. That table is **not** the Web RPC type. Web custom modules pass `Cloneable` over worker RPC. ([use-native-modules type mapping](https://lynxjs.org/guide/use-native-modules.html), `createNativeModules.ts`)

### Other host knobs (not PowerSync)

`initData` / `globalProps` / `updateData` / `updateGlobalProps` / `sendGlobalEvent`. `lynxGroupId` shares one background Worker across `<lynx-view>` instances. ([lynx-view](https://lynxjs.org/api/lynx-native-api/lynx-view/lynx-view.html), [use-data-from-host-platform](https://lynxjs.org/guide/use-data-from-host-platform.html))

[INFERENCE] Shared `lynxGroupId` shares `nativeModulesMap` imports in one worker. A Host helper singleton still belongs on the page, not in that worker.

### Fetch on Web vs native

Lynx Fetch on Web **is the browser Fetch** (CORS applies). Native Fetch has no CORS / redirect / keepalive / FormData / Blob. ([fetch compatibility](https://lynxjs.org/api/lynx-api/global/fetch.html)) `@powersync/web` sync uses **host-page** `fetch` / WebSocket (`WebRemote`), not Lynx Fetch. ([`WebRemote` / `SharedWebStreamingSyncImplementation.ts`](https://github.com/powersync-ja/powersync-js/blob/main/packages/web/src/db/sync/SharedWebStreamingSyncImplementation.ts))

---

## 3. Autolink does not generate Web

> Autolink currently covers native Android and iOS libraries only. It does not generate Web or HarmonyOS integration code.

A Lynx native library is npm + `lynx.lib.json` (Elements / Native Modules / Services). Host Autolink is Android Gradle plugins + iOS `cocoapods-lynx-library`. `lynx.lib.json` `platforms` keys documented: `android`, `ios`. Codegen emits Android/iOS specs + a JS facade, not a `<lynx-view>` map. ([autolink](https://lynxjs.org/guide/autolink.html))

**Web Adapter = host page wiring.** Installing the Client npm package does not register a Native Module on Lynx-for-Web.

---

## 4. `@powersync/web` on the host page

Package is an extension of `@powersync/common`. Public `PowerSyncDatabase` is `WebPowerSyncDatabase`. Default factory: `WASQLiteOpenFactory`. ([`packages/web/src/index.ts`](https://github.com/powersync-ja/powersync-js/blob/main/packages/web/src/index.ts), [`PowerSyncDatabase.ts`](https://github.com/powersync-ja/powersync-js/blob/main/packages/web/src/db/PowerSyncDatabase.ts), [javascript-web](https://docs.powersync.com/client-sdks/reference/javascript-web))

SSR: `ssrMode` defaults to `!('window' in globalThis)` → empty queries, no sync. Next.js docs: isolate PowerSync to client code. ([`resolveAndValidateOptions.ts`](https://github.com/powersync-ja/powersync-js/blob/main/packages/web/src/db/adapters/resolveAndValidateOptions.ts), [next-js](https://docs.powersync.com/client-sdks/frameworks/next-js))

Connection methods: HTTP streaming (default, recommended on web) or WebSocket. ([javascript-web “Connection Methods”](https://docs.powersync.com/client-sdks/reference/javascript-web))

`connect(connector)` still needs `fetchCredentials` + `uploadData`. On web with multi-tab shared workers, the **most recently opened tab** supplies those methods; when it closes, the previous tab. Credentials sent to the worker are `{ endpoint, token }` only (must be structured-cloneable). ([javascript-web “Multiple Tab Support”](https://docs.powersync.com/client-sdks/reference/javascript-web), `SharedWebStreamingSyncImplementation.ts`)

**FLAG (ticket 09, not a stack change):** CONTEXT.md says Connector lives in app JavaScript. `@powersync/web.connect(connector)` runs where `PowerSyncDatabase` is constructed — the host page. Bridging bundle Connector ↔ host `connect()` is a later pin. Shared-worker multi-tab already requires the connector to be callable from a tab.

---

## 5. Workers and `copy-assets`

PowerSync needs a **database worker** and a **sync worker**. Defaults spawn `new URL('./worker.js', import.meta.url)` as `Worker` or `SharedWorker` (`type: 'module'`). Shared name: `shared-powersync-${dbFilename}` (leading `shared-` when shared). ([`worker/client.ts`](https://github.com/powersync-ja/powersync-js/blob/main/packages/web/src/worker/client.ts))

Vite/webpack rewrite that `import.meta.url`. Metro / Turbopack do not. For those, copy the prebundled worker to a static URL. ([`worker/client.ts` comment](https://github.com/powersync-ja/powersync-js/blob/main/packages/web/src/worker/client.ts), [react-native-web-support](https://docs.powersync.com/client-sdks/frameworks/react-native-web-support), [next-js](https://docs.powersync.com/client-sdks/frameworks/next-js))

CLI (`bin` `powersync-web` → `bin/powersync.cjs`):

```bash
npx @powersync/web copy-assets
# or: powersync-web copy-assets -o public
```

Resolves `@powersync/web/bundled_worker`, copies **that file’s directory** (`dist/worker/`: `worker.js` + WA-SQLite / VFS chunks) to `{cwd}/{output}/@powersync/` after `rm -rf` of the destination. Default `--output` is `public`. ([`packages/web/bin/powersync.cjs`](https://github.com/powersync-ja/powersync-js/blob/main/packages/web/bin/powersync.cjs), [`package.json` `exports["./bundled_worker"]`](https://github.com/powersync-ja/powersync-js/blob/main/packages/web/package.json))

Documented load path after copy: `'/@powersync/worker.js'` for both `database.worker` and `sync.worker`. Next.js: gitignore `public/@powersync/*` (generated). ([react-native-web-support](https://docs.powersync.com/client-sdks/frameworks/react-native-web-support), [next-js](https://docs.powersync.com/client-sdks/frameworks/next-js))

Custom `worker` may be a string/URL or a factory returning `Worker` / `SharedWorker`. Worker `name` should be unique per `dbFilename`. ([react-native-web-support](https://docs.powersync.com/client-sdks/frameworks/react-native-web-support))

Lynx host pages that bundle with Rsbuild/Vite can use the default `import.meta.url` worker **or** `copy-assets`. CDN-hosted workers need same-origin or `remote-web-worker` (Lynx) / an explicit same-origin `worker` URL (PowerSync).

`useWebWorker: false` is documented as not recommended; OPFS VFS throws if workers are off. ([`options.ts`](https://github.com/powersync-ja/powersync-js/blob/main/packages/web/src/db/adapters/options.ts), `resolveAndValidateOptions.ts`)

---

## 6. VFS matrix (default not pinned here)

Enum `WASQLiteVFS` in [`vfs.ts`](https://github.com/powersync-ja/powersync-js/blob/main/packages/web/src/db/adapters/wa-sqlite/vfs.ts). Default in `resolveAndValidateOptions`: **`IDBBatchAtomicVFS`**. `vfsRequiresDedicatedWorkers`: everything except `IDBBatchAtomicVFS` and `InMemoryVfs` (those two may use SharedWorker when multi-tab is on).

From [javascript-web “SQLite Virtual File Systems”](https://docs.powersync.com/client-sdks/reference/javascript-web):

| VFS | Multi-tab (desktop) | Multi-tab Safari/iOS | Concurrent reads | Notes |
| --- | --- | --- | --- | --- |
| `IDBBatchAtomicVFS` (default) | yes | no | no | Broadest compatibility; IndexedDB |
| `OPFSCoopSyncVFS` | yes | yes | no | Documented Safari/iOS multi-tab pick |
| `AccessHandlePoolVFS` | no | no | no | Single-tab OPFS |
| `OPFSWriteAheadVFS` | yes | no | yes | Chromium only; `useWebWorker` must stay true; `additionalReaders` default 1 |
| `InMemoryVfs` | yes (shared worker; not Safari) | no | no | No persistence; `@powersync/web` ≥ 1.39.0 |
| `InMemoryWriteAheadLogPool` | isolated per tab | no | yes | **Not** `database.vfs`. Import `@powersync/web/extra/shared-memory-pool`. `@powersync/web` ≥ 2.2.0. Experimental. Needs cross-origin isolation + growable `SharedArrayBuffer`. No filename, no persistence |

Safari incognito: known OPFS issues (all OPFS variants). Firefox private tabs: OPFS not supported. ([javascript-web](https://docs.powersync.com/client-sdks/reference/javascript-web), [supported-platforms](https://docs.powersync.com/resources/supported-platforms))

OPFS cannot be cleared from DevTools; docs give `navigator.storage.getDirectory()` purge helpers. Encryption (ChaCha20) is an `encryptionKey` on open / factory — **out of this map**. ([javascript-web](https://docs.powersync.com/client-sdks/reference/javascript-web), [packages/web README](https://github.com/powersync-ja/powersync-js/blob/main/packages/web/README.md))

Ticket 09 pins the Client’s default VFS. This survey does not.

---

## 7. Multi-tab

`enableMultiTabs` default: `SharedWorker` exists, UA is not Android/iPhone/iPod/iPad, and `window.safari` is falsy. Docs: default `true` except Android, iOS, and Safari (`false` there). ([`resolveAndValidateOptions.ts`](https://github.com/powersync-ja/powersync-js/blob/main/packages/web/src/db/adapters/resolveAndValidateOptions.ts), [javascript-web flags](https://docs.powersync.com/client-sdks/reference/javascript-web))

When enabled: shared worker `shared-powersync-[dbFileName]`; one sync connection for all tabs; `fetchCredentials` / `uploadData` of the latest tab. IndexedDB VFS can share DB connections in that worker.

When disabled (or platform has no SharedWorker): per-tab dedicated workers; only one tab syncs; since 2.1.0 broadcast channels share watch notifications / sync status / stream subscriptions **less reliably**.

`broadcastLogs` default `true`. Disabling `useWebWorker` also disables multi-tab.

---

## 8. COOP / COEP / `SharedArrayBuffer`

Normal VFS path (IndexedDB / OPFS) does **not** require cross-origin isolation.

`InMemoryWriteAheadLogPool` **does**: growable `SharedArrayBuffer`; constructor throws without isolation. Typical headers: `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. Separate entry so unused apps do not bundle it. ([javascript-web](https://docs.powersync.com/client-sdks/reference/javascript-web), [`memory-pool/client.ts`](https://github.com/powersync-ja/powersync-js/blob/main/packages/web/src/db/adapters/memory-pool/client.ts))

Not required for the nijika-os MVP slice (offline + persist). Extra host-page headers only if that pool is chosen.

---

## 9. Host page vs npm subpath (facts, not an export design)

Published `@powersync/web` 2.3.0 `exports`:

| Subpath | What it is |
| --- | --- |
| `.` | `PowerSyncDatabase`, `WASQLiteOpenFactory`, `WASQLiteDBAdapter`, `WASQLiteVFS`, schema helpers re-exported from `@powersync/common`, sync types. `react-native` / `react-native-web` conditions → `dist/index.react_native_web.js` (default worker spawn is a throwing stub on Metro). |
| `./bundled_worker` | Prebundled `dist/worker/worker.js`. Input to `copy-assets`. |
| `./extra/shared-memory-pool` | `InMemoryWriteAheadLogPool` (+ default export). |

Bin: `powersync-web` → `copy-assets`.

### Must live on the host page (cannot be “just an npm import inside the Lynx bundle”)

- `import '@lynx-js/web-core/client'`
- `<lynx-view url="…web.bundle">` with size (containment)
- `nativeModulesMap = { [moduleName]: esmUrl }` assigned on the element
- `onNativeModulesCall` assigned on the element (page-side handler; this is where `@powersync/web` runs)
- Worker scripts reachable same-origin (`copy-assets` into the host’s static dir, **or** bundler-rewritten `import.meta.url`)
- Optional COOP/COEP if using `./extra/shared-memory-pool`
- Optional `import 'remote-web-worker'` if Lynx (or PowerSync) workers are cross-origin

The host app’s package.json is what installs `@powersync/web` and runs `copy-assets`. The Lynx bundle does not see `window`.

### Can be a documented subpath of the one Client npm (later ticket 09 / 10)

Not designed here. Facts that make a subpath *possible*:

- `nativeModulesMap` values are ESM URLs. A package can ship a `.js` whose default export is the factory `(NativeModules, NativeModulesCall) => …` and the host passes `new URL('…', import.meta.url)` or a blob. That factory still only hops via `NativeModulesCall`; it does not own WASQLite.
- `@powersync/web` already uses subpaths for worker + extra VFS. A Client package can document “host depends on `@powersync/web` + this subpath” the same way.
- Autolink will not emit that URL. The host still assigns `nativeModulesMap` / `onNativeModulesCall` by hand.

### Stays in the Lynx bundle

Public Client API (`PowerSyncDatabase`, `Schema`, `Table`, `column`, Connector types, `get` / `getAll` / `execute` / `writeTransaction` / `watch` / sync stream / `waitForFirstSync`) — implemented with `@powersync/common` talking to a Native Module, not by importing `@powersync/web` into PrimJS.

---

## 10. Locked architecture vs these facts

| Fact | Force a change? |
| --- | --- |
| `@powersync/web` needs workers + IndexedDB/OPFS + `window` | No — confirms host-page Web Adapter |
| Autolink Android/iOS only | No — already locked |
| `nativeModulesMap` ESM loads in `lynx-bg`, RPC data is `Cloneable` | No — host `onNativeModulesCall` is the Adapter. No live SQLite handle across the hop |
| Connector object vs shared-worker latest-tab | No — gap for ticket 09 |
| Default VFS `IDBBatchAtomicVFS`; Safari multi-tab wants `OPFSCoopSyncVFS` | No — ticket 09 pins Client default |
| `SharedArrayBuffer` only for experimental pool | No — MVP persist path does not need COOP/COEP |
| Encryption / `@powersync/react` | Out of map |

---

## Sources

1. https://docs.powersync.com/client-sdks/reference/javascript-web — VFS matrix, multi-tab, flags, workers, shared-memory pool, connection methods
2. https://docs.powersync.com/client-sdks/frameworks/react-native-web-support — `copy-assets`, `/@powersync/worker.js`
3. https://docs.powersync.com/client-sdks/frameworks/next-js — Turbopack `copy-assets -o public`, client-only init
4. https://docs.powersync.com/resources/supported-platforms — JS/Web browsers, OPFS private-tab notes
5. https://github.com/powersync-ja/powersync-js/blob/main/packages/web/package.json — exports, bin, 2.3.0
6. https://github.com/powersync-ja/powersync-js/blob/main/packages/web/bin/powersync.cjs — copy `bundled_worker` dir → `{output}/@powersync`
7. https://github.com/powersync-ja/powersync-js/blob/main/packages/web/src/worker/client.ts — default `import.meta.url` worker; Metro stub
8. https://github.com/powersync-ja/powersync-js/blob/main/packages/web/src/db/adapters/resolveAndValidateOptions.ts — defaults
9. https://github.com/powersync-ja/powersync-js/blob/main/packages/web/src/db/adapters/wa-sqlite/WASQLiteOpenFactory.ts — workers, extra readers
10. https://github.com/powersync-ja/powersync-js/blob/main/packages/web/src/db/adapters/wa-sqlite/vfs.ts — enum, dedicated-worker rule
11. https://github.com/powersync-ja/powersync-js/blob/main/packages/web/src/db/sync/SharedWebStreamingSyncImplementation.ts — latest-tab credentials
12. https://github.com/powersync-ja/powersync-js/blob/main/packages/web/src/db/adapters/memory-pool/client.ts — SharedArrayBuffer pool
13. https://registry.npmjs.org/@powersync/web/latest — 2.3.0, 2026-09-02
14. https://lynxjs.org/guide/start/integrate-with-existing-apps.html — Web host, `web-core/client`, `main.web.bundle`
15. https://lynxjs.org/api/lynx-native-api/lynx-view/lynx-view.html — `nativeModulesMap`, `onNativeModulesCall`, containment, workers FAQ
16. https://lynxjs.org/guide/autolink.html — no Web Autolink
17. https://lynxjs.org/guide/use-native-modules.html — BTS-only NativeModules
18. https://lynxjs.org/react/introduction.html — no `document`/`window`
19. https://lynxjs.org/api/lynx-api/global/fetch.html — Web = browser Fetch
20. https://lynxjs.org/llms.txt — dual-thread, JSON-serializable cross-thread, NativeModules list
21. https://github.com/lynx-family/lynx-stack/blob/main/packages/web-platform/web-core/ts/client/background/background-apis/createNativeModules.ts — ESM import in `lynx-bg`
22. https://github.com/lynx-family/lynx-stack/blob/main/packages/web-platform/web-core/ts/client/mainthread/crossThreadHandlers/registerNativeModulesCallHandler.ts — host handler
23. https://github.com/lynx-family/lynx-stack/blob/main/packages/web-platform/web-core/ts/types/NativeModules.ts — map + call types
24. https://unpkg.com/@lynx-js/web-core@0.26.0/dist/client/mainthread/LynxView.d.ts — element properties
25. https://registry.npmjs.org/@lynx-js/web-core/latest — 0.26.0, 2026-09-04
