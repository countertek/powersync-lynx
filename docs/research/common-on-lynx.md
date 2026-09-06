# Can `@powersync/common` run in Lynx background JS?

**Snapshot:** 2026-09-06. Packages inspected: `@powersync/common@2.2.0`, `@powersync/shared-internals@1.2.0`, `@powersync/web@2.3.0`, `@powersync/react-native@2.2.0` (npm tarballs + matching GitHub `main`). Lynx engine docs as of this date.

How to read: each claim is sourced unless marked `[INFERENCE]`. This note does not design the Client.

**Question:** can published `@powersync/common` (and whatever it needs) execute in the Lynx **background** JavaScript runtime?

**Answer:** Yes for `@powersync/common@2.2.0`. It is ESM-only, has **zero runtime npm dependencies**, and does not import Node builtins, `window`, `document`, `fetch`, or `WebSocket`. It is **not** the sync loop. The loop lives in `@powersync/shared-internals@1.2.0`, which official Web and React Native SDKs already load in JS. That split does **not** force vendoring `common` or moving the sync loop out of Lynx JS. A Lynx Client still has to supply a `DBAdapter` and an `AbstractRemote` (HTTP streaming `fetch`, optionally WebSocket), the same seam RN and Web already use.

---

## Sources

PowerSync:

- npm `@powersync/common@2.2.0`, `@powersync/shared-internals@1.2.0`, `@powersync/web@2.3.0`, `@powersync/react-native@2.2.0` (unpacked 2026-09-06)
- <https://github.com/powersync-ja/powersync-js> (`packages/common`, `packages/shared-internals`, `packages/web`, `packages/react-native`)
- <https://releases.powersync.com/announcements/v2-0-of-powersync-javascript-sdks> (2026-07-29)
- <https://docs.powersync.com/client-sdks/reference/javascript-web.md>
- <https://docs.powersync.com/client-sdks/reference/react-native-and-expo.md>
- <https://docs.powersync.com/client-sdks/watch-queries.md>
- <https://docs.powersync.com/client-sdks/writing-data.md>
- <https://docs.powersync.com/architecture/client-architecture.md>
- API extract: <https://powersync-ja.github.io/powersync-js/common/globals.html>

Lynx:

- <https://lynxjs.org/guide/scripting-runtime/index.md>
- <https://lynxjs.org/llms.txt>
- <https://lynxjs.org/guide/interaction/networking.md>
- <https://lynxjs.org/api/lynx-api/global/fetch.md>
- <https://lynxjs.org/api/rspeedy/rspeedy.source.include.md>
- <https://lynxjs.org/blog/lynx-rspack-2.md> (Rspeedy 0.15, 2026-06-30)
- Polyfill list: <https://github.com/lynx-family/lynx/blob/develop/js_libraries/lynx-polyfill/src/index.js>

---

## 1. 2.x split: `common` is the public surface; the loop is `shared-internals`

v2.0 of the JavaScript SDKs (announced 2026-07-29) moved implementation out of `@powersync/common`. The announcement states: `@powersync/common` now holds only the stable public interfaces; the implementation moves to a private `@powersync/shared-internals` package. (`releases.powersync.com/announcements/v2-0-of-powersync-javascript-sdks`)

Published `package.json` facts:

| Package | Version | Runtime deps | Role |
|---|---|---|---|
| `@powersync/common` | 2.2.0 | none (`devDependencies` only) | Public types + schema/logger/adapter **base classes** |
| `@powersync/shared-internals` | 1.2.0 | peer `@powersync/common@^2.2.0` | `BasePowerSyncDatabase`, streaming sync, HTTP/WS remotes |
| `@powersync/web` | 2.3.0 | `common@2.2.0`, `shared-internals@1.2.0`, wa-sqlite, comlink | `PowerSyncDatabase` + `WebRemote` + WASQLite |
| `@powersync/react-native` | 2.2.0 | `common@2.2.0`, `shared-internals@1.2.0`, `@powersync/react` | `PowerSyncDatabase` + `ReactNativeRemote` + OP-SQLite |

(`npm view` 2026-09-06; unpacked tarball `package.json` files.)

Both `common` and `shared-internals` are `"type": "module"` with a single `.` export to `lib/index.js`. CommonJS builds were removed in v2.0. (`package.json`; v2.0 announcement “Packages ship ESM only.”)

Web and RN both `export * from '@powersync/common'` and construct a platform subclass of `BasePowerSyncDatabase` from `@powersync/shared-internals`. (`packages/web/lib/index.js`, `packages/react-native/lib/index.js`, `packages/web/lib/db/PowerSyncDatabase.js`, `packages/react-native/lib/db/PowerSyncDatabase.js`)

**Locked architecture:** `@powersync/common` in Lynx JS still holds. `[INFERENCE]` A Lynx Client follows the same 2.x seam as RN: import public names from `common`, subclass `BasePowerSyncDatabase` from `shared-internals`, implement `DBAdapter` natively. That is using the published packages, not vendoring `common`.

---

## 2. 2.x public names

From `@powersync/common` `lib/index.d.ts` / API extract (`powersync-ja.github.io/powersync-js/common/globals`):

| Name | Kind | Where constructed |
|---|---|---|
| `PowerSyncDatabase` | **Not in `common`.** Platform class. | `new PowerSyncDatabase(...)` from `@powersync/web` or `@powersync/react-native` (`docs.powersync.com` JS Web / RN pages). Common exports `PowerSyncDatabaseConstructor<Options>` (`new (options): CommonPowerSyncDatabase`). |
| `CommonPowerSyncDatabase` | **Interface** (`lib/client/CommonPowerSyncDatabase.js` is empty `export {}`). | Type shared connectors against this. (`v2.0 announcement`; `PowerSyncBackendConnector.uploadData(database: CommonPowerSyncDatabase)`.) |
| `AbstractPowerSyncDatabase` | Deprecated type alias of `CommonPowerSyncDatabase`. | Do not use. |
| `DBAdapter` | **Abstract class** (v2.0: was an interface). Custom adapter implements `executeRaw`; base class builds `get` / `getAll` / `execute` / transactions. Also `LockContext`. | Platform Adapter. |
| `Schema`, `Table`, `ResolvedTable`, `column` | Runtime classes / const (`column.text` / `.integer` / `.real`). Schema v1 `new Column(...)` constructors **removed** in v2.0. | App JS. |
| Connector | Interface **`PowerSyncBackendConnector`**: `fetchCredentials()`, `uploadData(database)`, optional `postCheckpointRequest`. | App JS. There is no class named `Connector`. |
| `SQLOpenFactory` / `SQLOpenOptions` / `DatabaseSource` | Open via mutually exclusive `database` \| `factory` \| `opened`. | Constructor options. |
| `SyncStreamConnectionMethod` | Enum: `"http"` \| `"web-socket"`. | `connect()` options. |
| `waitForFirstSync`, `syncStream`, `watch`, `query` | Methods on `CommonPowerSyncDatabase`. | Implemented on `BasePowerSyncDatabase` in `shared-internals`. |

RN/Web docs still show `import { column, Schema, Table } from '@powersync/web'` / `'@powersync/react-native'` because those packages re-export `common`.

---

## 3. Imports: what `common` actually loads

Unpacked `@powersync/common@2.2.0` `lib/**/*.js`: every `import` is a relative `./….js` path. **No** `node:`, `fs`, `path`, `crypto`, `uuid`, `fetch`, `ws`, `buffer`, `process`. `package.json` has no `dependencies` field.

`@powersync/shared-internals@1.2.0` `lib/**/*.js` imports only `@powersync/common` plus relative files. The WebSocket stack is a **separate entry** `./websockets`:

- `"default": "./dist/websockets.mjs"` — Rollup bundle (includes a `buffer` polyfill; ~293 kB)
- `"node": "./dist/websockets.node.mjs"` — `import { Buffer } from 'node:buffer'`

Source of that entry (`lib/client/sync/stream/WebSocketSupport.js`) imports `rsocket-core` and `rsocket-websocket-client`. Those are `devDependencies` of `shared-internals`; they are **not** loaded unless a platform remote calls `loadWebSocketSupport` / `import('@powersync/shared-internals/websockets')`.

Lynx: npm packages are allowed; **C++ addons and Node builtins are not**. (`lynxjs.org/guide/scripting-runtime/index.md` “Module Names”; `llms.txt` §7.) `@powersync/common` and the default (non-`./websockets`) `shared-internals` graph match that rule. The Node `websockets.node.mjs` entry must not be resolved in Lynx; the default `websockets.mjs` is a browser-style bundle (still only needed for the WS path).

---

## 4. Globals and ES level

### Lynx background runtime

- Dual-thread: background runs ReactLynx / side effects / `fetch` / timers / `NativeModules`. (`llms.txt` §3, appendix 18)
- Engines: Android background **PrimJS** (QuickJS-based); iOS background **JavaScriptCore** unless PrimJS for debugging. Main thread is always PrimJS. Do not rely on engine-specific behavior. (`scripting-runtime/index.md`)
- Documented **maximum syntax**: background **ES2015 / ES6**; main **ES2019**. SWC transforms source during the build. (`scripting-runtime/index.md`; `llms.txt` §13)
- Rspeedy 0.15 (2026-06-30) raised the **bundler’s background output target** from ES2015 to **ES2017**. Scripting-runtime page still lists ES2015 as the engine maximum. (`lynxjs.org/blog/lynx-rspack-2.md`)
- **No `window` / `document`.** Replacement is the `lynx` global. (`llms.txt` §2, §16)
- **No Node builtins.** (`scripting-runtime/index.md`)
- Polyfills **only on iOS**, from `js_libraries/lynx-polyfill` (`@lynx-js/ios-polyfill`). The injected list is core-js 3.6.4 modules: `Symbol.asyncIterator`, `Array.flat`, typed arrays, `Object.fromEntries`, etc. **`AbortController`, `TextDecoder`, `fetch`, and `WebSocket` are not in that list.** (`lynx-polyfill/src/index.js`; `scripting-runtime/index.md` “Only injects polyfills on iOS”)
- Built-ins the docs list as available include `Promise`, `Map`/`Set`, `Symbol.asyncIterator`, `ArrayBuffer`. (`scripting-runtime/index.md`)

### What published PowerSync JS uses

`common` runtime (`lib/`):

- `AbortController` — `attachments/AttachmentQueue.js` (out of this map’s MVP) and `client/runOnSchemaChange.js` (schema-change restart for watched queries)
- `setTimeout` / `setInterval` — same files
- `console.log` / `warn` / `error` / `info` — `createConsoleLogger`
- `??=` (ES2021) — `Table.js` option defaults
- `Array.from`, optional chaining, classes, ESM

`shared-internals` runtime:

- `AbortController` throughout sync, mutex timeout, watch processors, `EventQueue.queueBasedAsyncIterable`
- `setTimeout` — retry delay, throttle, trigger cleanup (`120_000` numeric separator)
- `new TextDecoder()` — `AbstractRemote.createTextDecoder()` (UTF-8; documented as overridable for Hermes)
- `new WebSocket(url)` — `AbstractRemote.createSocket` and `WebsocketClientTransport` (WS path only)
- `globalThis` + optional `FinalizationRegistry` — leak warning for stream subscriptions (`ConnectionManager.js`). Feature-detected; null if missing
- `Symbol.asyncIterator ?? Symbol.for('Symbol.asyncIterator')` — `utils/compatibility.js`
- `??=` — `ConnectionManager`, `AbstractRemote.lazyFetchImplementation`
- Private field `#platform` — **only** `WebSocketSupport.js` (WS entry)
- TypeScript `target` for both packages is **`esnext`** (`tsconfig.base.json`). Published `lib/` is not downleveled.

Rspeedy **does not compile `node_modules` JavaScript by default**. `source.include` exists specifically because “some third-party dependencies have ESNext syntax, which may not be supported in Lynx.” (`api/rspeedy/rspeedy.source.include.md`)

`[INFERENCE]` Without `source.include` for `@powersync/common` and `@powersync/shared-internals`, PrimJS/JSC would see `??=`, numeric separators, and (on the WS path) private fields. That is a **bundler include**, not a vendor of `common`. Rspeedy 0.15’s ES2017 background target covers `async`/`await` and `??=` is still ES2021 — include + SWC is the documented fix.

---

## 5. Crypto / UUID

`common` and `shared-internals` contain **no** `crypto`, `randomUUID`, or `uuid` npm import.

Client-created row IDs are the **SQLite function `uuid()`** from `powersync-sqlite-core`, used in SQL: `INSERT … VALUES (uuid(), …)`. (`docs.powersync.com/client-sdks/writing-data.md`; RN docs mutation example.) Attachment queue IDs: `this.db.get('SELECT uuid() as id')` (`AttachmentQueue.js`).

`crypto.randomUUID()` appears in **`@powersync/web`** only (in-memory VFS / workers / tab-close locks). Not on the common/SI path.

`[INFERENCE]` Lynx JS does not need a JS UUID/crypto polyfill for the MVP slice. UUID minting is a SQLite-core load concern (ticket 02), not a PrimJS concern.

---

## 6. `watch` and async iterators

`CommonPowerSyncDatabase.watch` is implemented on `BasePowerSyncDatabase` in `shared-internals`:

- If the third argument has `onResult` → **callback** path (`watchWithCallback`). No async iterator required.
- Else → `watchWithAsyncGenerator` → `EventQueue.queueBasedAsyncIterable`, which returns `{ [symbolAsyncIterator]: () => ({ next, return }) }` and uses `AbortController`. (`BasePowerSyncDatabase.js` ~483–566; `utils/async.js` ~115–144)

A comment in the same file: “do not declare this as `async *onChange` as it will not work in React Native.” The SDK already avoids native async-generator syntax in this class; it builds an iterator object.

Official docs: the AsyncIterator `db.watch()` “is the foundational watch API”; the callback form exists “when you need smoother React Native compatibility or prefer synchronous method signatures.” They also say AsyncIterator/callback `db.watch()` is **back-compat**; prefer `db.query(…).watch()` + `registerListener`. (`docs.powersync.com/client-sdks/watch-queries.md`)

RN README: Async Iterator `watch` **and** `getCrudTransactions()` require `@azure/core-asynciterator-polyfill` plus `@babel/plugin-transform-async-generator-functions` on Expo. (`packages/react-native/README.md`)

Lynx lists `Symbol.asyncIterator` as a polyfilled/available Symbol. (`scripting-runtime/index.md`; iOS polyfill `es.symbol.async-iterator`.)

`[INFERENCE]` Callback `watch` / `query().watch().registerListener` run without async-generator transforms. The iterator form needs `Symbol.asyncIterator` (documented) and `AbortController` (not in the Lynx polyfill list). App `for await` loops still need SWC to lower async generators, which Rspeedy already does for app source.

---

## 7. Where HTTP and WebSocket live

**Not in `@powersync/common`.** Common only defines `SyncStreamConnectionMethod` and Connector types.

The protocol client is `AbstractRemote` + `AbstractStreamingSyncImplementation` in `shared-internals`:

- HTTP: `fetchStreamRaw` POSTs `/sync/stream`, requires `res.body.getReader()`, then NDJSON (`TextDecoder`) or BSON (`Uint8Array`). `fetch()` is abstract: platforms implement `fetch({ resource, request, expectStreamingResponse })`. (`AbstractRemote.js`)
- Default method on `BasePowerSyncDatabase` is **HTTP**. RN overrides: HTTP if the fetch impl `supportsStreams`, else WebSocket. (`BasePowerSyncDatabase.js` `defaultConnectionMethod`; `packages/react-native/lib/db/PowerSyncDatabase.js`)
- Web: `WebRemote.fetch` = global `fetch`; `loadWebSocketSupport` = **dynamic** `import('@powersync/shared-internals/websockets')`. (`packages/web/lib/db/sync/WebRemote.js`)
- RN: `ReactNativeRemote.fetch` uses `expo/fetch` when present (streaming), else RN’s non-streaming `fetch` and the constructor throws if HTTP streaming was requested. WS via static `import { WebSocketSupport } from '@powersync/shared-internals/websockets'`. (`packages/react-native/lib/sync/stream/fetch.js`, `ReactNativeRemote.js`)
- v2.0: HTTP is default; WebSockets (RSocket, ~500 kB) load only when connecting over WS. (`v2.0 announcement`; JS Web “Connection Methods”: “On the web, there is no compelling reason to use WebSockets over HTTP response streams.”)

PowerSync Service connection is “HTTP streams or WebSockets (depending on the specific Client SDK).” (`docs.powersync.com/architecture/client-architecture.md`)

### Lynx network surface (facts for the Client; details on the network ticket)

- Background `fetch` exists, host-provided HTTP service, not identical to browser Fetch (no CORS/redirect/keepalive/FormData/Blob). Android/iOS from Lynx 2.18. (`api/lynx-api/global/fetch.md`; `guide/interaction/networking.md`; `llms.txt` appendix 18)
- Streaming: `response.body.getReader()` documented; **`enableFetchAPIStandardStreaming = true`** is required. Streaming example uses `TextCodecHelper.decode(value)` because **“PrimJS currently lacks `TextEncoder` / `TextDecoder`.”** (`guide/interaction/networking.md`; `llms.txt` §13)
- `EventSource` exists (`lynx.EventSource`). PowerSync does not use SSE.
- Official Lynx scripting/networking pages do **not** document a `WebSocket` global. `[INFERENCE]` Treat WS as absent until a host or later Lynx API provides it.

`AbstractRemote.createTextDecoder()` is a method **so platforms can patch it** (“without forcing us to bundle a polyfill with `@powersync/common`”). (`AbstractRemote.js` comment.) A Lynx remote can return a `TextCodecHelper`-backed decoder, or prefer BSON (no decoder).

---

## 8. Flags: vendor `common`? move the sync loop?

| Flag | Forces vendor of `common`? | Forces moving the sync loop out of Lynx JS? |
|---|---|---|
| 2.x split (`common` vs `shared-internals`) | No. Load both published packages, as RN/Web do. | No. Loop is already JS in `shared-internals`. |
| ESM-only + `esnext` `??=` / `120_000` in `node_modules` | No. Rspeedy `source.include` for those two packages. | No. |
| No `window`/`document`/Node | No. Neither package needs them. | No. |
| No JS `crypto`/`uuid` | No. IDs are SQLite `uuid()`. | No. |
| `AbortController` not in Lynx polyfill list | No. Polyfill in the Client (or confirm JSC/PrimJS already has it). Used by SI watch + sync, not only attachments. | Only if it cannot be polyfilled **and** cannot be patched at the remote/watch seam. `[INFERENCE]` a 30-line polyfill is the first fix. |
| PrimJS no `TextDecoder` | No. Override `createTextDecoder` on the Lynx `AbstractRemote`, or use BSON. | No. |
| HTTP streaming needs `enableFetchAPIStandardStreaming` | No. PageConfig + Lynx `fetch`. | **If** Lynx streaming `fetch` cannot feed `res.body.getReader()` **and** no `WebSocket` exists, JS cannot run `/sync/stream`. That is the one evidence-backed path to a native sync loop. Unproven until the network ticket measures `fetch` streaming. |
| RSocket/WS `Buffer` + private fields | No. Default path is HTTP; WS entry is optional. | Same as row above. |
| `FinalizationRegistry` missing | No. Feature-detected; subscriptions still work; leak warning skipped. | No. |
| Attachments / `@powersync/react` | Out of this destination. | Out of this destination. |

**Would not change the locked architecture** on current evidence: `@powersync/common` + `@powersync/shared-internals` in Lynx **background** JS; native `DBAdapter` (SQLite + `powersync-sqlite-core`); Lynx-for-Web Host helper still runs `@powersync/web` in the host page (web workers / `navigator` / IndexedDB are Web-only — `WebPowerSyncDatabase` uses `getNavigatorLocks`, WASQLite, shared workers).

`[INFERENCE]` `@powersync/web` is the wrong package to import **inside** the Lynx background bundle. That is consistent with the locked Host-helper split, not a reason to vendor `common`.

---

## 9. MVP slice vs extra surface in `common`

`common` still exports attachments (`AttachmentQueue`, storage adapters). Those use `AbortController` and `setInterval`. This map’s contract excludes attachments. Tree-shaking ESM `import { Schema, Table, column, … }` avoids loading them **if** the bundler tree-shakes; a blanket `export *` from a Client entry would pull them in.

`@powersync/react-native` also `export * from '@powersync/react'`. That package is later / out of this destination (`map.md` Notes).

---

## Bottom line

1. Published `@powersync/common@2.2.0` is safe to execute in Lynx background JS: no Node, no DOM, no network, no JS crypto.
2. The Client **must also** run `@powersync/shared-internals@1.2.0` in that same JS (official 2.x layout). That is not vendoring `common`.
3. `PowerSyncDatabase` is a platform subclass; Lynx supplies one. Public app names `Schema`, `Table`, `column`, `DBAdapter`, `PowerSyncBackendConnector`, `CommonPowerSyncDatabase` come from `common`.
4. HTTP `/sync/stream` + `DBAdapter` stay in JS. Vendor `common` or move the loop native **only** if Lynx cannot provide streaming `fetch` (or WS) **and** `AbortController` cannot be polyfilled — not indicated by `common` itself.
