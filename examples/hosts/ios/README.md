# iOS native host (Autolink)

This is a drop-in recipe for a Lynx **4.0+** iOS host that loads the showcase bundle
and Autolinks `powersync-lynx`. It is not a full Xcode project.

Lynx Explorer does **not** include `NativePowerSyncModule`. Loading the Rspeedy
QR/URL in Explorer will fail at `waitForReady`. Use this host (or the web host).

## What this environment verified

- The ReactLynx **lynx** bundle compiles (`pnpm --dir examples/showcase build`).
- This iOS host was **not** built with Xcode and was **not** run on a simulator
  or device. Live `/sync/stream` incremental delivery and `disconnect()` cancellation
  are **not verified** on iOS.

## Prerequisites

- Xcode, iOS **15.0+**
- CocoaPods >= 1.11.3
- gem `cocoapods-lynx-library`
- Lynx **4.0+** (`Lynx`, `LynxService` with `Http`)
- The showcase npm package installed so Autolink can see `lynx.lib.json`

## Podfile

```ruby
source 'https://cdn.cocoapods.org/'
platform :ios, '15.0'

plugin 'cocoapods-lynx-library'

target 'PowerSyncLynxShowcase' do
  use_lynx_library!

  pod 'Lynx', '4.0.0', :subspecs => ['Framework']
  pod 'PrimJS', '4.0.0', :subspecs => ['quickjs', 'napi']
  pod 'LynxService', '4.0.0', :subspecs => ['Image', 'Log', 'Http']
end
```

`use_lynx_library!` discovers `powersync-lynx` via the host app `package.json`
dependency (`file:../..` in this repo, or a packed tarball in a consumer app).

## HTTP Service + streaming flag

Autolink registers `NativePowerSyncModule`. It does **not** install the HTTP
Service. Without `LynxService/Http` and PageConfig
`enableFetchAPIStandardStreaming = true` (LynxSDK 3.7+), Connector fetches and
`/sync/stream` will not run. Incremental delivery still remains unverified.

See `AppDelegate.mm` in this folder for the init order.

## Load the bundle

Point `LynxView` at the Rspeedy lynx artifact:

`examples/showcase/lynx-dist/main.lynx.bundle`

(Exact filename is whatever `pnpm --dir examples/showcase build` emits.)
