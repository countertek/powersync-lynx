# Lynx Native Module and Autolink limits for a DBAdapter

What a Lynx Native Module can pass, and what Autolink generates, if the public Client is `@powersync/common` plus a platform `DBAdapter`. Facts only. This note does not design a Native Module method list.

**Snapshot:** 2026-09-06. Claims are sourced unless marked `[INFERENCE]`. Autolink facts are from the Lynx **next** channel (`/next/guide/autolink.md`), which is the 4.0 Autolink surface this destination pins. Native Module runtime facts are from `use-native-modules` (current and next agree on the type table; next adds the Weak Node-API column). `DBAdapter` is `powersync-js` `packages/common/src/db/DBAdapter.ts` at commit `3aad5a4738bc` (2026-07-06).

**Does not force a change** to the locked architecture (`@powersync/common` in Lynx JS; native Adapter over SQLite + `powersync-sqlite-core`; Lynx-for-Web Host helper). Constraints below are what [Lock the native Adapter and Native Module contract](../../.scratch/lynx-powersync-client-spec/issues/08-lock-native-adapter-contract.md) must respect.

---

## Gist

A Native Module is a **background-thread** host object. Arguments and returns are the type-mapping table (primitives, `BigInt`, `ArrayBuffer`, JSON-shaped `object`/`array`, `function` callbacks). There is **no** passable live SQLite handle. `DBAdapter.readLock` / `writeLock` / `LockContext` and `tablesUpdated` for `watch` are JavaScript types in `@powersync/common`; they cannot be the Native Module wire. Autolink registers an npm native library app-wide on **Android 4.0** and **iOS 4.0**, and Lynxtron can load the same `lynx.lib.json` package as a `.node`. Autolink **does not** generate Web (or released HarmonyOS) integration. If Autolink tooling is missing, the documented path is manual `registerModule`.

---

## 1. Background thread only

Official Native Modules guide: “Currently, native modules can only be used in Background Thread Scripting.” Front-end code reaches them as `NativeModules.<Name>` on the **background** runtime. `NativeModules` is listed as a background-only API in the Lynx llms digest. ([use-native-modules](https://lynxjs.org/guide/use-native-modules), [next/use-native-modules](https://lynxjs.org/next/guide/use-native-modules.md), [next/llms.txt](https://lynxjs.org/next/llms.txt) §12 and Appendix 18)

Living spec §4.6: a Native Module is a host object in the **background thread runtime** based on Node-API or JSI. Native developers register host capabilities; script developers call them from BTS. ([living spec](https://lynxjs.org/guide/spec.html) / [living-spec](https://lynxjs.org/living-spec/index.html))

HarmonyOS extra: a `@Sendable` module’s methods are **synchronous**; every other Harmony module method is **asynchronous** and its return value is `null`. Results then go through a callback. HarmonyOS is out of this destination; recorded so a later contract does not assume every host can return SQL rows as a sync Native Module result. ([use-native-modules HarmonyOS](https://lynxjs.org/next/guide/use-native-modules.md))

Android and iOS samples do return values synchronously (`String getLabel(String id)` in the Autolink Native Module example) **and** take `Callback` / blocks. ([next/autolink](https://lynxjs.org/next/guide/autolink.md), [use-native-modules](https://lynxjs.org/guide/use-native-modules))

---

## 2. Passable types (runtime type mapping)

The interface specification “defines the methods and data types passed between” native code and the Lynx JavaScript runtime. Available types and native counterparts: ([use-native-modules Type Mapping Table](https://lynxjs.org/guide/use-native-modules), [next table](https://lynxjs.org/next/guide/use-native-modules.md))

| TypeScript | iOS | Android | HarmonyOS | Weak Node-API (desktop) |
|---|---|---|---|---|
| `null` | `nil` | `null` | `null` | `Napi::Value` / `env.Null()` |
| `undefined` | `nil` | `null` | `undefined` | `Napi::Value` / `env.Undefined()` |
| `boolean` | `BOOL` (`NSNumber` inside objects) | `boolean` (`Boolean` inside objects) | `boolean` | `Napi::Boolean` |
| `number` | `double` (`NSNumber` inside objects) | `double` (`Number` inside objects) | `number` | `Napi::Number` |
| `string` | `NSString` | `String` | `string` | `Napi::String` |
| `BigInt` | `NSString` | `long` (`Number` inside objects) | `BigInt` | `Napi::BigInt` |
| `ArrayBuffer` | `NSData` | `byte[]` | `Buffer` | `Napi::ArrayBuffer` |
| `object` | `NSDictionary` | `ReadableMap` | `object` | `Napi::Object` |
| `array` | `NSArray` | `ReadableArray` | `array` | `Napi::Array` |
| `function` | block `void (^)(id)` | `com.lynx.react.bridge.Callback` | `function` | `Napi::Function` |

Facts that matter for a `DBAdapter`:

- **Primitives** (`boolean`, `number`, `string`, nullish) pass. SQL text and bind parameters that are scalars fit.
- **Binary** passes as `ArrayBuffer` (`NSData` / `byte[]` / N-API `ArrayBuffer`). `@powersync/common` `SqliteValue` includes `Uint8Array` and `number[]` for blobs. ([QueryResult.ts](https://github.com/powersync-ja/powersync-js/blob/3aad5a4738bc/packages/common/src/db/QueryResult.ts))
- **Structured data** passes as `object` / `array` mapped to dictionary/array types, not to a live native instance the JS side can retain and call methods on.
- **Callbacks** pass as `function`. Native can invoke JS later (`callback.invoke(value)` on Android; block on iOS; `Napi::Function::Call` on desktop).
- There is **no** mapping for a host object identity, `sqlite3*`, file descriptor, or other native pointer. PrimJS `HostRef` exists for Element PAPI (living spec §4.3.3) and is **not** in this Native Module table.
- `Promise` is **not** a row in the runtime type-mapping table. Autolink **codegen** for non-Harmony targets lists promises as a generated-target type (see §6). `[INFERENCE]` a hand-written Native Module should treat async completion as a `function` callback unless codegen is used and verified on that host.

Glossary: [`CONTEXT.md`](../../CONTEXT.md).

---

## 3. No live SQLite handle across the Native Module

Consequences of §2, not a designed API:

1. JS cannot hold a SQLite connection object returned from native. `object` is `NSDictionary` / `ReadableMap`, a value snapshot.
2. Native **can** hold the connection as instance state. The official storage sample keeps `NSUserDefaults` / `SharedPreferences` / an in-process map on the module instance and exposes methods over it. ([use-native-modules](https://lynxjs.org/guide/use-native-modules))
3. Contrast: the official React Native `OPSQLiteDBAdapter` keeps live `OPSQLiteConnection` objects in JS (`open()` from `@op-engineering/op-sqlite`) and passes those into `readLock` / `writeLock` callbacks. That is a JSI/host-object wrapper, which Lynx Native Module type mapping does not provide. ([OPSqliteAdapter.ts](https://github.com/powersync-ja/powersync-js/blob/master/packages/react-native/src/db/adapters/op-sqlite/OPSqliteAdapter.ts))

So the Lynx JS `DBAdapter` talks to native by **method calls with passable types**. The SQLite handle stays native.

---

## 4. `DBAdapter` / `LockContext` / `watch` (what is JS)

Source: [`packages/common/src/db/DBAdapter.ts`](https://github.com/powersync-ja/powersync-js/blob/3aad5a4738bc/packages/common/src/db/DBAdapter.ts) (`3aad5a4738bc`).

**`DBAdapter`** extends `BaseObserver<DBAdapterListener>` and implements `SqlExecutor` + `DBGetUtils`. Abstract members a platform Adapter must implement:

- `name`, `close()`, `refreshSchema()`
- `readLock(fn, options?)`, `writeLock(fn, options?)` — `fn` receives a `LockContext`
- `executeRaw` is abstract on `LockContext`; default `DBAdapter.execute` / `executeRaw` / `executeBatch` acquire a **write** lock; `get` / `getAll` / `getOptional` acquire a **read** lock

**`LockContext`** is a JS abstract class: `executeRaw`, default `execute` / `get*` / `executeBatch`. **`Transaction`** adds `commit` / `rollback`. `readTransaction` / `writeTransaction` wrap locks and run `BEGIN IMMEDIATE` in JS.

**`DBLockOptions`**: `{ timeoutMs?: number }`.

**`tablesUpdated`**: listener on `DBAdapterListener`. Payload is `{ tables: string[] }` (`BatchedUpdateNotification`). `BaseObserver.registerListener` is JS-side subscribe/unsubscribe. Official `watch` / live queries in `common` listen here; they do not talk to SQLite update hooks themselves.

**`QueryResult` / `RawQueryResult`**: `insertId`, `rowsAffected`, `columnNames`, `rawRows: SqliteValue[][]`. `SqliteValue` = `string | number | bigint | number[] | Uint8Array | null`.

These types include JS functions (`fn: (tx: LockContext) => Promise<T>`), JS classes, and observer callbacks. They are the Adapter **in Lynx JS**, not Native Module arguments.

Official RN adapter (existence proof of how `common` expects an Adapter to behave, not a Lynx API):

- JS semaphores over one write connection and five read connections
- `writeLock` `finally`: `SELECT powersync_update_hooks('get')`, `JSON.parse` into `{ tables }`, `iterateListeners` → `tablesUpdated`
- write connection installs hooks with `SELECT powersync_update_hooks('install')`

([OPSqliteAdapter.ts](https://github.com/powersync-ja/powersync-js/blob/master/packages/react-native/src/db/adapters/op-sqlite/OPSqliteAdapter.ts))

Facts for the contract ticket, still not a method list:

- **Locks** can be implemented in the JS Adapter (queue / timeout around native execute calls) and/or inside native (serialize SQLite use). Native cannot receive the `LockContext` callback as a live handle.
- **`watch`** needs `tablesUpdated({ tables: string[] })` on the JS Adapter. Native can push table names with a `function` callback (`string[]` / `array` is in the type table), or JS can ask native after a write (the RN adapter’s `powersync_update_hooks('get')` pattern, as SQL text + result). Either way the **listener** stays in JS.
- **SQL in / rows out** fit passable types: `string` SQL, `array` of scalars/`ArrayBuffer` binds, `object`/`array` or `ArrayBuffer` for `RawQueryResult`.

---

## 5. Autolink: what it generates (Android/iOS 4.0 + Lynxtron; no Web)

Source: [next/guide/autolink.md](https://lynxjs.org/next/guide/autolink.md).

A Lynx native library is an npm package that may ship Elements, Native Modules, and/or Services. Manifest: `lynx.lib.json` at the package root. Autolink scans `node_modules` at **build** time and wires hosts.

**LCD (`features.autolink`)** in that page:

| Platform | Version added |
|---|---|
| Android | **4.0** |
| iOS | **4.0** |
| HarmonyOS | **No** |
| Web | **No** |

Lynxtron is documented on the same page but **not** in that LCD table. Opening paragraph: Autolink “provides app-wide registration on Android and iOS.” “HarmonyOS integration is documented below but is **not yet available in a released Lynx SDK**.” It “covers the package metadata and host loading used by Lynxtron native libraries, but **does not generate per-`LynxView` library registration or Web integration code**.”

If Autolink packages cannot be resolved from the configured registry: “Keep using the existing **manual native registration** flow.” Tooling names: `create-lynx-library`, `@lynx-js/autolink-codegen` (`lynx-autolink-codegen`); Android Gradle `org.lynxsdk.lynx.library-settings` and `org.lynxsdk.lynx.library-build` (docs example version **4.0.1**); iOS gem `cocoapods-lynx-library`; Lynxtron `@lynx-js/lynxtron-dev-plugins` `pluginLynxtron()`.

### Android 4.0

Host: settings plugin + app `library-build` plugin. Generates a **fixed Android registry** into app sources. Loaded when the app initializes `LynxEnv`. App-wide Elements / Native Modules / Services. App code adds no per-library native init. `platforms.android.packageName` required; `sourceDir` defaults to `android`.

### iOS 4.0

Host: `plugin 'cocoapods-lynx-library'` and `use_lynx_library!` in the Podfile. `pod install` generates a **registry pod** and hooks Lynx init (`LynxConfig` / `LynxEnv`). `sourceDir` defaults to `ios`; `podspecPath` defaults to the first `.podspec` under that dir. iOS discovery scans `@LynxNativeModule(...)`, `@LynxElement(...)`, `@LynxService(...)`.

### Lynxtron (Windows / macOS hosts that use it)

“Lynxtron enables Autolink for Desktop native libraries. **Not every Lynx-embedded Desktop host supports Autolink out of the box**; this is a Lynxtron-provided integration.” `pluginLynxtron()` (default on) scans `lynx.lib.json`, copies matching packages into host output, injects a require of each package’s `./lynxtron` entry, which loads the current host `.node` (e.g. `dist/macos/arm64/<name>.node`, `dist/windows/x64/<name>.node`). `platforms.lynxtron.path` is the artifact root (usually `dist`). `platforms.macos.sourceDir` / `platforms.windows.sourceDir` point at source-exposed `shared/`. After load, static registrations (`LYNX_REGISTER_NATIVE_MODULE`) appear on `NativeModules`. No extra Lynxtron registration macro. ([next/autolink](https://lynxjs.org/next/guide/autolink.md), [Lynxtron native libraries](https://lynxjs.org/next/lynxtron/Native-Libraries/Lynx-Native-Libraries.md), [next/use-native-modules Desktop](https://lynxjs.org/next/guide/use-native-modules.md))

Desktop SQLite binary choice is [Survey Lynx desktop native modules and SQLite](../../.scratch/lynx-powersync-client-spec/issues/06-survey-lynx-desktop-sqlite.md), not this note.

### No Web Autolink

LCD: Web **No**. Prose: Autolink does not generate Web integration code.

Lynx-for-Web Native Modules are **host-page JavaScript**, not ObjC/Kotlin and not Autolink:

- `<lynx-view>.nativeModulesMap`: `Record<string, string>` module name → **ESM URL**. The module default-exports a factory `(NativeModules, NativeModulesCall) => { methods }`.
- `<lynx-view>.onNativeModulesCall`: `(name, data, moduleName) => Promise<any> | any`. Return value is treated as callback data.

([lynx-view](https://lynxjs.org/api/lynx-native-api/lynx-view/lynx-view.md))

That matches the locked Host helper: Native Module-shaped calls from the Lynx bundle, implemented in the host page against `@powersync/web`. Autolink will not register that helper.

HarmonyOS Autolink is documented (Hvigor plugin, Registry HAR) but LCD **No** and “not yet available in a released Lynx SDK.” Destination already excludes HarmonyOS.

Stable `https://lynxjs.org/guide/autolink` (non-`/next/`) still says Autolink is Android/iOS only, Gradle plugin ids `org.lynxsdk.library-settings` / `org.lynxsdk.library-build` (no `.lynx.` infix), and does not document Lynxtron. Use **next** for 4.0 + Lynxtron.

---

## 6. `@lynxmodule` codegen limits

`lynx-autolink-codegen` reads `lynx.lib.json` and scans Native Module declaration files under `types/` for `/** @lynxmodule */` classes. It generates:

- `generated/<Name>.ts` — JavaScript facade
- Android `Spec.java`
- iOS `Spec.h` / `Spec.m`
- HarmonyOS `Spec.ets` (out of this destination)
- shared C++ N-API stubs under `shared/nativeModule/` when the N-API feature is selected

([next/autolink Authoring](https://lynxjs.org/next/guide/autolink.md))

**HarmonyOS generated spec** (even though Harmony is out): `void`, `string`, `number`, `boolean`, and nullable unions with `null` only.

**Other generated targets** (Android / iOS platform modules and N-API): arrays, objects/maps/sets, promises, and N-API wrapped types `ArrayBuffer`, typed arrays, `BigInt`, `Date`, `Function`, `Symbol`, `Buffer`, `Value`.

Stable `/guide/autolink` still says “The first version supports `void`, `string`, `number`, `boolean`, and nullable unions with `null`.” Treat that as the older Autolink page. This destination’s Autolink source is `/next/`.

Codegen does **not** invent a live SQLite type. Native implementations extend the generated spec (`ButtonModule extends ButtonModuleSpec`) and keep native state on the class.

A library may still ship a **hand-written** Native Module using the full runtime type table (§2) without going through `@lynxmodule`. Autolink still needs `lynx.lib.json` plus native discovery annotations (`@LynxNativeModule` / iOS `@LynxNativeModule("…")` / `LYNX_REGISTER_NATIVE_MODULE`).

---

## 7. Manual `registerModule` (documented fallback, not the floor)

When Autolink is unavailable, or for hosts Autolink does not cover, the Native Modules guide’s registration APIs:

| Host | Registration |
|---|---|
| iOS | `[globalConfig registerModule:NativeLocalStorageModule.class]` (class implements `LynxModule`, `+name`, `+methodLookup`) |
| Android | `LynxEnv.inst().registerModule("NativeLocalStorageModule", NativeLocalStorageModule.class)` (`@LynxMethod` on exported methods) |
| HarmonyOS | `this.modules.set(name, { moduleClass })` (Sendable → `this.sendableModules`) |
| Desktop (Node-API) | `LYNX_REGISTER_NATIVE_MODULE("Name", CreateFn, opaque)` then load the `.node` / link the library |
| Web | `nativeModulesMap` + `onNativeModulesCall` on `<lynx-view>` — not `registerModule` |

([use-native-modules](https://lynxjs.org/guide/use-native-modules), [next/use-native-modules](https://lynxjs.org/next/guide/use-native-modules.md), [lynx-view](https://lynxjs.org/api/lynx-native-api/lynx-view/lynx-view.md), [next/autolink](https://lynxjs.org/next/guide/autolink.md) tooling-availability paragraph)

Ticket 08 already: “Manual `registerModule` as a documented fallback, not the floor.” Autolink Android/iOS 4.0 + Lynxtron `pluginLynxtron()` is the generated path; manual registration is what hosts use when that path is missing.

Global Autolink modules load **before** a `LynxView` / `LynxBackgroundRuntime` explicit module map; an explicit local module keeps override behavior. ([next/autolink](https://lynxjs.org/next/guide/autolink.md))

---

## 8. Architecture flags

None of the above forces a change to: `@powersync/common` in Lynx JS; native Adapter over SQLite + `powersync-sqlite-core`; Web Host helper on `@powersync/web`.

| Observation | Why it does not reopen the lock |
|---|---|
| No live SQLite handle | Adapter in JS; native holds the DB. Same split the destination already named. |
| Locks and `tablesUpdated` are JS | `common` already owns `watch` / lock callbacks; native supplies SQL + optional table-name callbacks. |
| No Web Autolink | Host helper was already the Web path. |
| Lynxtron Autolink is host-plugin, not every desktop embedder | Ticket 06; not a mobile/Web architecture change. |
| Type table includes `ArrayBuffer` / `BigInt` | Richer than “JSON-serializable”; does not move `common` out of JS. |

---

## 9. Facts ticket 08 needs (still not a module API)

1. Native Module calls are **BTS-only**.
2. Wire types: §2 table. No live handle. Blobs = `ArrayBuffer`. Completions = `function` (codegen may emit promises on Android/iOS/N-API).
3. JS Adapter implements `DBAdapter` / `LockContext` / `tablesUpdated`. Native Module is an implementation detail; app code does not call `NativeModules` for this (already locked).
4. `watch` is JS listeners; native must be able to surface changed **table name strings**.
5. `readLock` / `writeLock` timeouts are JS (`timeoutMs`); native must not assume a JS closure runs *inside* a native lock object.
6. Autolink floor: Android 4.0 + iOS 4.0 via `lynx.lib.json`. Lynxtron via `pluginLynxtron()` + `./lynxtron` `.node`. **No Web Autolink.** Manual `registerModule` / Web maps when Autolink does not apply.
7. `@lynxmodule` codegen is optional scaffolding; Harmony spec is a primitive subset; Android/iOS/N-API codegen is broader but still not a SQLite handle type.

---

## Sources

1. https://lynxjs.org/guide/use-native-modules — BTS-only, type mapping, manual iOS/Android/Harmony registration
2. https://lynxjs.org/next/guide/use-native-modules.md — same + Weak Node-API column, `LYNX_REGISTER_NATIVE_MODULE`
3. https://lynxjs.org/next/guide/autolink.md — Autolink 4.0 Android/iOS, Lynxtron, no Web, `lynx.lib.json`, `@lynxmodule` codegen
4. https://lynxjs.org/guide/autolink — older Autolink page (Android/iOS only; narrower codegen sentence)
5. https://lynxjs.org/next/lynxtron/Native-Libraries/Lynx-Native-Libraries.md — Lynxtron load + static registration
6. https://lynxjs.org/api/lynx-native-api/lynx-view/lynx-view.md — Web `nativeModulesMap`, `onNativeModulesCall`
7. https://lynxjs.org/next/llms.txt — `NativeModules` background-only
8. https://lynxjs.org/living-spec/index.html — Native Module = BTS host object (N-API or JSI)
9. https://github.com/powersync-ja/powersync-js/blob/3aad5a4738bc/packages/common/src/db/DBAdapter.ts
10. https://github.com/powersync-ja/powersync-js/blob/3aad5a4738bc/packages/common/src/db/QueryResult.ts
11. https://github.com/powersync-ja/powersync-js/blob/3aad5a4738bc/packages/common/src/utils/BaseObserver.ts
12. https://github.com/powersync-ja/powersync-js/blob/master/packages/react-native/src/db/adapters/op-sqlite/OPSqliteAdapter.ts — official Adapter lock + `powersync_update_hooks` pattern (RN, not Lynx)
