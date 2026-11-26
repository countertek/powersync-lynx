# Native Module HTTP is a sync-stream seam, not SQL RPC

Lynx Callback is one-shot and stock Lynx fetch cannot keep a live `/sync/stream` NDJSON connection open on PrimJS. iOS, Android, and Desktop (`macos/arm64`, `windows/x64`) therefore expose `httpFetch` / `httpFetchAbort` on the same lookup name as SQL RPC (`NativePowerSyncModule`) so hosts do not register a second module. That is packaging, not the interface: SQL stays `open` / `close` / `execute` / `executeBatch` (ADR-0001); sync HTTP is a separate sub-interface (`NativeSyncHttp`) whose one-shot callback returns headers plus a `streamingId`, then UTF-8 `onData*` → `onError?` → `onEnd` on GlobalEventEmitter. Idle-complete (2.5 s quiet window, UTF-8 `body` / `bodyBase64` envelope) is only the fallback when no event sender is registered (and the buffered path for non-`/sync/stream` requests). iOS hosts inject the sender (`+[NativePowerSyncModule setSharedStreamEventSender:]` or Autolink `initWithParam:`); the library does not walk `UIWindow`s. Desktop N-API resolves PrimJS `GlobalEventEmitter` directly from `Napi::Env` (`lynx.getJSModule("GlobalEventEmitter")` / `lynx.GlobalEventEmitter`) into a `Napi::ThreadSafeFunction`, requiring zero host wiring on both Lynxtron and native CMake `LynxView` (with an optional C host override `SetNativePowerSyncStreamEventSender`). Lynx-for-Web stays SQL-only and uses browser `fetch`. Do not treat Native Module HTTP as `DBAdapter` or as the Host helper. Android `LynxFetchModule` is a separate JSON adapter and never streams ([ADR 0004](0004-lynx-fetch-module-is-json-only.md)).

> **0.3.0 Amendment (Gate #73 / [ADR 0005](0005-desktop-first-class-native-and-lynxtron.md)):** The original desktop SQL-only lock was lifted after empirical testing on both native CMake `LynxView` 4.2.0 (`LynxHttpService` is buffered-only with no incremental chunk callback or cancel hook) and Lynxtron 0.0.31 (`NativeModules.LynxFetchModule.fetch` hangs without settling JS callbacks on macOS arm64 and `AbortSignal` does not close the native socket). Desktop `NativePowerSyncModule` (`shared/nativeModule/`) now implements `httpFetch` / `httpFetchAbort` using `NSURLSession` on macOS and `WinHTTP` on Windows, sharing `shared/sync_http_session.h`, `shared/utf8_hold.h`, and `shared/sync_http_policy.h`.

Shared NDJSON fixtures for the `streamingId` path and idle-complete envelope live in [`shared/fixtures/sync-stream.json`](../../shared/fixtures/sync-stream.json). JS (`pnpm test`), Linux/macOS `make test`, `make test-ios`, and Android instrumentation replay that one catalog (issue #21).

## Stream-session contract (N3)

Android, iOS, and Desktop (`shared/nativeModule/desktop_sync_http.cc`) `NativeSyncHttp` share one decision state machine in [`shared/sync_http_session.h`](../../shared/sync_http_session.h). Host I/O (`StreamingHttp` / `IdleCompleteHttp` / desktop `NSURLSession` & `WinHTTP` backends) feeds `on_headers` / `on_data` / `on_end` / `on_error` / `abort`; the header returns effect bits (headers Callback, pre-headers fail Callback, `onData` / `onError` / `onEnd`, cancel I/O, drop).

Pre-headers failure Callback (parse error, connect/RST before a status line, abort before headers): `{ok:false,status:-1,statusText:"",message,body,idleComplete:false}`. JS still rejects on `ok === false` + `message`. After headers, abort and stream errors emit `onError` then `onEnd` and do not invoke the one-shot Callback again.

`httpFetchAbort` always Callbacks `{ok:true}`. It marks the session aborted and cancels I/O; the I/O `on_error` (or `on_end`) step emits the terminal. The abort caller does not emit events itself.

### Residual: JS cannot cancel native I/O before the headers Callback

Native assigns `streamingId` when `httpFetch` starts and can cancel I/O before headers if `httpFetchAbort(streamingId)` is invoked. JS only learns that id from the one-shot Callback (headers or pre-headers fail). The abort handle is therefore callback-only on the JS side.

Abort after `httpFetch` dispatch:

1. Rejects the JS `httpFetch` Promise immediately (`Aborted` / `AbortError`).
2. Removes the abort listener once the Promise settles.
3. Calls `httpFetchAbort` if a late Callback later delivers `streamingId`, and does not resolve a stream.

Until that Callback (or if it never fires), native I/O may continue. Promise rejection is not full cancellation. Closing the gap is a native handle-before-headers change, not this JS settlement.

### Intentional remaining host differences

- HTTP stacks stay platform-native: Android `HttpURLConnection`, iOS/macOS `NSURLSession`, Windows `WinHTTP`.
- Event sender: Android `LynxContext.sendGlobalEvent` when the module was constructed with a `LynxContext`; iOS host-injected sender (`initWithEventSender:` / `+setSharedStreamEventSender:`); Desktop `Napi::Env` lookup of PrimJS `GlobalEventEmitter` via `Napi::ThreadSafeFunction` (with optional `SetNativePowerSyncStreamEventSender` C override).
- Streaming success `statusText` may be empty on iOS; Android and Desktop use the HTTP reason phrase. JS does not require it.
- iOS/Desktop idle-complete *error* envelopes may also include empty `bodyBase64` / `contentType` (superset of the shared fail keys).
- Idle-complete timers stay host-local (`SocketTimeoutException` vs dispatch source vs WinHTTP receive timeout). UTF-8 hold is N2 (`utf8_hold.h`); timeouts are N1 (`sync_http_policy.h`).
