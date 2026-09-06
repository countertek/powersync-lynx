# Survey a Lynx-for-Web Host helper on @powersync/web

Type: research
Status: claimed

## Question

How can a host page run `@powersync/web` (WASQLite, workers, IndexedDB/OPFS) and expose it to the Lynx bundle through `nativeModulesMap` / `onNativeModulesCall`?

## Constraints

- Primary sources: `@powersync/web` (workers, `copy-assets`, VFS matrix, multi-tab, COOP/COEP / SharedArrayBuffer extras); Lynx-for-Web `nativeModulesMap`, `onNativeModulesCall`, same-origin workers, CSS containment on `<lynx-view>`.
- Autolink does **not** generate Web integration. The Host helper is the Web Adapter.
- Do not design the helper’s public exports. Surface what must live in the host page vs what can be a documented subpath of the one npm package.

Write findings to `docs/research/web-host-helper.md` on branch `research/web-host-helper`.

## Comments

Charting session 2026-09-06: claimed for parallel research on `research/web-host-helper`.
