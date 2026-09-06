# Survey whether @powersync/common can run in Lynx JS

Type: research
Status: resolved

## Question

Can published `@powersync/common` (and whatever it needs, e.g. `@powersync/shared-internals`) actually execute in the Lynx **background** JavaScript runtime?

## Constraints

- Primary sources: `powersync-ja/powersync-js` (`packages/common`, `packages/shared-internals`), npm package contents, Lynx scripting-runtime docs (PrimJS / JSC, ES levels, no Node builtins, no `window`/`document`).
- Do not design the Client. Facts only: imports, required globals, crypto/uuid, async iterators for `watch`, HTTP/WebSocket assumptions inside `common` vs inside `@powersync/web` / `@powersync/react-native`.
- Note the current 2.x public names (`PowerSyncDatabase`, `CommonPowerSyncDatabase`, `DBAdapter`, `Schema`, `column`, Connector).
- Flag anything that would force vendoring `common` or moving the sync loop out of Lynx JS.

Write findings to `docs/research/common-on-lynx.md` on branch `research/common-on-lynx`.

## Answer

Yes. `@powersync/common@2.2.0` is ESM-only, zero runtime deps, no Node/`window`/`document`/`fetch`. The sync loop is `@powersync/shared-internals@1.2.0` (same JS seam as RN/Web). Do not vendor `common`; do not move the loop native unless Lynx streaming `fetch` (or WS) cannot feed `/sync/stream`. Gist: [docs/research/common-on-lynx.md](../../../docs/research/common-on-lynx.md).

## Comments

Charting session 2026-09-06: claimed for parallel research on `research/common-on-lynx`.
