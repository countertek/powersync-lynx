# iOS native host (Autolink)

A Lynx **4.0** iPhone app that loads the ReactLynx TODO bundle and Autolinks
`NativePowerSyncModule`. Simulator is the path this repo verifies. Lynx Explorer
does **not** register the module.

## Prerequisites

- Xcode 16+ (this environment: Xcode 26.6)
- iOS **15.0+** (simulator does not need a signing team)
- CocoaPods >= 1.11.3
- gem `cocoapods-lynx-library` (`gem install cocoapods-lynx-library`)
- pnpm **12**
- The local compose stack from [`examples/README.md`](../../README.md) (`postgres` :5432, `powersync` :8080, `demo-api` :8081)

## Install / build / run (simulator)

From the repository root:

```bash
pnpm --dir examples/showcase install
pnpm --dir examples/showcase build          # emits examples/showcase/lynx-dist/main.lynx.bundle

pnpm --dir examples/hosts install           # Autolink scans this node_modules for lynx.lib.json
gem install cocoapods-lynx-library          # once per machine

cd examples/hosts/ios
pod install
xcodebuild -workspace PowerSyncLynxShowcase.xcworkspace \
  -scheme PowerSyncLynxShowcase \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO \
  build

APP=$(find build -name PowerSyncLynxShowcase.app | head -1)
UDID=$(xcrun simctl list devices available | awk -F '[()]' '/iPhone 17 Pro/{print $2; exit}')
xcrun simctl boot "$UDID" || true
xcrun simctl install "$UDID" "$APP"
xcrun simctl launch --console "$UDID" com.powersync.lynx.showcase
```

The simulator reaches `127.0.0.1` on the Mac, so it uses the same URLs as the web demo.

Open the Xcode workspace (not the `.xcodeproj`) after `pod install`. User Script Sandboxing is off so the Copy Lynx bundle phase can read `examples/showcase/lynx-dist/`.

## Server addressing

| Source | Keys |
|---|---|
| Info.plist (defaults) | `DEMO_DEVICE=ios`, `DEMO_API_URL=http://127.0.0.1:8081`, `POWERSYNC_URL=http://127.0.0.1:8080` |
| Process environment | `DEMO_DEVICE`, `DEMO_API_URL`, `POWERSYNC_URL` (`SIMCTL_CHILD_` prefix with `simctl launch`) |
| argv | `-DemoDevice ios-b -DemoApiUrl http://127.0.0.1:8081 -PowerSyncUrl http://127.0.0.1:8080` |

Two-client on two simulators:

```bash
xcrun simctl launch "$UDID_A" com.powersync.lynx.showcase -DemoDevice ios-a
xcrun simctl launch "$UDID_B" com.powersync.lynx.showcase -DemoDevice ios-b
```

Or one simulator + the web demo at `http://localhost:4173/?device=web-b`.

ATS is `NSAllowsLocalNetworking` only (not `NSAllowsArbitraryLoads`).

## Physical device

1. Set `DEMO_API_URL` / `POWERSYNC_URL` in Info.plist to `http://<Mac LAN IP>:8081` / `:8080`.
2. Confirm the compose ports are reachable on that LAN.
3. Sign the app with your team (`DEVELOPMENT_TEAM`) and run from Xcode. This checkout does not ship a signing identity.

## Troubleshooting

| Symptom | Check |
|---|---|
| `NativePowerSyncModule is not registered` | Open the **workspace**. `pod install` must see `examples/hosts/node_modules/powersync-lynx/lynx.lib.json`. |
| Copy Lynx bundle phase fails | `pnpm --dir examples/showcase build` first. |
| `connect skipped` | Compose profile `sync` is down, or ATS blocked a non-local URL. |
| Empty input field | `XElement` pod is missing. |
| Download hangs / `ps_buckets=0` after server 200 | Use `NativePowerSyncModule.httpFetch` (rebuild showcase + app). Confirm `streamingId` + GlobalEventEmitter `onData` (not idle-complete-only). Stock `LynxFetchModule.fetch` alone cannot deliver live NDJSON on PrimJS. |
| Stream never incremental | Bundle PageConfig `enableFetchAPIStandardStreaming` is set in `examples/showcase/lynx.config.ts`. Confirm `LynxHttpService` is registered before `LynxEnv` init. |

## `/sync/stream` download path (iOS)

Stock Lynx fetch on iOS does not deliver PowerSync’s live NDJSON body to PrimJS (`ps_buckets=0` on the identifier/`LynxFetchModule` path).

**Current path:** `LynxRemote` picks the `native-http` `SyncStreamTransport`, which calls `NativePowerSyncModule.httpFetch` for streaming downloads on iOS the same way as Android.

1. **Callback (one-shot):** status + `streamingId`, empty body.
2. **Chunks:** `NSURLSession` data delegate keeps the connection open and posts UTF-8 `onData` / `onEnd` via `LynxView.sendGlobalEvent` (or `initWithParam` event sender).
3. **JS:** incremental ReadableStream apply — not ~2.5s idle-complete batching.

Presence-only gate — do not require `typeof httpFetch === "function"`. Idle-complete remains a fallback when no event sender / LynxView is reachable.

The showcase `ViewController` calls `[NativePowerSyncModule setSharedStreamEventSender:lynxView]` after creating the view so `sendGlobalEvent` is available (Autolink does not pass the view as `initWithParam`).

Confirm the module exports `httpFetch` and `httpFetchAbort` in `methodLookup`.

### Rebuild after this change

```bash
pnpm --dir examples/showcase install
pnpm --dir examples/showcase build
pnpm --dir examples/hosts install
gem install cocoapods-lynx-library   # once per machine

cd examples/hosts/ios
pod install
xcodebuild -workspace PowerSyncLynxShowcase.xcworkspace \
  -scheme PowerSyncLynxShowcase \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO \
  build

APP=$(find build -name PowerSyncLynxShowcase.app | head -1)
UDID=$(xcrun simctl list devices available | awk -F '[()]' '/iPhone 17 Pro/{print $2; exit}')
xcrun simctl boot "$UDID" || true
# Prefer a clean install so an old Autolinked module binary is not reused:
xcrun simctl uninstall "$UDID" com.powersync.lynx.showcase || true
xcrun simctl install "$UDID" "$APP"
xcrun simctl launch --console "$UDID" com.powersync.lynx.showcase
```

### Verify downloads (not `hasSynced` alone)

1. Local stack up (`examples/docker-compose.yml`); create a todo via demo-api / web / Postgres.
2. On the simulator, confirm the todo appears in the list.
3. Optional SQLite check: `ps_buckets` count **> 0** and todos present after the server checkpoint.
4. Upload still works: add a todo on device and see it in Postgres / another client.

Expect `NativePowerSyncModule.httpFetch` incremental stream with a `NativePowerSyncHttpStream*` `streamingId` (not identifier-only / empty body). PowerSync logger debug: `powersync-lynx /sync/stream via native-http`. Cross-device: add a todo on web → it should appear on native promptly while the stream stays open.

Adapter tests: `NODE_OPTIONS=--experimental-strip-types pnpm test`  
Native Module (Mac): `make test-ios`

## What this environment verified

This checkout, 2026-09-08/09. Simulator **iPhone 17 Pro** (`ADEBF68F-584E-4A5D-9A9B-F0E134D10019`), iOS **26.5**, Xcode **26.6**, CocoaPods 1.17.0, Lynx pods **4.0.0**, pnpm **12.3.4**.

| Claim | Result |
|---|---|
| Build + install + launch | **Yes.** `xcodebuild` Debug iphonesimulator `CODE_SIGNING_ALLOWED=NO`, `simctl install` / `launch`. Bundle id `com.powersync.lynx.showcase` |
| UI paints, local DB ready after relaunch | **Yes.** After swapping the rebuilt `main.lynx.bundle` and force-stop relaunch (`ios-t2`): navy TODO screen, `DB ready`, composer/filters visible. `connect()` no longer blocks that pill |
| Sync handshake | **Partial (pre-httpFetch).** Log reached `connect: http://127.0.0.1:8080 as ios-t2` and sometimes `connected` / `sync connected`. Then `errorStreamingMalformedResponse`. `ps_data__todos` stayed 0 |
| Receive another client's rows | **No this checkout (pre-httpFetch).** Postgres still has `round2add` / `ande2e`; this Simulator store did not download them. Re-verify after rebuild with `httpFetch` / `streamingId` realtime |
| Add / toggle / delete / filter / restart persist | Composer is on screen after relaunch. **HID not used** this checkout |
| Go offline / Reconnect | Control is visible (`Go offline`). **Not tapped** here |
| Physical device | **Not run** |

Limitations: Lynx list rows often omit a11y nodes. `simctl io` screenshots of the LCD are the evidence, not the Simulator chrome. PrimJS iOS `fetch` is the identifier, not `globalThis.fetch`.
