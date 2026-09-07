# Lock package layout, Autolink, and version floors

Type: grilling
Status: resolved
Blocked by: 03, 06, 08, 09

## Question

What does the one Autolink npm look like on disk, and which host versions does this Client require?

Already locked: one package; `lynx.lib.json` for Android/iOS Autolink and desktop artifacts; Lynx **4.0+**; Apache-2.0; depend on published `@powersync/common` (pin a major) and `@powersync/web` in the Host helper; placeholder name `powersync-lynx`; real npm scope is not this destination; manual registration is a documented fallback, not a supported floor.

Pin:

- `package.json` exports (JS facade, types, Host helper subpath)
- `lynx.lib.json` platforms (android, ios, macos, windows, lynxtron; no harmony)
- peerDependencies (Lynx SDK range, `@powersync/common`)
- Min iOS / Android / macOS / Windows — start from PowerSync’s published floors unless Lynx forces higher
- Desktop: Lynxtron Autolink as the supported path vs CMake `RegisterNativeModule` as fallback (from desktop research)
- Native Module export name (Autolink / `registerModule` identifier the JS Adapter looks up; not a public API)

HITL: `/grilling` + `/domain-modeling`. Output: package layout + version matrix for the spec. No publish.

## Answer

One Autolink npm (`powersync-lynx`). Lynxtron Autolink is the supported desktop path; CMake `RegisterNativeModule` is the documented fallback, not a second product. Native Module lookup is `NativePowerSyncModule` (not public API). Exports: `.` (ESM barrel), `./web-host` (`attach`), `./lynxtron` (CJS Autolink loader). Factory is private `lib/web-host/factory.js`. Floors: Lynx 4.0+, iOS 15, Android 24, macOS 14.0, Windows 10. Peers: `@powersync/common` `^2.2.0`; `@powersync/web` `^2.3.0` optional. No `@lynx-js/react` peer. Cite: [assets/package-layout.md](../assets/package-layout.md).

**Desktop.** Ship `lynx.lib.json` `android` / `ios` / `lynxtron` / `macos` / `windows` (no `harmony`). `pluginLynxtron()` loads `./lynxtron` → `dist/<host>/<arch>/powersync-lynx.node`. CMake embedders call `LynxEnv.RegisterNativeModule("NativePowerSyncModule", …)`.

**JS.** `"type": "module"`. `.` is `export *` from `@powersync/common` plus `PowerSyncDatabase`. `./web-host` is host-page only. `@powersync/web` is imported only there so native installs do not pull WASM. `attach` sets `nativeModulesMap.NativePowerSyncModule` to `new URL('./factory.js', import.meta.url)`.

**Versions.** `@powersync/common` `^2.2.0` peer + runtime dep; `@powersync/shared-internals` `^1.2.0` runtime dep; `powersync-sqlite-core` **0.5.3**; SQLite 3.44+. Android `packageName` `com.powersync.lynx`. Apache-2.0. Real npm scope is not this destination.

## Comments

2026-09-07: claimed to grill and lock package layout, Autolink, and version floors. Planning only — no package, no publish, no implementation. Honor [Freeze the public JS API](07-freeze-public-js-api.md), [Lock the native Adapter and Native Module contract](08-lock-native-adapter-contract.md), and [Lock the Lynx-for-Web Host helper](09-lock-web-host-helper.md): one npm; Lynx barrel is `export *` from `@powersync/common` plus `PowerSyncDatabase`; Host helper is `powersync-lynx/web-host` (`attach`); Native Module name is Autolink/`registerModule` lookup, not public API.


2026-09-07 grilling round 1: official PowerSync floors + Lynx Autolink locked without grilling. Frontier is Lynx-only forks: Lynxtron Autolink vs CMake fallback; Native Module export name; `package.json` exports including `web-host`. No package, no publish.


2026-09-07 grilling round 1 answers: Q1 A (Lynxtron Autolink supported; CMake `RegisterNativeModule` documented fallback); Q2 A (`NativePowerSyncModule`); Q3 A (exports `.` / `./web-host` / `./lynxtron`; private `factory.js`; `@powersync/web` optional peer). Frontier empty; freeze recorded.

