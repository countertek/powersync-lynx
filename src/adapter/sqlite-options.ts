/** Official OP-SQLite defaults (`DEFAULT_SQLITE_OPTIONS`), encryption omitted. */
export const DEFAULT_SQLITE_OPTIONS = {
  journalMode: "WAL",
  synchronous: "NORMAL",
  journalSizeLimit: 6 * 1024 * 1024,
  cacheSizeKb: 50 * 1024,
  temporaryStorage: "memory",
  lockTimeoutMs: 30000,
} as const;

export const READ_CONNECTIONS = 5;
