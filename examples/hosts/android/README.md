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
| Download hangs / `ps_buckets=0` after server 200 | Stock `LynxHttpService` buffers via `ResponseBody.bytes()` on live `/sync/stream` and times out. This host registers `ShowcaseLynxHttpService` instead (idle-complete + long streaming read timeout). Rebuild/reinstall the APK after pulling that change. |

## `/sync/stream` download fix (`ShowcaseLynxHttpService`)

Stock Lynx 4.0.1 `LynxHttpService` on the **non-streaming** path calls `ResponseBody.bytes()` (see `LynxHttpService.kt` ~line 60). PowerSync keeps the chunked NDJSON connection open after `checkpoint_complete`, so OkHttp’s default read timeout surfaces as:

```text
java.net.SocketTimeoutException: timeout
  at okhttp3.ResponseBody.bytes
  at com.lynx.service.http.LynxHttpService$requestInner$1.onResponse
```

JS never receives body bytes / `streamingId` / `onData` → SQLite stays at `ps_buckets=0` even though the service returned ~19KB of ops.

This host registers `ShowcaseLynxHttpService` in `ShowcaseApplication` instead of `LynxHttpService.INSTANCE`:

- **Non-streaming `/sync/stream`:** read until EOF **or** a short idle timeout (~2.5s), then return the buffered checkpoint + ops. The bytes are also mirrored as `lynxExtension.powersyncIdleBodyBase64` because LynxFetchModule often fails to surface large `byte[]` bodies to JS (which previously selected an empty GlobalEventEmitter **fallback** and left `ps_buckets=0`).
- **LynxRemote (Android):** does **not** set `enableFetchAPIStandardStreaming` for sync streams; prefers idle-complete / raw body over nameless streaming fallback.
- **Streaming path:** pipe `byteStream()` into Lynx’s `HttpStreamingDelegate` with a **120s** read timeout so keepalive gaps do not abort the stream.

### Rebuild after this change

```bash
pnpm --dir examples/showcase install
pnpm --dir examples/showcase build
pnpm --dir examples/hosts install
cd examples/hosts/android
./gradlew :app:assembleDebug
adb uninstall com.powersync.lynx.showcase   # clears old DB; force-stop is not enough
./gradlew :app:installDebug
adb shell am start -n com.powersync.lynx.showcase/.MainActivity
```

### Verify downloads (not `hasSynced` alone)

1. Local stack up (`examples/docker-compose.yml`); create a todo via demo-api / web / Postgres.
2. On the emulator, confirm the todo appears in the list.
3. Optional SQLite check (after install with a debug shell / your usual DB inspector): `ps_buckets` count **> 0** and todos present after the server checkpoint.
4. Upload still works: add a todo on device and see it in Postgres / another client.

Host unit tests (no device): `./gradlew :app:testDebugUnitTest`

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
