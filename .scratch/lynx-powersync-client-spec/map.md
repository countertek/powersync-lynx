# Lynx PowerSync Client spec

Label: `wayfinder:map`

## Destination

A locked spec for a general-purpose Lynx PowerSync Client: one Autolink npm that ReactLynx apps import as `PowerSyncDatabase`, `Schema`, `Table`, `column`, and Connector, using the official JavaScript names for the nijika-os MVP slice (open DB, schema, `connect` + Connector, `get` / `getAll` / `execute` / `writeTransaction`, `watch`, Sync Stream subscribe, `waitForFirstSync`). `@powersync/common` runs in Lynx JavaScript; native Adapters (SQLite + `powersync-sqlite-core`) cover iOS, Android, Windows, and macOS; Lynx-for-Web uses a Host helper that runs `@powersync/web` in the host page. Lynx 4.0+, Apache-2.0, placeholder package name `powersync-lynx`. The package is not implemented on this map.

## Notes

- Domain: Lynx PowerSync Client. Read `CONTEXT.md` before every ticket. Use `/grilling` and `/domain-modeling` on HITL tickets.
- Stance: planning only. Utilize official PowerSync JavaScript (`@powersync/common`, `@powersync/shared-internals`, `@powersync/web`) and `powersync-sqlite-core`. Do not wrap Kotlin/Swift as the JavaScript runtime. Do not vendor `common` (`docs/research/common-on-lynx.md`: published `common` can run in Lynx JS).
- Platforms: iOS, Android, Lynx-for-Web, native Windows, native macOS. HarmonyOS is out. A Linux Lynx host is out.
- Contract: the nijika-os MVP slice. Remaining official features (attachments, Drizzle/Kysely, `@powersync/react` hooks) are later, not designed here.
- nijika-os is consumer #1, not the domain. No PMS nouns in this Client.
- Placeholder npm name `powersync-lynx`; real scope/org is a later publish decision, not this destination.
- Sibling facts (pointers, not this map’s research): `/Users/drkz/orca/projects/nijika-os/docs/research/lynx-constraints.md` and `powersync-assumptions.md`.
- Tracker: local markdown under `.scratch/lynx-powersync-client-spec/`. Refer to every ticket by its title.

## Decisions so far

<!-- the index: one line per closed ticket, enough to judge relevance, then zoom the link for the detail the ticket holds -->

- [Survey whether @powersync/common can run in Lynx JS](issues/01-survey-common-on-lynx-js.md): `@powersync/common@2.2.0` runs in Lynx background JS; the 2.x sync loop is `@powersync/shared-internals@1.2.0` in the same JS — no vendor. [docs/research/common-on-lynx.md](../../docs/research/common-on-lynx.md)
- [Survey how to load powersync-sqlite-core on Lynx native hosts](issues/02-survey-sqlite-core-load.md): official clients load Apache-2.0 `powersync-sqlite-core` via `sqlite3_powersync_init` (static auto-extension on Apple; loadable `.so`/`.dylib`/`.dll` elsewhere). OP-SQLite is the RN host, not a general native SQLite. Binary pick is [Lock the native Adapter and Native Module contract](issues/08-lock-native-adapter-contract.md). [docs/research/sqlite-core-load.md](../../docs/research/sqlite-core-load.md)
- [Survey Lynx Native Module and Autolink limits for a DBAdapter](issues/03-survey-lynx-native-module-adapter.md): Native Module is BTS-only; passable types are primitives / `BigInt` / `ArrayBuffer` / objects / arrays / callbacks — no live SQLite handle. Autolink Android+iOS 4.0 and Lynxtron; no Web Autolink; manual `registerModule` is the fallback. [docs/research/lynx-native-module-adapter.md](../../docs/research/lynx-native-module-adapter.md)
- [Survey Lynx networking for the PowerSync sync protocol](issues/04-survey-lynx-powersync-network.md): HTTP streaming can run in Lynx JS on iOS/Android if experimental Fetch streaming is on; Lynx-for-Web uses host-page browser `fetch`; WebSocket is not a documented Lynx app API; native HTTP only if streaming fails on a host. [docs/research/lynx-powersync-network.md](../../docs/research/lynx-powersync-network.md)
- [Survey a Lynx-for-Web Host helper on @powersync/web](issues/05-survey-web-host-helper.md): Host helper is host-page `@powersync/web` behind `<lynx-view>` `nativeModulesMap` / `onNativeModulesCall`; Autolink does not generate Web wiring. Worker assets via `copy-assets` or bundler `import.meta.url`. Default VFS is [Lock the Lynx-for-Web Host helper](issues/09-lock-web-host-helper.md). [docs/research/web-host-helper.md](../../docs/research/web-host-helper.md)
- [Survey Lynx desktop native modules and SQLite](issues/06-survey-lynx-desktop-sqlite.md): Lynx 4.0 CMake `LynxView` uses `LynxEnv.RegisterNativeModule` (no Autolink); Lynxtron Autolink (`.node`, `lynx.lib.json`) is `/next` only. `@powersync/node` can sit in the Lynxtron Node host after rebuild, not in Lynx JS. Floors: Windows 10, macOS 14 (Node/all-SDK) / 12 (Swift, Kotlin native). Lynxtron vs CMake is [Lock package layout, Autolink, and version floors](issues/10-lock-package-layout.md). [docs/research/lynx-desktop-sqlite.md](../../docs/research/lynx-desktop-sqlite.md)
- [Freeze the public JS API](issues/07-freeze-public-js-api.md): Apps import `powersync-lynx`: `export *` from `@powersync/common` plus Lynx `PowerSyncDatabase extends CommonPowerSyncDatabase`. Constructor `{ schema, database: { dbFilename, dbLocation? } }`. No `@powersync/react`. Later = attachments/ORM/hooks as products, not a smaller interface. [assets/public-js-api.d.ts](assets/public-js-api.d.ts)
- [Lock the native Adapter and Native Module contract](issues/08-lock-native-adapter-contract.md): JS Adapter = official `DBAdapter` (1 write + 5 read, JS locks, `powersync_update_hooks`). Native Module = async `open`/`close`/`execute`/`executeBatch` (no live handle). Apple static auto-extension; Android AAR; Windows DLL. Default `connectionMethod` HTTP. Autolink floor; `registerModule` fallback. [assets/native-adapter-contract.md](assets/native-adapter-contract.md)
- [Lock the Lynx-for-Web Host helper](issues/09-lock-web-host-helper.md): Host page `attach` from `powersync-lynx/web-host`; SQL RPC on `WASQLiteOpenFactory` (not a second `PowerSyncDatabase`); official VFS/multi-tab/worker defaults; Lynx constructor unchanged. [assets/web-host-helper.md](assets/web-host-helper.md)
- [Lock package layout, Autolink, and version floors](issues/10-lock-package-layout.md): One npm `powersync-lynx`; exports `.` / `./web-host` / `./lynxtron`; Native Module `NativePowerSyncModule`; Lynxtron Autolink desktop, CMake `RegisterNativeModule` fallback; floors iOS 15 / Android 24 / macOS 14 / Windows 10; peers `@powersync/common` `^2.2.0`, optional `@powersync/web` `^2.3.0`. [assets/package-layout.md](assets/package-layout.md)
- [Assemble the Client spec](issues/11-assemble-the-client-spec.md): One reading-order spec at [docs/spec.md](../../docs/spec.md). Glossary **attach**. Leftover fog (CI/release/npm scope; later ReactLynx hooks package) is out of this map.

## Not yet specified

None. Closing [Assemble the Client spec](issues/11-assemble-the-client-spec.md) finishes this map.

## Out of scope

- Implementing the npm package — this map hands off a spec
- CI, release, and the real npm scope
- Full official-SDK parity: attachments, Drizzle, Kysely, `@powersync/react` hooks
- A later ReactLynx hooks package (`@powersync/react` will not run as-is)
- HarmonyOS (Lynx Harmony modules are ArkTS; PowerSync Kotlin has no Harmony target)
- Linux as a Lynx host
- Wrapping Kotlin/Swift SDKs as the JavaScript runtime
- Landing in `powersync-ja/powersync-js` / `@powersync/*` as this destination
- nijika-os PMS domain (Stay, Folio, Organization)
- Encryption / SQLCipher
- PowerSync Service / Open Edition ops (that is the consumer app)
