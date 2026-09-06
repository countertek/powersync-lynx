# Lock package layout, Autolink, and version floors

Type: grilling
Status: open
Blocked by: 03, 06, 08, 09

## Question

What does the one Autolink npm look like on disk, and which host versions does this Client require?

Already locked: one package; `lynx.lib.json` for Android/iOS Autolink and desktop artifacts; Lynx **4.0+**; Apache-2.0; depend on published `@powersync/common` (pin a major) and `@powersync/web` in the Host helper; placeholder name `powersync-lynx`; real npm scope is not this destination; manual registration is a documented fallback, not a supported floor.

Pin:

- `package.json` exports (JS facade, types, Host helper subpath)
- `lynx.lib.json` platforms (android, ios, macos, windows, lynxtron; no harmony)
- peerDependencies (Lynx SDK range, `@powersync/common`)
- Min iOS / Android / macOS / Windows — start from PowerSync’s published floors unless Lynx forces higher
- Desktop: Lynxtron Autolink as the supported path vs CMake `RegisterNativeModule` as fallback (from desktop research)

HITL: `/grilling` + `/domain-modeling`. Output: package layout + version matrix for the spec. No publish.
