# Lynx desktop Native Modules and SQLite

What Lynx 4.0 actually supports for a Native Module plus SQLite / `powersync-sqlite-core` on native Windows and macOS. This note does not pick Lynxtron-only vs CMake `LynxView` as the Autolink floor. That is [Lock package layout, Autolink, and version floors](../../.scratch/lynx-powersync-client-spec/issues/10-lock-package-layout.md).

**Snapshot:** 2026-09-06. Claims are sourced unless marked `[INFERENCE]`.

How to read: Lynx **4.0** is the destination floor and the current docs site. Lynx **/next** is the unreleased docs channel. Desktop Autolink, Lynxtron `.node` loading, and the Desktop (Node-API) Native Module tab live on `/next`, not on the 4.0 Autolink / Native Modules pages.

---

## Answer

Two documented desktop hosts exist:

1. **CMake `LynxView` (Lynx 4.0, current docs).** Download `LynxSDK` GitHub Release 4.0.0 (`lynx_sdk_windows_x64.zip`, `lynx_sdk_windows_x86.zip`, `lynx_sdk_macos_arm64.zip`, `lynx_sdk_macos_x64.zip`), link `lynx.dll` / `libLynx.dylib`, then `lynx::pub::LynxEnv::GetInstance().RegisterNativeModule(...)` and `LynxView::Builder`. There is no Autolink plugin for this host. ([lynxjs.org/guide/start/integrate-with-existing-apps](https://lynxjs.org/guide/start/integrate-with-existing-apps.html), [github.com/lynx-family/lynx/releases/tag/4.0.0](https://github.com/lynx-family/lynx/releases/tag/4.0.0))

2. **Lynxtron Autolink (`/next` docs).** An Electron-like Node.js desktop host. `pluginLynxtron()` scans `lynx.lib.json` `platforms.lynxtron.path`, stages `.node` artifacts (`dist/macos/arm64/*.node`, `dist/windows/x64/*.node`), and `require()`s the package `./lynxtron` export. Static `LYNX_REGISTER_NATIVE_MODULE` then appears on Lynx `NativeModules`. Not every CMake embedder gets this. ([lynxjs.org/next/guide/autolink](https://lynxjs.org/next/guide/autolink.html), [lynxjs.org/next/lynxtron/Native-Libraries/Lynx-Native-Libraries](https://lynxjs.org/next/lynxtron/Native-Libraries/Lynx-Native-Libraries.html))

`@powersync/node` can run in the **Lynxtron Node.js host** after `@lynx-js/lynxtron-rebuild` of `better-sqlite3`. It cannot be imported by Lynx JS. Using it as the Client would put `PowerSyncDatabase` in Node, not in Lynx JS `@powersync/common`. **FLAG (architecture):** that would change the locked stack.

PowerSync published floors for desktop: **Windows 10**; **macOS 14.0** across all SDKs and for Node; **macOS 12.0** for Swift and Kotlin/Native macOS. Lynx 4.0 CMake pages do not raise those.

---

## 1. Two desktop hosts

### Lynx 3.7 announcement

Lynx 3.7 (16 Apr 2026) made macOS and Windows first-class. Same front-end stack as mobile/web. Desktop UI uses Lynx’s renderer, not native widgets. The blog pointed at Integrate with Existing Apps for host details and said Lynxtron (Electron-like, Lynx as UI) would be open-sourced soon. ([lynxjs.org/blog/lynx-3-7](https://lynxjs.org/blog/lynx-3-7.html))

### CMake `LynxView` (Lynx 4.0 current docs)

Integrate-with-existing-apps has Windows and macOS tabs next to iOS / Android / HarmonyOS / Web. Pins host SDK **4.0.0**. Both tabs:

- Download LynxSDK from GitHub Release 4.0.0, or build Explorer.
- CMake C++17 (macOS also `CMAKE_OBJCXX_STANDARD 17`).
- Link `thirdparty/lynx/lib/lynx.dll.lib` + copy `lynx.dll` (Windows) or `libLynx.dylib` into the app bundle `Frameworks/` (macOS).
- Optional `LynxServiceCenter::RegisterService` (HTTP for `lynx.fetch`).
- `LynxEnv::GetInstance()` then commented `lynx_env.RegisterNativeModule("ExplorerModule", ExplorerModuleCreator, nullptr)`.
- `LynxView::Builder` → `SetScreenSize` / `SetFrame` / `SetParent` / optional resource fetcher → `Build()` → `LoadTemplate`.

Windows parent is an `HWND`. macOS parent is `(__bridge NativeWindow)self.view` (`NSView`). ([lynxjs.org/guide/start/integrate-with-existing-apps](https://lynxjs.org/guide/start/integrate-with-existing-apps.html))

4.0.0 release assets include `lynx_sdk_windows_x64.zip`, `lynx_sdk_windows_x86.zip`, `lynx_sdk_macos_arm64.zip`, `lynx_sdk_macos_x64.zip`, plus Explorer tarballs for those four. Published 2026-07-20. ([github.com/lynx-family/lynx/releases/tag/4.0.0](https://github.com/lynx-family/lynx/releases/tag/4.0.0))

Explorer-from-source is GN/Ninja, not CMake. Windows Explorer README: Visual Studio 2022, `WINDOWSSDKDIR` = Windows Kits **10**, Node ≥ 18. macOS Explorer README (develop): Xcode 15+. Those are **build-machine** requirements, not a published min OS for the SDK zip. ([github.com/lynx-family/lynx/blob/4.0.0/explorer/windows/README.md](https://github.com/lynx-family/lynx/blob/4.0.0/explorer/windows/README.md))

### Lynxtron (`/next` + GitHub)

Lynxtron is “Electron with Chromium replaced by Lynx”: Node.js main process + Lynx UI. `LynxWindow` loads a Lynx bundle. Apache-2.0. Repo: `lynx-family/lynxtron`. README points at `lynxjs.org/lynxtron`. That path **404s** on the 4.0 docs site. The pages exist under `/next/lynxtron/`. Versions table: `/next` is unreleased; latest stable docs are 4.0. ([lynxjs.org/next/lynxtron/learn/what-is-lynxtron](https://lynxjs.org/next/lynxtron/learn/what-is-lynxtron.html), [github.com/lynx-family/lynxtron](https://github.com/lynx-family/lynxtron), [lynxjs.org/versions](https://lynxjs.org/versions.html))

Architecture (Lynxtron docs): one process, two threads. Main thread = Node + Lynx MTS. Background thread hosts isolated BTS contexts. BTS is **not** the Node global and cannot use Node APIs except through `NativeModules.bridge`, preload `contextBridge.exposeInLynxBTS()`, or Lynx Native Modules. ([lynxjs.org/next/lynxtron/learn/what-is-lynxtron](https://lynxjs.org/next/lynxtron/learn/what-is-lynxtron.html), [lynxjs.org/next/lynxtron/learn/Communication-Between-Node-And-Lynx](https://lynxjs.org/next/lynxtron/learn/Communication-Between-Node-And-Lynx.html))

---

## 2. Autolink vs `RegisterNativeModule`

### Lynx 4.0 Autolink (current)

Autolink “currently covers native Android and iOS libraries only. It does not generate Web or HarmonyOS integration code.” Host plugins: Android Gradle `org.lynxsdk.library-settings` / `library-build`, iOS `cocoapods-lynx-library`. Example `lynx.lib.json` has only `android` and `ios`. Manual registration until matching packages exist in the registry. ([lynxjs.org/guide/autolink](https://lynxjs.org/guide/autolink.html))

### `/next` Autolink (unreleased docs)

Adds HarmonyOS Hvigor (not in a released SDK yet) and Lynxtron. Still “does not generate per-`LynxView` library registration or Web integration code.”

Explicit: **“Lynxtron enables Autolink for Desktop native libraries. Not every Lynx-embedded Desktop host supports Autolink out of the box; this is a Lynxtron-provided integration.”** ([lynxjs.org/next/guide/autolink](https://lynxjs.org/next/guide/autolink.html))

`lynx.lib.json` desktop keys:

| Key | Meaning |
|---|---|
| `platforms.lynxtron.path` | Artifact root, usually `dist`. Host stages files; `./lynxtron` loads `dist/macos/arm64/<name>.node` or `dist/windows/x64/<name>.node`. |
| `platforms.macos.sourceDir` | Cross-platform native source (`shared/`). “May be reused by more platforms later.” |
| `platforms.windows.sourceDir` | Same `shared/` layout. |

Host Autolink consumers listed: Android Gradle, iOS CocoaPods, HarmonyOS Hvigor, Lynxtron `pluginLynxtron()`. **No CMake plugin.** `macos` / `windows` in the manifest are source-layout declarations, not a generated CMake registry.

`create-lynx-library --platforms lynxtron` (and optionally `android,ios,harmony`) emits `shared/`, `lynxtron/index.cjs` + `library_entry.cc`, and `dist/` per-host `.node`. Codegen for N-API modules writes C++ stubs under `shared/nativeModule/`. ([lynxjs.org/next/guide/autolink](https://lynxjs.org/next/guide/autolink.html))

### Manual registration

| Host | API | Where documented |
|---|---|---|
| iOS | `[globalConfig registerModule:Class]` | 4.0 Native Modules |
| Android | `LynxEnv.inst().registerModule(name, Class)` | 4.0 Native Modules |
| HarmonyOS | `this.modules.set(name, { moduleClass })` | 4.0 Native Modules |
| Windows/macOS CMake | `lynx_env.RegisterNativeModule("Name", Creator, nullptr)` | 4.0 integrate-with-existing-apps |
| Desktop Node-API / Lynxtron library | `LYNX_REGISTER_NATIVE_MODULE("Name", CreateFn, nullptr)` (static; load `.node` or link) | `/next` Native Modules Desktop tab |

4.0 Native Modules page has **no Desktop tab**. Desktop (Node-API) is `/next` only. ([lynxjs.org/guide/use-native-modules](https://lynxjs.org/guide/use-native-modules.html), [lynxjs.org/next/guide/use-native-modules](https://lynxjs.org/next/guide/use-native-modules.html))

Ticket 10 already locks “manual registration is a documented fallback, not a supported floor.” This note does not change that. CMake `RegisterNativeModule` is the **only** documented 4.0 desktop registration path. Lynxtron Autolink is the documented `/next` desktop Autolink path.

---

## 3. N-API vs C++

They are not alternatives. Desktop Lynx modules are **C++ that bind through Weak Node-API**.

- Headers: `@lynx-js/weak-node-api` (`napi.h`, `node_api.h`, `weak_napi_defines.h`) and `@lynx-js/lynx-library-headers` (`<lynx/registration.h>`).
- Methods are `Napi::CallbackInfo` functions on an `exports` object.
- `LYNX_REGISTER_NATIVE_MODULE("NativeLocalStorageModule", CreateFn, nullptr)` registers into the **Lynx** JS `NativeModules` object, using the Weak Node-API env owned by the Lynx runtime — not Node’s `require()`.
- Type map on `/next` adds a Weak Node-API column (`Napi::String`, `Napi::Function`, `Napi::ArrayBuffer`, …). 4.0 table has only iOS / Android / HarmonyOS.
- Autolink codegen: `@lynxmodule` → shared C++ N-API stubs. Feature flag `napi-native-module`.
- A Lynxtron `.node` **may** also export a normal Node-API addon. If the library only needs Lynx registration, the addon surface can be empty; `require()` is enough to run static constructors. ([lynxjs.org/next/guide/use-native-modules](https://lynxjs.org/next/guide/use-native-modules.html), [lynxjs.org/next/lynxtron/Native-Libraries/Lynx-Native-Libraries](https://lynxjs.org/next/lynxtron/Native-Libraries/Lynx-Native-Libraries.html))

Separate thing: **Node.js native modules** (`better-sqlite3`, etc.) in the Lynxtron **Node** host. Rebuild with `@lynx-js/lynxtron-rebuild` (Electron analogue: `@electron/rebuild`). Those modules are `require()`d in Node. They do **not** become `NativeModules.*` unless the library also uses `LYNX_REGISTER_NATIVE_MODULE`. To expose Node APIs to Lynx UI: preload `exposeInLynxBTS` or `NativeModules.bridge`. ([lynxjs.org/next/lynxtron/Native-Libraries/NodeJS-Native-Modules](https://lynxjs.org/next/lynxtron/Native-Libraries/NodeJS-Native-Modules.html))

CMake 4.0 path is the C++ `RegisterNativeModule(name, creator, opaque)` on `LynxEnv`. The 4.0 Native Modules guide does not show a Weak N-API sample for that creator. `[INFERENCE]` a CMake Adapter can still be C++ SQLite behind that creator; `/next` documents the N-API binding as the Desktop Native Module style.

Native Modules remain **background-thread only** on both 4.0 and `/next`. ([lynxjs.org/guide/use-native-modules](https://lynxjs.org/guide/use-native-modules.html))

---

## 4. Official PowerSync desktop SQLite paths

No official Lynx SDK. ([docs.powersync.com/client-sdks/overview](https://docs.powersync.com/client-sdks/overview.md))

### Node (`@powersync/node`)

Extension of `@powersync/common`. Default driver: optional peer `better-sqlite3` 12.x. Alternative: experimental `implementation: { type: 'node:sqlite' }` (not recommended). Queries run in `worker_threads`. ([docs.powersync.com/client-sdks/reference/node](https://docs.powersync.com/client-sdks/reference/node.md), [packages/node/package.json](https://github.com/powersync-ja/powersync-js/blob/main/packages/node/package.json))

`powersync-sqlite-core` is a loadable extension. Worker default path is the binary next to the compiled worker; entry `sqlite3_powersync_init`:

```ts
baseDB.loadExtension(worker.extensionPath(), 'sqlite3_powersync_init');
```

Filenames from `getPowerSyncExtensionFilename()`:

| OS | Arch | File |
|---|---|---|
| Windows | x64 / ia32 / arm64 | `powersync_x64.dll` / `powersync_x86.dll` / `powersync_aarch64.dll` |
| macOS | x64 / arm64 | `libpowersync_x64.macos.dylib` / `libpowersync_aarch64.macos.dylib` |

Same names as `powersync-sqlite-core` v0.5.3 release assets (13 Aug 2026). Node package `prepare:core` runs `download_core.js`. ([packages/node/src/db/SqliteWorker.ts](https://github.com/powersync-ja/powersync-js/blob/main/packages/node/src/db/SqliteWorker.ts), [packages/node/src/db/BetterSqliteWorker.ts](https://github.com/powersync-ja/powersync-js/blob/main/packages/node/src/db/BetterSqliteWorker.ts), [github.com/powersync-ja/powersync-sqlite-core/releases/tag/v0.5.3](https://github.com/powersync-ja/powersync-sqlite-core/releases/tag/v0.5.3))

Electron first-party analogue (`demos/example-electron-node`): `PowerSyncDatabase` in the **main process**; custom worker; webpack-copy the extension; `electron-rebuild` for `better-sqlite3`; IPC `get`/`getAll` to the renderer. ([demos/example-electron-node/README.md](https://github.com/powersync-ja/powersync-js/blob/main/demos/example-electron-node/README.md))

Supported: macOS **14.0**, Windows **10**, Linux glibc 2.34+, all non-EOL Node. HTTP and WebSocket. ([docs.powersync.com/resources/supported-platforms](https://docs.powersync.com/resources/supported-platforms.md))

### Kotlin JVM

`DatabaseDriverFactory` on JVM: AndroidX `BundledSQLiteDriver` + `addExtension(resolvePowerSyncLoadableExtensionPath()!!, "sqlite3_powersync_init")`. Same entry point. From v1.12.0 the core extension is statically linked into `com.powersync:core` for Apple native targets as well. JVM platforms: Linux AArch64/X64, macOS AArch64/X64, **Windows X64 only**. Kotlin/Native macOS **12.0**, aarch64. Windows native: no. ([docs.powersync.com/client-sdks/reference/kotlin](https://docs.powersync.com/client-sdks/reference/kotlin.md), [DatabaseDriverFactory.jvm.kt](https://github.com/powersync-ja/powersync-kotlin/blob/main/core/src/jvmMain/kotlin/com/powersync/DatabaseDriverFactory.jvm.kt), [supported-platforms](https://docs.powersync.com/resources/supported-platforms.md))

A Lynx CMake/Lynxtron host is not a JVM. Kotlin JVM is a **different process model**, not a drop-in Native Module.

### Swift macOS

`Package.swift`: `.macOS(.v12)`, `.iOS(.v15)`, depends on `powersync-sqlite-core-swift` **0.5.3** and `CSQLite` 3.51.2. From v1.14 the SDK is native Swift + Rust core (no Kotlin XCFramework). Non-Apple targets: **no** (“No good way to link PowerSync”). macOS Catalyst: no. ([Package.swift](https://github.com/powersync-ja/powersync-swift/blob/main/Package.swift), [docs.powersync.com/client-sdks/reference/swift](https://docs.powersync.com/client-sdks/reference/swift.md), [supported-platforms](https://docs.powersync.com/resources/supported-platforms.md))

Wrapping the Swift SDK as the Lynx JS runtime is out of this map. Swift-macOS is a **binary/load reference** for a CMake macOS Adapter, not the Client.

### `powersync-sqlite-core` desktop artifacts (v0.5.3)

Loadable: `powersync_x64.dll`, `powersync_x86.dll`, `powersync_aarch64.dll`, `libpowersync_x64.macos.dylib`, `libpowersync_aarch64.macos.dylib`. Plus `static_libs.zip`, `powersync-sqlite-core.xcframework.zip`. License Apache-2.0. APIs are for PowerSync SDKs; not a stable public C API. ([github.com/powersync-ja/powersync-sqlite-core](https://github.com/powersync-ja/powersync-sqlite-core), [releases/tag/v0.5.3](https://github.com/powersync-ja/powersync-sqlite-core/releases/tag/v0.5.3))

Which of those a Lynx Adapter ships is ticket 02, not this note.

---

## 5. Can `@powersync/node` sit in a Lynxtron host?

**In the Node.js host: yes, as a Node package.** Lynxtron docs use `better-sqlite3` as the native-module example. Rebuild with `@lynx-js/lynxtron-rebuild`, then `import Database from 'better-sqlite3'` in main/preload. `@powersync/node` is that same class of package (optional `better-sqlite3` + worker + loadable `.dll`/`.dylib`). The Electron main-process demo is the PowerSync-side recipe: custom worker, copy extension next to the worker, rebuild the native addon. ([lynxjs.org/next/lynxtron/Native-Libraries/NodeJS-Native-Modules](https://lynxjs.org/next/lynxtron/Native-Libraries/NodeJS-Native-Modules.html), [example-electron-node README](https://github.com/powersync-ja/powersync-js/blob/main/demos/example-electron-node/README.md))

**In Lynx JS: no.** BTS is an isolated context; no Node builtins; no C++ addons. App code would talk to a Node-side `PowerSyncDatabase` through `NativeModules.bridge` / `NativeModules.nodejs.exposed`, not `import { PowerSyncDatabase } from '@powersync/node'`. ([lynxjs.org/next/lynxtron/learn/what-is-lynxtron](https://lynxjs.org/next/lynxtron/learn/what-is-lynxtron.html))

**FLAG (architecture):** Locked stack is `@powersync/common` in Lynx JS + native `DBAdapter` (SQLite + `powersync-sqlite-core`). `@powersync/node` is a full platform SDK (`PowerSyncDatabase` from `@powersync/node`, workers, Node `fetch`/undici). Putting it in the Lynxtron host as the Client would move the JS SDK out of Lynx JS. It does not replace a Lynx Native Module Adapter. CMake hosts have no Node runtime, so this path is Lynxtron-only.

---

## 6. Min OS

Cross-SDK PowerSync minima (“regardless of which SDK you use”): Android 24, iOS 15, **macOS 14.0**, **Windows 10**, Linux glibc 2.34+. Individual SDKs may go lower. ([supported-platforms](https://docs.powersync.com/resources/supported-platforms.md))

| Source | Windows | macOS |
|---|---|---|
| PowerSync all-SDK floor | 10 | 14.0 (Sonoma) |
| `@powersync/node` | 10 | 14.0 |
| Kotlin/Native macOS | — | 12.0 (aarch64) |
| Kotlin JVM | unspecified (x86-64 only) | unspecified (x64 + aarch64) |
| Swift | no | 12.0 |
| Lynx 4.0 CMake integrate | unspecified | unspecified |
| Lynx 4.0 iOS integrate | — | iOS 10.0 (mobile, not desktop) |
| Lynx Explorer Windows build | Windows SDK **10** kit on the build machine | — |

Lynx 4.0 desktop pages do **not** publish a higher OS floor than PowerSync. Ticket 10: start from PowerSync floors unless Lynx forces higher — Lynx does not, on current 4.0 text.

If the Adapter is C++ + `powersync-sqlite-core` (not `@powersync/node`), Swift/Kotlin native **12** is the lowest PowerSync-published macOS number; the all-SDK table still says **14**. Node as host SDK would force **14**.

---

## 7. Facts ticket 10 needs (no decision)

Already locked (ticket 10): one Autolink npm; `lynx.lib.json` for Android/iOS Autolink **and desktop artifacts**; Lynx **4.0+**; manual registration is a documented fallback, not the floor.

This survey adds:

1. **4.0 Autolink is Android/iOS only.** Desktop Autolink keys (`lynxtron`, `macos`, `windows`) and `pluginLynxtron()` are `/next` docs.
2. **`lynx.lib.json` desktop shape on `/next`:** `platforms.lynxtron.path` = `dist`; `platforms.macos.sourceDir` / `platforms.windows.sourceDir` = `shared`. No Harmony on this map.
3. **CMake 4.0 host:** `RegisterNativeModule` on `LynxEnv`. `/next` says CMake embedders do not get Autolink out of the box.
4. **Desktop Native Module implementation language:** C++ + Weak Node-API + `LYNX_REGISTER_NATIVE_MODULE` on `/next`; C++ `RegisterNativeModule` on 4.0 CMake.
5. **Min OS to start from:** Windows **10**, macOS **14** (all-SDK / Node) or **12** (Swift / Kotlin native). Lynx 4.0 does not raise them.
6. **`@powersync/node` is not the Autolink Native Module.** It can live in the Lynxtron Node host only.

Do not decide Lynxtron-only vs CMake fallback here.

---

## Architecture flags

- **FLAG (locked stack, holds):** A CMake or Lynxtron Native Module that opens SQLite, `loadExtension(..., "sqlite3_powersync_init")` (or statically links core), and implements `DBAdapter` for `@powersync/common` in Lynx JS matches the lock. Official Node / Kotlin-JVM / Swift-macOS paths are load recipes, not the Client.
- **FLAG (would force a change):** Making `@powersync/node` the desktop Client (Node-side `PowerSyncDatabase`, Lynx UI via bridge/preload). That abandons `@powersync/common` in Lynx JS on desktop and cannot run on CMake `LynxView`.
- **FLAG (version channel):** Destination is Lynx 4.0+. Desktop Autolink is documented only on unreleased `/next`. Treating Lynxtron Autolink as the floor implies a Lynx docs/SDK channel newer than the 4.0 Autolink page.

---

## Sources

1. https://lynxjs.org/blog/lynx-3-7.html — 3.7 desktop announcement, Lynxtron “soon”
2. https://lynxjs.org/guide/start/integrate-with-existing-apps.html — 4.0 CMake Windows/macOS, `RegisterNativeModule`, SDK 4.0.0
3. https://lynxjs.org/guide/autolink.html — 4.0 Autolink Android/iOS only
4. https://lynxjs.org/guide/use-native-modules.html — 4.0 Native Modules (iOS/Android/Harmony; BTS-only)
5. https://lynxjs.org/next/guide/autolink.html — Lynxtron Autolink, `lynx.lib.json` macos/windows/lynxtron
6. https://lynxjs.org/next/guide/use-native-modules.html — Desktop (Node-API), Weak N-API, `LYNX_REGISTER_NATIVE_MODULE`
7. https://lynxjs.org/next/lynxtron/Native-Libraries/Lynx-Native-Libraries.html — `.node` load = static registration
8. https://lynxjs.org/next/lynxtron/Native-Libraries/NodeJS-Native-Modules.html — `better-sqlite3`, `@lynx-js/lynxtron-rebuild`
9. https://lynxjs.org/next/lynxtron/learn/what-is-lynxtron.html — Node host vs isolated BTS
10. https://lynxjs.org/next/lynxtron/learn/Communication-Between-Node-And-Lynx.html — bridge / preload
11. https://lynxjs.org/versions.html — 4.0 current; `/next` unreleased
12. https://github.com/lynx-family/lynx/releases/tag/4.0.0 — SDK zips, Explorer desktop assets
13. https://github.com/lynx-family/lynx/blob/4.0.0/explorer/windows/README.md — VS 2022, Windows Kits 10
14. https://github.com/lynx-family/lynxtron — Apache-2.0; docs URL 404s on 4.0 site
15. https://docs.powersync.com/resources/supported-platforms.md — Windows 10, macOS 14/12
16. https://docs.powersync.com/client-sdks/reference/node.md — `@powersync/node`, better-sqlite3
17. https://docs.powersync.com/client-sdks/reference/kotlin.md — JVM + Apple native
18. https://docs.powersync.com/client-sdks/reference/swift.md — macOS 12, no Windows
19. https://github.com/powersync-ja/powersync-js/blob/main/packages/node/src/db/SqliteWorker.ts — extension filenames
20. https://github.com/powersync-ja/powersync-js/blob/main/packages/node/src/db/BetterSqliteWorker.ts — `loadExtension(..., 'sqlite3_powersync_init')`
21. https://github.com/powersync-ja/powersync-js/blob/main/demos/example-electron-node/README.md — Electron main-process recipe
22. https://github.com/powersync-ja/powersync-kotlin/blob/main/core/src/jvmMain/kotlin/com/powersync/DatabaseDriverFactory.jvm.kt — BundledSQLiteDriver + extension
23. https://github.com/powersync-ja/powersync-swift/blob/main/Package.swift — `.macOS(.v12)`, core 0.5.3
24. https://github.com/powersync-ja/powersync-sqlite-core/releases/tag/v0.5.3 — Windows/macOS binaries
