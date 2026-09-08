# Android native host (Autolink)

A Lynx **4.0** Android app that loads the ReactLynx TODO bundle and Autolinks
`NativePowerSyncModule`. Emulator is the path this repo verifies. Lynx Explorer
does **not** register the module.

Floors: minSdk **24**, compileSdk 35, Lynx **4.0.1** (PrimJS **4.0.0** — Maven has no `primjs:4.0.1`), Autolink Gradle plugins **4.0.1**.

## Prerequisites

- JDK 17 (`JAVA_HOME`)
- Android SDK with `platforms;android-35` (or 36) and an ARM64 emulator image
- pnpm **12**
- The local compose stack from [`examples/README.md`](../../README.md)

This environment: Java 17, `ANDROID_HOME=$HOME/Library/Android/sdk`, AVD `Pixel_10_Pro` (API 37).

## Install / build / run (emulator)

From the repository root:

```bash
pnpm --dir examples/showcase install
pnpm --dir examples/showcase build

pnpm --dir examples/hosts install

cd examples/hosts/android
./gradlew :app:assembleDebug
$ANDROID_HOME/emulator/emulator -avd Pixel_10_Pro -no-snapshot-load &
$ANDROID_HOME/platform-tools/adb wait-for-device
./gradlew :app:installDebug
adb shell am start -n com.powersync.lynx.showcase/.MainActivity
```

The emulator reaches the Mac via **`10.0.2.2`**, not `127.0.0.1`. Defaults in
`app/src/main/res/values/strings.xml` already use that.

## Server addressing

| Source | Keys |
|---|---|
| `strings.xml` (defaults) | `demo_device=android`, `demo_api_url=http://10.0.2.2:8081`, `powersync_url=http://10.0.2.2:8080` |
| Launch extras | `device`, `demoApiUrl`, `powersyncUrl` |

Two-client (second store on the same emulator, or a second AVD):

```bash
adb shell am start -n com.powersync.lynx.showcase/.MainActivity --es device android-b
```

Or emulator + web demo at `http://localhost:4173/?device=web-b`.

Cleartext HTTP is allowed **only in debug** and only for `10.0.2.2`, `127.0.0.1`,
and `localhost` (`app/src/debug/res/xml/network_security_config.xml`). Release
builds have no cleartext.

## Physical device

1. Put the Mac's LAN IP in `strings.xml` (`demo_api_url` / `powersync_url`).
2. Add that IP as a `<domain>` under the debug network-security-config (or the
   request is blocked as cleartext).
3. `adb install` / Android Studio. USB debugging required. No signing account
   is needed for debug APKs.

## Troubleshooting

| Symptom | Check |
|---|---|
| Autolink plugin not found | Plugin ids are `org.lynxsdk.lynx.library-settings` / `library-build` **4.0.1** on the Gradle Plugin Portal, not the shorter `org.lynxsdk.library-*` names in older recipes. |
| `NativePowerSyncModule is not registered` | `pnpm --dir examples/hosts install` so Autolink can see `lynx.lib.json`. Fallback only if the plugin cannot resolve: `LynxEnv.inst().registerModule("NativePowerSyncModule", NativePowerSyncModule.class)`. |
| Missing bundle | `pnpm --dir examples/showcase build` first (`copyLynxBundle` fails loudly). |
| Token works, sync does not | Still pointing at `127.0.0.1` from inside the emulator. Use `10.0.2.2`. |
| `cleartext` / `ERR_CLEARTEXT_NOT_PERMITTED` | Debug network-security-config does not list that host. |
| Empty `<input>` | `xelement` + `xelement-input` 4.0.0 missing. |

## What this environment verified

This checkout, 2026-09-08/09. AVD **Pixel_10_Pro** (API 37, `emulator-5554`), JDK 17, AGP 8.7.2, Gradle 8.11.1, Lynx **4.0.1** (PrimJS **4.0.0**), pnpm **12.3.4**.

| Claim | Result |
|---|---|
| Build + install + launch | **Yes.** `./gradlew :app:assembleDebug`, `adb install`, `am start` `com.powersync.lynx.showcase/.MainActivity` |
| UI paints, local DB ready after relaunch | **Shared bundle fix** (`bootDemo`). This checkout did **not** rebuild/install the APK, so the emulator still needs `./gradlew :app:installDebug` to pick up **DB ready** without waiting for `connect()` |
| Add / persist / upload | Earlier emulator runs uploaded `round2add` / `ande2e` to Postgres. Those rows are **not** a current UI-ready proof |
| Upload + another client sees it | **Not re-verified this checkout.** iOS did not download existing Postgres todos |
| Go offline / Reconnect (stream cancel) | Same ReactLynx control. **Not re-tapped** this checkout |
| Offline queue | **Not re-tapped** this checkout |
| Toggle / delete / filter | Toggle/delete hit targets are small (Lynx `bindtap` on row text). Filters paint (All is filled teal). Not used as the money-shot proof |
| `fetch(url, init)` | **Broken on Android PrimJS** (`Failed to construct 'Request'`). Sync uses `LynxFetchModule`; demo-api POST uses `demoFetch()` in `examples/showcase/src/util.ts` |
| Physical device | **Not run** |

`am force-stop` often leaves the process; `adb uninstall` is the reliable way to load a new bundle (it wipes the local DB).
