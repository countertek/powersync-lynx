# 0.3.0 Spec: Windows and macOS Desktop Support (Native `LynxView` and Lynxtron)

Normative feature spec for `powersync-lynx` **0.3.0**, locking desktop support for **macOS** and **Windows** across both **native CMake `LynxView`** and **Lynxtron Autolink**.

Uses domain vocabulary from [`CONTEXT.md`](../../CONTEXT.md) (`Client`, `PowerSyncDatabase`, `Adapter`, `Native Module`, `Connector`, `Schema`). Supersedes desktop fallback language in [`docs/spec.md`](../../docs/spec.md) and adds [`docs/adr/0005-desktop-first-class-native-and-lynxtron.md`](../../docs/adr/0005-desktop-first-class-native-and-lynxtron.md).

---

## 1. Support Tiers, Targets, and Floors

| Dimension | Locked for `0.3.0` | Out of scope / Deferred |
|---|---|---|
| **Desktop host tiers** | **First-class**: Native CMake `LynxView` (macOS + Windows) **and** Lynxtron Autolink (macOS + Windows) | Linux as a Lynx host, HarmonyOS |
| **Architectures** | **`macos/arm64`**, **`windows/x64`** | `macos/x64` (dropped), `windows/arm64` & `windows/x86` (deferred) |
| **OS floors** | **macOS 14.0+**, **Windows 10+** | Older OS versions |
| **Dependencies** | Lynx **4.0+**, `powersync-sqlite-core` **0.5.3**, SQLite **3.44+** (amalgamation) | System SQLite, SQLCipher |

---

## 2. Packaging, Toolchain, and Release Distribution

- **Single npm package (`powersync-lynx`):**
  - Bundles prebuilt `dist/macos/arm64/` (`powersync-lynx.node`, `libpowersync_aarch64.macos.dylib`) and `dist/windows/x64/` (`powersync-lynx.node`, `powersync_x64.dll`).
  - Zero impact on web browser bundles (bundlers only consume JS/TS imports and `dist/web-host/factory.js`).
  - Strict tarball hygiene: release packaging asserts that `dist/` contains **only** `web-host/factory.js`, `macos/arm64/*`, and `windows/x64/*` (no stray `macos/x64` or `linux/x64` files).
- **Native toolchains (no cross-compile stubs):**
  - **macOS (`arm64`)**: built natively on macOS arm64 CI/release runners with Clang + CMake. Binaries shipped in npm remain **ad-hoc signed**; downstream app authors re-sign/notarize with their own Apple Developer ID during app packaging (`lynxtron-builder` / `codesign`).
  - **Windows (`x64`)**: built natively on `windows-latest` CI/release runners with **MSVC + CMake**, linking Lynxtron runtime symbols via `@lynx-js/lynx-library-headers`'s `lynx_link_lynxtron_runtime(...)`.
  - Retire `shared/win_host_stubs.c` and the Zig mingw `win-node` target from `Makefile` and `package.json` `files`.

---

## 3. Native CMake `LynxView` Integration and Core Loading

### 3.1 CMake target split (`shared/CMakeLists.txt`)

`shared/CMakeLists.txt` exposes two clean targets:

1. **`powersync_lynx_native`** (for native CMake `LynxView` consumers):
   - Compiles `shared/ps_sql.cc`, `third_party/sqlite/sqlite3.c`, and `shared/nativeModule/NativePowerSyncModule.cc` (without `lynxtron/library_entry.cc` and without any `native-vendor/` dependency).
   - Uses the consumer's Lynx Desktop C++ SDK headers (`LYNX_SDK_DIR` / target include paths).
   - Consumer registers the Native Module via:
     ```cpp
     lynx::pub::LynxEnv::GetInstance().RegisterNativeModule(
         "NativePowerSyncModule", CreateNativePowerSyncModule, nullptr);
     ```
   - Ships a CMake helper (e.g. `powersync_lynx_copy_core(<target>)`) to stage the platform's `powersync-sqlite-core` binary alongside the app executable (or into `Contents/Frameworks/` for macOS `.app` bundles).
2. **`powersync_lynx_napi`** (for Lynxtron `.node` builds):
   - Compiles `powersync-lynx.node` with `lynxtron/library_entry.cc` + `LYNX_REGISTER_NATIVE_MODULE` against `@lynx-js/lynx-library-headers` (`lynx_link_lynxtron_runtime` on Windows MSVC; `-Wl,-undefined,dynamic_lookup` on macOS).

### 3.2 `powersync-sqlite-core` loading

- **macOS (`arm64`)**: Dynamic `libpowersync_aarch64.macos.dylib` via `dlopen` + `sqlite3_auto_extension` (`CoreLoad::kAutoExtension`). Search order:
  1. `POWERSYNC_CORE_PATH` environment variable (if set and non-empty)
  2. `<ModuleDirectory>/libpowersync_aarch64.macos.dylib` (Lynxtron `.node` sibling & flat CLI binaries)
  3. `<ModuleDirectory>/../Frameworks/libpowersync_aarch64.macos.dylib` (native macOS `.app` bundles where the executable lives in `Contents/MacOS/`)
- **Windows (`x64`)**: Dynamic `powersync_x64.dll` via `sqlite3_load_extension(..., "sqlite3_powersync_init")` (`CoreLoad::kLoadExtension`). Search order:
  1. `POWERSYNC_CORE_PATH` environment variable (if set and non-empty)
  2. `<ModuleDirectory>\powersync_x64.dll`

---

## 4. Default Desktop `dbLocation` and UTF-8 Path Safety

When `open({ dbFilename, dbLocation?, readOnly? })` omits `dbLocation` (and `dbFilename` is not `:memory:`, not a `file:` URI, and not an absolute path):

- **macOS**: Resolve `~/Library/Application Support/<app>/`, where `<app>` is:
  1. `CFBundleIdentifier` when running inside a `.app` bundle (via CoreFoundation),
  2. else the current executable filename,
  3. else fallback `"powersync-lynx"`.
- **Windows**: Resolve `%LOCALAPPDATA%\<app>\` via `SHGetKnownFolderPath(FOLDERID_LocalAppData, ...)`, where `<app>` is:
  1. Current executable filename stem (UTF-16 → UTF-8),
  2. else fallback `"powersync-lynx"`.
- **Directory creation**: Auto-create the resolved default directory (recursively) if it does not exist. Explicit `dbLocation` preserves existing validation (must exist and be a directory).
- **Windows UTF-8 path safety**: Replace ANSI Win32 APIs (`GetModuleFileNameA`, `_stat`) in `shared/ps_sql.cc` and `shared/nativeModule/NativePowerSyncModule.cc` with wide-char UTF-16 ↔ UTF-8 equivalents (`GetModuleFileNameW`, `_wstat`, `CreateDirectoryW`) so non-ASCII user profiles work reliably.

---

## 5. Desktop `/sync/stream` Transport (Verification-First Gate)

- **Default path (verify first):** Keep Desktop Native Module SQL-only while verifying whether stock desktop `fetch` / `LynxHttpService` can deliver incremental NDJSON chunks and honor `AbortSignal` cancellation cleanly on:
  1. **Lynxtron** (macOS + Windows)
  2. **Native CMake `LynxView`** (macOS `NSURLSession` `LynxHttpService` and Windows `WinHTTP` `LynxHttpService` in the showcase hosts)
- **Conditional contingency (lift ADR-0003 Desktop SQL-only lock):** If stock desktop `fetch` or Lynx's C++ `LynxHttpService` interface cannot stream live NDJSON or cancel cleanly into PrimJS on either host type:
  - Reopen [ADR 0003](../../docs/adr/0003-native-module-http-is-streaming-fallback.md) and update `docs/spec.md` + `shared/tests/sync_http_session_test.cc`.
  - Implement Desktop Native Module `httpFetch` / `httpFetchAbort` (`NSURLSession` on macOS, `WinHTTP` on Windows) reusing `shared/sync_http_session.h` and `shared/utf8_hold.h`, and replay `shared/fixtures/sync-stream.json` on both platforms.

---

## 6. Runnable Showcase Hosts, SDK Acquisition, CI, and Release Gate

### 6.1 Showcase hosts (`examples/hosts/`)

Replace recipe-only `examples/hosts/desktop/` with three runnable showcase hosts loading `examples/showcase/lynx-dist/main.lynx.bundle` against `examples/docker-compose.yml` (`127.0.0.1:8080` / `:8081`):

- `examples/hosts/macos/` — native macOS CMake `LynxView` `.app` bundle
- `examples/hosts/windows/` — native Windows CMake `LynxView` app
- `examples/hosts/lynxtron/` — cross-platform Lynxtron app (macOS + Windows)

### 6.2 Lynx Desktop C++ SDK acquisition

- Ship a pinned, SHA-256-verified fetch script (and/or CMake integration) that downloads the pinned Lynx 4.x Desktop C++ SDK zip (`lynx_sdk_macos_arm64.zip` / `lynx_sdk_windows_x64.zip`) into a gitignored cache directory, with a `LYNX_SDK_DIR` environment/CMake override.

### 6.3 CI and Release Verification Bar

- **`.github/workflows/ci.yml`**: Add `macos-14` (`arm64`) and `windows-latest` (`x64`) jobs covering:
  - `powersync_lynx_native` + `powersync_lynx_napi` builds
  - C++ `ps_sql` + default-path + fixture unit tests
  - `scripts/check-native-artifacts.mjs`
  - Headless E2E sync verification on `windows-latest` (native Windows `LynxView` + Windows Lynxtron)
- **`.github/workflows/release.yml`**: Multi-OS fan-in (`build-macos` + `build-windows` → `publish`) with artifact & packed-consumer checks before `npm publish`.
- **0.3.0 release gate**: Live two-client sync verified across all four OS × host combinations (`macos/arm64` native, `macos/arm64` Lynxtron, `windows/x64` native, `windows/x64` Lynxtron) against the local compose stack (automated headless CI on Windows + interactive GUI sanity pass where available).

---

## 7. Implementation Tickets

| # | Ticket | Depends on |
|---|---|---|
| 02 | [Desktop CMake native target, macOS core lookup, and MSVC Lynxtron build](issues/02-desktop-cmake-and-core-loading.md) | — |
| 03 | [Default OS app-data `dbLocation` and Windows UTF-8 path safety](issues/03-desktop-default-db-location-and-win-utf8.md) | 02 |
| 04 | [Runnable Lynxtron showcase host and streaming check](issues/04-lynxtron-showcase-and-stream-check.md) | 02, 03 |
| 05 | [Runnable native macOS & Windows showcase hosts and Lynx SDK fetcher](issues/05-native-macos-windows-showcase-hosts.md) | 02, 03 |
| 06 | [Desktop `/sync/stream` verification gate & conditional Native Module HTTP](issues/06-desktop-sync-stream-contingency.md) | 04, 05 |
| 07 | [macOS & Windows CI builds, tests, and headless Windows E2E](issues/07-ci-macos-windows-and-headless-e2e.md) | 04, 05, 06 |
| 08 | [Multi-OS `release.yml`, tarball hygiene, docs bump, and `0.3.0` cut](issues/08-multi-os-release-and-0.3.0-cut.md) | 06, 07 |

## GitHub Tracking

- Spec Epic: #68

- [ ] #69 — [0.3.0] Desktop CMake native target, macOS core lookup, and MSVC Lynxtron build
- [ ] #70 — [0.3.0] Default OS app-data dbLocation and Windows UTF-8 path safety (blocked by #69)
- [ ] #71 — [0.3.0] Runnable Lynxtron showcase host (examples/hosts/lynxtron/) and streaming check (blocked by #69, #70)
- [ ] #72 — [0.3.0] Runnable native macOS & Windows showcase hosts and Lynx Desktop SDK fetcher (blocked by #69, #70)
- [ ] #73 — [0.3.0] Desktop /sync/stream verification gate & conditional Native Module HTTP (blocked by #71, #72)
- [ ] #74 — [0.3.0] macOS & Windows CI builds, native tests, and headless Windows E2E sync (blocked by #71, #72, #73)
- [ ] #75 — [0.3.0] Multi-OS release.yml, tarball hygiene, docs bump, and 0.3.0 release cut (blocked by #73, #74)
