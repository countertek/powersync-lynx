# Android native host (Autolink)

This is a drop-in recipe for a Lynx **4.0+** Android host that loads the showcase
bundle and Autolinks `powersync-lynx`. It is not a full Android Studio app.

Lynx Explorer does **not** register `NativePowerSyncModule`. There is no
Explorer/QR run path; see the try-it guide [`examples/README.md`](../../README.md).

## What this environment verified

- The ReactLynx **lynx** bundle compiles (`pnpm --dir examples/showcase build`).
- This Android host was **not** assembled with Gradle against a device/emulator
  in the examples task. Live `/sync/stream` incremental delivery and
  `disconnect()` cancellation are **not verified** on Android.

Floors: minSdk **24**, compileSdk 35, Lynx **4.0+**.

## Autolink Gradle

`settings.gradle`:

```gradle
plugins {
  id 'org.lynxsdk.library-settings'
}
```

`app/build.gradle`:

```gradle
plugins {
  id 'com.android.application'
  id 'org.lynxsdk.library-build'
}

dependencies {
  implementation 'org.lynxsdk.lynx:lynx:4.0.1'
  implementation 'org.lynxsdk.lynx:lynx-service-http:4.0.1'
}
```

The host app `package.json` must depend on `powersync-lynx` so Autolink can
find `lynx.lib.json`.

## HTTP Service + streaming flag

Register `LynxHttpService` with `LynxServiceCenter` before creating LynxView.
Set PageConfig `enableFetchAPIStandardStreaming = true` (LynxSDK 3.7+).
Service registration is a prerequisite, not proof of incremental delivery.
`ShowcaseApplication.kt` in this folder registers the HTTP Service before
`LynxEnv` init; this recipe does not include a LynxView.

## Load the bundle

Point LynxView at `examples/showcase/lynx-dist/main.lynx.bundle`.
