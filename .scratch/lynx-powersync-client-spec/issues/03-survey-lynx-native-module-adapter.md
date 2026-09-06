# Survey Lynx Native Module and Autolink limits for a DBAdapter

Type: research
Status: resolved

## Question

What can a Lynx Native Module actually pass, and what does Autolink generate, if the public Client is `@powersync/common` plus a `DBAdapter`?

## Constraints

- Primary sources: lynxjs.org Native Modules, Autolink (`lynx.lib.json`, Android/iOS 4.0, Lynxtron, **no Web Autolink**), type-mapping table, background-thread-only rule; `DBAdapter` / `LockContext` in `@powersync/common`.
- Cover: primitives vs binary vs callbacks vs no live SQLite handle; table-update notifications for `watch`; read/write locks; `@lynxmodule` codegen limits; Autolink vs manual `registerModule`.
- Do not design the Native Module API. Facts the contract ticket needs.

Write findings to `docs/research/lynx-native-module-adapter.md` on branch `research/lynx-native-module-adapter`.

## Answer

A Native Module is BTS-only. It can pass primitives, `BigInt`, `ArrayBuffer`, JSON-shaped objects/arrays, and `function` callbacks — not a live SQLite handle. `DBAdapter` locks, `LockContext`, and `tablesUpdated` for `watch` stay in Lynx JS. Autolink: Android/iOS 4.0 + Lynxtron `lynx.lib.json`; no Web Autolink. Manual `registerModule` is the documented fallback.

Note: [docs/research/lynx-native-module-adapter.md](../../../docs/research/lynx-native-module-adapter.md)

## Comments

Charting session 2026-09-06: claimed for parallel research on `research/lynx-native-module-adapter`.
