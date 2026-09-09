# FM-PS-LYNX-010 — architecture pass on post-#32 main

Survey of `main` at `442ec6fda09f` (merge of #32) with the `/improve-codebase-architecture` skill: Ousterhout depth vocabulary (**module**, **interface**, **depth**, **seam**, **adapter**, **leverage**, **locality**), `CONTEXT.md` domain names, ADR-0001/0002/0003 not re-litigated. Analysis only; no refactors in this PR.

Gate on this tree (Node 22.22, pnpm 12.3.4): `pnpm test` 92/92, `pnpm typecheck` clean, `pnpm lint` 0/0, Linux `make test` passes (ps_sql + shared NDJSON fixtures + JNI `-c`). `make test-ios` / Android instrumentation not run (need a Mac).

## Hot spots (git log since 2026-09-08)

`src/sync/LynxRemote.ts` (17 touches), `test/lynx-remote-stream.test.ts` (15), `ios/src/NativePowerSyncModule.mm`, `android/.../NativePowerSyncModule.java`, `src/adapter/native.ts`, `src/globals.ts`. The `/sync/stream` path is where change concentrates; the survey weights it accordingly.

## What #23–#32 fixed (checked against the tree, not the PR text)

| Prior item | State on main | Evidence |
| --- | --- | --- |
| **H** verification gate | Landed | `.github/workflows/ci.yml`, `engines >=22.18`, `consumer-rules.pro` |
| **E** one `LynxHost` | Landed, deep | `src/host.ts` 6-method interface; `PrimJSLynxHost` + `test/fake-lynx-host.ts` = two adapters, real seam |
| **A** `SyncStreamTransport` | Landed | `src/sync/transport/SyncStreamTransport.ts`; `LynxRemote.fetch` is a 12-line pick; FM-PS-LYNX-003 diagnostic gone |
| **B** NativeSyncHttp split | Landed | Android `NativeSyncHttp.java`, iOS `NativeSyncHttp.mm`; SQL RPC unchanged (ADR-0001) |
| **C** one idle-complete envelope | Landed | `shared/sync_http_policy.h`; `NativeHttpFetchEnvelope` (`body` / `bodyBase64` / `idleComplete`) |
| **F** shared NDJSON fixtures | Landed | `shared/fixtures/sync-stream.json` replayed by JS, Linux, iOS, Android tests |
| **D** Android SQL on `ps_sql` | Landed | `PsSqlEngine.java` → `ps_sql_jni.cc` → `shared/ps_sql.cc`; no `androidx.sqlite-bundled` |
| **G** iOS host-provided sender | Landed | `NativePowerSyncModule+StreamEvents.h`; `make test` greps that the `UIWindow` walk is gone |

Every lettered item from the prior pass is on main. The remaining findings below are a fresh backlog, not leftovers.

## Healthy deep modules (leave alone)

- **Host helper** `src/web-host/page-rpc.ts` — one interface (`handleNativeCall(name, data, attachOptions, loadWeb)`); lease-held `BEGIN`/`COMMIT` emulation, file refcounts, update-hooks stash/merge all hidden; 26 tests cross that interface (`test/web-host.test.ts`). Module-level `files`/`connections` registry is intentional (one file shared across `<lynx-view>`s, spec §multi-tab).
- **LynxHost** (`src/host.ts`) — PrimJS lookup order hidden behind six methods; fake adapter used by every transport test.
- **SyncStreamTransport seam placement** — `SyncStreamRequest` in, `Response` out, fits `AbstractRemote.fetch`. The seam is right; what sits *behind* it is the problem (T1).
- **Adapter** `LynxDBAdapter` / `LynxConnection` — port of the official RN/web adapter shape; tested through the Native Module fake.
- **shared `ps_sql`** — one SQL engine for iOS, desktop N-API and (post-D) Android JNI.

---

## Candidates

### T1 — Sync-stream `Response` assembly sits beside the transport seam, not behind each adapter

**Strength: Strong**

**Files:** `src/sync/transport/NativeHttpFetch.ts` (118), `LynxFetchModule.ts` (77), `HostFetch.ts` (42), `response.ts` (322), `events.ts` (300), `bytes.ts` (337), `src/sync/LynxRemote.ts`.

**Problem.** The three `SyncStreamTransport` adapters are shallow: each builds a payload, fires the host call, then hands a bag to `response.ts`, which chooses the body reader from a five-flag mini-protocol (`WireFetchSuccess.streamingId` / `idleComplete` / `body` / `bodyBase64` plus the `streamingFallback` boolean). That protocol is an interface *between* files inside the same package, and callers must also know an ordering invariant: `enterEarlyCapture()` has to run before native emits the first `onData`. Today it is called in both `LynxRemote.fetch` (line 41) and `fetchViaNativeHttp` (line 58) — belt-and-braces because no single module owns the invariant. Understanding "how does one `/sync/stream` chunk reach PowerSync's line splitter" is a four-file hop: `NativeHttpFetch` → `response.ts` (`fromNativeHttpEnvelope`, `LynxFetchResponse` ctor) → `events.ts` (`streamingReader` → `createStreamingReader` → `hookEmitter` / `ensureSlot` / `drainEarly`) → `bytes.ts` (`toUint8`). `HostFetch` still sniffs `Response.lynxExtension.streamingId` and can fall into `eventStreamingResponse` — LynxFetchModule knowledge inside the host-fetch adapter.

**Deletion test.** Delete `response.ts`: the reader choice reappears three times, once per adapter — so a shared body-reader module earns its keep. Delete the *flags* and the `enterEarlyCapture` call in `LynxRemote`: nothing reappears. The shared part should be internal; the decision part belongs to each adapter.

**Solution.** Each adapter returns a finished `Response`. One internal `syncStreamResponse` takes exactly two shapes — `{ status, headers, bytes }` (buffered / idle-complete / JSON) or `{ status, headers, streamingId }` (GlobalEventEmitter) — no `streamingFallback`, no `idleComplete` flag on the wire type. `NativeHttpFetch` owns `enterEarlyCapture` (it is the only adapter that needs early capture); `LynxRemote` stops calling it. `HostFetch` never looks at `lynxExtension`. `response.ts`'s public surface shrinks from 8 exports to ~3.

**Benefits.** Locality: a `streamingId` regression is fixed in one adapter, not in `response.ts` + the adapter that fed it. Leverage: the interface stays `SyncStreamTransport.fetch(request)`, which is already how `test/lynx-remote-stream.test.ts` (27 tests) and `test/sync-stream-transport.test.ts` cross the seam — those tests survive unchanged. The three transport files would also be lintable again (see V1).

```
Before                                             After
┌──────────┐ ┌────────────┐ ┌─────────┐            ┌──────────────┐ ┌──────────────┐ ┌──────────┐
│NativeHttp│ │LynxFetchMod│ │HostFetch│  shallow   │ native-http  │ │lynx-fetch-mod│ │host-fetch│
└────┬─────┘ └─────┬──────┘ └────┬────┘            │ + early cap. │ │ (JSON)       │ │          │
     └──── 5-flag WireFetchSuccess ───┐             │ + streamingId│ │              │ │          │
                 ┌────────────────────▼───┐         └──────┬───────┘ └──────┬───────┘ └────┬─────┘
                 │ response.ts (8 exports)│                └── syncStreamResponse({bytes}|{streamingId})
                 │ events.ts  (early cap.)│                                  │ (internal, 2 shapes)
                 │ bytes.ts   (toUint8)   │                                  ▼
                 └────────────────────────┘                             Response
```

### T2 — LynxFetchModule *streaming* fallback: a seam with no reachable second adapter

**Strength: Worth exploring** (Strong on the deletion if the reachability argument below holds; decision should be grilled, then recorded as an ADR)

**Files:** `src/sync/transport/LynxFetchModule.ts`, `events.ts` (`NATIVE_STREAM_PREFIX`, `NATIVE_STREAM_SLOTS = 64`, `preSlotNativeStreams`, `hookEventsMap` — monkeypatching the emitter's private `_events.get` — `foreignListeners`, `streamingReaderFallback`), `response.ts` (`streamingFallback`, `eventStreamingResponse` no-id branch), ~9 of 27 tests in `test/lynx-remote-stream.test.ts`.

**Problem.** `pickSyncStreamTransport` order is: streaming + `httpFetch` present → `native-http`; else Android + `LynxFetchModule` → `lynx-fetch-module`; else `host-fetch`. After B+C every Autolink `NativePowerSyncModule` on Android carries `httpFetch`, so `lynx-fetch-module` can only win a *streaming* request when the SQL Native Module is absent — and then the Client cannot open a database at all. The nameless 64-slot `LynxFetchModuleStreamingEventN` pre-slotting, the `_events` hook and `streamingReaderFallback` exist for a path no supported configuration reaches. Evidence of accretion: `liveStreamNames` (`events.ts:12`) is consulted but never populated. LynxFetchModule *is* still the Android path for non-streaming JSON GETs (write-checkpoint; the gzip-as-binary-string tests), so the adapter itself is live.

**Deletion test.** Delete the streaming half of the LynxFetchModule adapter: the 64-slot pre-slotting, `_events.get` hook, `streamingFallback`, and `eventStreamingResponse(response)` without id vanish, and nothing reappears elsewhere. Delete the whole adapter: Android JSON quirk-handling reappears in `host-fetch` — so keep it, as a JSON-only adapter.

**Solution.** Decide (grilling): "LynxFetchModule is the Android JSON adapter; it never streams." Then `streamingExtension()` and `enableFetchAPIStandardStreaming` go, `pickSyncStreamTransport` no longer offers `lynx-fetch-module` for `expectStreamingResponse`, `events.ts` shrinks to the `streamingId`-keyed reader, and the ~9 LynxFetchModule-streaming tests are retired. Record as ADR-0004 so future passes do not re-suggest either direction. Neither contradicts ADR-0003 (which already says stock Lynx fetch is not the live NDJSON path).

**Benefits.** Locality: `events.ts` becomes one concept (streamingId → reader) instead of three (named streams, nameless slots, foreign listener replay). Leverage: less interface for the next agent to learn before touching `/sync/stream`.

### T3 — `callNative` string dispatch in the Adapter

**Strength: Worth exploring** (small)

**Files:** `src/adapter/native.ts` (`callNative` overloads, lines 138–177), `src/adapter/LynxConnection.ts`, `LynxDBAdapter.openConnection`.

**Problem.** `callNative(method, first?, sql?, params?)` is four overloads over one `switch` with four `SAFETY` casts that re-derive what the overload already knew. Its interface is as wide as the four Native Module methods it wraps — a pass-through.

**Deletion test.** Replace with a `NativeSql` value built once (`{ open, close, execute, executeBatch }`, each a promise-returning function over `withNativeCallback`). The casts vanish; nothing moves. `test/adapter.test.ts` keeps faking the Native Module (its seam is one level down), so tests survive.

**Benefits.** Small locality win, removes four `SAFETY` comments the anti-slop lint exists to discourage.

### T4 — Sync-protocol policy hidden inside a header helper

**Strength: Speculative** (small)

**Files:** `src/sync/transport/bytes.ts` `headerMap` → `preferNdjsonAccept` (lines 284–321), `SyncStreamTransport.syncStreamRequestFromFetch`.

**Problem.** `headerMap()` rewrites `Accept: …bson-stream…` to `application/x-ndjson` and injects `Accept-Encoding: identity`. That is a sync-protocol decision (NDJSON only, no BSON, no gzip — because Lynx drops `Content-Type` and OkHttp may hand JS compressed bytes), but it is invisible from `SyncStreamRequest`, the one place a caller looks. Move it into `syncStreamRequestFromFetch` as a named step so the invariant lives at the seam.

### Noted, not proposed

- `PrimJSLynxHost` repeats the globalThis → bare-identifier → eval lookup per binding. Implementation-only (the interface is already deep) and the literal bare-identifier reads are load-bearing for the Lynx bundler. Leave it.
- Host helper `transactionControl` SQL sniffing (`BEGIN`/`COMMIT`/`ROLLBACK`) is Adapter knowledge inside the Host helper, but it is required by ADR-0002 (SQL RPC has no lock methods). Documented, tested, leave it.
- `installAbortControllerPolyfill()` runs at import in two modules (`abort-controller.ts:89`, `host.ts:34`). Idempotent; cosmetic.

## Verification observations (V)

- **V1** `oxlint.config.ts` ignores exactly `src/sync/transport/{bytes,events,response}.ts` — the deepest transport code is the only un-linted Client code. T1/T2 shrink those files enough to drop the ignore.
- **V2** `test/install-graph.test.ts` and `test/pack-contents.test.ts` shell out to `pnpm`; they fail under a broken corepack shim and pass under the repo toolchain. Environment-coupled, not architecture; fine in CI.
- **V3** `make test` enforces ADR-0003's "no `UIWindow` walk" by `grep` on `NativeSyncHttp.mm`. It works; the iOS fixture test (`ios_sync_http_fixture_test.mm`) is the seam-level check and needs a Mac.
- **V4** `shared/sync_http_policy.h` comments "Keep Android IdleCompleteHttp.java / StreamingHttp.java constants in lockstep" — Java copies the policy constants by hand (see N-section).

<!-- NATIVE_SECTION -->

## Top recommendation

**T1 first.** It is where the hot spots are (`LynxRemote`, the stream tests), it turns three shallow adapters into three deep ones without moving the seam A already placed, it removes the duplicated `enterEarlyCapture` ordering invariant, and it lets the transport directory back under lint (V1). T2 should be grilled immediately after (or alongside) because deleting the nameless-slot fallback is what lets `events.ts` collapse to one concept; T1 without T2 still leaves the 64-slot machinery behind the host-fetch adapter's fallback branch.
