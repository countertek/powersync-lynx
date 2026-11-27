import { DBAdapter, LockContext } from "@powersync/common";
import type { DBLockOptions, QueryResult, RawQueryResult } from "@powersync/common";
import { timeoutSignal, Semaphore } from "@powersync/shared-internals";
import { getLynxHost } from "../host.ts";
import { TabCoordinator } from "../tabs.ts";
import { nativeSql, type BindValueRows, type BindValues, type OpenPayload } from "./native.ts";

/** Official OP-SQLite defaults (`DEFAULT_SQLITE_OPTIONS`), encryption omitted. */
const DEFAULT_SQLITE_OPTIONS = {
  journalMode: "WAL",
  synchronous: "NORMAL",
  journalSizeLimit: 6 * 1024 * 1024,
  cacheSizeKb: 50 * 1024,
  temporaryStorage: "memory",
  lockTimeoutMs: 30000,
} as const;

const READ_CONNECTIONS = 5;

class LynxConnection extends LockContext {
  readonly dbId: string;

  constructor(dbId: string) {
    super();
    this.dbId = dbId;
  }

  executeRaw(query: string, params?: BindValues): Promise<RawQueryResult> {
    return nativeSql.execute(this.dbId, query, params);
  }

  executeNativeBatch(query: string, params?: BindValueRows): Promise<QueryResult<never>> {
    return nativeSql.executeBatch(this.dbId, query, params);
  }

  async refreshSchema(): Promise<void> {
    await this.get("PRAGMA table_info('sqlite_master')");
  }

  close(): Promise<void> {
    return nativeSql.close(this.dbId);
  }
}

export interface LynxAdapterOpenOptions {
  name: string;
  dbLocation?: string;
}

interface NestedAbortSignal {
  signal: AbortSignal;
  cleanUpInnerSignal?: () => void;
}

export class LynxDBAdapter extends DBAdapter {
  name: string;
  initialized: Promise<void>;
  readConnections: Semaphore<LynxConnection> | null = null;
  writeConnection: Semaphore<LynxConnection> | null = null;
  abortController: AbortController;
  options: LynxAdapterOpenOptions;
  readonly tabs: TabCoordinator;

  constructor(options: LynxAdapterOpenOptions) {
    super();
    this.options = options;
    this.name = options.name;
    this.tabs = new TabCoordinator(options, { waitForAdapter: true });
    this.abortController = new AbortController();
    this.initialized = this.init();
    // Prevent unhandled rejection when callers construct the Adapter before awaiting initialized.
    this.initialized.catch(() => {});
  }

  async init(): Promise<void> {
    const {
      lockTimeoutMs,
      journalMode,
      journalSizeLimit,
      synchronous,
      cacheSizeKb,
      temporaryStorage,
    } = DEFAULT_SQLITE_OPTIONS;
    const dbFilename = this.options.name;
    const opened: LynxConnection[] = [];
    let sharedWithTabs = false;

    try {
      const writeOpened = await this.openConnection(false, dbFilename);
      const underlyingWriteConnection = writeOpened.connection;
      sharedWithTabs ||= writeOpened.multiTab;
      opened.push(underlyingWriteConnection);

      const baseStatements = [
        `PRAGMA busy_timeout = ${lockTimeoutMs}`,
        `PRAGMA cache_size = -${cacheSizeKb}`,
        `PRAGMA temp_store = ${temporaryStorage}`,
      ];

      const writeConnectionStatements = [
        ...baseStatements,
        `PRAGMA journal_mode = ${journalMode}`,
        `PRAGMA journal_size_limit = ${journalSizeLimit}`,
        `PRAGMA synchronous = ${synchronous}`,
        `SELECT powersync_update_hooks('install')`,
      ];

      for (const statement of writeConnectionStatements) {
        for (let tries = 0; tries < 30; tries++) {
          try {
            await underlyingWriteConnection.execute(statement);
            break;
          } catch (e) {
            if (e instanceof Error && e.message.includes("database is locked") && tries < 29) {
              continue;
            }
            throw e;
          }
        }
      }

      const underlyingReadConnections: LynxConnection[] = [];
      for (let i = 0; i < READ_CONNECTIONS; i++) {
        const readOpened = await this.openConnection(true, dbFilename);
        const conn = readOpened.connection;
        sharedWithTabs ||= readOpened.multiTab;
        opened.push(conn);
        for (const statement of baseStatements) {
          await conn.execute(statement);
        }
        underlyingReadConnections.push(conn);
      }

      this.writeConnection = new Semaphore([underlyingWriteConnection]);
      this.readConnections = new Semaphore(underlyingReadConnections);
      this.tabs.adapterReady(sharedWithTabs, getLynxHost().tabs(), (change) => {
        this.iterateListeners((l) => l.tablesUpdated?.(change));
      });
    } catch (error) {
      this.tabs.adapterFailed();
      await Promise.allSettled(opened.map((conn) => conn.close()));
      throw error;
    }
  }

  private async openConnection(
    readOnly: boolean,
    dbFilename: string,
  ): Promise<{ connection: LynxConnection; multiTab: boolean }> {
    const payload: OpenPayload = { dbFilename, readOnly };
    if (this.options.dbLocation != null) {
      payload.dbLocation = this.options.dbLocation;
    }
    const { dbId, multiTab } = await nativeSql.open(payload);
    return { connection: new LynxConnection(dbId), multiTab };
  }

  private writers(): Semaphore<LynxConnection> {
    const writeConnection = this.writeConnection;
    if (writeConnection == null) {
      throw new Error("LynxDBAdapter write connection is not open");
    }
    return writeConnection;
  }

  private readers(): Semaphore<LynxConnection> {
    const readConnections = this.readConnections;
    if (readConnections == null) {
      throw new Error("LynxDBAdapter read connections are not open");
    }
    return readConnections;
  }

  async close(): Promise<void> {
    await this.initialized;
    this.abortController.abort();
    this.tabs.closeTables();

    const writeSemaphore = this.writeConnection;
    const readSemaphore = this.readConnections;
    if (writeSemaphore == null && readSemaphore == null) {
      throw new Error("LynxDBAdapter write connection is not open");
    }

    let returnWrite: (() => void) | undefined;
    let writeItem: LynxConnection | undefined;
    if (writeSemaphore != null) {
      const acquired = await writeSemaphore.requestOne();
      writeItem = acquired.item;
      returnWrite = acquired.release;
    }

    let returnReaders: (() => void) | undefined;
    let readers: LynxConnection[] = [];
    if (readSemaphore != null) {
      const acquired = await readSemaphore.requestAll();
      readers = acquired.items;
      returnReaders = acquired.release;
    }

    const toClose = writeItem == null ? readers : [writeItem, ...readers];
    let keepWrite = false;
    const remainingReaders: LynxConnection[] = [];
    let firstError: unknown;
    try {
      const outcomes = await Promise.allSettled(toClose.map((conn) => conn.close()));
      for (let i = 0; i < outcomes.length; i++) {
        const outcome = outcomes[i]!;
        if (outcome.status !== "rejected") {
          continue;
        }
        if (firstError === undefined) {
          firstError = outcome.reason;
        }
        const conn = toClose[i]!;
        if (conn === writeItem) {
          keepWrite = true;
        } else {
          remainingReaders.push(conn);
        }
      }
      if (firstError !== undefined) {
        throw firstError;
      }
    } finally {
      this.writeConnection = keepWrite ? writeSemaphore : null;
      this.readConnections = remainingReaders.length > 0 ? new Semaphore(remainingReaders) : null;
      returnWrite?.();
      returnReaders?.();
    }
  }

  private generateNestedAbortSignal(options?: DBLockOptions): NestedAbortSignal {
    const outerSignal = this.abortController.signal;
    let signal: AbortSignal;
    let cleanUpInnerSignal: (() => void) | undefined;

    if (options?.timeoutMs && !outerSignal.aborted) {
      const innerController = new AbortController();
      const timeout = timeoutSignal(options.timeoutMs);
      const innerCleanup = () => {
        innerController.abort();
        outerSignal.removeEventListener("abort", innerCleanup);
        timeout.removeEventListener("abort", innerCleanup);
      };
      cleanUpInnerSignal = innerCleanup;
      outerSignal.addEventListener("abort", innerCleanup);
      timeout.addEventListener("abort", innerCleanup);
      signal = innerController.signal;
    } else {
      signal = outerSignal;
    }

    return { signal, cleanUpInnerSignal };
  }

  async readLock<T>(fn: (tx: LockContext) => Promise<T>, options?: DBLockOptions): Promise<T> {
    await this.initialized;
    const { signal, cleanUpInnerSignal } = this.generateNestedAbortSignal(options);
    const { item, release } = await this.readers().requestOne(signal);
    try {
      return await fn(item);
    } finally {
      release();
      cleanUpInnerSignal?.();
    }
  }

  private async withWriteConnection<T>(
    fn: (conn: LynxConnection) => Promise<T>,
    options?: DBLockOptions,
  ): Promise<T> {
    await this.initialized;
    const { signal, cleanUpInnerSignal } = this.generateNestedAbortSignal(options);
    const { item, release } = await this.writers().requestOne(signal);
    try {
      return await fn(item);
    } finally {
      try {
        const {
          rawRows: [[jsonUpdate]],
        } = await item.executeRaw("SELECT powersync_update_hooks('get')");
        const tablesJson = jsonUpdate == null ? "[]" : String(jsonUpdate);
        // SAFETY: powersync_update_hooks('get') returns a JSON array of table name strings.
        const tables: string[] = JSON.parse(tablesJson);
        const notification = { tables };
        if (notification.tables.length) {
          this.iterateListeners((l) => l.tablesUpdated?.(notification));
          this.tabs.postTableChange(notification);
        }
      } finally {
        release();
        cleanUpInnerSignal?.();
      }
    }
  }

  writeLock<T>(fn: (tx: LockContext) => Promise<T>, options?: DBLockOptions): Promise<T> {
    return this.withWriteConnection(fn, options);
  }

  async refreshSchema(): Promise<void> {
    await this.initialized;
    await this.withWriteConnection((conn) => conn.refreshSchema());
    const { items, release } = await this.readers().requestAll();
    try {
      for (const readConnection of items) {
        await readConnection.refreshSchema();
      }
    } finally {
      release();
    }
  }

  executeBatch(query: string, params?: BindValueRows): Promise<QueryResult<never>> {
    return this.withWriteConnection((conn) => conn.executeNativeBatch(query, params));
  }
}
