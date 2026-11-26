# 07: macOS & Windows CI builds, native tests, and headless Windows E2E sync

Type: task
Status: ready-for-agent
Blocked by: 04, 05, 06
Spec: ../spec.md (#68)
GitHub: #74

## Scope

Expand `.github/workflows/ci.yml` beyond `ubuntu-latest` to build and test `powersync-lynx` natively on `macos-14` (`arm64`) and `windows-latest` (`x64`), including automated headless E2E sync verification on Windows.

### Changes

1. **macOS CI job (`macos-14`, `arm64`)**:
   - Build `powersync_lynx_napi` (`dist/macos/arm64/powersync-lynx.node`) and `powersync_lynx_native` + `examples/hosts/macos/`.
   - Run `make test`, `make test-ios` (if simulator/macOS host test binary runs cleanly), `node scripts/check-native-artifacts.mjs --macos`, and `pnpm test`.
2. **Windows CI job (`windows-latest`, `x64`, MSVC)**:
   - Build `powersync_lynx_napi` (`dist/windows/x64/powersync-lynx.node`) via CMake + MSVC (`lynx_link_lynxtron_runtime`).
   - Build and run `ps_sql_test` (including UTF-8 and `%LOCALAPPDATA%` default-path tests) and `node scripts/check-native-artifacts.mjs --windows`.
   - Build `examples/hosts/windows/` (native CMake `LynxView` app) and `examples/hosts/lynxtron/`.
   - Run automated headless E2E sync verification on `windows-latest` (launching a mock/local PowerSync sync server or compose stack and verifying SQLite persistence + `/sync/stream` download + CRUD upload + abort/reconnect on both Windows native and Windows Lynxtron).
3. **Keep Linux `ubuntu-latest` job fast**:
   - Continues running `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm check-packed-consumers`, and Linux `make test`.

## Acceptance Criteria

- `.github/workflows/ci.yml` runs green across `ubuntu-latest`, `macos-14`, and `windows-latest` on PRs and pushes to `main`.
- Windows headless E2E verifies both native CMake `LynxView` and Lynxtron sync end-to-end (including `ps_buckets > 0` / row convergence and clean shutdown).

## Verification

- Open PR with CI changes and verify all three OS matrix jobs pass in GitHub Actions.
