# macOS native host (CMake `LynxView`)

A native macOS **arm64** (macOS 14.0+, Cocoa `NSApplication` + `NSWindow` + `NSView`)
`.app` bundle hosting Lynx **4.2.0** `LynxView` and linking `powersync_lynx_native`
directly via CMake `add_subdirectory(../../../shared powersync_shared)`.

## Prerequisites

- Apple Silicon Mac (`arm64`), macOS **14.0+**
- Xcode Command Line Tools (AppleClang C++17 / Objective-C++)
- CMake **3.22+**
- Node **>= 22.18** and pnpm **12**
- Optional: local sync compose stack (`docker compose --profile sync up --build`
  from `examples/`) for live sync on `127.0.0.1:8080` / `:8081`

## Fetch SDK & native dependencies

From the repository root:

```bash
# 1. Fetch SQLite amalgamation + libpowersync_aarch64.macos.dylib (dist/macos/arm64/)
node scripts/fetch-native-deps.mjs --macos-arm64

# 2. Fetch pinned, SHA-256-verified Lynx 4.2.0 Desktop macOS arm64 SDK
node scripts/fetch-lynx-desktop-sdk.mjs --macos-arm64

# 3. Build the ReactLynx showcase bundle (examples/showcase/lynx-dist/main.lynx.bundle)
pnpm install
pnpm --dir examples/showcase install
pnpm --dir examples/showcase build
```

Offline / custom SDK installs can set `LYNX_SDK_DIR` (environment variable or
`-DLYNX_SDK_DIR=...`) pointing at an extracted Lynx Desktop SDK directory.

## Build

```bash
cmake -S examples/hosts/macos -B examples/hosts/macos/build -DCMAKE_BUILD_TYPE=Release
cmake --build examples/hosts/macos/build -j
```

The post-build step stages all runtime dependencies into
`examples/hosts/macos/build/PowerSyncLynxShowcase.app`:

- `Contents/Frameworks/libpowersync_aarch64.macos.dylib` (via `powersync_lynx_copy_core(PowerSyncLynxShowcase)`)
- `Contents/Frameworks/libLynx.dylib` (resolved via `@executable_path/../Frameworks`)
- `Contents/Resources/data/icudtl.dat`
- `Contents/Resources/LynxResources.bundle` & `LynxDebugResources.bundle`
- `Contents/Resources/main.lynx.bundle`

## Run

```bash
open examples/hosts/macos/build/PowerSyncLynxShowcase.app
```

Or run the binary directly in a terminal to see live Lynx, HTTP, and SQLite logs:

```bash
examples/hosts/macos/build/PowerSyncLynxShowcase.app/Contents/MacOS/PowerSyncLynxShowcase
```

### Configuration overrides (`globalProps` & runtime flags)

| Option | CLI flags | Environment variable | Default |
|---|---|---|---|
| Device ID | `-DemoDevice <id>` / `--device <id>` | `DEMO_DEVICE` | `macos` |
| Demo API URL | `-DemoApiUrl <url>` / `--demo-api-url <url>` | `DEMO_API_URL` | `http://127.0.0.1:8081` |
| PowerSync URL | `-PowerSyncUrl <url>` / `--powersync-url <url>` | `POWERSYNC_URL` | `http://127.0.0.1:8080` |
| Lynx bundle | `-BundlePath <path>` / `--bundle <path>` | `LYNX_BUNDLE_PATH` | `Contents/Resources/main.lynx.bundle` |
| Automated smoke test | `--smoke-test` | `SMOKE_TEST=1` | off |
| Smoke duration (sec) | `--smoke-seconds <N>` | `SMOKE_TEST_SECONDS` | `6.0` |

### Two-client walkthrough

1. Start the local sync stack in `examples/`:
   ```bash
   docker compose --profile sync up --build
   ```
2. Launch two native instances with distinct device IDs (each opens its own
   SQLite database in `~/Library/Application Support/com.powersync.lynx.showcase/`):
   ```bash
   examples/hosts/macos/build/PowerSyncLynxShowcase.app/Contents/MacOS/PowerSyncLynxShowcase -DemoDevice mac-a &
   examples/hosts/macos/build/PowerSyncLynxShowcase.app/Contents/MacOS/PowerSyncLynxShowcase -DemoDevice mac-b &
   ```
   Or pair one macOS native window with the web demo (`http://localhost:4173/?device=web-b`).

## Empirical Verification Findings (Gate Ticket #73 — Branch B Implemented & Verified)

Verified on macOS `arm64`, AppleClang 21.0.0, CMake 3.22.1, Lynx Desktop C++ SDK **4.2.0**
(`lynx_sdk_macos_arm64.zip`, SHA-256 `bcbc69270ce5b18ae8503c1bcd284197eb220b76acf5807ebab1efb956750469`)
against the live local compose stack (`postgres` + `mongo` + `powersync-service` + `demo-api`).

### Initial stock `LynxHttpService` gate findings (triggered Branch B)

1. **`include/lynx_http_service.h` & `include/capi/lynx_http_service_capi.h`** (byte-for-byte identical between `macos-arm64` and `windows-x64`):
   - `LynxHttpResponse` only exposes buffered `SetBody(...)` + `Complete()`, with **no incremental chunk callback** and **no cancel/abort hook**.
2. **`LynxResources.bundle/Contents/Resources/lynx_core.js`**:
   - Stock `fetch` rejects `AbortSignal` locally without a native abort call, and `AbortSignal` (`class Ne extends ye`) splices its listener array inside `forEach` during `emit` (skipping subsequent abort listeners when an earlier listener removes itself).
3. **Gate #73 resolution (ADR-0003 reopened for Desktop)**:
   - Desktop `NativePowerSyncModule` (`shared/nativeModule/NativeSyncHttpNapi.cc` + `shared/sync_http/apple_sync_http.mm`) now exposes `httpFetch` / `httpFetchAbort` backed by `NSURLSession`, sharing `shared/sync_http/sync_http_engine.{h,cc}`, `shared/sync_http/sync_http_session.{h,cc}`, and `shared/sync_http_policy.h`, and delivering `GlobalEventEmitter` events directly via `Napi::Env` + `Napi::ThreadSafeFunction` (zero host wiring required).
   - `installAbortControllerPolyfill()` feature-detects and replaces Lynx 4.2/4.4's broken `AbortController` splice-during-emit bug.

### Live Verification Matrix (Post-Gate #73)

| Check | Result | Concrete evidence |
|---|---|---|
| CMake build & `.app` staging | **Pass** | Built `PowerSyncLynxShowcase.app` cleanly via `add_subdirectory(../../../shared)` linking `powersync_lynx_native` (with `shared/sync_http/apple_sync_http.mm` + `-framework Foundation`) + `powersync_lynx_copy_core(...)`. |
| `libpowersync_aarch64.macos.dylib` lookup | **Pass** | Loaded dynamically from `Contents/Frameworks/libpowersync_aarch64.macos.dylib` with no `POWERSYNC_CORE_PATH` set. |
| Default macOS `dbLocation` | **Pass** | Resolved `CFBundleIdentifier` (`com.powersync.lynx.showcase`), auto-created `~/Library/Application Support/com.powersync.lynx.showcase/`, and initialized `powersync-lynx-todo-<device>.db`. |
| Showcase UI & Connector HTTP (`/token`, `/upload`) | **Pass** | `OnFirstScreen`, `OnLoadSuccess`, and `OnRuntimeReady` fired cleanly; `GET /token` and `POST /upload` succeeded via Desktop Native Module HTTP (`httpFetch`). |
| Live NDJSON `/sync/stream` via `native-http` | **Pass** | Initial checkpoint downloaded (`ps_buckets=1`, `seed-1: "Initial todo €100"` plus cross-host Lynxtron uploads); live cross-client push (`"Live push macOS native €99 🎉"`) arrived incrementally in ~500 ms while `/sync/stream` stayed open. |
| Multi-byte UTF-8 chunk boundaries | **Pass** | Shared `shared/sync_http/sync_http_session.{h,cc}` (`split-multibyte` fixture replayed over loopback `NSURLSession` in `make test`) and live 3-byte (`€`) + 4-byte (`🚀`, `🎉`, `✨`) UTF-8 decoded cleanly without corruption. |
| `AbortSignal` / `db.disconnect()` & reconnect | **Pass** | `db.disconnect()` invoked `httpFetchAbort` -> `NSURLSessionDataTask cancel`; proxy observed server TCP socket close in **7 ms**; offline local write uploaded (`pendingCrud=0`) and external mutation converged cleanly on reconnect (`stream#2`). |
