# Package layout, Autolink, and version floors

Asset of [Lock package layout, Autolink, and version floors](../issues/10-lock-package-layout.md). Not a package, not a publish. Placeholder name `powersync-lynx`; real npm scope is not this destination.

Honor [Freeze the public JS API](../issues/07-freeze-public-js-api.md), [Lock the native Adapter and Native Module contract](../issues/08-lock-native-adapter-contract.md) / [native-adapter-contract.md](native-adapter-contract.md), [Lock the Lynx-for-Web Host helper](../issues/09-lock-web-host-helper.md) / [web-host-helper.md](web-host-helper.md).

---

## One npm

Apache-2.0. `"type": "module"`. Lynx **4.0+**.

Lynx-bundle barrel (`.`): `export *` from `@powersync/common` plus Lynx `PowerSyncDatabase`. Do not export Native Module, Adapter, or Host-helper types from `.`.

Host page: `import { attach } from 'powersync-lynx/web-host'`.

Autolink (not app code): `pluginLynxtron()` `require`s `powersync-lynx/lynxtron`.

---

## Native Module export name

Lookup string on every host: **`NativePowerSyncModule`**. Not public API. App code never calls `NativeModules`.

| Surface | Uses |
|---|---|
| JS Adapter | `NativeModules.NativePowerSyncModule` |
| Android | `@LynxNativeModule(name = "NativePowerSyncModule")` in `com.powersync.lynx`; fallback `LynxEnv.registerModule("NativePowerSyncModule", …)` |
| iOS | `@LynxNativeModule("NativePowerSyncModule")`; fallback `[globalConfig registerModule:…]` |
| Lynxtron | `LYNX_REGISTER_NATIVE_MODULE("NativePowerSyncModule", …)` after `./lynxtron` loads the `.node` |
| CMake `LynxView` | `LynxEnv.RegisterNativeModule("NativePowerSyncModule", …)` |
| Host helper `attach` | `nativeModulesMap.NativePowerSyncModule` |

Must not collide with the public class `PowerSyncDatabase`.

---

## Desktop

Lynxtron Autolink is the **supported desktop path**. Ship `lynx.lib.json` `lynxtron` / `macos` / `windows` and `./lynxtron`.

CMake `LynxEnv.RegisterNativeModule("NativePowerSyncModule", …)` is the same documented fallback as iOS/Android `registerModule` — not a second product. Web is the Host helper, not `registerModule`.

Lynx 4.0 Autolink pages cover Android/iOS only; desktop Autolink keys and `pluginLynxtron()` are `/next`. This Client still ships those keys so Windows/macOS have a supported Autolink path.

`@powersync/node` is not the desktop Client.

---

## `package.json` (sketch, not published)

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
- No `@lynx-js/react` peer — the barrel does not import React. Autolink’s “pin Lynx SDK in peerDependencies” has no single published JS package for the native host; the floor is Lynx **4.0+** in the host build (Android Autolink Gradle plugins 4.0+, iOS `cocoapods-lynx-library`, Lynxtron `pluginLynxtron()`).

---

## `lynx.lib.json`

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

---

## On disk

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

---

## Version matrix

PowerSync all-SDK floors; Lynx 4.0 does not raise them.

| Floor | Version |
|---|---|
| Lynx host SDK | **4.0+** |
| iOS | **15.0** |
| Android | **API 24** |
| macOS | **14.0** |
| Windows | **10** |
| `@powersync/common` | **^2.2.0** (peer + runtime dep) |
| `@powersync/shared-internals` | **^1.2.0** (runtime dep; official 2.x loop) |
| `@powersync/web` | **^2.3.0** (optional peer; Host helper only) |
| `powersync-sqlite-core` | **0.5.3** (published core at the research snapshot; load is [native-adapter-contract.md](native-adapter-contract.md)) |
| SQLite | **3.44+**, never Apple system SQLite |

CI, release, and the real npm scope remain not this destination.
