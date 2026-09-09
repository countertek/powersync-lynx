# Native Module HTTP is a sync-stream seam, not SQL RPC

Lynx Callback is one-shot and stock Lynx fetch cannot keep a live `/sync/stream` NDJSON connection open on PrimJS. iOS and Android Autolink therefore expose `httpFetch` / `httpFetchAbort` on the same lookup name as SQL RPC (`NativePowerSyncModule`) so hosts do not register a second module. That is packaging, not the interface: SQL stays `open` / `close` / `execute` / `executeBatch` (ADR-0001); sync HTTP is a separate sub-interface (`NativeSyncHttp`) whose one-shot callback returns headers plus a `streamingId`, then UTF-8 `onData*` → `onError?` → `onEnd` on GlobalEventEmitter. Idle-complete (2.5 s quiet window, UTF-8 `body` / `bodyBase64` envelope) is only the fallback when no event sender is registered. iOS hosts inject the sender (`+[NativePowerSyncModule setSharedStreamEventSender:]` or Autolink `initWithParam:`); the library does not walk `UIWindow`s. Desktop N-API stays SQL-only; Lynx-for-Web and desktop use identifier `fetch`. Do not treat Native Module HTTP as `DBAdapter` or as the Host helper. Android `LynxFetchModule` is a separate JSON adapter and never streams ([ADR 0004](0004-lynx-fetch-module-is-json-only.md)).

Shared NDJSON fixtures for the `streamingId` path and idle-complete envelope live in [`shared/fixtures/sync-stream.json`](../../shared/fixtures/sync-stream.json). JS (`pnpm test`), Linux `make test`, `make test-ios`, and Android instrumentation replay that one catalog (issue #21).

## Stream-session contract (N3)

Android and iOS `NativeSyncHttp` share one decision state machine in [`shared/sync_http_session.h`](../../shared/sync_http_session.h). Host I/O (`StreamingHttp` / `IdleCompleteHttp`) feeds `on_headers` / `on_data` / `on_end` / `on_error` / `abort`; the header returns effect bits (headers Callback, pre-headers fail Callback, `onData` / `onError` / `onEnd`, cancel I/O, drop). Desktop N-API must not include this file.

Pre-headers failure Callback (parse error, connect/RST before a status line, abort before headers): `{ok:false,status:-1,statusText:"",message,body,idleComplete:false}`. JS still rejects on `ok === false` + `message`. After headers, abort and stream errors emit `onError` then `onEnd` and do not invoke the one-shot Callback again.

`httpFetchAbort` always Callbacks `{ok:true}`. It marks the session aborted and cancels I/O; the I/O `on_error` (or `on_end`) step emits the terminal. The abort caller does not emit events itself.

### Intentional remaining host differences

- HTTP stacks stay platform-native: Android `HttpURLConnection`, iOS `NSURLSession`.
- Event sender: Android `LynxContext.sendGlobalEvent` when the module was constructed with a `LynxContext`; iOS host-injected sender (`initWithEventSender:` / `+setSharedStreamEventSender:`).
- Streaming success `statusText` may be empty on iOS; Android uses the HTTP reason phrase. JS does not require it.
- iOS idle-complete *error* envelopes may also include empty `bodyBase64` / `contentType` (superset of the shared fail keys).
- Idle-complete timers stay host-local (`SocketTimeoutException` vs dispatch source). UTF-8 hold is N2 (`utf8_hold.h`); timeouts are N1 (`sync_http_policy.h`).
