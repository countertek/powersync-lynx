# 03: Default OS app-data `dbLocation` and Windows UTF-8 path safety

Type: task
Status: ready-for-agent
Blocked by: 02
Spec: ../spec.md (#68)
GitHub: #70

## Scope

Ensure omitting `dbLocation` on macOS and Windows stores SQLite files in an OS-standard writable app-data directory rather than CWD, and make Windows filesystem paths UTF-8 safe.

### Changes

1. **Default `dbLocation` resolution (`shared/nativeModule/NativePowerSyncModule.cc` and/or `shared/ps_sql.cc`)**:
   - When `dbLocation` is omitted and `dbFilename` is relative (not `:memory:`, not `file:...`, not an absolute path):
     - **macOS**: resolve `~/Library/Application Support/<app>/`, deriving `<app>` from `CFBundleIdentifier` (via CoreFoundation when running in a `.app` bundle), else current executable name, else `"powersync-lynx"`.
     - **Windows**: resolve `%LOCALAPPDATA%\<app>\` via `SHGetKnownFolderPath(FOLDERID_LocalAppData, ...)`, deriving `<app>` from the current executable stem, else `"powersync-lynx"`.
   - Recursively create the default directory if it does not yet exist; return a structured `{ ok: false, message }` envelope on failure.
   - Preserve existing behavior for explicit `dbLocation` (must already exist and be a directory), absolute paths, `:memory:`, and `file:` URIs.
2. **Windows UTF-8 / wide-char path safety (`shared/ps_sql.cc`, `shared/nativeModule/NativePowerSyncModule.cc`)**:
   - Replace `GetModuleFileNameA` with `GetModuleFileNameW` + UTF-16 → UTF-8 conversion (no `MAX_PATH` truncation).
   - Replace `_stat` in `is_directory()` with `_wstat` on UTF-8 → UTF-16 converted paths.
   - Use `CreateDirectoryW` for recursive directory creation on Windows.
3. **Unit tests (`shared/tests/ps_sql_test.cc`)**:
   - Test default directory resolution & auto-creation when `dbLocation` is omitted.
   - Test non-ASCII UTF-8 directory and database filenames.
   - Test `:memory:`, `file:` URI, absolute path, and explicit `dbLocation` (existing vs missing) remain intact.

## Acceptance Criteria

- Opening `{ dbFilename: "app.db" }` without `dbLocation` writes to `~/Library/Application Support/<app>/app.db` on macOS and `%LOCALAPPDATA%\<app>\app.db` on Windows, creating the folder automatically.
- Non-ASCII paths (e.g. Japanese / accented user directories) open and load `powersync-sqlite-core` without error on both macOS and Windows.
- Explicit `dbLocation`, `:memory:`, `file:`, and absolute paths match existing behavior.
- C++ unit tests pass on Linux/macOS/Windows.

## Verification

- `make test`
- `pnpm test`
- Windows MSVC build and run of `ps_sql_test`.
