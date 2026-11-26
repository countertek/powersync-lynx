# Lynxtron desktop host (Autolink, macOS & Windows)

A cross-platform Lynxtron desktop app (`@lynx-js/lynxtron` `0.0.31`) that loads
the shared ReactLynx TODO bundle (`examples/showcase/lynx-dist/main.lynx.bundle`)
inside a `LynxWindow` and registers `NativePowerSyncModule` automatically via
Lynxtron Autolink (`pluginLynxtron()` + `powersync-lynx/lynxtron`).

## Prerequisites

- Node **>= 22.18** (`.nvmrc`)
- pnpm **12** (`packageManager` is `pnpm@12.3.4`; do not use the `npm` CLI)
- **macOS 14+ (`arm64`)** or **Windows 10+ (`x64`)**
- Platform `powersync-lynx.node` + `powersync-sqlite-core` binaries present under
  `dist/macos/arm64/` (built via `make node` on macOS) or `dist/windows/x64/`
- Local compose stack from [`examples/README.md`](../../README.md) (`postgres` :5432,
  `powersync` :8080, `demo-api` :8081)

## Install / build / run

From the repository root:

```bash
# 1. Install root deps and build the native desktop addon (macOS arm64)
pnpm install
make node                                   # builds dist/macos/arm64/powersync-lynx.node + core dylib

# 2. Build the shared ReactLynx TODO bundle
pnpm --dir examples/showcase install
pnpm --dir examples/showcase build          # emits examples/showcase/lynx-dist/main.lynx.bundle

# 3. Install, build (runs Lynxtron Autolink staging), and launch the Lynxtron host
pnpm --dir examples/hosts/lynxtron install
pnpm --dir examples/hosts/lynxtron build    # emits dist/desktop/main.js + staged .lynxtron/native/
pnpm --dir examples/hosts/lynxtron start
```

For iterative host development with watch/restart:

```bash
pnpm --dir examples/hosts/lynxtron dev
```

## How Autolink works

- `rsbuild.config.ts` registers `pluginLynxtron()` from
  `@lynx-js/lynxtron-dev-plugins/rsbuild` in a Node-targeted environment.
- `pluginLynxtron()` scans `package.json` dependencies for `lynx.lib.json`
  entries with `platforms.lynxtron.targets`, matches the current `os`/`arch`
  (`darwin`/`arm64` or `win32`/`x64`), stages `powersync-lynx/lynxtron`,
  `powersync-lynx.node`, and the sibling `powersync-sqlite-core` library into
  `dist/desktop/.lynxtron/native/node_modules/powersync-lynx/`, and prepends the
  generated loader to `dist/desktop/main.js`.
- Requiring `powersync-lynx/lynxtron` loads `powersync-lynx.node`, running
  static `LYNX_REGISTER_NATIVE_MODULE("NativePowerSyncModule", ...)` before the
  `LynxWindow` opens.
- Always launch `lynxtron ./dist/desktop/main.js` (as configured in `pnpm start`)
  so the AutoLink loader resolves `.lynxtron/native/` alongside `main.js`.

## Server addressing & CLI / env overrides

Host configuration is injected into the showcase bundle via
`LynxWindow.loadFile(bundlePath, { globalProps })`, matching `examples/hosts/ios`
and `examples/hosts/android`:

| Setting | Default | Environment variable | CLI flags |
|---|---|---|---|
| `device` | `lynxtron` | `DEMO_DEVICE` | `--device <id>`, `-DemoDevice <id>` |
| `demoApiUrl` | `http://127.0.0.1:8081` | `DEMO_API_URL` | `--demo-api-url <url>`, `-DemoApiUrl <url>` |
| `powersyncUrl` | `http://127.0.0.1:8080` | `POWERSYNC_URL` | `--powersync-url <url>`, `-PowerSyncUrl <url>` |
| Bundle path | `examples/showcase/lynx-dist/main.lynx.bundle` | `LYNX_BUNDLE_PATH` | `--bundle <path>` |
| Windowless mode | `false` | `LYNXTRON_WINDOWLESS=1` | `--windowless` / `--headless` |

CLI flags take precedence over environment variables, which take precedence over
defaults. Each `device` value opens its own SQLite file
(`powersync-lynx-todo-<device>.db`) in the OS default app-data directory:

- **macOS**: `~/Library/Application Support/com.lynxjs.Lynxtron/`
- **Windows**: `%LOCALAPPDATA%\<executable-stem>\`

## Two-client walkthrough

Start the local sync stack (`docker compose --profile sync up --build` in
`examples/`), then launch two clients with distinct device IDs:

### Lynxtron + Web showcase

1. Start the web showcase (`pnpm --dir examples/showcase dev:web`) and open
   `http://localhost:4173/?device=web-b`.
2. Start the Lynxtron host:
   ```bash
   pnpm --dir examples/hosts/lynxtron start -- --device lynxtron-a
   ```

### Two Lynxtron windows

```bash
# Terminal 1
pnpm --dir examples/hosts/lynxtron start -- --device lynxtron-a

# Terminal 2
pnpm --dir examples/hosts/lynxtron start -- --device lynxtron-b
```

If ports `:5432` / `:8080` / `:8081` are already bound on your machine, pass
`--demo-api-url` and `--powersync-url` (or `DEMO_API_URL` / `POWERSYNC_URL`).

## Verified status & `/sync/stream` Gate #73 findings

Empirically verified on **macOS arm64** (`@lynx-js/lynxtron@0.0.31`,
`@lynx-js/lynxtron-dev-plugins@0.0.31`, Lynx SDK `4.4`, `powersync-sqlite-core`
`0.5.3/2ba6b280`, Node `26.13.0`, pnpm `12.3.4`) against
`examples/docker-compose.yml` (`--profile sync`, isolated ports `18080`/`18081`)
and a local Node HTTP NDJSON server:

| Check | Status | Observed evidence |
|---|---|---|
| Lynxtron Autolink build & staging | **Pass** | `rsbuild build` staged `powersync-lynx.node` + `libpowersync_aarch64.macos.dylib` + `lynxtron/index.cjs` under `dist/desktop/.lynxtron/native/node_modules/powersync-lynx/` with zero warnings. |
| `NativePowerSyncModule` registration & SQLite open | **Pass** | Both windowed and `--windowless` launches loaded `NativePowerSyncModule` and created `~/Library/Application Support/com.lynxjs.Lynxtron/powersync-lynx-todo-<device>.db` (`powersync_rs_version() = 0.5.3/2ba6b280`, `ps_kv.client_id` populated, schema tables created). |
| Local CRUD & restart persistence | **Pass** | `INSERT` + `UPDATE` into `todos` recorded 2 ops in `ps_crud` and persisted across full process restart (`count: 1`, `completed: 1` on relaunch). |
| Showcase UI launch (`globalProps`) | **Pass** | `examples/showcase/lynx-dist/main.lynx.bundle` launched in `LynxWindow` (windowed & windowless), received `{ device, demoApiUrl, powersyncUrl }` via `lynx.__globalProps`, opened the per-device DB, and initiated `GET /token`. |
| Stock Lynxtron BTS `fetch()` (`/token` & `/sync/stream`) | **Fail (triggers Gate #73)** | See exact root cause below. `ps_buckets` stayed `0`; live NDJSON chunks did not reach PrimJS. |
| `AbortSignal` stream cancellation | **Fail (triggers Gate #73)** | See exact root cause below. JS promise rejected locally, but native TCP stream stayed open on the server. |
| Windows `x64` build & run | **Not yet run** | `lynx.lib.json` `win32`/`x64` target and cross-platform host config are wired; native Windows verification runs in CI (#74). |

### Concrete evidence for Gate Ticket #73 (ADR-0005 Section 5)

1. **Stock `fetch()` callback never settles on macOS arm64 Lynxtron `0.0.31`**:
   - Inspecting `String(fetch)` in Lynxtron BTS shows `fetch()` delegates to
     `NativeModules.LynxFetchModule.fetch(req, resolve, reject)`.
   - HTTP requests **do** reach the server via macOS `CFNetwork`
     (`User-Agent: lynxtron/1.0.0 CFNetwork/3896.200.61 Darwin/27.2.0`), and the
     server returns `HTTP 200` + full body (tested against `demo-api`
     `GET /health`, `GET /token`, a local Node server with both
     `Connection: close` and `keep-alive`, and chunked `POST /stream` with both
     `useStreaming: false` and `useStreaming: true`, in both windowed and
     `--windowless` modes).
   - However, **`NativeModules.LynxFetchModule.fetch` never invokes either its
     JS `resolve` or `reject` callback** — every `await fetch(...)` hangs
     indefinitely (`TIMEOUT` after 3–4s in probes), so `GET /token` never
     completes in the showcase and `/sync/stream` never yields bytes into PrimJS
     (`ps_buckets = 0`).
2. **`AbortSignal` does not cancel the underlying native HTTP connection**:
   - Lynxtron `0.0.31`'s BTS `fetch()` implementation only binds
     `signal.addEventListener("abort", () => reject(signal.reason))` and has no
     native abort/cancel call on `LynxFetchModule`.
   - When `AbortController.abort()` was called at `t = 1501 ms` during an open
     chunked `POST /stream?us=true` request, the JS promise rejected at
     `t = 1501 ms`, **but the server socket remained open** and continued
     writing chunk 2 at `t = 2000 ms` until the Lynxtron process exited.
3. **Gate #73 decision input**:
   - The ADR-0005 verification gate condition is triggered on macOS arm64
     Lynxtron. Gate Ticket #73 should reopen ADR-0003 and implement Desktop
     Native Module `httpFetch` / `httpFetchAbort` (`NSURLSession` on macOS,
     `WinHTTP` on Windows, sharing `shared/sync_http_session.h` and
     `shared/utf8_hold.h`). Note also that because stock `fetch()` hangs even
     for non-streaming JSON requests (`GET /token`, `POST /upload`) on
     `@lynx-js/lynxtron@0.0.31`, desktop hosts/connectors should also be tested
     against the Native Module HTTP path (or a newer Lynxtron runtime once
     upstream fixes `LynxFetchModule`).
