# Lynx PowerSync Client spec

Label: `wayfinder:map`

## Destination

A locked spec for a general-purpose Lynx PowerSync Client: one Autolink npm that ReactLynx apps import as `PowerSyncDatabase`, `Schema`, `Table`, `column`, and Connector, using the official JavaScript names for the nijika-os MVP slice (open DB, schema, `connect` + Connector, `get` / `getAll` / `execute` / `writeTransaction`, `watch`, Sync Stream subscribe, `waitForFirstSync`). `@powersync/common` runs in Lynx JavaScript; native Adapters (SQLite + `powersync-sqlite-core`) cover iOS, Android, Windows, and macOS; Lynx-for-Web uses a Host helper that runs `@powersync/web` in the host page. Lynx 4.0+, Apache-2.0, placeholder package name `powersync-lynx`. The package is not implemented on this map.

## Notes

- Domain: Lynx PowerSync Client. Read `CONTEXT.md` before every ticket. Use `/grilling` and `/domain-modeling` on HITL tickets.
- Stance: planning only. Utilize official PowerSync JavaScript (`@powersync/common`, `@powersync/web`) and `powersync-sqlite-core`. Do not wrap Kotlin/Swift as the JavaScript runtime. Do not vendor `common` unless research proves PrimJS/JSC cannot run it.
- Platforms: iOS, Android, Lynx-for-Web, native Windows, native macOS. HarmonyOS is out. A Linux Lynx host is out.
- Contract: the nijika-os MVP slice. Remaining official features (attachments, Drizzle/Kysely, `@powersync/react` hooks) are later, not designed here.
- nijika-os is consumer #1, not the domain. No PMS nouns in this Client.
- Placeholder npm name `powersync-lynx`; real scope/org is a later publish decision, not this destination.
- Sibling facts (pointers, not this map’s research): `/Users/drkz/orca/projects/nijika-os/docs/research/lynx-constraints.md` and `powersync-assumptions.md`.
- Tracker: local markdown under `.scratch/lynx-powersync-client-spec/`. Refer to every ticket by its title.

## Decisions so far

<!-- the index: one line per closed ticket, enough to judge relevance, then zoom the link for the detail the ticket holds -->

## Not yet specified

- What to do if PrimJS/JSC cannot run `@powersync/common` (fork vs native sync loop) — hangs on [Survey whether @powersync/common can run in Lynx JS](issues/01-survey-common-on-lynx-js.md)
- Exact native SQLite binary (which build of `powersync-sqlite-core`, OP-SQLite vs amalgamation vs shipped `.so`/`.dylib`) — hangs on [Survey how to load powersync-sqlite-core on Lynx native hosts](issues/02-survey-sqlite-core-load.md)
- Lynxtron-required desktop vs CMake hosts as a documented Autolink fallback — hangs on [Survey Lynx desktop native modules and SQLite](issues/06-survey-lynx-desktop-sqlite.md)
- Worker asset layout and default VFS for the Host helper — hangs on [Survey a Lynx-for-Web Host helper on @powersync/web](issues/05-survey-web-host-helper.md)
- CI, release, and the real npm scope
- A later ReactLynx hooks package (`@powersync/react` will not run as-is)

## Out of scope

- Implementing the npm package — this map hands off a spec
- Full official-SDK parity: attachments, Drizzle, Kysely, `@powersync/react` hooks
- HarmonyOS (Lynx Harmony modules are ArkTS; PowerSync Kotlin has no Harmony target)
- Linux as a Lynx host
- Wrapping Kotlin/Swift SDKs as the JavaScript runtime
- Landing in `powersync-ja/powersync-js` / `@powersync/*` as this destination
- nijika-os PMS domain (Stay, Folio, Organization)
- Encryption / SQLCipher
- PowerSync Service / Open Edition ops (that is the consumer app)
