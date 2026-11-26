# 02: Desktop CMake native target, macOS core lookup, and MSVC Lynxtron build

Type: task
Status: resolved
Spec: ../spec.md (#68)
GitHub: #69

## Scope

Refactor desktop CMake, native core loading, and artifact tooling to make both native CMake `LynxView` and Lynxtron first-class on `macos/arm64` and `windows/x64`, and switch Windows `.node` builds to native MSVC.

### Changes

1. **`shared/CMakeLists.txt`**:
   - Expose a clean consumer-linkable target `powersync_lynx_native` (compiles `ps_sql.cc`, `sqlite3.c`, `NativePowerSyncModule.cc`; no `lynxtron/library_entry.cc`, no `native-vendor/` dependency; consumes Lynx SDK headers from consumer target / `LYNX_SDK_DIR`).
   - Add a CMake helper (e.g. `powersync_lynx_copy_core(<target>)`) to copy `libpowersync_aarch64.macos.dylib` (into executable dir or `.app/Contents/Frameworks/`) or `powersync_x64.dll` alongside the app binary.
   - Keep `powersync_lynx_napi` (gated via a CMake option, e.g. `POWERSYNC_BUILD_LYNXTRON_NAPI`, default `OFF` when consumed via `add_subdirectory` or `ON` for standalone Lynxtron builds) building `powersync-lynx.node` with `@lynx-js/lynx-library-headers` and calling `lynx_link_lynxtron_runtime(powersync_lynx_napi)` on `WIN32`.
2. **Retire Zig mingw stubs**:
   - Delete `shared/win_host_stubs.c`.
   - Remove `win-node` Zig mingw cross-compile target from `Makefile` and remove `shared/win_host_stubs.c` from `package.json` `files`.
3. **macOS & Windows `powersync-sqlite-core` lookup (`shared/nativeModule/NativePowerSyncModule.cc`)**:
   - Check `POWERSYNC_CORE_PATH` env var first.
   - On macOS, probe `<ModuleDirectory>/libpowersync_aarch64.macos.dylib` then `<ModuleDirectory>/../Frameworks/libpowersync_aarch64.macos.dylib`.
   - On Windows, probe `<ModuleDirectory>\powersync_x64.dll`.
4. **Scripts (`scripts/fetch-native-deps.mjs`, `scripts/check-native-artifacts.mjs`)**:
   - Add target-scoped fetch flags (e.g. `--macos-arm64`, `--windows-x64`) so release builds only populate `dist/macos/arm64` and `dist/windows/x64` without stray `macos/x64` or `linux/x64` assets.
   - Update `scripts/check-native-artifacts.mjs` to support single-platform checks (`--macos`, `--windows`) as well as full release checks, verifying MSVC-built `powersync-lynx.node` PE exports and Mach-O arm64 binary.

## Acceptance Criteria

- A standalone CMake project can `add_subdirectory(.../shared)` and link `powersync_lynx_native` without `native-vendor/` installed.
- `powersync_lynx_napi` builds `dist/macos/arm64/powersync-lynx.node` via Clang/CMake on macOS arm64 and `dist/windows/x64/powersync-lynx.node` via MSVC/CMake (`lynx_link_lynxtron_runtime`) on Windows x64.
- `shared/win_host_stubs.c` and Zig mingw `win-node` are removed.
- macOS core lookup resolves `POWERSYNC_CORE_PATH`, sibling `<ModuleDirectory>`, and `../Frameworks/`.
- `make test` and `pnpm test` pass.

## Verification

- `pnpm test && pnpm typecheck && pnpm lint && make test`
- CMake configure & build of both `powersync_lynx_native` and `powersync_lynx_napi` on macOS arm64 (and Windows x64 MSVC).
- `node scripts/check-native-artifacts.mjs` passes on built artifacts.
