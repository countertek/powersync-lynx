# LynxFetchModule is JSON-only; it never streams

Stock Lynx `LynxFetchModule` is the Android JSON HTTP adapter (write-checkpoint, gzip-as-binary-string). It is not a `/sync/stream` transport.

`pickSyncStreamTransport` only selected `lynx-fetch-module` for `expectStreamingResponse` when `NativePowerSyncModule.httpFetch` was absent. On Android Autolink, `httpFetch` lives on the same `NativePowerSyncModule` class as SQL RPC (`open` / `close` / `execute` / `executeBatch`). Opening a database throws if that module is not registered. A host that can open a DB therefore always has `httpFetch`, so the picker takes `native-http` and never reaches LynxFetchModule for streaming.

The leftover path was nameless GlobalEventEmitter slots (`LynxFetchModuleStreamingEvent` + AtomicLong, `streamingFallback`, `enableFetchAPIStandardStreaming` on the module request). Stock LynxFetchModule cannot keep a live NDJSON connection open on PrimJS (empty body / `streamingId: null` while JS waited on those slots). Host READMEs already record that; this ADR deletes the JS machinery rather than keeping an unreachable fallback.

Streaming download stays Native Module HTTP (`streamingId` + `onData*` → `onError?` → `onEnd`, idle-complete when no event sender) or identifier `fetch` (Lynx-for-Web / desktop). LynxFetchModule remains the live Android JSON adapter: `pickSyncStreamTransport` uses it only when `expectStreamingResponse` is false.
