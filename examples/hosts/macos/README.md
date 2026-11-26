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

## Empirical Verification Findings (Gate Ticket #73)

Verified on macOS `arm64`, AppleClang 21.0.0, CMake 3.22.1, Lynx Desktop C++ SDK **4.2.0**
(`lynx_sdk_macos_arm64.zip`, SHA-256 `bcbc69270ce5b18ae8503c1bcd284197eb220b76acf5807ebab1efb956750469`).

| Check | Result | Concrete evidence |
|---|---|---|
| CMake build & `.app` staging | **Pass** | Built `PowerSyncLynxShowcase.app` cleanly via `add_subdirectory(../../../shared)` linking `powersync_lynx_native` + `powersync_lynx_copy_core(...)`. |
| `libpowersync_aarch64.macos.dylib` lookup | **Pass** | Loaded dynamically from `Contents/Frameworks/libpowersync_aarch64.macos.dylib` with no `POWERSYNC_CORE_PATH` set. |
| Default macOS `dbLocation` | **Pass** | Resolved `CFBundleIdentifier` (`com.powersync.lynx.showcase`), auto-created `~/Library/Application Support/com.powersync.lynx.showcase/`, and initialized `powersync-lynx-todo-<device>.db` with full PowerSync schema (`ps_buckets`, `ps_crud`, `ps_data__todos`, `todos`, etc.). |
| Showcase UI & normal JSON `fetch` | **Pass** | `OnFirstScreen`, `OnLoadSuccess`, and `OnRuntimeReady` fired cleanly (`exit 0` in `--smoke-test`). `GET /token` through `NSURLSession`-backed `ShowcaseHttpService` returned `HTTP 200` (374 bytes from local compose `demo-api`). |
| Live NDJSON `/sync/stream` via `LynxHttpService` | **Fail — Contingency Triggered (#73)** | `POST /sync/stream` reached both the local compose PowerSync service (`127.0.0.1:18080`) and a mock NDJSON streaming server. Because Lynx 4.2.0 `LynxHttpService` is buffered-only, live streams block until EOF/timeout and deliver 0 chunks (`ps_buckets=0`, `todos=0`). Even when the mock server closes after 500ms (`HTTP 200`, 396 bytes), `ps_buckets` remains `0` because PrimJS `fetch` returns a non-streaming `Response` without `body.getReader()`. |
| `AbortSignal` cancellation via `LynxHttpService` | **Fail — Contingency Triggered (#73)** | Lynx 4.2.0 `lynx_core.js` rejects the JS Promise locally on `signal.abort()` without notifying native code, and `lynx_http_service_capi.h` exposes no cancel/abort hook to terminate an in-flight `NSURLSessionDataTask` or `WinHTTP` request. |

### Exact Lynx 4.2.0 SDK header & runtime findings

1. **`include/lynx_http_service.h` & `include/capi/lynx_http_service_capi.h`** (byte-for-byte identical between `macos-arm64` and `windows-x64`):
   - `LynxHttpService::Request(std::shared_ptr<LynxHttpRequest>, std::shared_ptr<LynxHttpResponse>)`
   - `LynxHttpResponse` only exposes: `SetStatusCode(int)`, `SetStatusText(const char*)`, `AddHeader(const std::string&, const std::string&)`, `SetBody(uint8_t*, size_t, dtor, opaque)`, and `Complete()` (`lynx_http_response_callback`).
   - **No incremental chunk callback** (`OnData` / `WriteBody` / `streamingId`) exists in the C or C++ API.
   - **No cancellation API** (`Cancel` / `Abort`) exists on `lynx_http_service_t` or `lynx_http_request_t`.
2. **`LynxResources.bundle/Contents/Resources/lynx_core.js`**:
   - `fetch` registers `a.addEventListener("abort", s => { i(a.reason) })` purely in JS, then invokes `NativeModules.LynxFetchModule.fetch(f, onSuccess, onError)` with no native abort call.
   - `lynx_core.js` only wraps the response in `_ReadableStreamClass` when `o.lynxExtension.useStreaming || pageConfigSubset?.enableFetchAPIStandardStreaming` is truthy, and expects the native response to supply `lynxExtension.streamingId` + `GlobalEventEmitter` events (`onData` / `onEnd` / `onError`). Desktop `LynxHttpService` cannot emit those events.
3. **Path forward for Gate Ticket #73**:
   - Reopen ADR-0003 for Desktop and add `httpFetch` / `httpFetchAbort` to Desktop `NativePowerSyncModule` (`NSURLSession` on macOS, `WinHTTP` on Windows), sharing `shared/sync_http_session.h` and `shared/utf8_hold.h`.
   - Native `LynxView` hosts already have `lynx::pub::LynxView::SendGlobalEvent(const std::string& name, const std::string& json)` (`include/lynx_view.h`) to forward incremental `onData` / `onEnd` / `onError` events to `GlobalEventEmitter`.
