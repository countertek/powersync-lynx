## FM-PS-LYNX-011 triage — verdict: **partially done, still needs work** (leave open; do not close on E2E alone)

Checked against `main` @ `442ec6f` (post-#32). `pnpm test` 92/92, `pnpm typecheck`, `pnpm lint`, Linux `make test` (incl. NDJSON fixture replay + loopback HTTP) all green on that tip.

### Done on `main` (A, B+C, F from #32)

**Realtime path restored and made primary**
- `streamingId` / GlobalEventEmitter is the first-choice native transport: `pickSyncStreamTransport` prefers `native-http` whenever `NativePowerSyncModule.httpFetch` is present (`src/sync/transport/SyncStreamTransport.ts`, `src/sync/transport/NativeHttpFetch.ts:110-118`; commit `a3ada7e`). Idle-complete is a fallback only when no `streamingId` is returned (`13c223f`, ADR-0003).
- Android and iOS both emit `onData*` → `onError?` → `onEnd` from a `NativeSyncHttp` sub-interface separate from SQL RPC (`13c223f`); iOS uses a host-injected event sender instead of walking `UIWindow`s (D+G).
- E2E on `main` proved live `/sync/stream` on iOS and Android.

**Automated regression (the acceptance this issue asked for)**
- Shared catalog `shared/fixtures/sync-stream.json` (`checkpoint-ops`, `error-then-end`, `idle-complete`) — commit `a413a48`.
- JS: `test/sync-stream-fixtures.test.ts` replays the catalog through `LynxRemote.fetch` on the `streamingId` path (onData before onEnd; onError then onEnd fails the reader; idle-complete envelope without `streamingId`). `test/sync-stream-transport.test.ts:19,108` pins the pick order (native-http first; skipped only when `httpFetch` is absent). `test/lynx-remote-stream.test.ts:318,391,437` cover incremental `streamingId` delivery through PowerSync's line split.
- Native: `shared/tests/sync_stream_fixtures_test.cc` (Linux, asserts the B terminal sequence and rejects the old Android onError-without-onEnd shape), `ios/tests/ios_sync_http_fixture_test.mm` (`make test-ios`), `android/host/src/androidTest/.../NativeSyncHttpFixtureTest.java` (instrumentation).
- CI (`.github/workflows/ci.yml`, from #23 `f30f585`) runs `pnpm test` + `pnpm typecheck` + `pnpm lint` + `make test` on every push/PR, so the JS and Linux halves of the regression gate are enforced.

**README**
- Root `README.md` "Native streaming caveat" (`README.md:79-87`) documents the `streamingId` one-shot callback, GlobalEventEmitter chunks, the `onData*` → `onError?` → `onEnd` sequence, idle-complete as fallback, and "rebuild showcase + host". Host guides tell users what proves the realtime path (`examples/hosts/ios/README.md:135`, `examples/hosts/android/README.md:100`: `NativePowerSyncHttpStream*` id, `onData` before `onEnd`, logger line `via native-http`). `docs/spec.md` "Sync transport" and ADR-0003 record the contract.

### Not done — keep open for these

1. **Regression coverage of the path's lifecycle is incomplete.** The FM-PS-LYNX-010 review of #32 filed Highs H1–H3 as a *separate* fix issue; they are not grounds to close this one but they are why "streams work" ≠ "regression-proof": `disconnect()` never reaches `httpFetchAbort` once headers resolved (`test/lynx-remote-stream.test.ts:386` asserts `aborted === undefined`, the opposite branch), iOS `timeoutIntervalForResource` = 150 s force-closes a healthy stream (`ios/src/StreamingHttp.mm:137-138`), `earlyEvents` retains every chunk (`src/sync/transport/events.ts`). No JS or native test pins abort, long-lived stream, or buffer release. Android instrumentation has no abort/`error-then-end` case (iOS does).
2. **`make test-ios` and Android instrumentation are not in CI** (Mac-only); the device halves of the fixture replay run only when someone runs them.
3. **README drift that this issue's README acceptance should cover:**
   - `examples/README.md:47` still says the two-window money shot is *"Not verified this checkout … `ps_data__todos` stayed 0 … `errorStreamingMalformedResponse`"* — pre-B/C text contradicted by the E2E on `main`.
   - `examples/README.md:195` presents LynxEnv `enable_fetch_api_standard_streaming` as the streaming prerequisite; post-B stock Lynx fetch is explicitly *not* the live NDJSON path (`docs/spec.md:178`).
   - `README.md:87` refers to a `raw-body` fallback label that no longer exists in `src/` (it was the deleted FM-PS-LYNX-003 diagnostic); the current fallback name is idle-complete.
   - `examples/README.md:56,151` cite `.github/workflows/publish.yml`; the workflow is `release.yml`.
   - Root README / spec registration section do not mention the new consumer build requirements introduced by D (NDK, CMake ≥ 3.22, `c++_shared`, Gradle `node` exec) — only `examples/hosts/android/README.md` does (M2 in the #32 review).

### Acceptance criteria (updated)

- [x] `streamingId` realtime path is the primary native transport and idle-complete is fallback-only (A, B+C).
- [x] Shared NDJSON fixtures replayed by JS + Linux native tests in CI (F, #23).
- [x] Root README documents the path, terminal sequence, and rebuild requirement.
- [ ] Abort / long-lived / buffer-release regressions covered once the H1–H3 fix issue lands (reference it here; close this after that PR adds the `fetchStream` + abort test and an Android abort instrumentation case).
- [ ] `examples/README.md` verification table and streaming note updated to the post-#32 state; `README.md:87` `raw-body` → idle-complete; `publish.yml` → `release.yml`.
- [ ] Root README (or spec registration) lists the Android consumer build requirements from D.

*FM-PS-LYNX-011 item A, Claude Fable 5.1 (Cursor cloud agent). Issues API returns 403 for the agent token; posted from `.scratch/fm-ps-lynx-011/`.*
