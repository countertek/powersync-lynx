# 06: Desktop `/sync/stream` verification gate & conditional Native Module HTTP (`httpFetch`)

Type: task
Status: ready-for-agent
Blocked by: 04, 05
Spec: ../spec.md (#68)
GitHub: #73

## Scope

Decision and implementation gate for desktop `/sync/stream` live NDJSON streaming and `AbortSignal` cancellation, based on empirical results from Tickets `04` (Lynxtron) and `05` (native macOS & Windows CMake `LynxView`).

### Evaluation Criteria

Stock desktop `fetch` / `LynxHttpService` passes **only** if all four desktop targets (`macos/arm64` native, `macos/arm64` Lynxtron, `windows/x64` native, `windows/x64` Lynxtron) satisfy:
1. Live `/sync/stream` stays open after initial checkpoint (`ps_buckets > 0`) and delivers incremental NDJSON updates from another client promptly (no buffering hang / read-timeout failure).
2. `AbortSignal` (`db.disconnect()` / `Go offline` → `Reconnect`) cleanly aborts the underlying HTTP stream and allows immediate reconnect without wedged sockets or leaked streams.
3. Multi-byte UTF-8 boundaries split across chunks decode without corruption.

### Branch A — Stock desktop `fetch` passes on all 4 combinations

- Keep Desktop Native Module SQL-only (preserve ADR-0003 and `shared/tests/sync_http_session_test.cc` desktop guard).
- Record verification evidence in `docs/spec.md` and host READMEs.
- Ensure `HostFetch.ts` handles any desktop-specific response/abort nuances discovered during testing, with unit tests in `test/`.

### Branch B — Stock desktop `fetch` or `LynxHttpService` fails streaming or abort on any target

- Reopen ADR-0003 (add amendment or ADR-0006) and update `docs/spec.md` + `shared/tests/sync_http_session_test.cc` to allow Desktop Native Module HTTP.
- Implement `httpFetch` / `httpFetchAbort` in `shared/nativeModule/` backed by `NSURLSession` on macOS and `WinHTTP` on Windows, sharing `shared/sync_http_session.h` and `shared/utf8_hold.h` (matching iOS/Android `onData*` → `onError?` → `onEnd` + `GlobalEventEmitter` contract).
- Replay `shared/fixtures/sync-stream.json` against both macOS and Windows desktop `NativeSyncHttp` implementations in C++ tests.

## Acceptance Criteria

- All four OS × host combinations deliver incremental live NDJSON sync updates and cancel/reconnect cleanly.
- `docs/spec.md` and `docs/adr/` accurately reflect whichever branch was taken.
- All unit and fixture tests (`pnpm test`, `make test`, plus macOS/Windows native tests) pass.

## Verification

- Two-client live sync test (add/toggle/delete on web → appears promptly on desktop while stream stays open; `Go offline` → mutate → `Reconnect` → converges).
- `pnpm test && make test` (plus platform HTTP fixture tests if Branch B is taken).
