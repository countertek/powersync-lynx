Updated the body from a fresh `/improve-codebase-architecture` pass on `main` @ b19c2f5 (FM-PS-LYNX-007, post-realtime merge). Summary of what moved:

**Added**
- **E. Lynx host-globals module** — six independent PrimJS lookup ladders plus an import-order AbortController invariant; the reason the stream tests must mutate `globalThis`. Enabler for A.
- **D. Android SQL RPC onto `ps_sql`** — Android reimplements the SQL engine that iOS/desktop share; three bind/envelope dialects.
- **F. Shared NDJSON stream fixtures** — `make test-ios` does not compile `StreamingHttp.mm`, Android instrumentation never calls `httpFetch`; the Android/iOS terminal-event asymmetry shipped unnoticed.
- **G. iOS host-provided event sender** — library walks `UIWindow`s for a `LynxView`.
- **H. Verification gate** — `pnpm typecheck` (44) and `pnpm lint` (2) are red on main, Node floor unpinned, `consumer-rules.pro` empty, no CI. Listed as a prerequisite, not a refactor.
- **State of main** section with hot spots and check results so the list can be re-run against a baseline.

**Changed**
- **A. Deepen the transport** — now framed as one `SyncStreamTransport` interface with three adapters (NativeHttpFetch primary, LynxFetchModule fallback, plain `fetch`), and names the concrete cost: `LynxFetchResponse` picks one of four readers, the 64-slot GlobalEventEmitter capture patches `addListener` / `emit` / `_events.get` / `lynx.getJSModule`, and the `FM-PS-LYNX-003` diagnostic (25 refs) should be deleted in favour of the logger.
- **B. Separate native sync HTTP from SQL RPC** — adds the spec/ADR drift (`docs/spec.md` still says "There is no Native Module HTTP"; no ADR-0003), the desktop asymmetry (N-API module has no `httpFetch`), the two TypeScript declarations/lookups on the JS side, and the terminal-event contract (`onData* -> onError? -> onEnd`) that Android and iOS currently implement differently.
- **C. Unify idle-complete** — scope widened from the three native copies to the double JS encoding (`lynxExtension.powersyncIdle*` vs envelope `idleComplete/bodyBase64`), the platform-only knobs (`idleCompleteMs`, Content-Type default), and the showcase class named in library comments. Decision framed: idle-complete is a fallback adapter behind B.
- **Sequencing** now H -> E -> A -> B + C -> F -> D -> G, with A as top recommendation (hottest file, red typecheck, no native rebuild).

**Left as-is**
- Host helper `page-rpc.ts` (deep; tested through `handleNativeCall`; ADR-0002), Adapter / `callNative` (ADR-0001 mirror of official RN), desktop N-API module (SQL-only by design).

**Deferred**
- Lynx-for-Web streaming stays on the plain `fetch` adapter.

**Links to #19 / #20 / #21**
- #21 (keep the `streamingId` realtime path) is the acceptance criterion for A, B, C and F rather than its own architecture bullet; F gives it an executable fixture.
- #19 (`hasSynced` is not download proof) is consumer UX; the one architecture hook is A replacing `console.log` path labels with a logger / `SyncStatus` signal.
- #20 (`waitForReady` vs first-sync helpers) is DX on the public interface; no architecture item, linked only.

Full report (HTML, Tailwind + Mermaid) was written to the reviewer's temp dir; the markdown body above is the durable copy.
