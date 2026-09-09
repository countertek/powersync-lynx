import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema, Table, column } from "../src/index.ts";
import type { CommonPowerSyncDatabase } from "../src/index.ts";
import { PowerSyncDatabase } from "../src/PowerSyncDatabase.ts";
import { SyncStatusSnapshot } from "@powersync/shared-internals";
import type { CoreSyncStatus } from "@powersync/shared-internals";
import type {
  BindValueRows,
  BindValues,
  NativeCallback,
  OpenPayload,
} from "../src/adapter/native.ts";

const FULL_SYNC_PRIORITY = 2147483647;

interface StatusEmitter {
  currentStatus: SyncStatusSnapshot;
  iterateListeners(
    callback: (listener: { statusChanged?: (status: SyncStatusSnapshot) => void }) => void,
  ): void;
}

function installAppNative() {
  let nextId = 1;

  function ok(columnNames: string[], rawRows: Array<Array<string | number>>) {
    return { ok: true, insertId: 0, rowsAffected: 0, columnNames, rawRows };
  }

  function handleExecute(sql: string) {
    if (sql.includes("powersync_rs_version")) {
      return ok(["version"], [["0.5.3"]]);
    }
    if (sql.includes("powersync_offline_sync_status")) {
      return ok(
        ["r"],
        [
          [
            JSON.stringify({
              connected: false,
              connecting: false,
              priority_status: [],
              downloading: null,
              streams: [],
            }),
          ],
        ],
      );
    }
    if (sql.includes("PRAGMA table_info")) {
      return ok(["cid", "name"], [[0, "type"]]);
    }
    if (sql.includes("sqlite_master")) {
      return ok(["name"], []);
    }
    if (sql.includes("powersync_update_hooks('get')")) {
      return ok(["powersync_update_hooks"], [["[]"]]);
    }
    return ok([], []);
  }

  globalThis.NativeModules = {
    NativePowerSyncModule: {
      open(_payload: OpenPayload, cb: NativeCallback) {
        const dbId = `db-${nextId++}`;
        queueMicrotask(() => cb({ ok: true, dbId }));
      },
      close(_dbId: string, cb: NativeCallback) {
        queueMicrotask(() => cb({ ok: true }));
      },
      execute(_dbId: string, sql: string, _params: BindValues, cb: NativeCallback) {
        queueMicrotask(() => cb(handleExecute(sql)));
      },
      executeBatch(_dbId: string, sql: string, _params: BindValueRows, cb: NativeCallback) {
        queueMicrotask(() => cb(handleExecute(sql)));
      },
    },
  };
}

function coreStatus(connected: boolean, hasSynced: boolean): CoreSyncStatus {
  return {
    connected,
    connecting: false,
    priority_status: [
      {
        priority: FULL_SYNC_PRIORITY,
        has_synced: hasSynced,
        last_synced_at: hasSynced ? 1_700_000_000_000_000 : 0,
      },
    ],
    downloading: null,
    streams: [],
  };
}

function emitStatus(db: StatusEmitter, connected: boolean, hasSynced: boolean): void {
  const snapshot = new SyncStatusSnapshot(coreStatus(connected, hasSynced), {});
  db.currentStatus = snapshot;
  db.iterateListeners((listener) => {
    listener.statusChanged?.(snapshot);
  });
}

function stillPending(promise: Promise<void>, ms: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => false),
    new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(true), ms);
    }),
  ]);
}

test("waitForFirstSync stays pending on connected and resolves on hasSynced", async () => {
  installAppNative();
  const db = new PowerSyncDatabase({
    schema: new Schema({
      lists: new Table({ name: column.text }),
    }),
    database: { dbFilename: "wait-for-first-sync.db" },
  });
  try {
    await db.waitForReady();
    assert.notEqual(db.currentStatus.hasSynced, true);
    assert.equal(db.currentStatus.connected, false);

    const firstSync = db.waitForFirstSync();
    await new Promise((resolve) => setImmediate(resolve));

    // SAFETY: Client instance is BaseObserver; iterateListeners is the status fan-out waitForFirstSync uses.
    const emitter = db as CommonPowerSyncDatabase & StatusEmitter;
    emitStatus(emitter, true, false);
    assert.equal(db.currentStatus.connected, true);
    assert.notEqual(db.currentStatus.hasSynced, true);
    assert.equal(
      await stillPending(firstSync, 50),
      true,
      "connected alone must not finish waitForFirstSync",
    );

    emitStatus(emitter, true, true);
    assert.equal(db.currentStatus.hasSynced, true);
    await firstSync;
  } finally {
    await db.close();
  }
});
