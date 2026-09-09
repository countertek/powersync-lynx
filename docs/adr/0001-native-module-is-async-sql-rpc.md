# Native Module is async SQL RPC, not DBAdapter

Lynx cannot pass a live `sqlite3*` or a `Promise`. Official React Native still implements `DBAdapter` in JavaScript: 1 write + 5 read WAL connections, JS locks, `powersync_update_hooks`, and async execute so `watch` can overlap sync apply. The Lynx Native Module is that same split — `open` / `close` / `execute` / `executeBatch` with `function` callbacks and a passable `{ ok, message, code? }` envelope — because a synchronous native `execute` would stall `/sync/stream` on the background JS thread while rows are copied. The JS Adapter throws `Error`, owns locks and `tablesUpdated`, and never calls `loadExtension`.

iOS/Android Autolink also registers `httpFetch` / `httpFetchAbort` on this lookup name. That is a separate sync-HTTP seam ([ADR 0003](0003-native-module-http-is-streaming-fallback.md)), not a widening of SQL RPC. Desktop N-API stays SQL-only.

iOS, Android, and desktop N-API bind onto one C++ engine (`shared/ps_sql`). Android is a JNI binder (not `androidx.sqlite-bundled`). Host wire types for INTEGER beyond `MAX_SAFE_INTEGER` stay in the binder (Lynx `Long` / tagged `{__psBig}` / N-API BigInt).
