# Survey Lynx desktop native modules and SQLite

Type: research
Status: resolved

## Question

What is the supported way, on Lynx 4.0, to run a Native Module plus SQLite/`powersync-sqlite-core` on native Windows and macOS (Lynxtron and/or CMake `LynxView`)?

## Constraints

- Primary sources: Lynx 3.7 desktop announcement, integrate-with-existing-apps (Windows/macOS CMake), Autolink `/next` (Lynxtron `.node`, `platforms.macos` / `windows` `shared/`), PowerSync Node / Kotlin-JVM / Swift-macOS SQLite paths.
- Cover: Autolink vs `RegisterNativeModule`; N-API vs C++; whether `@powersync/node` can sit in a Lynxtron host; min OS versions PowerSync already publishes (Windows 10, macOS 12/14).
- Do not decide “Lynxtron only” vs CMake fallback. Facts [Lock package layout, Autolink, and version floors](10-lock-package-layout.md) needs.

Write findings to `docs/research/lynx-desktop-sqlite.md` on branch `research/lynx-desktop-sqlite`.

## Answer

Two desktop hosts: Lynx 4.0 CMake `LynxView` registers with `LynxEnv.RegisterNativeModule` (no Autolink); Lynxtron Autolink (`.node`, `lynx.lib.json` `lynxtron`/`macos`/`windows`) is documented only on `/next`. `@powersync/node` can run in the Lynxtron Node host after rebuild, not in Lynx JS. PowerSync floors: Windows 10, macOS 14 (all-SDK/Node) / 12 (Swift, Kotlin native). Did not pick Lynxtron-only vs CMake fallback.

Findings: [docs/research/lynx-desktop-sqlite.md](../../../docs/research/lynx-desktop-sqlite.md)

## Comments

Charting session 2026-09-06: claimed for parallel research on `research/lynx-desktop-sqlite`.
