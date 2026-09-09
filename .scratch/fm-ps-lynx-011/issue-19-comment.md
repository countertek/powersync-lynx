## FM-PS-LYNX-011 triage — verdict: **partially done, still needs work** (leave open)

Checked against `main` @ `442ec6f` (post-#32). `pnpm test` 92/92, `pnpm typecheck`, `pnpm lint`, Linux `make test` all green on that tip.

### What landed after #23 / #32

- **Docs caveat exists.** Root `README.md` "Sync caveats" row: *`hasSynced` alone — not proof that downloads applied; confirm `ps_buckets > 0` / row presence and the native `streamingId` realtime path* (`README.md:93`, from #16). Host guides carry a "Verify downloads (not `hasSynced` alone)" section with the `ps_buckets > 0` + row-presence procedure (`examples/hosts/ios/README.md:129-137`, `examples/hosts/android/README.md:115-121`).
- **The architecture hook #18 promised for this issue landed in A (#32, `a3ada7e`).** The FM-PS-LYNX-003 `console.log` path labels are gone; `LynxRemote.fetch` now reports which transport served `/sync/stream` through the PowerSync logger (`src/sync/LynxRemote.ts:44-49`, `powersync-lynx /sync/stream via native-http`), tested in `test/sync-stream-transport.test.ts:136`.
- **Realtime download itself is proven** (E2E on iOS/Android on `main`; JS + native fixture replay in `test/sync-stream-fixtures.test.ts`, `shared/tests/sync_stream_fixtures_test.cc`). So the "connected but `ps_buckets=0`" failure this issue was reacting to is fixed at the transport layer.

### What is still missing (the UX part of the title)

1. **No download-applied signal in the showcase.** `examples/showcase/src/App.tsx:102-129` renders only `connecting` / `connected` / `offline` and logs `download in progress` / `sync error`. It never surfaces `status.hasSynced`, `status.lastSyncedAt`, or a "first checkpoint applied" event. The only proof a user gets is the `watch` result.
2. **`hasSynced` semantics are not documented.** `hasSynced` is `core.last_synced_at != null` (`@powersync/shared-internals` `SyncStatus.js:161`), i.e. persisted in SQLite by the core: a relaunched app reports `hasSynced === true` from an *earlier* run before the current stream has delivered anything. The README row says "not proof" without saying why or what to watch instead (`lastSyncedAt` advancing, `dataFlowStatus.downloading` → false, `waitForFirstSync()` on a fresh DB).
3. **Stale verification table.** `examples/README.md:47` still reads *"Two-window money shot — Not verified this checkout … `ps_data__todos` stayed 0 … `errorStreamingMalformedResponse`"*. That predates B+C/F and contradicts the E2E result on `main`.
4. The transport debug line (item above) is `LogLevels.debug` on the PowerSync logger; the showcase does not attach a logger, so the log drawer never shows it.

### Acceptance criteria (updated)

- [ ] Showcase status pill/log shows `lastSyncedAt` (or `hasSynced` + a `first checkpoint applied at …` log line derived from `statusChanged`), distinct from `connected`.
- [ ] Root `README.md` "Sync caveats" explains that `hasSynced` / `lastSyncedAt` persist across launches and names the signals that *do* indicate the current session downloaded (`lastSyncedAt` advancing after `connected`, row presence via `watch`, `ps_buckets > 0` for debugging).
- [ ] `examples/README.md` verification table row for the two-window money shot updated to the post-#32 state (iOS/Android E2E proven on `main`; what remains unverified, if anything).
- [ ] Optional: showcase passes a logger so `powersync-lynx /sync/stream via <transport>` appears in the sync log drawer (one line; no new API).

No library API change is needed for any of these; this is docs + showcase.

*FM-PS-LYNX-011 item A, Claude Fable 5.1 (Cursor cloud agent). Issues API returns 403 for the agent token; posted from `.scratch/fm-ps-lynx-011/`.*
