# Issue #18 comment (FM-PS-LYNX-010 reconcile) — paste if Issues API 403s

**FM-PS-LYNX-010 — second `/improve-codebase-architecture` pass, on `main` @ `442ec6fda09f` (post-#32).** Same vocabulary as the FM-PS-LYNX-007 pass (module / interface / depth / seam / adapter / leverage / locality; `CONTEXT.md` names; ADR-0001/0002/0003 not re-litigated). Full report: `.scratch/fm-ps-lynx-010/architecture-review.md`.

## What landed (verified on the tree, not the PR text)

All eight lettered items are on `main`: **H** (#23), **E, A, B, C, F, D, G** (#32). Gate on this tree: `pnpm test` 92/92, typecheck and lint clean, Linux `make test` green.

- **E** is a real seam: `LynxHost` has two adapters (`PrimJSLynxHost`, `FakeLynxHost`) and every transport test crosses it.
- **A** placed the seam correctly: `SyncStreamRequest` in, `Response` out; `LynxRemote.fetch` is a 12-line pick and the FM-PS-LYNX-003 diagnostic is gone.
- **B+C** hold: SQL RPC is untouched; `NativeSyncHttp` is a sub-interface on the same lookup; one envelope for idle-complete.
- **D** made `ps_sql` the single deep SQL module across iOS, desktop and Android.
- **F/G** are enforced: the shared NDJSON catalog is replayed on every host; `make test` greps that the `UIWindow` walk is gone.

## What the second pass finds — a fresh backlog, not leftovers

**Still Strong**

- **T1** The three `SyncStreamTransport` adapters are shallow; `Response` assembly sits *beside* the seam in `response.ts` / `events.ts` / `bytes.ts` behind a five-flag `WireFetchSuccess` protocol, and the `enterEarlyCapture()` ordering invariant is called in two places because no module owns it. Each adapter should return a finished `Response`; the shared body-reader becomes internal with two shapes (`{bytes}` | `{streamingId}`). Tests already cross `SyncStreamTransport.fetch` and survive.
- **N1** Android re-types the ADR-0003 policy (`2500` ms idle window, timeouts, `NativePowerSyncHttpStream` prefix) as Java literals "in lockstep" with `shared/sync_http_policy.h`; iOS consumes the header. Nothing fails on drift. Start with an equality check in `make test`.
- **N2** The incomplete-UTF-8 hold exists three times (`StreamingHttp.java`, `StreamingHttp.mm`, `bytes.ts`); Android's copy cites the JS one. One shared C helper for native plus a split-multibyte fixture case.

**Worth exploring**

- **T2** The LynxFetchModule *streaming* fallback (64 pre-slotted `LynxFetchModuleStreamingEventN` names, `_events.get` monkeypatch, `streamingReaderFallback`) is unreachable in any configuration that can also open a database — post-B, every Autolink Android module has `httpFetch`. `liveStreamNames` is consulted but never populated. LynxFetchModule is still the live Android *JSON* adapter. Grill "JSON-only", record ADR-0004, delete the streaming half and ~9 tests.
- **N3** Android and iOS `NativeSyncHttp` orchestrations agree on the fixtures but differ at the edges (pre-headers failure envelope shape, abort ownership; Android instrumentation lacks `error-then-end`/abort). Extract the state machine or at least one shared behavioural test list. Must remain a sub-interface (ADR-0003).
- **T3** `callNative` string dispatch (4 overloads, 4 `SAFETY` casts) → one `NativeSql` value.
- **N4** iOS compiles a materialized copy of `ps_sql`; `test-ios` links against a hard-coded Actions runner path.

**Speculative / noted** — T4 (`headerMap` hides the NDJSON-only + identity-encoding policy), `PrimJSLynxHost` internal lookup repetition (load-bearing for the bundler), thin native forwarders (ADR-0003 packaging), and: unifying Long / `{__psBig}` / BigInt across binders would contradict ADR-0001 — not proposed.

**Deferred from the prior pass** — nothing. Every A–H item shipped; the intermediate "C deferred" / "A deferred" notes in the #32 commit trail were superseded within the same stack.

## Housekeeping

- #18 is now historical (original list + A–H trail). Proposed: prepend the post-#32 status table (`.scratch/fm-ps-lynx-010/issue-18-post-32-status.md`) and close it once the FM-PS-LYNX-010 follow-up issue exists (`.scratch/fm-ps-lynx-010/follow-up-issue.md`).
- Related: #21 (streamingId hardening) is now covered by the shared fixture replay (F); #19 / #20 are UX / API surface, not touched by this pass.
- No refactors in this pass — analysis only (Claude Fable 5.1).
