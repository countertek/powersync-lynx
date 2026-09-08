/** Official OP-SQLite defaults (`DEFAULT_SQLITE_OPTIONS`), encryption omitted. */
export declare const DEFAULT_SQLITE_OPTIONS: {
    readonly journalMode: "WAL";
    readonly synchronous: "NORMAL";
    readonly journalSizeLimit: number;
    readonly cacheSizeKb: number;
    readonly temporaryStorage: "memory";
    readonly lockTimeoutMs: 30000;
};
export declare const READ_CONNECTIONS = 5;
