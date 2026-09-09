# Issue #18 comment (D+G landed) — paste if Issues API 403s

FM-PS-LYNX-008 **D+G** is open as a PR targeting `main` (stacks on F / #27).

**D — Android SQL onto shared `ps_sql`:** Autolink `NativePowerSyncModule` SQL RPC (`open`/`close`/`execute`/`executeBatch`) is a thin Java binder over JNI `PsSqlEngine` → `shared/ps_sql`. `androidx.sqlite-bundled` is gone. Core remains Maven `libpowersync.so` + `sqlite3_load_extension`. NativeSyncHttp (B) is unchanged and not merged into SQL. Intentional binder diffs vs iOS/desktop: INTEGER beyond MAX_SAFE is Lynx `Long` (iOS tagged `{__psBig}`, N-API BigInt); default path is `Context.getDatabasePath`; core load is loadExtension not auto_extension.

**G — iOS host-provided event sender:** `NativeSyncHttp` no longer walks `UIWindow`/`LynxView`. Incremental `/sync/stream` needs `+[NativePowerSyncModule setSharedStreamEventSender:]` (showcase `ViewController` already registers the `LynxView`) or Autolink `initWithParam:`. No sender → idle-complete fallback (C). iOS fixture test covers shared-sender streaming plus idle-complete without a sender.

Linux: `pnpm typecheck/lint/test` and `make test` (includes JNI `-c` of `ps_sql_jni.cc` + grep that the UIWindow walk is gone). `make test-ios` / Android NDK+instrumentation need Mac.
