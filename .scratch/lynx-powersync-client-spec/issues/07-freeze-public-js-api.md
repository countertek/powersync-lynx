# Freeze the public JS API

Type: grilling
Status: open
Blocked by: 01

## Question

What exact TypeScript exports and method shapes does the Client present, matching official PowerSync JavaScript names for the destination slice?

Already locked: `PowerSyncDatabase`, `Schema`, `Table`, `column`, `connect(connector)`, `get` / `getAll` / `execute` / `writeTransaction`, `watch`, Sync Stream subscribe, `waitForFirstSync`. Apps import one module (placeholder `powersync-lynx`), which re-exports from `@powersync/common`. No ReactLynx hooks on this map.

Pin:

- Constructor / open options (`schema`, `dbFilename`, one instance per file)
- Connector (`fetchCredentials`, `uploadData`) and `disconnect` / `close`
- `watch` callback vs async iterator
- Sync Stream subscribe / unsubscribe / TTL
- Connection status (`waitForFirstSync` and whether `currentStatus` is in)
- What is **explicitly later**: `getOptional`, `executeRaw`, raw tables, attachments, ORM, hooks

HITL: `/grilling` + `/domain-modeling`. Honor [Survey whether @powersync/common can run in Lynx JS](01-survey-common-on-lynx-js.md). Output: public API list another session can implement; a short `.d.ts` sketch is allowed as an asset, not the package.
