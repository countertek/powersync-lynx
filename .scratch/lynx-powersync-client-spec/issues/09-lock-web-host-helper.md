# Lock the Lynx-for-Web Host helper

Type: grilling
Status: open
Blocked by: 05, 07

## Question

What does the host page import and wire so Lynx-for-Web apps use the same Client API as native?

Already locked: `@powersync/web` cannot run inside the Lynx bundle; the Host helper lives in the host page; same npm package (subpath or documented helper); Autolink does not wire Web.

Pin:

- Export path (e.g. `powersync-lynx/web-host`)
- How to attach it (`nativeModulesMap` / `onNativeModulesCall`)
- Worker / WASM asset rules (`copy-assets` or equivalent)
- Default VFS and multi-tab stance for this Client
- What the Lynx bundle still constructs (`new PowerSyncDatabase({ schema, database: { dbFilename } })`)

HITL: `/grilling` + `/domain-modeling`. Output: host-integration section the spec can include.
