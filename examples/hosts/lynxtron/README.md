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

## Verified status & `/sync/stream` Gate #73 resolution (PASS)

Empirically verified on **macOS arm64** (`@lynx-js/lynxtron@0.0.31`,
`@lynx-js/lynxtron-dev-plugins@0.0.31`, Lynx SDK `4.4`, `powersync-sqlite-core`
`0.5.3/2ba6b280`, Node `26.13.0`, pnpm `12.3.4`) against the live local compose
stack (`examples/docker-compose.yml` `--profile sync`, isolated ports
`18080`/`18081`):

| Check | Status | Observed evidence |
|---|---|---|
| Lynxtron Autolink build & staging | **Pass** | `rsbuild build` staged `powersync-lynx.node` (with `NSURLSession` Desktop `NativeSyncHttp`) + `libpowersync_aarch64.macos.dylib` + `lynxtron/index.cjs` under `dist/desktop/.lynxtron/native/node_modules/powersync-lynx/` with zero warnings. |
| `NativePowerSyncModule` registration & SQLite open | **Pass** | Both windowed and `--windowless` launches loaded `NativePowerSyncModule` and created `~/Library/Application Support/com.lynxjs.Lynxtron/powersync-lynx-todo-<device>.db` (`powersync_rs_version() = 0.5.3/2ba6b280`, `ps_kv.client_id` populated, schema tables created). |
| Local CRUD & restart persistence | **Pass** | `INSERT` + `UPDATE` into `todos` recorded ops in `ps_crud` and persisted across full process restart. |
| Connector JSON (`/token`, `/upload`) via `native-http` | **Pass** | `demoFetch` and `pickSyncStreamTransport` route desktop non-streaming JSON (`/token`, `/upload`, `/write-checkpoint2.json`) through `NativePowerSyncModule.httpFetch`, bypassing `@lynx-js/lynxtron@0.0.31`'s hanging `LynxFetchModule.fetch`. |
| Live NDJSON `/sync/stream` via `native-http` | **Pass** | Initial checkpoint downloaded (`ps_buckets=1`, `seed-1: "Initial todo €100"`); live cross-client push (`"Live push Lynxtron 🚀"`) arrived incrementally in ~500 ms while `/sync/stream` stayed open. |
| Multi-byte UTF-8 chunk boundaries | **Pass** | Shared `shared/utf8_hold.h` (`split-multibyte` fixture replayed in `make test`) and live 3-byte (`€`) + 4-byte (`🚀`, `✨`) UTF-8 decoded cleanly without corruption. |
| `AbortSignal` / `db.disconnect()` & reconnect | **Pass** | `db.disconnect()` invoked `httpFetchAbort` -> `NSURLSessionDataTask cancel`; proxy observed server TCP socket close in **6 ms**; offline local mutation uploaded (`pendingCrud=0`) and external mutation converged cleanly on reconnect (`stream#2`). |
| Windows `x64` build & run | **Pending CI (#74)** | `lynx.lib.json` `win32`/`x64` target, `WinHTTP` `desktop_sync_http_win.cc`, and cross-platform host config are wired; native Windows verification runs in CI (#74). |

### Historical Gate #73 trigger context (why Branch B was taken)

1. On `@lynx-js/lynxtron@0.0.31` (macOS arm64), stock `fetch()` delegates to
   `NativeModules.LynxFetchModule.fetch`, which sends requests over `CFNetwork`
   but never invokes JS `resolve` or `reject`, hanging both `/token` and
   `/sync/stream`, and its JS-only `AbortSignal` does not close the TCP socket.
2. In addition, Lynx 4.2/4.4's `lynx_core.js` `AbortSignal` splices its listener
   array inside `forEach` during `emit`, skipping subsequent abort listeners when
   an earlier listener removes itself.
3. Gate #73 reopened ADR-0003 for Desktop (`shared/nativeModule/desktop_sync_http.*`
   + `desktop_sync_http_macos.mm` / `desktop_sync_http_win.cc`), added desktop
   `native-http` routing for both streaming and non-streaming JSON requests, and
   added feature-detection in `installAbortControllerPolyfill()` to replace the
   broken Lynx `AbortController`.
