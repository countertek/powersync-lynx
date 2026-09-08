# Windows and macOS native hosts (Lynxtron)

Lynxtron Autolink is the supported desktop path. CMake
`LynxEnv.RegisterNativeModule("NativePowerSyncModule", …)` is the documented
fallback, not a second product.

## What this environment verified

- The ReactLynx **lynx** bundle compiles (same artifact as iOS/Android).
- A Lynxtron desktop host was **not** launched here. Windows and macOS
  streaming are undocumented; the integration guide's HTTP Service example is
  a stub. Incremental delivery and `RequestInit.signal` cancellation are
  **not verified**.

## Autolink

The library ships `lynx.lib.json` keys `lynxtron`, `macos`, and `windows`, plus
`powersync-lynx/lynxtron` which loads `dist/<host>/<arch>/powersync-lynx.node`.

In the desktop host's Rspeedy/Lynxtron config:

```ts
import { pluginLynxtron } from "@lynx-js/lynxtron-rsbuild-plugin"; // name as published by Lynx 4.0

export default defineConfig({
  plugins: [pluginLynxtron()],
});
```

The host `package.json` depends on `powersync-lynx` so Autolink can see
`lynx.lib.json`. `pluginLynxtron()` `require`s `powersync-lynx/lynxtron`.

## HTTP Service

Desktop hosts must implement and register `LynxHttpService`. The Android/iOS
PageConfig streaming flag does not apply. Without a real HTTP Service,
Connector fetches and `/sync/stream` will not run.

## Load the bundle

Point the Lynxtron view at `examples/showcase/lynx-dist/main.lynx.bundle`.
