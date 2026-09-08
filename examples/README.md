# Examples: PowerSync Lynx showcase

A ReactLynx demo app that consumes `powersync-lynx` as a **package consumer**
(not part of the published Client). It exercises the locked MVP slice: open a
DB, declare a Schema, `connect` with a Connector, `get` / `getAll` / `execute` /
`writeTransaction`, `watch`, Sync Stream subscribe, and `waitForFirstSync`.

License: Apache-2.0. Lynx **4.0+**.

## How this app consumes the Client

`examples/showcase` is a **separate pnpm project**, not a workspace member of
the library. That keeps the library's native install graph free of
`@powersync/web` / WASQLite (see `test/install-graph.test.ts`).

| Field | Value |
|---|---|
| Dependency | `"powersync-lynx": "file:../.."` |
| Why not `workspace:*` | A shared workspace virtual store would install the optional web peer at the library root |
| Why not a packed tarball | Same TypeScript entry (`src/*.ts`) the package publishes; `file:` is the local stand-in for that consumer install |
| Web extra | Showcase **directly** depends on `@powersync/web` (optional peer of the Client) and `@lynx-js/web-core` |

Install **the library first**, then the showcase:

```bash
# from the repository root — pnpm 12 only, no npm CLI
pnpm install
pnpm bundle-factory   # writes dist/web-host/factory.js (gitignored, required by attach)

cd examples/showcase
pnpm install
```

`file:../..` uses the Client sources in-place. A published consumer would
depend on the npm tarball instead; the import names do not change.

## Verification labels (read this first)

The captain chose to ship examples without gating on real-host streaming or
cancellation evidence. This app and this guide use those labels:

| Claim | Status |
|---|---|
| Open DB, Schema, `get` / `getAll` / `execute` / `writeTransaction`, `watch` | **Exercised** in library tests and in the showcase source. **Built** for Rspeedy `web` (`lynx-dist/main.web.bundle`) and `lynx` (`lynx-dist/main.lynx.bundle`) in this environment |
| Connector `connect` + Sync Stream `subscribe` + `waitForFirstSync` call path | **Exercised** as source (optional UI button). Resolves only with a real PowerSync Service; otherwise the UI reports the error/timeout |
| Lynx-for-Web Host helper (`attach` + WASQLite factory ESM URL) | **Built** (`host-dist/`, factory hashed ESM with a function default export). **Served** at `http://127.0.0.1:4173/` in this environment (`index.html`, `/main.web.bundle`, factory JS all HTTP 200). Factory URL is executable ESM, not a Blob URL |
| In-browser WASQLite open through `<lynx-view>` | **Not driven** here (no headless Lynx+IndexedDB pass). Open Chrome at the preview URL to exercise it |
| Live `/sync/stream` incremental delivery on iOS / Android / Windows / macOS | **Not verified** |
| `disconnect()` cancelling a live stream (native `fetch` honoring `AbortSignal`) | **Not verified** |
| Physical iOS / Android / Windows / macOS Autolink host run | **Not verified** in this environment. Native hosts are scaffolded |
| Lynx Explorer | **Will not work** for SQL: Explorer does not register `NativePowerSyncModule` |

Do not treat a successful web build as proof of per-platform sync.


## What you should see

The UI is a todo showcase:

1. **DB ready** pill after `waitForReady`
2. Three seeded lists (Groceries, Weekend project, Showcase) via `writeTransaction`
3. Todos update through `watch` when you add or toggle items
4. **writeTransaction batch** inserts three todos atomically
5. Workflow log records each API (`get`, `getAll`, `execute`, `watch`, `connect`, `syncStream`)
6. Connector defaults to **offline demo** (`fetchCredentials` returns `null`). Optional endpoint + JWT calls `connect` + `syncStream("todos").subscribe()` + `waitForFirstSync` (4s timeout)

`uploadData` **completes the local CRUD queue**. It does not POST to an app backend.

## Run: Lynx-for-Web (the path to try first)

From `examples/showcase`:

```bash
pnpm dev:web
```

This:

1. Bundles `dist/web-host/factory.js` in the library
2. Builds Rspeedy `web` + `lynx` artifacts into `lynx-dist/`
3. Starts the Vite host at **http://localhost:4173**

The host page imports `attach` from `powersync-lynx/web-host`, calls it on
`<lynx-view>` **before** setting `url` to `/main.web.bundle`. Vite rewrites
`import.meta.url` so the lynx-bg factory and `@powersync/web` workers stay
executable ESM (the PR 7 factory mechanism).

```bash
pnpm build          # rspeedy web + lynx
pnpm preview:web    # production host-dist
```

Rspeedy `source.include` compiles `@powersync/common`, `@powersync/shared-internals`,
and the Client TypeScript (PrimJS does not accept untransformed `??=`).

## Run: iOS (native host)

1. `pnpm build` in `examples/showcase` (lynx bundle)
2. Follow [`hosts/ios/README.md`](hosts/ios/README.md): Autolink Podfile,
   `LynxService/Http`, PageConfig `enableFetchAPIStandardStreaming = true`
3. Point `LynxView` at `lynx-dist/main.lynx.bundle`

**Not verified here:** Xcode build, simulator/device, live streaming, cancellation.

## Run: Android (native host)

1. `pnpm build` in `examples/showcase`
2. Follow [`hosts/android/README.md`](hosts/android/README.md): Autolink Gradle
   plugins, `lynx-service-http`, `LynxHttpService` registration, streaming flag
3. Point LynxView at `lynx-dist/main.lynx.bundle`

**Not verified here:** Gradle APK, emulator/device, live streaming, cancellation.

## Run: Windows and macOS (native hosts)

Scaffold only: [`hosts/desktop/README.md`](hosts/desktop/README.md).
`pluginLynxtron()` + `powersync-lynx/lynxtron`. Desktop HTTP Service is a stub
in Lynx's own integration guide. **Not launched in this environment.**

## Lint / format

`examples/` is a ReactLynx consumer (component props, JSX, Rspeedy/Vite). The
library anti-slop plugin (`no-object-parameters`) is incompatible with React
function components, so **root oxlint ignores `examples/`**. oxfmt still
formats showcase TypeScript. Generated `lynx-dist/`, `host-dist/`, and
`node_modules/` are ignored.

Root checks (library):

```bash
pnpm lint
pnpm typecheck
pnpm test
```

Showcase checks:

```bash
pnpm --dir examples/showcase typecheck
pnpm --dir examples/showcase build
```

## Layout

```
examples/
  README.md                 this guide
  showcase/                 ReactLynx app + Lynx-for-Web host
    src/                    Lynx bundle (Schema, Connector, UI)
    host/                   attach() page (Vite)
    lynx.config.ts          environments.web + environments.lynx
  hosts/
    ios/                    Autolink + HTTP Service recipe
    android/                Autolink + HTTP Service recipe
    desktop/                Lynxtron scaffold
```
