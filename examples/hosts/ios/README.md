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
| Stream never incremental | Bundle PageConfig `enableFetchAPIStandardStreaming` is set in `examples/showcase/lynx.config.ts`. Confirm `LynxHttpService` is registered before `LynxEnv` init. |

## What this environment verified

This checkout, 2026-09-08/09. Simulator **iPhone 17 Pro** (`ADEBF68F-584E-4A5D-9A9B-F0E134D10019`), iOS **26.5**, Xcode **26.6**, CocoaPods 1.17.0, Lynx pods **4.0.0**, pnpm **12.3.4**.

| Claim | Result |
|---|---|
| Build + install + launch | **Yes.** `xcodebuild` Debug iphonesimulator `CODE_SIGNING_ALLOWED=NO`, `simctl install` / `launch`. Bundle id `com.powersync.lynx.showcase` |
| UI paints, local DB ready after relaunch | **Yes.** After swapping the rebuilt `main.lynx.bundle` and force-stop relaunch (`ios-t2`): navy TODO screen, `DB ready`, composer/filters visible. `connect()` no longer blocks that pill |
| Sync handshake | **Partial.** Log reached `connect: http://127.0.0.1:8080 as ios-t2` and sometimes `connected` / `sync connected`. Then `errorStreamingMalformedResponse`. `ps_data__todos` stayed 0 |
| Receive another client's rows | **No this checkout.** Postgres still has `round2add` / `ande2e`; this Simulator store did not download them |
| Add / toggle / delete / filter / restart persist | Composer is on screen after relaunch. **HID not used** this checkout |
| Go offline / Reconnect | Control is visible (`Go offline`). **Not tapped** here |
| Physical device | **Not run** |

Limitations: Lynx list rows often omit a11y nodes. `simctl io` screenshots of the LCD are the evidence, not the Simulator chrome. PrimJS iOS `fetch` is the identifier, not `globalThis.fetch`.
