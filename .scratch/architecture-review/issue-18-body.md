# Architecture improvement list (post-realtime merge)

Status: ready-for-human
Type: task
Source: FM-PS-LYNX-007 `/improve-codebase-architecture` survey of `main` @ b19c2f5 (Claude Fable 5.1, 2026-09-09).
Vocabulary: **module / interface / seam / adapter / depth / locality / leverage** from the codebase-design skill; domain nouns from `CONTEXT.md` (Client, PowerSyncDatabase, Adapter, Native Module, Host helper, Connector).

Related issues, linked not restated: #19 (UX: `hasSynced` is not download proof), #20 (DX: `waitForReady` vs first-sync helpers), #21 (hardening: keep the `streamingId` realtime path).

## State of main

- `pnpm test` 75/75 (needs Node >= 22.18; the default 22.14 cannot load `.ts` tests or `oxlint.config.ts`).
- `pnpm typecheck` 44 errors, 42 in `test/lynx-remote-stream.test.ts` (connector stubs missing `uploadData`; hand-built objects cast to `Response` / `NativeModulesHost`).
- `pnpm lint` 2 errors (`src/adapter/native.ts:85`, `src/globals.ts:12`).
- No CI workflow; `android/consumer-rules.pro` is empty.
- Hot spots (last 80 commits): `src/sync/LynxRemote.ts` x18, `test/lynx-remote-stream.test.ts` x13, `ios/src/NativePowerSyncModule.mm` x9, `src/web-host/page-rpc.ts` x7, Android `NativePowerSyncModule.java` x6.

## Actionable list

### H. Verification gate (prerequisite, not a refactor)

- Pin the Node floor (`engines`, `.nvmrc`) at >= 22.18.
- Make `pnpm typecheck` and `pnpm lint` green on main (most test casts disappear with E below).
- Publish real `consumer-rules.pro` for the Autolink provider and module class.
- CI: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `make test`.

### E. One Lynx host-globals module — Worth exploring

Files: `src/globals.ts`, `test/globals.ts`, `src/abort-controller.ts` (side-effect import in 4 files), `native.ts nativeModulesHost()`, `LynxRemote.ts lookupNativePowerSyncModule() / lynxFetchModule() / isLynxAndroid() / lynxHost() / textCodecHelper()`.

Problem: six independent "find the PrimJS global" ladders (globalThis -> bare binding -> `eval`), plus an AbortController polyfill whose install depends on import order. Every stream test recreates this environment through `globalThis` writes.

Shape: one `LynxHost` interface (native module lookup, global-event emitter, platform, text codec, fetch) with a PrimJS adapter and a fake adapter for tests. Two adapters justify the seam. Enabler for A.

### A. Deepen the `/sync/stream` transport module — Strong (top recommendation)

Files: `src/sync/LynxRemote.ts` (1392 lines), `src/sync/gunzip.ts`, `test/lynx-remote-stream.test.ts` (1552 lines).

Problem: one module holds four transports (`NativePowerSyncModule.httpFetch`, `LynxFetchModule.fetch`, identifier `fetch`, GlobalEventEmitter chunk capture with 64 pre-slotted `LynxFetchModuleStreamingEvent{N}` names that monkey-patch `addListener` / `emit` / `_events.get` / `lynx.getJSModule`), ten-shape byte coercion, three base64 and three UTF-8 strategies, gzip sniffing, Accept/Accept-Encoding rewriting, and a one-shot `FM-PS-LYNX-003` diagnostic (25 references, module-level mutable state, `console.log` in library code). `LynxFetchResponse`'s constructor alone picks one of four readers. The interface is effectively "the whole PrimJS environment", so tests cannot cross a seam; they rebuild the environment.

Shape: one `SyncStreamTransport` interface — `fetch(request) -> { status, headers, chunks, abort }`. Today's paths become adapters selected once at construction: NativeHttpFetch (primary; `streamingId` first, per #21), LynxFetchModule (fallback; the 64-slot capture lives only here), plain `fetch` (web/desktop). Byte/UTF-8/base64/gzip coercion and header policy move inside. `LynxRemote` shrinks to `createTextDecoder` plus delegation. Delete the FM-PS-LYNX-003 block; surface "which path served the stream" through the PowerSync logger / `SyncStatus` instead of `console.log` — this is also the hook #19 needs for a real download signal.

Tests: an in-memory adapter replays NDJSON fixtures (see F); no `globalThis` mutation, no `as Response`.

### B. Split sync HTTP out of the Native Module SQL RPC seam — Strong

Files: `android/.../NativePowerSyncModule.java` (`httpFetch`, `httpFetchAbort`, `sendStreamEvent`), `ios/src/NativePowerSyncModule.mm`, `shared/nativeModule/NativePowerSyncModule.cc` (no `httpFetch`), `src/adapter/native.ts` vs `LynxRemote.ts` (two type declarations, two lookups), `docs/spec.md` "Sync transport", `docs/adr/0001`.

Problem: `/sync/stream` HTTP was layered onto the SQL RPC module during the realtime work. The Native Module interface now includes stream ids, idle flags, event names and abort; it differs per host (desktop has none); `docs/spec.md` still says "There is no Native Module HTTP"; no ADR records the decision. Terminal events differ: Android emits `onError` alone on stream failure but `onError` + `onEnd` on a thrown exception; iOS always emits `onError` then `onEnd`.

Shape: two deep modules. Native Module stays `open / close / execute / executeBatch` (ADR-0001). A named sync HTTP transport module (own lookup string, or a clearly separated sub-interface) exposes `start(request) -> { status, headers, streamId }` and `abort(streamId)`, with one terminal sequence (`onData* -> onError? -> onEnd`) implemented identically on Android and iOS. One TypeScript declaration and one lookup. Desktop either gains the adapter or is declared "fetch adapter only". Record as ADR-0003; correct the spec's transport table.

ADR note: touches ADR-0001's stated scope. Worth reopening because the module already ships HTTP; the ADR must either narrow the name to SQL only (this proposal) or be superseded.

### C. One idle-complete policy, one wire encoding — Strong

Files: `android/.../IdleCompleteHttp.java`, `ios/src/IdleCompleteHttp.mm`, `examples/hosts/android/.../ShowcaseLynxHttpService.java`, `LynxRemote.ts` (`lynxExtension.powersyncIdleComplete / powersyncIdleBodyBase64` vs envelope `idleComplete / body / bodyBase64`).

Problem: sync-stream URL detection, the 2.5 s idle window, long-lived heuristics and the 120 s keepalive are copied three times natively (plus the showcase); iOS accepts `idleCompleteMs` / `timeoutMs` and defaults `Content-Type`, Android does neither. JS then converts the Native Module envelope into the LynxFetchModule `lynxExtension` shape before decoding it. Library comments name the showcase class.

Shape: idle-complete is one fallback adapter behind B's interface (hosts without a global-event sender). One policy per host with shared constants and request schema; one JS envelope; the showcase HTTP service serves Connector/JSON traffic only or is deleted, and the library never references it.

### D. Android SQL RPC onto the shared `ps_sql` engine — Strong

Files: `android/.../NativePowerSyncModule.java` 303-634, `shared/ps_sql.h/.cc`, `ios/src/NativePowerSyncModule.mm` 89-147, `shared/nativeModule/NativePowerSyncModule.cc` 235-252.

Problem: Android reimplements bind / step / envelope / tagged bigint / MAX_SAFE on `BundledSQLiteDriver` while iOS and desktop are thin binders over `ps_sql::Engine`; three dialects drift.

Shape: Android becomes a JNI type-mapping binder over `ps_sql`. Deletion test: complexity concentrates. Risk: NDK build and `powersync-sqlite-core` load path on Android; keep as its own effort after B/C.

### F. Shared NDJSON stream fixtures across JS, iOS, Android — Worth exploring

Files: `Makefile` 59-91 (`test-ios` compiles `IdleCompleteHttp.mm` but not `StreamingHttp.mm`), `android/host` instrumentation (never calls `httpFetch`), `ios/tests/ios_module_rpc_test.mm`, `test/lynx-remote-stream.test.ts`.

Problem: the realtime path is device-verified only; the Android/iOS terminal-event asymmetry shipped because nothing compares hosts.

Shape: fixture files (checkpoint -> data -> keepalive -> idle; error mid-stream; abort; gzip body; split UTF-8) replayed by each adapter of B against a local socket, plus the JS in-memory adapter. This is the executable acceptance criterion for #21.

### G. Host-provided event sender on iOS — Worth exploring

Files: `ios/src/NativePowerSyncModule.mm` 266-294 (`resolveStreamEventSender` walks `UIWindow`s for a `LynxView`), `NativePowerSyncModule+StreamEvents.h`, `examples/hosts/ios` `ViewController.m`.

Problem: the library reaches into UIKit and the showcase must also call `setSharedStreamEventSender:`; Android gets the same from `LynxContext` with no glue.

Shape: require one sender at module init, delete the window walk, document the host obligation once in `examples/hosts/ios/README.md`.

## Left as-is

- Host helper `src/web-host/page-rpc.ts`: lease/transaction state machine behind `handleNativeCall`; tests cross the same seam; second real adapter of the SQL RPC seam (ADR-0002).
- Adapter `LynxDBAdapter` / `LynxConnection` / `callNative`: mirrors the official RN split (ADR-0001); the `callNative` switch is a pass-through whose deletion would move, not concentrate, complexity.
- Desktop Lynxtron N-API module: SQL-only by design; B decides whether it gains an HTTP adapter.

## Deferred / linked

- #19 and #20 are consumer-facing UX/DX; the only architecture hook is A's logger/`SyncStatus` signal.
- #21 is the acceptance criterion for A, B, C and F, not a separate architecture item.
- Lynx-for-Web streaming (`enableFetchAPIStandardStreaming` has no web equivalent): stays with the plain `fetch` adapter; revisit if a Host-helper transport is ever needed.

## Sequencing

H -> E -> A -> B + C (with ADR-0003 and `docs/spec.md` transport update) -> F alongside B/C -> D -> G.

## Risks

- PrimJS quirks baked into `LynxRemote.ts` (never gate on `typeof === "function"`, cross-realm `ArrayBuffer` tags, `.call/.apply` on host methods, one-shot `Response.body`) must be preserved as adapter behaviour with tests before any deletion.
- Renaming or splitting the Native Module touches Autolink registration, iOS `methodLookup`, and R8 keep rules on every host.
- Device-only verification today: A must land with F's JS fixtures at minimum; B/C need `make test-ios` to compile `StreamingHttp.mm`.
- ADR-0001 wording: decide narrow-vs-supersede before B starts.
