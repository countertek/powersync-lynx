# How official PowerSync clients load `powersync-sqlite-core`

**Snapshot:** 2026-09-06. Facts only unless marked `[INFERENCE]`. This note lists options and constraints for [Lock the native Adapter and Native Module contract](../../.scratch/lynx-powersync-client-spec/issues/08-lock-native-adapter-contract.md). It does **not** pick which binary a Lynx Client ships.

How to read: each claim is sourced. Later native Adapter tickets must not violate the invariants at the end.

---

## Question

How do official PowerSync clients load `powersync-sqlite-core` on iOS, Android, Windows, and macOS, and what would a Lynx Adapter have to ship?

---

## Sources

- https://github.com/powersync-ja/powersync-sqlite-core (README, LICENSE, Cargo.toml, podspec, Package.swift, android/build.gradle.kts, crates/core, crates/loadable, releases/tag/v0.5.3)
- https://github.com/powersync-ja/powersync-sqlite-core-swift (Package.swift)
- https://github.com/powersync-ja/powersync-kotlin (README, CHANGELOG, ConnectionFactory, DatabaseDriverFactory, ExtractLib.kt)
- https://github.com/powersync-ja/powersync-swift (Package.swift, registerPowerSyncCoreExtension.swift)
- https://github.com/powersync-ja/powersync-js (`packages/react-native`, `packages/node`)
- https://docs.powersync.com/resources/supported-platforms.md
- https://docs.powersync.com/client-sdks/reference/{kotlin,swift,react-native-and-expo,node}.md
- https://docs.powersync.com/client-sdks/advanced/{sqlite-extensions,unit-testing}.md
- https://repo1.maven.org/maven2/com/powersync/{powersync-sqlite-core,core}/maven-metadata.xml
- https://repo1.maven.org/maven2/com/powersync/core/1.15.0/core-1.15.0.pom
- https://trunk.cocoapods.org/api/v1/pods/powersync-sqlite-core
- https://github.com/OP-Engineering/op-sqlite (README, package.json)
- https://op-engineering.github.io/op-sqlite/docs/installation/

Sibling nijika-os notes were pointers only. Not cited as fact.

---

## What `powersync-sqlite-core` is

`powersync-ja/powersync-sqlite-core` is the PowerSync SQLite extension used by official client SDKs. The README states the APIs are **not currently stable** and are **intended to be used by PowerSync SDKs only**. ([powersync-sqlite-core README](https://github.com/powersync-ja/powersync-sqlite-core))

Workspace version on `main` / latest GitHub release is **0.5.3** (published 2026-08-13). ([Cargo.toml workspace.package.version](https://github.com/powersync-ja/powersync-sqlite-core/blob/master/Cargo.toml), [releases/tag/v0.5.3](https://github.com/powersync-ja/powersync-sqlite-core/releases/tag/v0.5.3))

The loadable C entry point is `sqlite3_powersync_init`. After load, SQL APIs include `.load powersync` (shell), `powersync_replace_schema(...)`, `powersync_init()`, and `powersync_rs_version()`. ([crates/core/src/lib.rs](https://github.com/powersync-ja/powersync-sqlite-core/blob/master/crates/core/src/lib.rs), [README](https://github.com/powersync-ja/powersync-sqlite-core))

The extension requires SQLite **3.44+** (`MIN_SQLITE_VERSION_NUMBER = 3044000`). ([crates/core/src/constants.rs](https://github.com/powersync-ja/powersync-sqlite-core/blob/master/crates/core/src/constants.rs))

Two mechanical load styles exist in official clients:

1. **Runtime loadable** — `sqlite3_load_extension` / host `loadExtension(path, "sqlite3_powersync_init")` against a `.so` / `.dylib` / `.dll`.
2. **Static auto-extension** — link the core into the process and call `sqlite3_auto_extension(sqlite3_powersync_init)` before opening connections.

The shell demo is `.load powersync` after `cargo build -p powersync_loadable`. Apple XCFrameworks are built with `./tool/build_xcframework.sh`. ([README](https://github.com/powersync-ja/powersync-sqlite-core))

---

## License

| Artifact | License | Source |
|---|---|---|
| `powersync-sqlite-core` | Apache-2.0 | [LICENSE](https://github.com/powersync-ja/powersync-sqlite-core/blob/master/LICENSE), [Cargo.toml](https://github.com/powersync-ja/powersync-sqlite-core/blob/master/Cargo.toml) `license = "Apache-2.0"`, podspec `s.license = 'Apache License, Version 2.0'`, GitHub `License: Apache License 2.0` |
| Maven AAR `com.powersync:powersync-sqlite-core` | Apache License, Version 2.0 | [android/build.gradle.kts POM](https://github.com/powersync-ja/powersync-sqlite-core/blob/master/android/build.gradle.kts) |
| `@powersync/react-native`, `@powersync/node`, `powersync-js` | Apache-2.0 | package.json + LICENSE |
| `powersync-swift` | Apache-2.0 | GitHub repo license |
| `com.powersync:core` (Kotlin SDK) | **MIT** | [core-1.15.0.pom](https://repo1.maven.org/maven2/com/powersync/core/1.15.0/core-1.15.0.pom) |
| `@op-engineering/op-sqlite` | MIT | [op-sqlite README / package.json](https://github.com/OP-Engineering/op-sqlite) |

A Lynx Adapter that ships `powersync-sqlite-core` binaries can do so under Apache-2.0. Wrapping the Kotlin SDK instead would pull MIT (and would also violate this map’s “do not wrap Kotlin/Swift as the JavaScript runtime” stance).

---

## Distribution

Official clients do **not** all consume the same package. Same GitHub release, four ship channels:

| Channel | Coordinate | Latest observed | What it contains |
|---|---|---|---|
| GitHub Releases | `powersync-ja/powersync-sqlite-core` `v0.5.3` | 2026-08-13 | Per-arch loadable binaries, `powersync-sqlite-core.xcframework.zip`, `static_libs.zip`, `libpowersync-wasm.a`, SBOM |
| CocoaPods | `powersync-sqlite-core` | **0.5.3** (trunk 2026-08-13) | Vendored XCFramework from the GitHub zip. podspec: iOS 11.0, macOS 10.13, watchOS 9.0 |
| SwiftPM | `https://github.com/powersync-ja/powersync-sqlite-core-swift.git` | binaryTarget **0.5.3** | Downloads `powersync-sqlite-core.xcframework.zip`. Platforms in that Package.swift: iOS 11, macOS 10.13 |
| Maven Central | `com.powersync:powersync-sqlite-core` | **0.5.3** | Prefab AAR with `libpowersync.so` for `armeabi-v7a`, `arm64-v8a`, `x86`, `x86_64`. soname `libpowersync.so` |
| Maven Central | `com.powersync:core` | **1.15.0** | Kotlin SDK. Docs: core extension is bundled; Apple no longer needs a separate CocoaPod/SPM dep as of Kotlin 1.12.0 |
| npm | `@powersync/react-native` **2.2.0** | pins core **0.5.2** | CocoaPod `powersync-sqlite-core ~> 0.5.2` + Maven `com.powersync:powersync-sqlite-core:0.5.2` + SPM exact `0.5.2` |
| npm | `@powersync/node` **1.0.0** | downloads core **0.5.2** | `download_core.js` fetches GitHub release assets into `lib/` |

There is no npm package that *is* `powersync-sqlite-core`. Node downloads GitHub assets at build time. ([packages/node/download_core.js](https://github.com/powersync-ja/powersync-js/blob/main/packages/node/download_core.js), [packages/node/package.json](https://github.com/powersync-ja/powersync-js/blob/main/packages/node/package.json) `"prepare:core": "node download_core.js"`)

The in-repo `Package.swift` on `powersync-sqlite-core` itself is **not released**; comment: “never released, we're only using this to support local builds for the Swift SDK.” Platforms there: iOS 13, macOS 10.15, watchOS 9. ([powersync-sqlite-core/Package.swift](https://github.com/powersync-ja/powersync-sqlite-core/blob/master/Package.swift))

### v0.5.3 GitHub assets (Lynx-relevant)

From [releases/latest assets](https://api.github.com/repos/powersync-ja/powersync-sqlite-core/releases/latest):

**Android (loadable `.so`):** `libpowersync_{aarch64,armv7,x64,x86}.android.so`

**iOS (loadable `.dylib`):** `libpowersync_aarch64.ios.dylib`, `libpowersync_{aarch64,x64}.ios-sim.dylib`

**macOS (loadable `.dylib`):** `libpowersync_{aarch64,x64}.macos.dylib`

**Windows (loadable `.dll`):** `powersync_{x64,x86,aarch64}.dll`

**Apple packaged:** `powersync-sqlite-core.xcframework.zip` (also CocoaPods/SPM)

**Static:** `static_libs.zip`

Linux and tvOS/watchOS assets exist; this map’s Client does not target Linux or those Apple variants.

---

## How each official client loads the extension

### Shared load contract

Every official native/desktop path ends at `sqlite3_powersync_init`. Hosts that load dynamically pass that as the entry point. Hosts that link statically register it with `sqlite3_auto_extension`. ([crates/core/src/lib.rs](https://github.com/powersync-ja/powersync-sqlite-core/blob/master/crates/core/src/lib.rs), [sqlite-extensions.md](https://docs.powersync.com/client-sdks/advanced/sqlite-extensions.md))

SQLite must allow extension loading (`ENABLE_LOAD_EXTENSION`) **unless** the core is linked statically and registered via `sqlite3_auto_extension`. Dart unit-testing docs for the loadable path: rename `powersync_x64.dll` → `powersync.dll`, `libpowersync_aarch64.dylib` → `libpowersync.dylib`, place next to the test binary. ([unit-testing.md](https://docs.powersync.com/client-sdks/advanced/unit-testing.md)) Those rename examples omit the OS infix Node uses (`libpowersync_aarch64.macos.dylib`). `[INFERENCE]` Dart’s download names differ from Node’s GitHub asset names; both come from the same release tag family.

### iOS

| Client | Distribution | Load |
|---|---|---|
| **Swift SDK** | SPM `powersync-swift` exact-pins `powersync-sqlite-core-swift` **0.5.3**. Also depends on `powersync-ja/CSQLite` 3.51.2. Platforms: iOS 15, macOS 12, watchOS 9, tvOS 15. | `sqlite3_auto_extension(sqlite3_powersync_init)` in `registerPowerSyncCoreExtension()`. Static. |
| **Kotlin SDK ≥ 1.12.0** | `com.powersync:core` only. Docs: remove CocoaPod `powersync-sqlite-core` and SPM `powersync-sqlite-core-swift`. Apple uses `static-sqlite-driver`, not `androidx.sqlite-bundled`. | `sqlite3_auto_extension` wrapping `sqlite3_powersync_init`. `resolvePowerSyncLoadableExtensionPath()` returns `null`. |
| **Kotlin SDK &lt; 1.12.0** | App must add SPM `powersync-sqlite-core-swift` or CocoaPod `powersync-sqlite-core`. | External Apple package. |
| **React Native** | `@powersync/react-native` depends on CocoaPod `powersync-sqlite-core ~> 0.5.2` and SPM exact `0.5.2`. Bundle id used at load: `co.powersync.sqlitecore` / `powersync-sqlite-core`. | Dynamic: `getDylibPath('co.powersync.sqlitecore', 'powersync-sqlite-core')` then `DB.loadExtension(libPath, 'sqlite3_powersync_init')`. |

Swift: [Package.swift](https://github.com/powersync-ja/powersync-swift/blob/main/Package.swift), [registerPowerSyncCoreExtension.swift](https://github.com/powersync-ja/powersync-swift/blob/main/Sources/PowerSync/Implementation/sqlite3/registerPowerSyncCoreExtension.swift), [docs Swift](https://docs.powersync.com/client-sdks/reference/swift.md).

Kotlin: [CHANGELOG 1.12.0](https://github.com/powersync-ja/powersync-kotlin/blob/main/CHANGELOG.md), [ConnectionFactory.native.kt](https://github.com/powersync-ja/powersync-kotlin/blob/main/common/src/nativeMain/kotlin/com/powersync/ConnectionFactory.native.kt), [docs Kotlin](https://docs.powersync.com/client-sdks/reference/kotlin.md), [core/build.gradle.kts appleMain](https://github.com/powersync-ja/powersync-kotlin/blob/main/core/build.gradle.kts).

RN: [powersync-react-native.podspec](https://github.com/powersync-ja/powersync-js/blob/main/packages/react-native/powersync-react-native.podspec), [ios/Package.swift](https://github.com/powersync-ja/powersync-js/blob/main/packages/react-native/ios/Package.swift), [OPSqliteAdapter.ts](https://github.com/powersync-ja/powersync-js/blob/main/packages/react-native/src/db/adapters/op-sqlite/OPSqliteAdapter.ts).

Swift SDK has **no** Linux/Windows target (“No good way to link PowerSync”). No macOS Catalyst, no visionOS. ([supported-platforms.md](https://docs.powersync.com/resources/supported-platforms.md))

### Android

| Client | Distribution | Load |
|---|---|---|
| **Kotlin SDK** | `com.powersync:core` (latest Maven 1.15.0). Uses `androidx.sqlite.driver.bundled.BundledSQLiteDriver`. | `BundledSQLiteDriver.addExtension("libpowersync.so", "sqlite3_powersync_init")`. Path helper returns `"libpowersync.so"`. JNI soname is `libpowersync.so` (AAR prefab). |
| **React Native** | Maven `com.powersync:powersync-sqlite-core:0.5.2` from `@powersync/react-native` `android/build.gradle`. minSdk **24**. | `DB.loadExtension('libpowersync', 'sqlite3_powersync_init')`. |

Kotlin: [DatabaseDriverFactory.android.kt](https://github.com/powersync-ja/powersync-kotlin/blob/main/core/src/androidMain/kotlin/com/powersync/DatabaseDriverFactory.android.kt), [ConnectionFactory.android.kt](https://github.com/powersync-ja/powersync-kotlin/blob/main/common/src/androidMain/kotlin/com/powersync/ConnectionFactory.android.kt), [android/build.gradle.kts soname](https://github.com/powersync-ja/powersync-sqlite-core/blob/master/android/build.gradle.kts).

RN: [android/build.gradle](https://github.com/powersync-ja/powersync-js/blob/main/packages/react-native/android/build.gradle), [android/gradle.properties](https://github.com/powersync-ja/powersync-js/blob/main/packages/react-native/android/gradle.properties) `PowerSync_minSdkVersion=24`.

Kotlin 1.6.1 changelog records a real load bug: `dlopen failed: library "libpowersync.so.so" not found` — the filename must not double the `.so` suffix. ([CHANGELOG 1.6.1](https://github.com/powersync-ja/powersync-kotlin/blob/main/CHANGELOG.md))

Docs language that the extension is “statically linked into `com.powersync:core` for Apple targets … consistent with Android and JVM” means **the binary is inside the SDK artifact**, not that Android/JVM skip `load_extension`. Android and JVM still call `addExtension(...)`. ([docs Kotlin](https://docs.powersync.com/client-sdks/reference/kotlin.md) vs [DatabaseDriverFactory.android.kt](https://github.com/powersync-ja/powersync-kotlin/blob/main/core/src/androidMain/kotlin/com/powersync/DatabaseDriverFactory.android.kt))

### Windows

No official Swift or React Native Windows client. ([supported-platforms.md](https://docs.powersync.com/resources/supported-platforms.md): Swift “Non-apple targets (Linux, Windows) = No”; RN “React Native for Windows = No”)

| Client | Distribution | Load |
|---|---|---|
| **Kotlin** | `com.powersync:core` JVM. Windows **x86-64 only**. Native Windows = No (“Maybe soon”). | Extract classpath resource `powersync_x64.dll` (prefix empty, extension `dll`, arch `x64`) to a temp file, then `BundledSQLiteDriver.addExtension(path, "sqlite3_powersync_init")`. |
| **Node** | `@powersync/node` downloads `powersync_{x64,x86,aarch64}.dll` from GitHub. | Worker: `baseDB.loadExtension(path, 'sqlite3_powersync_init')` on `better-sqlite3` (default) or `node:sqlite` (`allowExtension: true`). |

Kotlin: [ExtractLib.kt](https://github.com/powersync-ja/powersync-kotlin/blob/main/common/src/jvmMain/kotlin/com/powersync/ExtractLib.kt), [DatabaseDriverFactory.jvm.kt](https://github.com/powersync-ja/powersync-kotlin/blob/main/core/src/jvmMain/kotlin/com/powersync/DatabaseDriverFactory.jvm.kt), [supported-platforms.md Kotlin table](https://docs.powersync.com/resources/supported-platforms.md).

Node: [download_core.js](https://github.com/powersync-ja/powersync-js/blob/main/packages/node/download_core.js), [SqliteWorker.ts `getPowerSyncExtensionFilename`](https://github.com/powersync-ja/powersync-js/blob/main/packages/node/src/db/SqliteWorker.ts), [BetterSqliteWorker.ts](https://github.com/powersync-ja/powersync-js/blob/main/packages/node/src/db/BetterSqliteWorker.ts), [NodeSqliteWorker.ts](https://github.com/powersync-ja/powersync-js/blob/main/packages/node/src/db/NodeSqliteWorker.ts).

Node currently downloads **0.5.2** hashes even though GitHub latest is 0.5.3. ([download_core.js `const version = '0.5.2'`](https://github.com/powersync-ja/powersync-js/blob/main/packages/node/download_core.js))

### macOS

| Client | Distribution | Load |
|---|---|---|
| **Swift SDK** | Same SPM product as iOS. min macOS **12**. | Same static `sqlite3_auto_extension`. |
| **Kotlin native** | `com.powersync:core`. macOS native **aarch64 only**, min **12**. macOS JVM x86-64 + aarch64. No Mac Catalyst native. | Native: `sqlite3_auto_extension`. JVM: extract `libpowersync_{x64,aarch64}.macos.dylib` from JAR resources. |
| **Node** | GitHub `libpowersync_{x64,aarch64}.macos.dylib`. Docs min macOS **14**. | Same `loadExtension(..., 'sqlite3_powersync_init')`. |
| **React Native** | Official RN table has no macOS row. OP-SQLite itself claims macOS. | Official PowerSync RN adapter branches `Platform.OS === 'ios'` vs else (Android `libpowersync`). There is no `macos` branch in `loadPowerSyncExtension`. |

Swift/Kotlin mins: [supported-platforms.md](https://docs.powersync.com/resources/supported-platforms.md), [powersync-swift Package.swift](https://github.com/powersync-ja/powersync-swift/blob/main/Package.swift). Node min: [supported-platforms.md Node table](https://docs.powersync.com/resources/supported-platforms.md) macOS 14.0. RN load: [OPSqliteAdapter.ts](https://github.com/powersync-ja/powersync-js/blob/main/packages/react-native/src/db/adapters/op-sqlite/OPSqliteAdapter.ts).

---

## Min OS / arch (Client-relevant)

Cross-SDK floor from [supported-platforms.md](https://docs.powersync.com/resources/supported-platforms.md) (the page the ticket names; URL is `/resources/supported-platforms`, not `/client-sdks/supported-platforms`):

| Platform | Cross-SDK minimum | Notes from individual SDKs |
|---|---|---|
| Android | SDK **24** (7.0) | Kotlin lists SDK **23**. RN Autolink module minSdk **24**. Capacitor/MAUI 24. AAR ABIs: arm64-v8a, armeabi-v7a, x86, x86_64 |
| iOS | **15.0** | Swift 15. Kotlin 14. RN SPM package `.iOS(.v15)`. Device aarch64; sim aarch64 + x64 dylibs exist |
| macOS | **14.0** (Sonoma) as the cross-SDK row | Swift/Kotlin native **12.0**. Node **14.0**. Kotlin native macOS is **aarch64 only**; x64 macOS is JVM-only in Kotlin 1.13.0+ (Apple x86_64 targets removed) |
| Windows | **10** | Kotlin JVM **x86-64 only**. Node: x64, ia32, arm64 DLLs. No Swift, no RN-Windows, no Kotlin/Native Windows |

Kotlin 1.13.0 **removed** `iosX64()`, `macosX64()`, `tvosX64()`, `watchosX64()`. ([CHANGELOG 1.13.0](https://github.com/powersync-ja/powersync-kotlin/blob/main/CHANGELOG.md))

This map’s destination is Lynx 4.0+ on iOS, Android, native Windows, native macOS. That is **stricter than** some SDK floors and **broader than** Swift (no Windows) and RN (no Windows). `[INFERENCE]` A Lynx Adapter cannot copy one official SDK’s packaging and cover all four hosts.

---

## OP-SQLite: is it RN-only?

**Official PowerSync uses OP-SQLite only as the React Native SQLite host.** `@powersync/react-native` peerDepends on `@op-engineering/op-sqlite` `>=17.1.0 <19.0.0`. Docs install line is `npx expo install @powersync/react-native @op-engineering/op-sqlite`. Kotlin, Swift, and Node do not depend on it. ([react-native package.json](https://github.com/powersync-ja/powersync-js/blob/main/packages/react-native/package.json), [docs RN](https://docs.powersync.com/client-sdks/reference/react-native-and-expo.md))

**The OP-SQLite *package* is not RN-only.** First-party docs: “This package runs on `iOS`, `Android`, `macOS` and `web`.” `package.json` description: “Fastest SQLite for React Native (with node.js support)”; keywords include `react-native`, `ios`, `android`, `node`, `sqlite`; exports include `node` and `browser`. Peer deps are still `react` and `react-native`. Node support is a Jest façade: “NOT to prove the correctness of the library. The NodeJS façade is a convenience and it's not meant for production usage.” Web cannot load extensions. `iosSqlite: true` (Apple system SQLite) **cannot load extensions**. ([op-sqlite installation](https://op-engineering.github.io/op-sqlite/docs/installation/), [package.json](https://github.com/OP-Engineering/op-sqlite/blob/main/package.json), [README](https://github.com/OP-Engineering/op-sqlite))

Docs RN page says “version 1.17.0 or later”; the published peer range is `>=17.1.0 <19.0.0`. Cite the package.json range as the contract. ([docs RN](https://docs.powersync.com/client-sdks/reference/react-native-and-expo.md) vs [package.json](https://github.com/powersync-ja/powersync-js/blob/main/packages/react-native/package.json))

OP-SQLite is MIT, not Apache-2.0.

---

## Options a Lynx Adapter could ship (do not pick)

Ticket 08 needs a per-platform load choice. Official clients prove these work. None is selected here.

**A. GitHub loadable binaries, loaded at runtime**  
Ship matching `v0.5.3` assets (`libpowersync_*.android.so` / `*.ios.dylib` / `*.macos.dylib` / `powersync_*.dll`) next to a Lynx-bundled SQLite that has `ENABLE_LOAD_EXTENSION`. Call `sqlite3_load_extension(path, "sqlite3_powersync_init")`. This is what Node and RN already do (RN via OP-SQLite’s `loadExtension`). Windows native has no other official pattern.

**B. Maven AAR `com.powersync:powersync-sqlite-core` (Android)**  
Prefab `libpowersync.so` for four ABIs, soname `libpowersync.so`. Load as `"libpowersync.so"` / `"libpowersync"`. RN already depends on this AAR. Kotlin `com.powersync:core` wraps the same idea inside its own artifact.

**C. CocoaPods `powersync-sqlite-core` and/or SPM `powersync-sqlite-core-swift` (iOS, macOS)**  
XCFramework zip from GitHub. Swift SDK and Kotlin &lt; 1.12 used this. RN still uses CocoaPod `~> 0.5.2` plus SPM 0.5.2. Then either `sqlite3_auto_extension` (Swift/Kotlin native) or `getDylibPath` + `loadExtension` (RN).

**D. Static link (`static_libs.zip` or XCFramework) + `sqlite3_auto_extension(sqlite3_powersync_init)`**  
What current Swift and Kotlin/Native Apple do. Avoids iOS `ENABLE_LOAD_EXTENSION` (Apple’s system SQLite disables it; OP-SQLite documents this under `iosSqlite`). Requires the Adapter to link its own SQLite (Swift uses `powersync-ja/CSQLite`; Kotlin Apple uses `static-sqlite-driver`; Kotlin Android/JVM use `androidx.sqlite-bundled`).

**E. Let `@op-engineering/op-sqlite` be the SQLite + use its `loadExtension`**  
Works on official RN iOS/Android. Package also claims macOS. Not used by Kotlin/Swift/Node. Turbo Module / React Native autolink surface, MIT, peer on `react-native`. Web backend cannot load this extension. `[INFERENCE]` A Lynx Native Module is not a React Native Turbo Module; OP-SQLite would have to be re-hosted or is the wrong SQLite.

**F. Consume `com.powersync:core` / `powersync-swift` as the Adapter**  
Out of this destination: map refuses wrapping Kotlin/Swift as the JavaScript runtime. Listed only so 08 does not “discover” it as a shortcut.

Version pin constraint: RN and Node are still on **0.5.2** while GitHub/Maven/CocoaPods/SPM latest is **0.5.3**. `[INFERENCE]` A Lynx Client should pin an explicit core version and not assume official JS packages are on latest.

SQLite 3.44+ is a hard floor of the extension itself.

---

## FLAG vs locked architecture

Locked: `@powersync/common` in Lynx JS; native `DBAdapter` over SQLite + `powersync-sqlite-core`; web is host-page `@powersync/web`.

Nothing above forces a change. Every official native SDK still *is* SQLite plus this extension. Windows native is simply not covered by Swift/RN; the loadable DLL in option A is how Node and Kotlin-JVM do Windows.

`[INFERENCE]` The locked architecture still holds. Ticket 08 picks A–D (and whether E is even eligible) per host. Ticket 06 (Lynx desktop SQLite) still owns how Lynxtron/CMake hosts expose SQLite, not which core binary to download.

---

## Invariants for later tickets

1. The extension entry point is `sqlite3_powersync_init`. Do not invent another.
2. Ship Apache-2.0 `powersync-sqlite-core` (currently 0.5.3 latest). Do not treat Kotlin MIT `com.powersync:core` as the core license.
3. SQLite 3.44+. System iOS SQLite cannot load the extension.
4. Android JNI name is `libpowersync.so` (not `libpowersync.so.so`).
5. OP-SQLite is the official **RN host**, not the official iOS/Android/Windows/macOS PowerSync strategy, and not Apache-2.0.
6. No official client gives a single binary that covers iOS + Android + Windows + macOS. Per-host packaging is required.
7. Do not pick the binary in this ticket.
