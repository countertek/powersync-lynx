# New issue — paste if Issues API 403s

**Title:** FM-PS-LYNX-010: post-#32 deepening backlog (transport adapters, LynxFetchModule streaming fallback, native sync-HTTP duplication)

**Labels:** `ready-for-human` (T2 / N3 need a grilling decision before code), `ready-for-agent` for T1, T3, N1, N2 once the order below is confirmed

---

Second `/improve-codebase-architecture` pass on `main` @ `442ec6fda09f`, after #18's A–H items all landed (#23, #32). #18 stays historical; this is the fresh backlog. Full survey with before/after diagrams and deletion-test reasoning: `.scratch/fm-ps-lynx-010/architecture-review.md`.

Vocabulary: **module / interface / depth / seam / adapter / leverage / locality** (`/codebase-design`); domain names from `CONTEXT.md`; ADR-0001/0002/0003 are constraints, not targets.

## Client (Lynx-bundle TypeScript)

### T1 — Transport adapters own their `Response` — **Strong**
`src/sync/transport/{NativeHttpFetch,LynxFetchModule,HostFetch}.ts`, `response.ts`, `events.ts`, `bytes.ts`, `LynxRemote.ts`.
The three `SyncStreamTransport` adapters are shallow; the reader choice lives in `response.ts` behind a five-flag `WireFetchSuccess` (`streamingId` / `idleComplete` / `body` / `bodyBase64` / `streamingFallback`), and `enterEarlyCapture()` is called in both `LynxRemote.fetch` and `fetchViaNativeHttp` because no module owns the ordering invariant. `HostFetch` still sniffs `lynxExtension.streamingId`.
**Do:** each adapter returns a finished `Response`; one internal `syncStreamResponse({bytes} | {streamingId})`; `NativeHttpFetch` alone owns early capture; `LynxRemote` stops calling it; `HostFetch` never reads `lynxExtension`. `response.ts` exports shrink from 8 to ~3. Existing tests cross `SyncStreamTransport.fetch` / `LynxRemote.fetch` and must pass unchanged. Then drop the three files from the `oxlint.config.ts` ignore list.

### T2 — LynxFetchModule streaming fallback: grill, then ADR-0004, then delete — **Worth exploring** (Strong on the delete if the reachability holds)
`LynxFetchModule.ts`, `events.ts` (`NATIVE_STREAM_PREFIX`, `NATIVE_STREAM_SLOTS = 64`, `preSlotNativeStreams`, `hookEventsMap`, `foreignListeners`, `streamingReaderFallback`, the never-populated `liveStreamNames`), `response.ts` (`streamingFallback`), ~9 tests in `test/lynx-remote-stream.test.ts`.
`pickSyncStreamTransport` lets `lynx-fetch-module` win a *streaming* request only when `httpFetch` is absent on Android — i.e. when no `NativePowerSyncModule` is registered and no database can open. LynxFetchModule remains the live Android **JSON** adapter (write-checkpoint, gzip-as-binary-string cases).
**Decide:** "LynxFetchModule is the Android JSON adapter; it never streams." If yes → ADR-0004, remove `streamingExtension`/`enableFetchAPIStandardStreaming`, exclude it from streaming picks, delete the nameless-slot machinery, retire the matching tests. If no → record why so the next pass does not re-suggest it.

### T3 — `callNative` → `NativeSql` — **Worth exploring**, small
`src/adapter/native.ts:138–177`, `LynxConnection.ts`, `LynxDBAdapter.openConnection`. Four overloads over one `switch` with four `SAFETY` casts. Replace with one `NativeSql` value of promise-returning functions built on `withNativeCallback`. `test/adapter.test.ts` keeps faking the Native Module.

### T4 — Name the NDJSON-only header policy at the seam — **Speculative**
`bytes.ts` `headerMap` → `preferNdjsonAccept` rewrites `Accept` and injects `Accept-Encoding: identity` invisibly. Move into `syncStreamRequestFromFetch` as a named step.

## Native Module

### N1 — Android consumes the sync-HTTP policy instead of copying it — **Strong**
`shared/sync_http_policy.h` vs `IdleCompleteHttp.java:25–29`, `StreamingHttp.java:29–31`, `NativeSyncHttp.java:30`. Java re-types `2500` / `30000` / `120000` / `"NativePowerSyncHttpStream"` "in lockstep"; nothing fails on drift.
**Do first:** a Linux `make test` check that parses both and asserts equality. **Then:** generate the Java constants from the header, or route the heuristics through the existing JNI.

### N2 — One shared incomplete-UTF-8 hold for native chunking — **Strong**
`StreamingHttp.java:147`, `StreamingHttp.mm:15`, `bytes.ts:18`. Same algorithm three times; Android's comment cites the JS copy. Add one shared C helper for iOS/Android; add a split-multibyte case to `shared/fixtures/sync-stream.json` so all three (JS copy stays for host-fetch bodies) are pinned to the same bytes.

### N3 — One stream-session contract for Android and iOS `NativeSyncHttp` — **Worth exploring**
`NativeSyncHttp.java/.mm`, `StreamingHttp.*`, `IdleCompleteHttp.*`. Two orchestrations agree on fixtures, differ at the edges: pre-headers failure envelope is `{ok:false,message}` on Android vs `{ok:false,status:-1,body,idleComplete:false,…}` on iOS; abort ownership differs; Android instrumentation has no `error-then-end` / abort case.
**Grill:** extract the decision state machine (headers-sent, idle-vs-streaming, terminal emission, abort-after-headers) as shared C++ driven by host I/O callbacks, *or* settle for one shared behavioural test list both hosts run. Keep it a sub-interface on the same lookup (ADR-0003); desktop stays SQL-only.

### N4 — Stop compiling a materialized copy of `ps_sql` on iOS — **Worth exploring**
`scripts/fetch-native-deps.mjs` `materializeIosSrcCompileInputs`, `ios/powersync-lynx.podspec`, `Makefile` `test-ios` `install_name_tool -change /Users/runner/…`. Compile `../shared` by path; discover the dylib id with `otool -D`.

## Not proposed (recorded so it is not re-suggested)

- Unifying Long / `{__psBig}` / BigInt packing across binders — contradicts ADR-0001.
- Collapsing thin forwarders (`PsSqlEngine.java`, iOS `httpFetch` forwarders, `LynxLibraryProviderImpl`, `lynxtron/library_entry.cc`) — ADR-0003 packaging / Autolink ceremony.
- Restructuring the Host helper (`page-rpc.ts`) — already deep; module-level file registry is intentional (one file across `<lynx-view>`s).

## Suggested order

1. T1 · 2. T2 grilling → ADR-0004 → delete · 3. N1 + N2 · 4. T3 · 5. N3 grilling · 6. N4, T4 when they bite.

## Verification

`pnpm test` (92), `pnpm typecheck`, `pnpm lint`, Linux `make test` all green on the surveyed tree. `make test-ios` and Android instrumentation need a Mac / emulator and were not run for this pass.

Prior pass: #18. Related: #19, #20, #21. Model: Claude Fable 5.1.
