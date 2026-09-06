# Lynx networking for the PowerSync sync protocol

Can the PowerSync JavaScript sync loop (HTTP streaming and/or WebSocket) run in Lynx JS, or does the Adapter need native HTTP?

**Snapshot:** 2026-09-06. Published packages: `@powersync/common@2.2.0`, `@powersync/shared-internals@1.2.0`. Destination pins Lynx 4.0+.

This note does not design the Client. Facts the later contract ticket needs.

**Answer:** The download loop is JavaScript (`@powersync/shared-internals`), not the SQLite Adapter. HTTP streaming is the preferred path and can run in Lynx JS **if** Lynx `fetch` actually yields incremental `Response.body` chunks. That is documented as an **experimental** PageConfig on Android/iOS (`enableFetchAPIStandardStreaming`, LynxSDK 3.7+). Lynx-for-Web uses browser `fetch` in the host page, so it matches the official Web SDK. WebSocket is a documented PowerSync fallback (RSocket-over-WS) but is **not** a documented Lynx application API. Connector `fetchCredentials` / `uploadData` are ordinary JSON `fetch` in app JS and do not need streaming. Native HTTP is a **flag**, not the default: only if streaming `fetch` fails on a target host and WebSocket is also unavailable.

Does **not** force moving `@powersync/common` out of Lynx JS or wrapping Kotlin/Swift as the runtime.

---

## 1. What the PowerSync JS sync loop actually does

The Client SDK connects to the PowerSync Service over **HTTP streams or WebSockets**. ([docs.powersync.com/architecture/client-architecture](https://docs.powersync.com/architecture/client-architecture.md))

Protocol (same for initial download, catch-up, and live incremental): client sends JWT + current buckets/op IDs; service streams checkpoint-available, data ops, checkpoint-complete, then waits for the next checkpoint. Interrupt → new session from last point. ([docs.powersync.com/architecture/powersync-protocol](https://docs.powersync.com/architecture/powersync-protocol.md))

JS transport (`@powersync/shared-internals` `AbstractRemote`):

1. **HTTP (preferred):** `POST {endpoint}/sync/stream` with JSON body, `Authorization: Token {jwt}`, `Accept: application/vnd.powersync.bson-stream;q=0.9, application/x-ndjson;q=0.8`, `cache: 'no-store'`, abort `signal`. Requires `res.ok` **and** `res.body`. Reads with `res.body.getReader()`. NDJSON lines via `TextDecoder`; BSON via `Uint8Array` chunks. ([github.com/powersync-ja/powersync-js `packages/shared-internals/src/client/sync/stream/AbstractRemote.ts`](https://github.com/powersync-ja/powersync-js/blob/main/packages/shared-internals/src/client/sync/stream/AbstractRemote.ts))
2. **WebSocket (fallback):** `https` → `wss`. RSocket (`rsocket-core` + `rsocket-websocket-client`), not a raw JSON WebSocket. Uses `new WebSocket(url)` (overridable). Keepalive 20s, socket timeout 30s. ([same tree `WebSocketSupport.ts`](https://github.com/powersync-ja/powersync-js/blob/main/packages/shared-internals/src/client/sync/stream/WebSocketSupport.ts); RN/Web docs below)

`connectionMethod` is `SyncStreamConnectionMethod.HTTP | WEB_SOCKET` on `connect()`. Default is HTTP on most SDKs. React Native without Expo uses WebSocket because **RN `fetch()` cannot stream**. ([@powersync/common `packages/common/src/client/sync/options.ts`](https://github.com/powersync-ja/powersync-js/blob/main/packages/common/src/client/sync/options.ts); [docs.powersync.com/client-sdks/reference/react-native-and-expo](https://docs.powersync.com/client-sdks/reference/react-native-and-expo.md))

| SDK | Default `connectionMethod` | Why |
| --- | --- | --- |
| JavaScript Web | HTTP | Browser `fetch` streams. Web docs: “no compelling reason to use WebSockets over HTTP response streams.” ([javascript-web](https://docs.powersync.com/client-sdks/reference/javascript-web.md)) |
| React Native + Expo | HTTP | `expo/fetch` supports streams. ([react-native-and-expo](https://docs.powersync.com/client-sdks/reference/react-native-and-expo.md); [RN `fetch.ts`](https://github.com/powersync-ja/powersync-js/blob/main/packages/react-native/src/sync/stream/fetch.ts)) |
| Plain React Native | WebSocket | Built-in RN `fetch` has `supportsStreams: false`. HTTP throws unless a custom streaming `fetchImplementation` is passed. ([RN `ReactNativeRemote.ts`](https://github.com/powersync-ja/powersync-js/blob/main/packages/react-native/src/sync/stream/ReactNativeRemote.ts); [RN `PowerSyncDatabase.ts`](https://github.com/powersync-ja/powersync-js/blob/main/packages/react-native/src/db/PowerSyncDatabase.ts)) |
| Node | HTTP | Node `fetch` streams. ([supported-platforms](https://docs.powersync.com/resources/supported-platforms.md); [Node `NodeRemote.ts`](https://github.com/powersync-ja/powersync-js/blob/main/packages/node/src/sync/stream/NodeRemote.ts)) |

Platform table: RN HTTP **and** WS yes (WS default); JS Web both yes (HTTP default); Flutter/Swift/.NET/Rust HTTP yes, WS no. ([supported-platforms](https://docs.powersync.com/resources/supported-platforms.md))

Service keepalive (every ~20s) also triggers `uploadData()`. That is a **protocol** keepalive, not Fetch `RequestInit.keepalive`. ([client-side-integration](https://docs.powersync.com/configuration/app-backend/client-side-integration.md))

---

## 2. Who owns the stream: `common` vs platform package

Split in published 2.x JS:

| Layer | Package | Owns |
| --- | --- | --- |
| Public types / Connector / `connect()` | `@powersync/common` | `PowerSyncBackendConnector`, `PowerSyncCredentials`, `SyncStreamConnectionMethod`, `CommonPowerSyncDatabase.connect` |
| Loop + HTTP/WS bytes | `@powersync/shared-internals` | `AbstractStreamingSyncImplementation` (checkpoints, CRUD upload loop, `powersync_control`), `AbstractRemote.fetchStream` / `socketStreamRaw` |
| Platform Remote | `@powersync/web`, `@powersync/react-native`, `@powersync/node` | Concrete `fetch()`, `createSocket()`, `loadWebSocketSupport()`, default `connectionMethod`, user-agent |

`@powersync/common` **does not** POST `/sync/stream`. `BasePowerSyncDatabase.defaultConnectionMethod` is HTTP; RN overrides it from `fetch.supportsStreams`. Each platform constructs `XxxRemote` + `XxxStreamingSyncImplementation`. ([`BasePowerSyncDatabase.ts`](https://github.com/powersync-ja/powersync-js/blob/main/packages/shared-internals/src/client/BasePowerSyncDatabase.ts); [`WebRemote.ts`](https://github.com/powersync-ja/powersync-js/blob/main/packages/web/src/db/sync/WebRemote.ts); RN files above)

**Implication for this Client:** a Lynx platform package (LynxRemote + LynxStreamingSyncImplementation) is the RN/Web/Node pattern. The Adapter stays `DBAdapter` (SQLite + core). The stream stays in Lynx **background** JS unless a host’s `fetch` cannot stream **and** WebSocket is missing.

---

## 3. Connector `fetchCredentials` / `uploadData`

Same object official JS uses. Lives in **app JavaScript**. ([CONTEXT.md](../../CONTEXT.md); [PowerSyncBackendConnector.ts](https://github.com/powersync-ja/powersync-js/blob/main/packages/common/src/client/connection/PowerSyncBackendConnector.ts))

- `fetchCredentials()` → `{ endpoint, token, expiresAt? }`. SDK caches; calls on connect, ~30s before JWT expiry, after expiry, on 401. Always return a fresh token. ([client-side-integration](https://docs.powersync.com/configuration/app-backend/client-side-integration.md); RN/Web SDK pages)
- `uploadData(database)` → `getNextCrudTransaction()` / `getCrudBatch()`, POST mutations to **the app backend** (not PowerSync Service), then `.complete()`. Ordinary JSON `fetch`. Throw only for transient errors. ([same](https://docs.powersync.com/configuration/app-backend/client-side-integration.md))

These calls do **not** use `/sync/stream`, `Response.body`, Blob, FormData, or `keepalive`. Lynx native `fetch` with `method`/`headers`/`JSON.stringify` body is the documented request shape. ([lynxjs.org/guide/interaction/networking](https://lynxjs.org/guide/interaction/networking.md); [lynxjs.org/react/data-fetching](https://lynxjs.org/react/data-fetching.md))

| Surface | Which `fetch` |
| --- | --- |
| Native iOS/Android/Windows/macOS Lynx bundle | Lynx `fetch` (host HTTP Service) |
| Lynx-for-Web | Browser `fetch` (CORS applies) |

`fetch` is **background-thread only**. ([lynxjs.org/llms.txt](https://lynxjs.org/llms.txt) appendix)

---

## 4. Lynx `fetch`, streaming, EventSource, Web

### Host HTTP Service (required for native `fetch`)

Lynx Fetch “depends on the HTTP service provided by the integrated Lynx Service.” Engine looks up a registered service; it does not ship networking itself. ([networking](https://lynxjs.org/guide/interaction/networking.md); [LynxService API](https://lynxjs.org/api/lynx-native-api/lynx-service.md))

| Host | How HTTP is injected |
| --- | --- |
| iOS | `pod 'LynxService', …, :subspecs => ['Http']` |
| Android | `org.lynxsdk.lynx:lynx-service-http` + `LynxServiceCenter.registerService(LynxHttpService)` (+ OkHttp in the official sample) |
| Windows / macOS | Host implements `lynx::pub::LynxHttpService::Request` and `LynxServiceCenter::RegisterService`. Integrate docs: “Register http service for lynx.fetch.” |
| Web | **No LynxService.** Fetch uses the browser. LynxService compatibility: Web ❌ |

([integrate-with-existing-apps](https://lynxjs.org/guide/start/integrate-with-existing-apps.md); [lynx-service](https://lynxjs.org/api/lynx-native-api/lynx-service.md))

`fetch` itself: Android/iOS 2.18+, HarmonyOS 3.5, Clay macOS/Windows 3.7, Web yes. ([fetch API](https://lynxjs.org/api/lynx-api/global/fetch.md))

### Native Fetch gaps (not Web)

Official compatibility note: native Lynx does **not** support CORS, **redirect**, **keepalive**, **FormData/Blob**. Web uses the browser Fetch and follows Web rules. ([fetch API](https://lynxjs.org/api/lynx-api/global/fetch.md))

Against PowerSync:

| Gap | Sync download | Connector |
| --- | --- | --- |
| CORS | N/A on native | N/A on native; **yes on Lynx-for-Web** (browser CORS to PowerSync + app API) |
| `redirect` | Unlikely on `/sync/stream` | Same |
| `keepalive` | Unused (`RequestInit.keepalive`). Protocol keepalive is independent | Unused |
| FormData/Blob | Unused (JSON body; stream is `getReader()` bytes) | Unused for MVP JSON CRUD. Attachments later. |
| `cache: 'no-store'` | PowerSync HTTP sets it. Native Fetch compatibility tables did not render in this fetch; [INFERENCE] unknown options are ignored. POST streams are typically uncached. | Unused |

LCD tables for `RequestInit.signal` / `cache` did not render in fetched markdown, so those fields are **unverified here**. PowerSync abort depends on `AbortController` + `signal`. [INFERENCE] JSC/PrimJS often have `AbortController`; confirm on device.

### Experimental streaming Fetch

Lynx documents `response.body.getReader()` + `TextCodecHelper.decode(value)` against a streaming URL. **Experimental.** Enable PageConfig `enableFetchAPIStandardStreaming = true`. ([networking](https://lynxjs.org/guide/interaction/networking.md))

`enableFetchAPIStandardStreaming`: when enabled, Fetch uses the **standard** streaming response path; when disabled/unset, non-standard fallback unless a legacy flag is present. **Supported platform: Android, iOS. Since: LynxSDK 3.7.** Not listed for Clay macOS/Windows, HarmonyOS, or Web. ([rspeedy Config](https://lynxjs.org/next/api/rspeedy/type-config.config.html))

`llms.txt` also mentions `lynxExtension.useStreaming`. The networking guide’s name is `enableFetchAPIStandardStreaming`. [INFERENCE] older/alternate name; the PageConfig field is the one to set.

PowerSync **requires** `res.body` (`if (!res.ok || !res.body) throw`). Without standard streaming, `body` may be missing or only complete after the connection ends — that is the RN failure mode.

PrimJS has **no** `TextEncoder`/`TextDecoder`. Lynx ships `TextCodecHelper` (UTF-8 string ↔ ArrayBuffer). ([networking](https://lynxjs.org/guide/interaction/networking.md); [llms.txt](https://lynxjs.org/llms.txt)) PowerSync NDJSON uses `new TextDecoder()` in `AbstractRemote.createTextDecoder()`, with an explicit hook “to allow patching it for Hermes … without forcing us to bundle a polyfill with `@powersync/common`.” A Lynx Remote **must** override this (or polyfill). BSON path does not need `TextDecoder`. This is a JS patch, not native HTTP.

### EventSource

`new lynx.EventSource(url)` — Web-shaped SSE. ([networking](https://lynxjs.org/guide/interaction/networking.md)) PowerSync HTTP is **POST `/sync/stream`** NDJSON/BSON, not SSE `text/event-stream`. EventSource cannot replace the sync loop. It is also absent from the published global API index ([lynx-api/global](https://lynxjs.org/api/lynx-api/global.md)).

### WebSocket

Lynx networking docs cover `fetch`, streaming `fetch`, EventSource, `TextCodecHelper`. No application `WebSocket` constructor. Rspeedy `dev.hmr` / `liveReload` WebSocket is the **dev server**, not app networking. PowerSync WS needs `WebSocket` + RSocket. [INFERENCE] do not treat WS as a Lynx-JS fallback unless a host polyfill (`@lynx-js/websocket` appears in engine issues, not the networking guide) is an explicit product choice.

### Lynx-for-Web

Locked architecture: Host helper runs `@powersync/web` in the **host page**. Browser `fetch` streams; HTTP is the Web SDK default. CORS and cookies apply. No `enableFetchAPIStandardStreaming`. Multi-tab/workers belong to [Survey a Lynx-for-Web Host helper on @powersync/web](../../.scratch/lynx-powersync-client-spec/issues/05-survey-web-host-helper.md), not this note.

---

## 5. Per-host verdict

| Host | Sync download in Lynx JS? | Native HTTP? |
| --- | --- | --- |
| iOS / Android | **Likely HTTP**, with `enableFetchAPIStandardStreaming`, HTTP Service registered, `createTextDecoder` patched, background thread. Prove `getReader()` yields **incremental** chunks, not a buffered full body. | Only if that proof fails. |
| Windows / macOS | `fetch` exists (Clay 3.7) via **host-implemented** `LynxHttpService`. Streaming PageConfig **not** listed for Clay. Host `Request` must stream or JS never sees chunks. | **Flag.** Desktop HTTP Service is a stub (`// TODO`) in integrate docs. |
| Lynx-for-Web | **Yes**, in the host page via `@powersync/web` + browser `fetch`. Not inside the Lynx bundle. | No. |
| HarmonyOS | Out of destination. | — |

Connector JSON `fetch` is available wherever HTTP Service (or browser Fetch) is wired. That is independent of streaming.

---

## 6. Flags (do not re-decide the locked stack)

Locked: `@powersync/common` in Lynx JS; native Adapter is SQLite + `powersync-sqlite-core`; web is host-page `@powersync/web`. Nothing here forces wrapping Kotlin/Swift as the JS runtime.

Flags for the contract ticket:

1. **Android/iOS streaming is experimental.** If `enableFetchAPIStandardStreaming` does not deliver incremental `ReadableStream` chunks, HTTP download cannot run in JS. Same class of bug as RN without `expo/fetch`.
2. **Windows/macOS streaming is undocumented.** Host `LynxHttpService` may need to implement streaming; otherwise native HTTP (or a JS-facing stream Native Module) is required on desktop only.
3. **No documented Lynx WebSocket.** WS cannot be assumed as the RN-style fallback. If HTTP streaming fails, the alternative is native HTTP, not `connectionMethod: WEB_SOCKET`, unless the Client ships a WebSocket polyfill.
4. **`TextDecoder` missing on PrimJS.** Override `createTextDecoder` (or polyfill). Not a reason for native HTTP.
5. **`AbortController` / `RequestInit.signal` / `cache`.** Confirm on device. Abort is how PowerSync disconnects a live stream. If `signal` is ignored, disconnect leaks connections — still JS-fixable (timeout/close API) before native HTTP.
6. **Lynx-for-Web CORS.** Host-page `@powersync/web` must be allowed to call the PowerSync endpoint and the app upload API.
7. **HTTP Service omitted** → `fetch` does not work at all (download **and** Connector). That is a host integrate requirement, not an Adapter protocol.

None of these say “move the sync loop out of JS” unless (1) or (2) fail on a ship host **and** (3) stays true.

---

## Sources

1. https://docs.powersync.com/architecture/client-architecture.md — HTTP or WS; JWT; SQLite; upload queue
2. https://docs.powersync.com/architecture/powersync-protocol.md — checkpoint / data / complete stream
3. https://docs.powersync.com/client-sdks/reference/react-native-and-expo.md — HTTP default Expo; WS because RN `fetch` cannot stream; Connector
4. https://docs.powersync.com/client-sdks/reference/javascript-web.md — HTTP default/recommended; WS optional
5. https://docs.powersync.com/configuration/app-backend/client-side-integration.md — `fetchCredentials` / `uploadData` when-called; 20s keepalive
6. https://docs.powersync.com/resources/supported-platforms.md — HTTP/WS by SDK
7. https://github.com/powersync-ja/powersync-js/blob/main/packages/common/src/client/sync/options.ts — `SyncStreamConnectionMethod`
8. https://github.com/powersync-ja/powersync-js/blob/main/packages/common/src/client/connection/PowerSyncBackendConnector.ts
9. https://github.com/powersync-ja/powersync-js/blob/main/packages/shared-internals/src/client/sync/stream/AbstractRemote.ts — POST `/sync/stream`, `getReader`, `TextDecoder`
10. https://github.com/powersync-ja/powersync-js/blob/main/packages/shared-internals/src/client/sync/stream/AbstractStreamingSyncImplementation.ts — HTTP vs WS branch; `/sync/stream`
11. https://github.com/powersync-ja/powersync-js/blob/main/packages/shared-internals/src/client/sync/stream/WebSocketSupport.ts — RSocket
12. https://github.com/powersync-ja/powersync-js/blob/main/packages/shared-internals/src/client/BasePowerSyncDatabase.ts — default HTTP; platform Remote
13. https://github.com/powersync-ja/powersync-js/blob/main/packages/react-native/src/sync/stream/fetch.ts — `expo/fetch` vs RN polyfill
14. https://github.com/powersync-ja/powersync-js/blob/main/packages/react-native/src/sync/stream/ReactNativeRemote.ts
15. https://github.com/powersync-ja/powersync-js/blob/main/packages/react-native/src/db/PowerSyncDatabase.ts — default method from `supportsStreams`
16. https://github.com/powersync-ja/powersync-js/blob/main/packages/web/src/db/sync/WebRemote.ts — global `fetch`
17. https://github.com/powersync-ja/powersync-js/blob/main/packages/node/src/sync/stream/NodeRemote.ts
18. https://cdn.jsdelivr.net/npm/@powersync/common/package.json — 2.2.0
19. https://cdn.jsdelivr.net/npm/@powersync/shared-internals/package.json — 1.2.0
20. https://lynxjs.org/guide/interaction/networking.md — Fetch + HTTP Service; experimental streaming; EventSource; TextCodecHelper
21. https://lynxjs.org/api/lynx-api/global/fetch.md — no CORS/redirect/keepalive/FormData/Blob on native; Web = browser Fetch
22. https://lynxjs.org/next/api/rspeedy/type-config.config.html — `enableFetchAPIStandardStreaming` Android/iOS 3.7
23. https://lynxjs.org/guide/start/integrate-with-existing-apps.md — Http subspec / `LynxHttpService` / desktop TODO
24. https://lynxjs.org/api/lynx-native-api/lynx-service.md — Service lookup; Web ❌
25. https://lynxjs.org/llms.txt — BTS-only `fetch`; PrimJS no TextEncoder/Decoder
26. https://lynxjs.org/react/data-fetching.md — Fetch + TanStack Query; compatibility diffs
27. https://lynxjs.org/api/lynx-api/global.md — globals: fetch, timers, SystemInfo; no EventSource/WebSocket
