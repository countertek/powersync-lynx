# Lock the native Adapter and Native Module contract

Type: grilling
Status: resolved
Blocked by: 01, 02, 03, 04, 06

## Question

How does the native Adapter implement `DBAdapter` (SQLite + `powersync-sqlite-core`) behind a Lynx Native Module, and what is the JSON method contract?

Already locked: `@powersync/common` in Lynx JS; Native Module is an implementation detail; app code never calls `NativeModules` for this. iOS, Android, Windows, macOS.

Pin:

- Which `DBAdapter` methods cross the Native Module vs stay in JS
- SQLite + `powersync-sqlite-core` load choice per platform (from the research options)
- Default `connectionMethod` (HTTP vs WebSocket) given Lynx `fetch`
- Locks, `watch` table notifications, threading (background-only)
- Error shape back to JS
- Manual `registerModule` as a documented fallback, not the floor

HITL: `/grilling` + `/domain-modeling`. Do not implement native code. Output: Native Module + Adapter contract the spec can cite.


## Answer

Native Adapter matches official PowerSync JavaScript (`OPSQLiteDBAdapter` + HTTP Remote), mapped onto a Lynx Native Module. App code never calls `NativeModules`. Public type remains `CommonPowerSyncDatabase`. Cite: [assets/native-adapter-contract.md](../assets/native-adapter-contract.md). ADR: [docs/adr/0001-native-module-is-async-sql-rpc.md](../../../docs/adr/0001-native-module-is-async-sql-rpc.md).

**Wire.** Native Module is thin SQL RPC: `open` / `close` / `execute` / `executeBatch`. Opaque `dbId`; no live `sqlite3*`. Completions are `function` callbacks with `{ ok: true, … }` or `{ ok: false, message, code? }`. The JS Adapter throws a JS `Error`. `readLock` / `writeLock` / `timeoutMs` / `LockContext` / `BEGIN IMMEDIATE` / `tablesUpdated` stay in JS. `watch` uses official `SELECT powersync_update_hooks('install'|'get')`. JS never calls `loadExtension`. No Native Module HTTP.

**Concurrency (official RN).** Per file: 1 write + 5 read connections, WAL, official OP-SQLite PRAGMA defaults (no encryption). Native methods return immediately; SQLite runs off the background JS thread so `/sync/stream` and overlapping reads can proceed.

**Core.** `sqlite3_powersync_init`. Apple: bundled SQLite 3.44+ + static `sqlite3_auto_extension`. Android: Maven AAR `libpowersync.so` + `loadExtension`. Windows: GitHub loadable DLL + `loadExtension`. Not OP-SQLite.

**Sync.** Default `connectionMethod` is HTTP. `createTextDecoder` → Lynx `TextCodecHelper`. iOS/Android: `enableFetchAPIStandardStreaming = true`. No WebSocket default. Native HTTP is a later flag if a host’s `fetch` cannot stream.

**Registration.** Autolink is the floor. Manual `registerModule` is the documented fallback, not a second product. Export name is [Lock package layout, Autolink, and version floors](10-lock-package-layout.md). Host helper should use the same method names ([Lock the Lynx-for-Web Host helper](09-lock-web-host-helper.md)).

## Comments

2026-09-07: claimed to grill and lock the native Adapter + Native Module contract. Planning only — no package, no Host helper, no implementation.

2026-09-07 grilling round 1: frontier is Native Module wire vs JS Adapter, per-platform core load, default connectionMethod, error shape, registerModule fallback. Locks / watch / BTS folded into the wire question. No package, no Host helper.

2026-09-07 grilling round 1 answers: align with official PowerSync. Locked Q1–Q5 to A (thin SQL RPC + JS locks/`powersync_update_hooks`; official per-host core load; HTTP default; envelope → JS `Error`; Autolink floor / `registerModule` fallback). Round 2 is the leftover fork vs official RN: concurrency (1-write+5-read async vs Lynx-simpler one connection).

2026-09-07 grilling round 2: Q1 A — official RN concurrency (1 write + 5 read, callback completions). Frontier empty; contract frozen.
