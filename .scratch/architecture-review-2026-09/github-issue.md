## Summary

Architecture review via `/improve-codebase-architecture` (Matt Pocock engineering skill), informed by `CONTEXT.md`, ADR-0001, ADR-0002, and recent git hotspots after the realtime `/sync/stream` merge.

**Top recommendation:** deepen the Lynx → official `Response` transport module (collapse PrimJS/host/HTTP quirks out of `LynxRemote`).

HTML report (self-contained, temp): produced as `/tmp/architecture-review-*.html` during the agent run; also mirrored under Cursor artifacts for this session.

Vocabulary used below (from `/codebase-design`): **module**, **interface**, **depth**, **seam**, **adapter**, **leverage**, **locality**. Domain terms from `CONTEXT.md`: Client, PowerSyncDatabase, Adapter, Native Module, Host helper, Connector.

---

## Findings

### 1. `LynxRemote` is a shallow mega-module (Strong · local-substitutable)

**Files:** `src/sync/LynxRemote.ts` (~1392 lines), `src/sync/gunzip.ts`, `test/lynx-remote-stream.test.ts`

**Problem:** The public class looks deep (`extends AbstractRemote`), but callers/tests must still know PrimJS `typeof` quirks, `powersyncIdleBodyBase64`, `streamingId` vs empty body, GlobalEventEmitter slot races, gzip-as-JSON, and the `httpFetch` presence gate. Interface complexity ≈ implementation complexity → **shallow**.

**Deletion test:** Deleting internal path helpers does not remove complexity — it reappears across tests and host fallbacks. The *concept* “Lynx bytes → streaming Response” is earning its keep; the *current module shape* is not.

**Recommended change:** Collapse “Lynx bytes → official `Response`” behind one deep module whose interface is only URL/headers/body/abort → streaming `Response`. Keep PrimJS/event/idle/gzip quirks inside. Let `LynxRemote` stay a thin `AbstractRemote` adapter.

**Wins:** locality for stream bugs; leverage across hosts; tests hit one seam; interface shrinks.

---

### 2. Native Module mixes SQL RPC and HTTP streaming (Strong · ports & adapters)

**Files:** `NativePowerSyncModule` (Android/iOS), `StreamingHttp.*`, `IdleCompleteHttp.*`, `src/adapter/native.ts` (SQL-only types)

**Problem:** ADR-0001 defined a deep SQL RPC seam (`open`/`close`/`execute`/`executeBatch`). Adding `httpFetch` / abort / streaming IDs widens the Native Module interface and mixes domains. Adapter types stay SQL-only; Remote redefines a second `NativeHttpFetchModule` lookup (including `eval`).

> **ADR / spec conflict:** Contradicts ADR-0001 and locked `docs/spec.md` (“There is no Native Module HTTP” / “Native HTTP for `/sync/stream` … is not this spec”). Worth reopening because hosts cannot deliver incremental `/sync/stream` through PrimJS fetch alone.

**Recommended change:** Treat native sync HTTP as its own **port** (even if Autolinked in the same package): one deep host-side module whose interface is “stream NDJSON for this request,” separate from the SQL RPC adapter. Update or supersede ADR-0001 / spec text once the port shape is grilled.

**Wins:** restores SQL seam clarity; two adapters (prod native + test fake) justify the HTTP port; Adapter stays deep.

---

### 3. Triple idle-complete / long-lived-stream policy (Strong · ports & adapters)

**Files:** `ShowcaseLynxHttpService.java`, Android/iOS `IdleCompleteHttp`, `LynxRemote.bodyFromFetchSuccess`

**Problem:** Same policies (`isSyncStreamUrl`, idle ~2500ms, `readUntilIdleOrEof`, base64 idle body) duplicated across showcase and library. Locality broken — recent git history is mostly this class of fix.

**Recommended change:** One deep “PowerSync long-lived HTTP read” module owned by the library. Showcase HTTP becomes ordinary `LynxHttpService` (or a thin demo wrapper) without reimplementing sync-stream idle logic.

**Wins:** one idle policy; stop example/library drift.

---

### 4. Stream event protocol spread across JS + Android + iOS + host glue (Worth exploring)

**Files:** `LynxRemote` GlobalEventEmitter hooks; Android `sendStreamEvent`; iOS `setSharedStreamEventSender`; `examples/hosts/ios/App/ViewController.m`

**Problem:** Event name prefixes, array-wrapped payloads, 64-slot early-capture, and iOS LynxView sender wiring leak into Remote. Missing host glue silently falls back to idle-complete.

**Recommended change:** Deepen a single “attach stream listener / deliver UTF-8 chunks / end|error” module so `LynxRemote` never hooks `_events` or slot races itself.

---

### 5. Dual Native Module lookup (Worth exploring · in-process)

**Files:** `src/adapter/native.ts` vs `LynxRemote.lookupNativePowerSyncModule`

**Problem:** Two modules for “find NativePowerSyncModule”; SQL path vs HTTP path diverge on PrimJS quirks (callable vs presence-only).

**Recommended change:** One deep Native Module handle: resolve once; expose SQL RPC and (if kept) HTTP behind one typed seam.

---

### 6–7. Speculative / lower payoff

- **UTF-8 framing** copied in JS + Java + ObjC → shared contract + test vectors (in-process).
- **Host-helper `page-rpc.ts`** overloads lease + update-hooks + envelope mapping; `attach` stays deep (ADR-0002) — split internal modules and share `__psBig`/`__psAb` tags with Adapter.

---

## Preserve (healthy depth)

- `PowerSyncDatabase` thin wiring over official bases
- Adapter ↔ Native Module SQL RPC (ADR-0001) — clearest deep seam in the tree
- Host helper `attach` → WASQLite SQL RPC (ADR-0002)
- `gunzip.ts` simple interface / deep inflate
- `LynxStreamingSyncImplementation` intentional shallow lock adapter

---

## Risks

| Risk | Mitigation |
|------|------------|
| Reopening ADR-0001/spec without a replacement port leaves docs lying | Grill the HTTP port first; write a short ADR when the reason is load-bearing |
| Deepening transport while leaving triple idle policy will reintroduce drift | Sequence idle consolidation with or immediately after transport |
| Collapsing showcase HTTP too early breaks demo Connector/`demoFetch` path | Keep showcase as thin wrapper until library path is proven on both hosts |
| Tests currently stage the whole PrimJS host (~1550-line stream suite) | Replace with seam-level Response fixtures as the deep module lands; delete shallow path tests that no longer earn their keep |
| FM-PS-LYNX-003 diagnostics still in tree add noise to the mega-module | Strip diagnostics as part of transport deepening, not a separate epic |

---

## Suggested sequencing

1. **Deepen Lynx → Response transport** (finding 1) — highest leverage; concentrates recent heat.
2. **Formalize native sync HTTP as a separate port** (finding 2) + ADR/spec amendment — do not fold HTTP into Adapter.
3. **Consolidate idle/long-lived read** into library-owned module; thin showcase (finding 3).
4. **Stream attach module** (finding 4) and **unified Native Module handle** (finding 5) as follow-ons once the transport seam exists.
5. Speculative: UTF-8 contract vectors; Host-helper internal lease/hooks split.

Do **not** start a large refactor PR from this issue alone. Next step per skill: pick a candidate and run `/grilling` (+ `/domain-modeling` for any new glossary terms / ADRs).

---

## Method notes

- Skill: `mattpocock/skills` → `improve-codebase-architecture` (+ `codebase-design` vocabulary, `HTML-REPORT.md` scaffold)
- Hotspot inference: `git log` post-merge stream work (`LynxRemote`, `httpFetch`, IdleComplete, showcase HTTP)
- Domain docs read: `CONTEXT.md`, `docs/adr/0001-*`, `docs/adr/0002-*`, `docs/agents/domain.md`
- No CONTEXT.md/ADR edits in this pass (grilling not yet chosen); domain-modeling deferred until a candidate is selected
