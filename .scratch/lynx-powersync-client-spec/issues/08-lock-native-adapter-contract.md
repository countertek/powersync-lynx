# Lock the native Adapter and Native Module contract

Type: grilling
Status: open
Blocked by: 01, 02, 03, 04, 06

## Question

How does the native Adapter implement `DBAdapter` (SQLite + `powersync-sqlite-core`) behind a Lynx Native Module, and what is the JSON method contract?

Already locked: `@powersync/common` in Lynx JS; Native Module is an implementation detail; app code never calls `NativeModules` for this. iOS, Android, Windows, macOS.

Pin:

- Which `DBAdapter` methods cross the Native Module vs stay in JS
- SQLite + `powersync-sqlite-core` load choice per platform (from the research options)
- Default `connectionMethod` (HTTP vs WebSocket) given Lynx `fetch`
- Locks, `watch` table notifications, threading (background-only)
- Error shape back to JS
- Manual `registerModule` as a documented fallback, not the floor

HITL: `/grilling` + `/domain-modeling`. Do not implement native code. Output: Native Module + Adapter contract the spec can cite.
