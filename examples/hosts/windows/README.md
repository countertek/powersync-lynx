# Windows native host (CMake `LynxView`)

A native Windows **x64** (Windows 10+, MSVC) Win32 `HWND` application hosting
Lynx **4.2.0** `LynxView` and linking `powersync_lynx_native` directly via
CMake `add_subdirectory(../../../shared powersync_shared)`.

## Prerequisites

- Windows **10+** (`x64`)
- Visual Studio 2022 (MSVC C++17 toolchain / Desktop development with C++)
- CMake **3.22+**
- Node **>= 22.18** and pnpm **12**
- Optional: local sync compose stack (`docker compose --profile sync up --build`
  from `examples/`) for live sync on `127.0.0.1:8080` / `:8081`

## Fetch SDK & native dependencies

From the repository root (PowerShell):

```powershell
# 1. Fetch SQLite amalgamation + powersync_x64.dll (dist/windows/x64/)
node scripts/fetch-native-deps.mjs --windows-x64

# 2. Fetch pinned, SHA-256-verified Lynx 4.2.0 Desktop Windows x64 SDK
node scripts/fetch-lynx-desktop-sdk.mjs --windows-x64

# 3. Build the ReactLynx showcase bundle (examples/showcase/lynx-dist/main.lynx.bundle)
pnpm --dir examples/showcase install
pnpm --dir examples/showcase build
```

Offline / custom SDK installs can set `LYNX_SDK_DIR` (environment variable or
`-DLYNX_SDK_DIR=...`) pointing at an extracted Lynx Desktop SDK directory.

## Build

```powershell
cmake -S examples/hosts/windows -B examples/hosts/windows/build -G "Visual Studio 17 2022" -A x64
cmake --build examples/hosts/windows/build --config Release
```

The post-build step stages all runtime artifacts beside
`PowerSyncLynxShowcase.exe` (under `build\Release\`):

- `powersync_x64.dll` (via `powersync_lynx_copy_core(PowerSyncLynxShowcase)`)
- `lynx.dll`, `lynx_core.js`, `lynx_core_dev.js`
- `data\icudtl.dat`
- `main.lynx.bundle`

## Run

```powershell
.\examples\hosts\windows\build\Release\PowerSyncLynxShowcase.exe
```

### Configuration overrides (`globalProps` & runtime flags)

| Option | CLI flags | Environment variable | Default |
|---|---|---|---|
| Device ID | `-DemoDevice <id>` / `--device <id>` | `DEMO_DEVICE` | `windows` |
| Demo API URL | `-DemoApiUrl <url>` / `--demo-api-url <url>` | `DEMO_API_URL` | `http://127.0.0.1:8081` |
| PowerSync URL | `-PowerSyncUrl <url>` / `--powersync-url <url>` | `POWERSYNC_URL` | `http://127.0.0.1:8080` |
| Lynx bundle | `-BundlePath <path>` / `--bundle <path>` | `LYNX_BUNDLE_PATH` | `<exe_dir>\main.lynx.bundle` |
| Automated smoke test | `--smoke-test` | `SMOKE_TEST=1` | off |
| Smoke duration (sec) | `--smoke-seconds <N>` | `SMOKE_TEST_SECONDS` | `6.0` |
| Hidden window (CI) | `--headless` | `HEADLESS=1` | off |

Example automated smoke run (for CI / headless E2E):

```powershell
.\examples\hosts\windows\build\Release\PowerSyncLynxShowcase.exe `
  --smoke-test --headless --smoke-seconds 8 --device win-ci
```

### Two-client sync walkthrough

1. Start the local sync stack in `examples/`:
   ```powershell
   docker compose --profile sync up --build
   ```
2. Launch two native windows with distinct device IDs (each opens its own
   SQLite database in `%LOCALAPPDATA%\PowerSyncLynxShowcase\`):
   ```powershell
   Start-Process .\examples\hosts\windows\build\Release\PowerSyncLynxShowcase.exe -ArgumentList "-DemoDevice","win-a"
   Start-Process .\examples\hosts\windows\build\Release\PowerSyncLynxShowcase.exe -ArgumentList "-DemoDevice","win-b"
   ```

## Integration & `/sync/stream` notes

- **Native module registration**: calls
  `lynx::pub::LynxEnv::GetInstance().RegisterNativeModule("NativePowerSyncModule", CreateNativePowerSyncModule, nullptr)`.
- **Default SQLite directory**: `powersync-lynx` resolves and auto-creates
  `%LOCALAPPDATA%\PowerSyncLynxShowcase\` via `SHGetKnownFolderPath` + UTF-16
  Win32 APIs (`shared/nativeModule/db_location.h` + `shared/win_utf8.h`).
- **`WinHTTP` `LynxHttpService`**: implemented in `src/ShowcaseHttpService.cc`
  and registered via `LynxServiceCenter::GetInstance().RegisterService(...)`.
- **Live `/sync/stream` via Desktop Native Module HTTP (Gate #73)**: Lynx 4.2.0
  `LynxHttpService` (`include/lynx_http_service.h`) is buffered-only with no
  incremental chunk callback or cancel hook. `powersync_lynx_native` now
  exposes `httpFetch` / `httpFetchAbort` backed by `WinHTTP`
  (`shared/sync_http/win_sync_http.cc`), sharing
  `shared/sync_http/sync_http_engine.{h,cc}`,
  `shared/sync_http/sync_http_session.{h,cc}`, and
  `shared/sync_http_policy.h` with zero host wiring required. Native Windows
  `x64` CI build and headless E2E sync verification run in `.github/workflows/ci.yml`.
