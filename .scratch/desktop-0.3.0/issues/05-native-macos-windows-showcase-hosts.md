# 05: Runnable native macOS & Windows showcase hosts (`examples/hosts/macos/` & `windows/`) + Lynx SDK fetcher

Type: task
Status: ready-for-agent
Blocked by: 02, 03
Spec: ../spec.md (#68)
GitHub: #72

## Scope

Build runnable native CMake `LynxView` showcase apps for macOS (`arm64`) and Windows (`x64`) linking `powersync_lynx_native`, plus a pinned, SHA-256-verified Lynx 4.x Desktop C++ SDK fetcher.

### Changes

1. **Lynx Desktop C++ SDK fetcher (`scripts/fetch-lynx-desktop-sdk.mjs` + CMake hook)**:
   - Downloads pinned Lynx 4.x Desktop SDK zips (`lynx_sdk_macos_arm64.zip`, `lynx_sdk_windows_x64.zip`) from GitHub Releases with SHA-256 verification into a gitignored cache directory (e.g. `third_party/lynx-sdk/`).
   - Supports `LYNX_SDK_DIR` env/CMake override for offline/custom SDK setups.
2. **Create `examples/hosts/macos/`**:
   - CMake project producing a native macOS `.app` bundle (`arm64`, macOS 14.0+).
   - Integrates `powersync-lynx` via `add_subdirectory(.../shared)` + `powersync_lynx_native` + `powersync_lynx_copy_core(...)` (staging `libpowersync_aarch64.macos.dylib` into `Contents/Frameworks/`).
   - Calls `LynxEnv::GetInstance().RegisterNativeModule("NativePowerSyncModule", CreateNativePowerSyncModule, nullptr)`.
   - Implements a real `NSURLSession`-backed `LynxHttpService` registered with `LynxServiceCenter`.
   - Loads `examples/showcase/lynx-dist/main.lynx.bundle`; supports `DEMO_DEVICE`, `DEMO_API_URL`, `POWERSYNC_URL` env/argv overrides.
   - `README.md` with build/run/verify steps.
3. **Create `examples/hosts/windows/`**:
   - CMake project producing a native Windows x64 app (`HWND` host, MSVC, Windows 10+).
   - Integrates `powersync-lynx` via `add_subdirectory(.../shared)` + `powersync_lynx_native` + `powersync_lynx_copy_core(...)` (staging `powersync_x64.dll` next to `.exe`).
   - Calls `LynxEnv::GetInstance().RegisterNativeModule("NativePowerSyncModule", CreateNativePowerSyncModule, nullptr)`.
   - Implements a real `WinHTTP`-backed `LynxHttpService` registered with `LynxServiceCenter`.
   - Loads `examples/showcase/lynx-dist/main.lynx.bundle`; supports `DEMO_DEVICE`, `DEMO_API_URL`, `POWERSYNC_URL` env/argv overrides.
   - `README.md` with build/run/verify steps.
4. **Verify `/sync/stream` on native CMake `LynxView`**:
   - Test live NDJSON streaming + `AbortSignal` cancellation on macOS native (and Windows native via CI/VM) and record concrete findings as input to Ticket `06`.

## Acceptance Criteria

- `examples/hosts/macos/` builds cleanly via CMake on macOS arm64, launches the `.app`, loads `libpowersync_aarch64.macos.dylib` from `Contents/Frameworks/`, opens SQLite in `~/Library/Application Support/<bundle-id>/`, and paints the showcase UI.
- `examples/hosts/windows/` builds cleanly via CMake + MSVC on Windows x64, stages `powersync_x64.dll`, and links `powersync_lynx_native`.
- Lynx Desktop SDK fetcher verifies SHA-256 and respects `LYNX_SDK_DIR`.
- Concrete `/sync/stream` + `AbortSignal` verification findings are recorded for Ticket `06`.

## Verification

- `node scripts/fetch-lynx-desktop-sdk.mjs --macos-arm64` + CMake build & launch of `examples/hosts/macos/` against `examples/docker-compose.yml`.
- CMake build of `examples/hosts/windows/` on `windows-latest` / Windows x64.
