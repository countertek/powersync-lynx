# Host helper is WASQLite SQL RPC, not WebPowerSyncDatabase

Lynx-for-Web has no Autolink, and `@powersync/web` needs `window`, workers, and IndexedDB/OPFS, so it cannot run in the Lynx bundle. The Host helper is the same Native Module SQL RPC as native (`open` / `close` / `execute` / `executeBatch`) mapped onto host-page `WASQLiteOpenFactory`, not a second `PowerSyncDatabase`. Connector and `/sync/stream` stay in Lynx JS so the public API matches native; `enableMultiTabs` is official WASQLite SharedWorker sharing, not official Web’s shared sync worker.
