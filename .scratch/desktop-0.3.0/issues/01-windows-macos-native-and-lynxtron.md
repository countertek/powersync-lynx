# 0.3.0: Support Windows and macOS (native LynxView and Lynxtron)

Type: grilling
Status: resolved

## Answer

Locked in [spec.md](../spec.md) and split into implementation tickets `02`–`08` under `.scratch/desktop-0.3.0/issues/`. All 16 grilling decisions confirmed by the user on 2026-11-26.

## Goal

Add Windows and macOS desktop support for the `0.3.0` release, covering both:
1. Native desktop hosts (CMake `LynxView` on macOS and Windows)
2. Lynxtron desktop hosts (macOS and Windows)

## Current state (repo baseline)

- **Package & manifest**: `lynx.lib.json` declares `lynxtron` (`dist`), `macos` (`shared`), and `windows` (`shared`). `package.json` exports `./lynxtron` (`lynxtron/index.cjs`).
- **Native module**: `shared/nativeModule/NativePowerSyncModule.cc`, `shared/ps_sql.{cc,h}`, `lynxtron/library_entry.cc`, and `shared/win_host_stubs.c` implement a SQL-only Weak Node-API module (`open` / `close` / `execute` / `executeBatch`).
- **Build & artifacts**: `Makefile` builds only `dist/macos/arm64/powersync-lynx.node` and `dist/windows/x64/powersync-lynx.node` (via Zig `x86_64-windows-gnu` cross-compile). `scripts/check-native-artifacts.mjs` checks only those two targets. `dist/` contains no committed desktop binaries.
- **Release & CI**: `.github/workflows/ci.yml` and `.github/workflows/release.yml` run only on `ubuntu-latest`. `package.json` `prepack` fetches only the SQLite amalgamation (`--sqlite`), not `powersync-sqlite-core` desktop binaries or built `.node` addons.
- **Native CMake embedding**: `shared/CMakeLists.txt` references `../native-vendor/node_modules/@lynx-js/...` and builds only a `.node` `MODULE` target; it is not yet a clean consumer-linkable native CMake integration.
- **Sync transport**: `docs/spec.md`, ADR-0003, and `shared/tests/sync_http_session_test.cc` lock Desktop N-API as SQL-only, falling through to host `fetch` (`LynxHttpService`), which is unverified on desktop.
- **Default DB path**: When `dbLocation` is omitted, Desktop N-API opens `dbFilename` relative to CWD (unlike iOS Documents and Android `Context.getDatabasePath`).
- **Showcase hosts**: `examples/hosts/desktop/` is recipe-only (README + unwired `lynxtron.config.ts`).

## Decisions to lock (grilling)

All frontier decisions settled across Rounds 1–3 (pending final user confirmation):

- **Host tiers (`Q1 = A`)**: Promote both native CMake `LynxView` (macOS + Windows) and Lynxtron (macOS + Windows) to first-class supported desktop tiers in `0.3.0`; update `docs/spec.md`, `README.md`, and `package.json`.
- **Targets & floors (`Q2 = C`, spec unchanged)**: `macos/arm64` (macOS 14.0+) and `windows/x64` (Windows 10+) only. Drop `macos/x64`; defer `windows/arm64` and `windows/x86`. Lynx 4.0+, `powersync-sqlite-core` 0.5.3, SQLite 3.44+.
- **Packaging & release (`Q3 = A`, `Q13 = A`, `Q14 = A`)**:
  - Single `powersync-lynx` npm package bundling prebuilt `dist/macos/arm64/` (`powersync-lynx.node` + `libpowersync_aarch64.macos.dylib`) and `dist/windows/x64/` (`powersync-lynx.node` + `powersync_x64.dll`), with strict tarball checks excluding stray `macos/x64` / `linux/x64` binaries.
  - Multi-OS `release.yml` building macOS on `macos-arm64` and Windows natively with **MSVC + CMake** (`lynx_link_lynxtron_runtime` from `@lynx-js/lynx-library-headers`); retire `shared/win_host_stubs.c` and Zig mingw `win-node`.
  - macOS binaries in npm remain **ad-hoc signed**; downstream app packaging handles Developer ID signing/notarization.
- **Native CMake integration & core loading (`Q7 = A`, `Q8 = A`)**:
  - `shared/CMakeLists.txt` exposes a standalone consumer CMake target (`powersync_lynx_native`, no `native-vendor/` dependency) for `add_subdirectory(...)` + `LynxEnv::GetInstance().RegisterNativeModule("NativePowerSyncModule", CreateNativePowerSyncModule, nullptr)`, plus a CMake helper to stage `powersync-sqlite-core`.
  - macOS keeps dynamic `libpowersync_aarch64.macos.dylib` (`dlopen` + `sqlite3_auto_extension`), searching `POWERSYNC_CORE_PATH`, `ModuleDirectory()`, and `../Frameworks/` (for `.app` bundles), and updates `docs/spec.md` to match. Windows keeps `powersync_x64.dll` via `sqlite3_load_extension`.
- **Default `dbLocation` (`Q5 = A`, `Q9 = A`)**:
  - When `dbLocation` is omitted, resolve and auto-create an OS app-data directory: macOS `~/Library/Application Support/<app>/` (`CFBundleIdentifier` in `.app` bundle, else executable name, fallback `powersync-lynx`) and Windows `%LOCALAPPDATA%\<app>\` (executable stem, fallback `powersync-lynx`).
  - Keep explicit `dbLocation`, absolute paths, `:memory:`, and `file:` URIs unchanged. Fix Windows wide-char/UTF-8 path handling (`GetModuleFileNameW`, `_wstat`, `SHGetKnownFolderPath`).
- **Sync transport (`Q4 = A`, `Q12 = A`)**:
  - Verify stock desktop `fetch` / `LynxHttpService` live NDJSON streaming + `AbortSignal` first (in Lynxtron and in native macOS/Windows showcase hosts with real `NSURLSession` / `WinHTTP` `LynxHttpService`).
  - If stock streaming or abort fails on either host type, lift the Desktop SQL-only lock (ADR-0003, `docs/spec.md`, `sync_http_session_test.cc`) and implement Desktop Native Module `httpFetch` / `httpFetchAbort` sharing `shared/sync_http_session.h` + `shared/utf8_hold.h`.
- **Showcase hosts, SDK fetch & verification (`Q6 = A`, `Q10 = A`, `Q11 = A`, `Q15 = A`)**:
  - Replace recipe-only `examples/hosts/desktop/` with runnable `examples/hosts/macos/`, `examples/hosts/windows/`, and `examples/hosts/lynxtron/` loading `examples/showcase/lynx-dist/main.lynx.bundle`.
  - Auto-fetch pinned, SHA-256-verified Lynx 4.x Desktop C++ SDK zips into a gitignored cache (with `LYNX_SDK_DIR` override) for showcase hosts and CI.
  - Add macOS + Windows CI jobs (native build, C++/N-API tests, artifact checks, headless Windows E2E sync on `windows-latest`), plus interactive GUI two-client live-sync verification across all four OS × host combinations before cutting `0.3.0`.
- **Issue tracking (`Q16 = A`)**: Keep spec and implementation tickets local under `.scratch/desktop-0.3.0/`.

## Comments

2026-11-26: Issue filed to kick off 0.3.0 Windows + macOS (native & Lynxtron) grilling. Round 1 frontier opened.

2026-11-26 Round 1 answers:
- Q1: A — Promote both native CMake `LynxView` and Lynxtron to first-class supported desktop tiers in 0.3.0.
- Q2: C — Target `macos/arm64` and `windows/x64` only (drop `macos/x64`, defer `windows/arm64` / `windows/x86`).
- Q3: Open — user asked about package size impact for other platforms, especially web. Measured local sizes: web browser bundle impact is 0 bytes; desktop prebuilts add ~3.9 MB unpacked (~1.7 MB gzipped) to the npm tarball (which already ships ~19.5 MB unpacked of SQLite C sources). Carried to Round 2.
- Q4: A — Verify stock desktop `fetch` / `LynxHttpService` first; lift SQL-only lock and add Desktop Native Module `httpFetch` if stock streaming/abort fails.
- Q5: A — Default to OS app-data directory when `dbLocation` is omitted on macOS and Windows.
- Q6: A — Ship runnable showcase hosts for native macOS, native Windows, and Lynxtron; add macOS + Windows CI jobs; verify live two-client sync across all four combinations before 0.3.0.

2026-11-26 Round 2 answers:
- Q3: A — Bundle prebuilt `dist/macos/arm64/` and `dist/windows/x64/` binaries inside the single `powersync-lynx` npm package via multi-OS release workflow.
- Q7: A — Expose clean `add_subdirectory` CMake target (`powersync_lynx_native`) + core-staging helper for native CMake `LynxView` consumers (no `native-vendor/` dependency).
- Q8: A — Keep dynamic `libpowersync_aarch64.macos.dylib` on macOS (add `../Frameworks/` lookup for `.app` bundles + `POWERSYNC_CORE_PATH` override) and update `docs/spec.md` to match.
- Q9: A — Auto-derive default app-data subfolder from macOS `CFBundleIdentifier`/executable name and Windows executable stem (fallback `powersync-lynx`), auto-creating the directory.
- Q10: A — Create `examples/hosts/macos/`, `examples/hosts/windows/`, and `examples/hosts/lynxtron/` (removing stale recipe-only `examples/hosts/desktop/`).
- Q11: A — Automate Windows build, native tests, and headless E2E sync verification on GitHub Actions `windows-latest`, plus an interactive GUI sanity pass if a Windows machine/VM is available.
- Q12: A — Verify Lynx desktop `LynxHttpService` / `fetch` streaming first (building real `NSURLSession` / `WinHTTP` `LynxHttpService` in showcase hosts); fall back to lifting the SQL-only lock with Desktop Native Module `httpFetch` if stock streaming/abort fails.

2026-11-26 Round 3 answers:
- Q13: A — Switch Windows `.node` builds to native MSVC + CMake (`lynx_link_lynxtron_runtime`) on Windows CI/release; retire `shared/win_host_stubs.c` and Zig mingw `win-node`.
- Q14: A — Ad-hoc signed macOS binaries in npm; downstream apps handle Developer ID signing/notarization.
- Q15: A — Pinned, SHA-256-verified auto-fetch for Lynx 4.x Desktop C++ SDK zips (with `LYNX_SDK_DIR` override).
- Q16: A — Keep tracking local under `.scratch/desktop-0.3.0/`.
- Frontier empty; awaiting user confirmation of shared understanding before writing `.scratch/desktop-0.3.0/spec.md` and implementation tickets.
