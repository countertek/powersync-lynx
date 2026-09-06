# Survey how to load powersync-sqlite-core on Lynx native hosts

Type: research
Status: claimed

## Question

How do official PowerSync clients load `powersync-sqlite-core` on iOS, Android, Windows, and macOS, and what would a Lynx Adapter have to ship?

## Constraints

- Primary sources: `powersync-ja/powersync-sqlite-core`, Kotlin/Swift/React Native/Node adapters in `powersync-ja` repos, PowerSync supported-platforms docs.
- Cover: distribution (CocoaPods, Maven, npm, raw binaries), how the extension is loaded into SQLite, min OS / arch, license (Apache-2.0), whether OP-SQLite is RN-only.
- Do not pick which binary this Client ships. Surface the options and constraints [Lock the native Adapter and Native Module contract](08-lock-native-adapter-contract.md) needs.

Write findings to `docs/research/sqlite-core-load.md` on branch `research/sqlite-core-load`.

## Comments

Charting session 2026-09-06: claimed for parallel research on `research/sqlite-core-load`.
