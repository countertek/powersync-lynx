declare module "@powersync/web" {
  import type { PowerSyncLoggerLike, WASQLiteAdapter, WASQLiteOpenFields } from "./page-rpc.js";

  export class WASQLiteOpenFactory {
    constructor(options: { open: WASQLiteOpenFields; logger: PowerSyncLoggerLike });
    openDB(): WASQLiteAdapter | Promise<WASQLiteAdapter>;
  }

  export function createConsoleLogger(options: { prefix: string }): PowerSyncLoggerLike;
}
