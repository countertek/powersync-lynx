## FM-PS-LYNX-011 triage — verdict: **partially done, still needs work** (leave open)

Checked against `main` @ `442ec6f` (post-#32). `pnpm test` 92/92, `pnpm typecheck`, `pnpm lint`, Linux `make test` all green on that tip.

### What is already true on `main`

- **The helpers exist on the public type with no Lynx work needed.** `PowerSyncDatabase` is typed as official `CommonPowerSyncDatabase` (`src/PowerSyncDatabase.ts:64-66`), so `db.waitForFirstSync()`, `db.waitForStatus(predicate)`, `currentStatus`, and `registerListener({ statusChanged })` are all available; `waitForFirstSync` is `waitForStatus(status => status.hasSynced)` in `@powersync/shared-internals` `BasePowerSyncDatabase.js:202-208` and rides on the same `statusChanged` events the showcase already consumes.
- **The distinction is documented once.** Root `README.md:95`: *`waitForReady()` opens SQLite; it does **not** wait for `connect()` / first checkpoint.* `docs/spec.md` "Status" lists `currentStatus`, `db.waitForFirstSync()`, `subscription.waitForFirstSync()`, `registerListener({ statusChanged })`, `waitForStatus` (`docs/spec.md:122`).
- **The recommended boot pattern is implemented and unit-tested.** `examples/showcase/src/boot.ts` (`bootDemo`) marks the UI locally ready after `waitForReady()` and lets `connect()` settle later; `test/demo-boot.test.ts` proves local-ready fires while `connect()` is still pending and that a rejected `connect()` does not block it. `examples/README.md:162` states the same.

### What is still missing (the DX part)

1. **`waitForFirstSync` appears nowhere a consumer would look.** Root `README.md` Install snippet (`README.md:59-60`) is `await db.waitForReady(); await db.connect(connector);` with no mention of `waitForFirstSync()` / `waitForStatus`; the word `waitForFirstSync` does not occur in `README.md` or `examples/README.md` at all. Only `docs/spec.md` lists it.
2. **Showcase never uses it.** `examples/showcase/src/App.tsx` derives its label from `connected` / `connecting` only; there is no "first sync done" state, so the demo does not model the choice this issue is about.
3. **No test crosses `waitForFirstSync()` on Lynx.** `test/database.test.ts:119` and `test/web-host.test.ts:850,881` exercise `waitForReady()`; nothing asserts `waitForFirstSync()` resolves when a `statusChanged` with `hasSynced: true` arrives (or that it does not resolve on `connected` alone).

### Acceptance criteria (updated)

- [ ] Root `README.md`: a short "Ready vs synced" note under Install or Sync caveats — `waitForReady()` = local SQLite open; `waitForFirstSync()` = first checkpoint applied (`hasSynced`); `waitForStatus(s => s.connected)` = stream up. One snippet showing `waitForReady()` → render → `connect()` → `waitForFirstSync()` in the background (never block first paint on it).
- [ ] Showcase: after `connect()`, call `getDb().waitForFirstSync()` (non-blocking, with an abort on unmount) and log / pill `first sync done`; keep the local-ready-first ordering already enforced by `bootDemo`.
- [ ] One unit test asserting `PowerSyncDatabase.waitForFirstSync()` resolves on a `statusChanged` carrying `hasSynced: true` and stays pending on `connected: true, hasSynced: false` (can reuse the `test/web-host.test.ts` host-helper harness or a stubbed sync implementation).
- [ ] Note the persistence caveat shared with #19: `hasSynced` is `last_synced_at != null` from the core, so `waitForFirstSync()` resolves immediately on a DB that synced in a previous launch.

No new Lynx API; docs + showcase + one test.

*FM-PS-LYNX-011 item A, Claude Fable 5.1 (Cursor cloud agent). Issues API returns 403 for the agent token; posted from `.scratch/fm-ps-lynx-011/`.*
