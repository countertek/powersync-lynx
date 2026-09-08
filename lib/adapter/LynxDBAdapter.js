import '../abort-controller.js';
import { DBAdapter } from '@powersync/common';
import { timeoutSignal, Semaphore } from '@powersync/shared-internals';
import { LynxConnection } from './LynxConnection.js';
import { callNative } from './native.js';
import { DEFAULT_SQLITE_OPTIONS, READ_CONNECTIONS } from './sqlite-options.js';

export class LynxDBAdapter extends DBAdapter {
  name;
  initialized;
  readConnections = null;
  writeConnection = null;
  abortController;

  constructor(options) {
    super();
    this.options = options;
    this.name = options.name;
    this.abortController = new AbortController();
    this.initialized = this.init();
  }

  async init() {
    const { lockTimeoutMs, journalMode, journalSizeLimit, synchronous, cacheSizeKb, temporaryStorage } =
      DEFAULT_SQLITE_OPTIONS;
    const dbFilename = this.options.name;
    const opened = [];

    try {
      const underlyingWriteConnection = await this.openConnection(false, dbFilename);
      opened.push(underlyingWriteConnection);

      const baseStatements = [
        `PRAGMA busy_timeout = ${lockTimeoutMs}`,
        `PRAGMA cache_size = -${cacheSizeKb}`,
        `PRAGMA temp_store = ${temporaryStorage}`
      ];

      const writeConnectionStatements = [
        ...baseStatements,
        `PRAGMA journal_mode = ${journalMode}`,
        `PRAGMA journal_size_limit = ${journalSizeLimit}`,
        `PRAGMA synchronous = ${synchronous}`,
        `SELECT powersync_update_hooks('install')`
      ];

      for (const statement of writeConnectionStatements) {
        for (let tries = 0; tries < 30; tries++) {
          try {
            await underlyingWriteConnection.execute(statement);
            break;
          } catch (e) {
            if (e instanceof Error && e.message.includes('database is locked') && tries < 29) {
              continue;
            }
            throw e;
          }
        }
      }

      const underlyingReadConnections = [];
      for (let i = 0; i < READ_CONNECTIONS; i++) {
        const conn = await this.openConnection(true, dbFilename);
        opened.push(conn);
        for (const statement of baseStatements) {
          await conn.execute(statement);
        }
        underlyingReadConnections.push(conn);
      }

      this.writeConnection = new Semaphore([underlyingWriteConnection]);
      this.readConnections = new Semaphore(underlyingReadConnections);
    } catch (error) {
      await Promise.allSettled(opened.map((conn) => conn.close()));
      throw error;
    }
  }

  async openConnection(readOnly, dbFilename) {
    const payload = { dbFilename, readOnly };
    if (this.options.dbLocation != null) {
      payload.dbLocation = this.options.dbLocation;
    }
    const { dbId } = await callNative('open', payload);
    return new LynxConnection(dbId);
  }

  async close() {
    await this.initialized;
    this.abortController.abort();

    const { item: writeConnection, release: returnWrite } = await this.writeConnection.requestOne();
    const { items: readers, release: returnReaders } = await this.readConnections.requestAll();

    try {
      await writeConnection.close();
      await Promise.all(readers.map((c) => c.close()));
    } finally {
      returnWrite();
      returnReaders();
    }
  }

  generateNestedAbortSignal(options) {
    const outerSignal = this.abortController.signal;
    let signal;
    let cleanUpInnerSignal;

    if (options?.timeoutMs && !outerSignal.aborted) {
      const innerController = new AbortController();
      const timeout = timeoutSignal(options.timeoutMs);
      cleanUpInnerSignal = () => {
        innerController.abort();
        outerSignal.removeEventListener('abort', cleanUpInnerSignal);
        timeout.removeEventListener('abort', cleanUpInnerSignal);
      };
      outerSignal.addEventListener('abort', cleanUpInnerSignal);
      timeout.addEventListener('abort', cleanUpInnerSignal);
      signal = innerController.signal;
    } else {
      signal = outerSignal;
    }

    return { signal, cleanUpInnerSignal };
  }

  async readLock(fn, options) {
    await this.initialized;
    const { signal, cleanUpInnerSignal } = this.generateNestedAbortSignal(options);
    const { item, release } = await this.readConnections.requestOne(signal);
    try {
      return await fn(item);
    } finally {
      release();
      cleanUpInnerSignal?.();
    }
  }

  async writeLock(fn, options) {
    await this.initialized;
    const { signal, cleanUpInnerSignal } = this.generateNestedAbortSignal(options);
    const { item, release } = await this.writeConnection.requestOne(signal);
    try {
      return await fn(item);
    } finally {
      try {
        const {
          rawRows: [[jsonUpdate]]
        } = await item.executeRaw("SELECT powersync_update_hooks('get')");
        const notification = {
          tables: JSON.parse(jsonUpdate)
        };
        if (notification.tables.length) {
          this.iterateListeners((l) => l.tablesUpdated?.(notification));
        }
      } finally {
        release();
        cleanUpInnerSignal?.();
      }
    }
  }

  async refreshSchema() {
    await this.initialized;
    await this.writeLock((l) => l.refreshSchema());
    const { items, release } = await this.readConnections.requestAll();
    try {
      for (const readConnection of items) {
        await readConnection.refreshSchema();
      }
    } finally {
      release();
    }
  }

  executeBatch(query, params) {
    return this.writeLock((conn) => conn.executeNativeBatch(query, params));
  }
}
