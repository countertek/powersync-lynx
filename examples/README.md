# Examples: PowerSync Lynx TODO

A ReactLynx **TODO app** that consumes `powersync-lynx` as a **package consumer**
(not part of the published Client). One screen: add, complete-toggle, delete,
filter (all / active / done). A collapsible sync log is part of the show.

The demo story is **two browser windows on one account against one Postgres
database**, talking to a local PowerSync service. There is no cloud account and
no hand-pasted JWT: the compose stack mints a static HS256 demo token.

License: Apache-2.0. Lynx **4.0+**. pnpm **12** only.

## How this app consumes the Client

`examples/showcase` is a **separate pnpm project**, not a workspace member of
the library. That keeps the library's native install graph free of
`@powersync/web` / WASQLite (see `test/install-graph.test.ts`).

| Field | Value |
|---|---|
| Dependency | `"powersync-lynx": "link:../.."` |
| Why not `workspace:*` | A shared workspace virtual store would install the optional web peer at the library root |
| Why not a packed tarball | Same TypeScript entry (`src/*.ts`) the package publishes; `file:` is the local stand-in. Prove the tarball with `pnpm publish-dry-run` |
| Web extra | The app **directly** depends on `@powersync/web` (optional peer of the Client) and `@lynx-js/web-core` |

```bash
# from the repository root — pnpm 12 only, no npm CLI
pnpm install
pnpm bundle-factory   # writes dist/web-host/factory.js and prints outfile + byte size

cd examples/showcase
pnpm install
```

## What is verified vs not

Read this before treating a green web preview as "sync works".

| Claim | Status |
|---|---|
| Open DB, Schema, `get` / `execute` / `watch`, add / toggle / delete / filter | **Exercised** in the TODO app source. **Built** for Rspeedy `web` and `lynx` |
| First-load / refresh race (lost or duplicated rows) | **Fix in source + unit tests** (`runExclusive` in `test/first-load-race.test.ts`). Watch-only UI (no local seed), exclusive `waitForReady`, per-device local DB filename, drop watch updates after unmount. **Not** an in-browser IndexedDB flush proof |
| Lynx-for-Web Host helper (`attach` + WASQLite factory ESM URL) | **Built**. Served by `pnpm dev:web` / `pnpm preview:web` |
| Compose profile `sync` (Postgres + PowerSync + demo-api) | **Checked in**. Image pull / container start is **not verified** in every environment. If `journeyapps/powersync-service` cannot be pulled or exits, the app stays a local offline queue |
| Demo token endpoint | **Static HS256 JWT** minted by `demo-api` with the compose-stack secret. **Not** a JourneyApps / PowerSync Cloud account. **Not** RS256/JWKS from a real IdP |
| `uploadData` | POSTs CRUD to `demo-api`, which writes Postgres. **Not** a production app backend |
| Local UI ready without waiting for `connect()` | **Unit tested** (`test/demo-boot.test.ts`). iOS Simulator relaunch shows **DB ready** and the composer while `/sync/stream` is still handshake/erroring. Watch starts from local ready, not from first checkpoint |
| Two-window money shot (A writes, B sees it via PowerSync) | **Not verified this checkout.** iOS `ios-t2` opened **DB ready** / sometimes **sync connected**, but `ps_data__todos` stayed 0 and the log repeated `errorStreamingMalformedResponse`. Web two-window procedure still documented below |
| Offline / reconnect beat (queue writes, reconnect, watch them sync) | In-app **Go offline / Reconnect** is `disconnect()` / `connect()`, not an OS network drop. **Not re-tapped** this checkout |
| Live `/sync/stream` download on Android | **Native Module HTTP** (`httpFetch` + `streamingId` realtime; idle-complete fallback). Rebuild showcase + APK. Prove with a server-created todo on device and `ps_buckets > 0`. |
| Live `/sync/stream` download on iOS | **Same Native Module HTTP path as Android**. Rebuild showcase + `pod install` + xcodebuild. Expect `ps_buckets > 0`. See [`hosts/ios/README.md`](hosts/ios/README.md). |
| `disconnect()` cancelling a live native stream | Same ReactLynx control. **Not tapped** this checkout |
| Physical iOS / Android Autolink host run | **Documented**. Simulator / emulator is what this checkout exercises |
| Windows / macOS Autolink host run | **Not verified**. Desktop remains recipe-only |
| Lynx Explorer | **Will not work** for SQL: Explorer does not register `NativePowerSyncModule` |
| `pnpm publish` to npmjs | **Workflow checked in** (`.github/workflows/publish.yml`). **Not run** from this task |
| Publish dry-run to local Verdaccio | **Scripted** (`pnpm publish-dry-run`). Requires compose profile `registry` |

Do not treat a successful web build as proof of per-platform sync.

## Prerequisites

- pnpm **12** (`package.json` `packageManager` is `pnpm@12.3.4`)
- Node **>= 22.18** (library `engines` / `.nvmrc`)
- Docker with Compose v2 (profiles)
- Two browser windows for the web money shot
- iOS Simulator: Xcode 16+, CocoaPods, `gem install cocoapods-lynx-library` — [`hosts/ios/README.md`](hosts/ios/README.md)
- Android Emulator: JDK 17, Android SDK, an ARM64 AVD — [`hosts/android/README.md`](hosts/android/README.md)

## 1. Start the local sync stack

From `examples/`:

```bash
docker compose --profile sync up --build
```

This starts:

| Service | Port | What it is |
|---|---|---|
| `postgres` | 5432 | Demo schema (`todos`) + `powersync` publication, `wal_level=logical` |
| `mongo` + `mongo-rs-init` | internal | PowerSync **bucket storage**. Same approach as the official self-host demo. Not the app data model |
| `powersync` | 8080 | `journeyapps/powersync-service` replicating Postgres |
| `demo-api` | 8081 | `GET /token` (HS256 JWT) and `POST /upload` (CRUD → Postgres) |

The JWT is a **dev token**: HS256, subject `demo-user`, 12h expiry, signed with the compose-stack secret. The TODO app fetches it on boot. You do not paste a JWT.

If the PowerSync image cannot run in your environment, the TODO app still opens, logs `connect skipped: …`, and queues writes locally.

```bash
# optional: confirm the token endpoint
curl -s http://127.0.0.1:8081/health
curl -s http://127.0.0.1:8081/token
```

## 2. Run the web TODO app

From `examples/showcase`:

```bash
pnpm dev:web
```

This bundles `dist/web-host/factory.js`, builds Rspeedy `web` + `lynx`, and
starts the Vite host at **http://localhost:4173**.

Production-style preview:

```bash
pnpm build
pnpm preview:web
```

## 3. Money shot (two windows, one account)

Each `?device=` value gets its **own WASQLite file**. Two windows on the same
origin without that query param share IndexedDB and would fake the demo.

1. Window A: http://localhost:4173/?device=a
2. Window B: http://localhost:4173/?device=b
3. Wait until both show **DB ready**. Sync pill should move to **connected** if the compose stack is up (otherwise both stay offline — that is not the money shot).
4. In A, add a todo. Open the **Sync log** drawer: you should see `insert:` then `upload:`.
5. In B, the same todo should appear via `watch` after PowerSync downloads it. Toggle complete in A; B should follow. Delete in A; B should drop it.

If B never updates: the stack is down, `uploadData` failed (log it), or the two windows share a device id. Filter pills are local-only (they do not sync).

## 4. Offline / reconnect beat

In window A:

1. Tap **Go offline**. Log: `disconnected` / `offline: disconnected; local writes will queue`.
2. Add or toggle a todo. It stays local. Window B does not see it yet.
3. Tap **Reconnect**. Log: `reconnect:` then `upload:` then B catches up.

Chrome DevTools → Network → Offline is the OS-drop variant of the same beat. The in-app button is `db.disconnect()` / `db.connect()`, which is enough to queue CRUD and replay it.

## 5. Publish dry-run (Verdaccio)

```bash
# from examples/
docker compose --profile registry up -d

# from the repository root — pnpm 12
pnpm publish-dry-run
```

That publishes `powersync-lynx` to `http://localhost:4873`, installs it into a
scratch consumer, and checks `src/index.ts` plus `dist/web-host/factory.js`
(the factory default export is a function). Real npm publish is
`.github/workflows/publish.yml` (`workflow_dispatch` and `v*` tags, provenance).
That workflow is **not** test/lint CI.

Both profiles at once:

```bash
docker compose --profile sync --profile registry up --build
```

## What you should see in the app

1. **DB ready** after `waitForReady` (does not wait for `connect()` / first sync). Sync may stay connecting/offline; errors stay in the log
2. Empty list on first load (no local seed — Postgres is the source of truth when the stack is up)
3. Add / complete-toggle / delete / filter
4. Collapsible **Sync log**: connect, disconnect, upload/download, CRUD, errors, timestamps
5. **Go offline / Reconnect**

`uploadData` writes Postgres through `demo-api`. It does not POST to a cloud backend.

## Run: iOS / Android

Web is the fastest path. iOS Simulator and Android Emulator are **runnable apps**
that load the same ReactLynx TODO bundle (`examples/showcase`) via Autolink.

- iOS: [`hosts/ios/README.md`](hosts/ios/README.md)
- Android: [`hosts/android/README.md`](hosts/android/README.md)
- Windows / macOS: [`hosts/desktop/README.md`](hosts/desktop/README.md) (recipe-only)

Native hosts inject `device`, `demoApiUrl`, and `powersyncUrl` through Lynx
`globalProps`. The Android emulator default is `http://10.0.2.2:8081` / `:8080`.
iOS Simulator and web keep `http://127.0.0.1:8081` / `:8080`. Override via
Info.plist / `strings.xml`, `simctl` argv/env, or `adb` extras — do not hard-code
a laptop LAN IP.

```bash
# shared: bundle the ReactLynx app, then Autolink scan roots
pnpm --dir examples/showcase install
pnpm --dir examples/showcase build
pnpm --dir examples/hosts install
```

Two-client: one native store + `http://localhost:4173/?device=web-b`, or two
native launches with different `device` values. Filter pills stay local.

**Streaming:** hosts set LynxEnv `enable_fetch_api_standard_streaming` so Fetch uses the standard stream path (LynxSDK 3.7+). That is a prerequisite, not by itself proof of incremental `/sync/stream`.

**Not verified on Windows / macOS Lynxtron.** Desktop remains recipe-only.

## Lint / format

`examples/` is a ReactLynx consumer. Root oxlint ignores `examples/` (anti-slop
`no-object-parameters` vs React props). oxfmt still formats showcase TypeScript.

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm --dir examples/showcase typecheck
pnpm --dir examples/showcase build
```

## Layout

```
examples/
  README.md                 this guide
  docker-compose.yml        profiles: sync, registry
  sync/                     PowerSync config, Postgres init, demo-api
  registry/                 Verdaccio config
  scripts/publish-dry-run.mjs
  showcase/                 ReactLynx TODO + Lynx-for-Web host
    src/                    Schema, Connector, UI, log drawer
    host/                   attach() page (Vite)
  hosts/                    Autolink iOS + Android apps; desktop still recipe-only
```
