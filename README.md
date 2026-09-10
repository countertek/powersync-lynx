<div align="center" markdown>

![powersync-lynx — PowerSync for Lynx apps](https://raw.githubusercontent.com/countertek/powersync-lynx/main/docs/assets/powersync-lynx-readme-hero.png)

**PowerSync JavaScript inside Lynx apps.** One Autolink package, one `PowerSyncDatabase` surface, local SQLite plus sync on web, iOS, and Android.

**[Spec](https://github.com/countertek/powersync-lynx/blob/main/docs/spec.md)** · **[Examples](https://github.com/countertek/powersync-lynx/tree/main/examples)** · **[Glossary](https://github.com/countertek/powersync-lynx/blob/main/CONTEXT.md)**

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://github.com/countertek/powersync-lynx/blob/main/LICENSE)
[![pnpm](https://img.shields.io/badge/pnpm-12-F69220?logo=pnpm&logoColor=white)](https://pnpm.io)
[![Lynx](https://img.shields.io/badge/Lynx-4.0%2B-black)](https://lynxjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[Changelog](https://github.com/countertek/powersync-lynx/releases) · [Report Bug](https://github.com/countertek/powersync-lynx/issues) · [Request Feature](https://github.com/countertek/powersync-lynx/issues)

![Rule](https://cdn.jsdelivr.net/gh/andreasbm/readme/assets/lines/rainbow.png)

</div>

## 🎯 When to use this

You are building a **ReactLynx** app and want the same PowerSync client model as Web / React Native: open a local DB, declare a Schema, `connect` with a Connector, then `get` / `execute` / `watch` while `/sync/stream` stays in Lynx JS.

Use this package when you need:

| Need | What you get |
| --- | --- |
| **One JS API** | `PowerSyncDatabase` typed as official `CommonPowerSyncDatabase` |
| **Native SQL** | Autolinked `NativePowerSyncModule` (async SQL RPC) on iOS and Android |
| **Lynx-for-Web** | Host helper `attach()` mapping that RPC onto WASQLite |
| **Local demo stack** | Compose Postgres + PowerSync + demo API under `examples/` |

Do **not** expect Lynx Explorer to run SQL: Explorer does not register `NativePowerSyncModule`. Windows / macOS hosts are recipe-only today.

## 📦 Install

```bash
pnpm add powersync-lynx @powersync/common
```

For Lynx-for-Web, also depend on the optional peer `@powersync/web` in the **app** (not in the library install graph).

```ts
import { PowerSyncDatabase, Schema, Table, column } from "powersync-lynx";

const schema = new Schema({
  todos: new Table({
    id: column.text,
    description: column.text,
    completed: column.integer,
  }),
});

const db = new PowerSyncDatabase({
  schema,
  database: { dbFilename: "app.db" },
});

await db.waitForReady(); // SQLite open — first paint can happen now
void db.connect(connector); // PowerSyncBackendConnector: fetchCredentials + uploadData
```

### Ready vs synced

`waitForReady()` opens the local file. It does **not** wait for `connect()` or a checkpoint. Do not await first sync before first paint:

```ts
await db.waitForReady();
showLocalUi(); // get / execute / watch from SQLite

void db.connect(connector); // stream handshake must not gate the composer
void db.waitForFirstSync().then(() => {
  // hasSynced — may already be true from a previous launch (persisted)
});
void db.waitForStatus((status) => status.connected === true); // this session's socket
```

| Call | Resolves when |
| --- | --- |
| **`waitForReady()`** | Local SQLite is open |
| **`waitForFirstSync()`** | `hasSynced === true` (persisted across launches; not the same as `connected`) |
| **`waitForStatus(s => s.connected)`** | This session has a live PowerSync socket |

Lynx-for-Web host page (not the bundle):

```ts
import { attach } from "powersync-lynx/web-host";
// wire Native Module SQL RPC onto WASQLite for one <lynx-view>
```

## 📱 Platforms

| Platform | Persistence | Sync download path |
| --- | --- | --- |
| **Lynx-for-Web** | Host-page WASQLite via `powersync-lynx/web-host` | Browser `fetch` streaming |
| **iOS** | Native SQLite + PowerSync core through Autolink | `NativePowerSyncModule.httpFetch` |
| **Android** | Same Native Module path | `NativePowerSyncModule.httpFetch` |
| **Windows / macOS** | Documented Autolink recipes only | Not verified in this checkout |

### Native streaming (iOS / Android)

Stock Lynx fetch cannot keep a live `/sync/stream` NDJSON connection open. Autolink hosts use **`NativePowerSyncModule.httpFetch`**:

1. One-shot callback returns status + `streamingId` (empty body).
2. Chunks arrive as UTF-8 strings on **`GlobalEventEmitter`**. Terminal sequence: `onData*` → `onError?` → `onEnd`.
3. `LynxRemote` rebuilds a ReadableStream so PowerSync applies NDJSON incrementally.

Idle-complete (buffered UTF-8 `body` / `bodyBase64` when no event sender is registered) is the fallback, not the primary path. `httpFetchAbort(streamingId)` cancels after headers (`onError` then `onEnd`). Abort before the headers Callback settles the JS Promise immediately; native I/O may continue until a late Callback delivers `streamingId` ([ADR 0003](https://github.com/countertek/powersync-lynx/blob/main/docs/adr/0003-native-module-http-is-streaming-fallback.md)). Host details: [iOS](https://github.com/countertek/powersync-lynx/blob/main/examples/hosts/ios/README.md), [Android](https://github.com/countertek/powersync-lynx/blob/main/examples/hosts/android/README.md).

### Status signals

`hasSynced` and `lastSyncedAt` live in SQLite (`powersync_offline_sync_status`). After a relaunch they can be true even if this process has not opened `/sync/stream`. Treat them as “this database has completed a checkpoint at least once,” not “this session downloaded.”

| Signal | Meaning |
| --- | --- |
| **`hasSynced` / `lastSyncedAt`** | Persisted. True after a prior launch is **not** proof this session downloaded. |
| **`waitForFirstSync()`** | Resolves when `hasSynced` is true, including a persisted value. Stays pending on `connected` alone. |
| **`connected` / `waitForStatus(s => s.connected)`** | This session has a live PowerSync socket. |
| **`downloading` / first checkpoint this session** | This session received checkpoint data (`lastSyncedAt` advanced). Use row presence / `ps_buckets > 0` when you need download evidence. |
| **`powersync-lynx /sync/stream via <transport>`** | Logger debug for this session’s transport (`native-http`, host `fetch`, …). Attach a `logger` on `PowerSyncDatabase` (default min level is `info`). |

## Limits

- **Lynx Explorer** does not register `NativePowerSyncModule` — SQL and native streaming will not run there.
- **Windows / macOS** hosts are Autolink recipes only. Desktop is not a full Autolink product path in this checkout (N-API is SQL-only; desktop `/sync/stream` is unverified).
- **Native abort before headers:** JS settlement may precede native cancel until the `streamingId` Callback ([ADR 0003](https://github.com/countertek/powersync-lynx/blob/main/docs/adr/0003-native-module-http-is-streaming-fallback.md)).
- **Demo tokens** in the examples stack are a static HS256 JWT, not PowerSync Cloud / JWKS production auth.

## 🧪 Local demo stack

Consumer TODO app + sync backends live under [`examples/`](https://github.com/countertek/powersync-lynx/tree/main/examples). Full walkthrough: [examples/README.md](https://github.com/countertek/powersync-lynx/blob/main/examples/README.md).

```bash
# 1) Sync profile: Postgres + PowerSync + demo-api
cd examples
docker compose --profile sync up --build

# 2) Library + showcase (from repo root)
cd ..
pnpm install
pnpm bundle-factory
cd examples/showcase
pnpm install
pnpm dev:web   # http://localhost:4173
```

Two-window money shot: open `/?device=a` and `/?device=b` so each client gets its own WASQLite file. Native Autolink hosts: [iOS](https://github.com/countertek/powersync-lynx/blob/main/examples/hosts/ios/README.md), [Android](https://github.com/countertek/powersync-lynx/blob/main/examples/hosts/android/README.md). Desktop stays recipe-only.

## 🛠️ Develop this package

```bash
pnpm install
pnpm test          # Adapter / Client unit tests (node --test)
pnpm lint
pnpm fmt
pnpm typecheck
make test          # Native Module (see Makefile for iOS / Android targets)
```

Requires **Node >= 22.18** (`.nvmrc` / `package.json` `engines`) and pnpm 12 (`packageManager` is `pnpm@12.3.4`).

Autolink apps compile this package’s `android/` tree: **NDK** + **CMake** for JNI `ps_sql`, with `-DANDROID_STL=c++_shared`. The consumer SDK needs an NDK and CMake so `externalNativeBuild` can build `libpowersync_lynx_sql.so`. `android/build.gradle` also runs a Gradle `Exec` of `node scripts/fetch-native-deps.mjs --sqlite` on `preBuild` (sqlite amalgamation). Gradle hosts without Node are tracked as [#39](https://github.com/countertek/powersync-lynx/issues/39) M2 and do not block `pnpm test` / `make test`. Sync-HTTP timeouts and stream event names live in `shared/sync_http_policy.h`; Android compiles committed `SyncHttpPolicy.java` generated from that header (`node scripts/gen-sync-http-policy-java.mjs`). Consumer Gradle does not run the generator. Drift fails `make test` / `pnpm test`.

iOS Autolink compiles canonical `shared/ps_sql.{cc,h}` through `ios/src/ps_sql_engine.cc` (a CocoaPods compile unit that `#include`s the shared engine). CocoaPods drops `source_files` outside `PODS_TARGET_SRCROOT` (`ios/`), so the podspec does not list `../shared/ps_sql.cc`. Those shared sources still ship in the npm package; `fetch-native-deps` does not copy them under `ios/src`.

Normative Client behavior: [docs/spec.md](https://github.com/countertek/powersync-lynx/blob/main/docs/spec.md). Ubiquitous language: [CONTEXT.md](https://github.com/countertek/powersync-lynx/blob/main/CONTEXT.md). ADRs: [docs/adr/](https://github.com/countertek/powersync-lynx/tree/main/docs/adr).

## 🔗 Links

- [Examples guide](https://github.com/countertek/powersync-lynx/blob/main/examples/README.md)
- [License (Apache-2.0)](https://github.com/countertek/powersync-lynx/blob/main/LICENSE)
- [Issues](https://github.com/countertek/powersync-lynx/issues) (no `CONTRIBUTING.md` yet; PRs that match the spec and existing checks are welcome)

---

#### 📝 License

Copyright © 2026 [countertek](https://github.com/countertek). <br />
This project is [Apache-2.0](https://github.com/countertek/powersync-lynx/blob/main/LICENSE) licensed.
