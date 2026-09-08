// @ts-nocheck
import assert from "node:assert/strict";
import { test } from "node:test";
import { LynxDBAdapter } from "../src/adapter/LynxDBAdapter.ts";
import {
  blobToArrayBuffer,
  callNative,
  decodeCell,
  encodeBindParams,
  type BindValueRows,
  type BindValues,
  type NativeCallback,
  type NativePowerSyncModule,
  type NativeWireEnvelope,
  type OpenPayload,
} from "../src/adapter/native.ts";

function isArrayBuffer(value: ArrayBuffer | Uint8Array | number[] | string | null): boolean {
  return value instanceof ArrayBuffer;
}

interface ExecuteRequest {
  dbId: string;
  sql: string;
  params: BindValues | BindValueRows;
}

interface NativeOverrides {
  execute?: (request: ExecuteRequest) => NativeWireEnvelope;
  executeBatch?: (request: ExecuteRequest) => NativeWireEnvelope;
  open?: NativePowerSyncModule["open"];
}

interface OpenCall {
  payload: OpenPayload;
  dbId: string;
  callback: boolean;
}

interface CloseCall {
  dbId: string;
  callback: boolean;
}

interface ExecuteCall {
  dbId: string;
  sql: string;
  params: BindValues;
  callback: boolean;
}

interface BatchCall {
  dbId: string;
  sql: string;
  params: BindValueRows;
  callback: boolean;
}

function requireNative(): NativePowerSyncModule {
  const native = globalThis.NativeModules?.NativePowerSyncModule;
  if (native == null) {
    throw new Error("NativePowerSyncModule is not registered");
  }
  return native;
}

function installMockNative(overrides: NativeOverrides = {}) {
  let nextId = 1;
  const opens: OpenCall[] = [];
  const executes: ExecuteCall[] = [];
  const batches: BatchCall[] = [];
  const closes: CloseCall[] = [];
  const inFlightByDb = new Map<string, number>();

  function trackStart(dbId: string) {
    const n = (inFlightByDb.get(dbId) ?? 0) + 1;
    inFlightByDb.set(dbId, n);
    if (n > 1) {
      overlappingSameDb += 1;
    }
  }

  function trackEnd(dbId: string) {
    inFlightByDb.set(dbId, (inFlightByDb.get(dbId) ?? 1) - 1);
  }

  let overlappingSameDb = 0;
  let maxConcurrentOpens = 0;
  let currentOpens = 0;

  const native = {
    open(payload: OpenPayload, cb: NativeCallback) {
      currentOpens += 1;
      maxConcurrentOpens = Math.max(maxConcurrentOpens, currentOpens);
      const dbId = `db-${nextId++}`;
      opens.push({ payload, dbId, callback: cb instanceof Function });
      queueMicrotask(() => {
        currentOpens -= 1;
        cb({ ok: true, dbId });
      });
      return Promise.resolve("must-not-await-native-return");
    },
    close(dbId: string, cb: NativeCallback) {
      closes.push({ dbId, callback: cb instanceof Function });
      queueMicrotask(() => cb({ ok: true }));
      return Promise.resolve("must-not-await-native-return");
    },
    execute(dbId: string, sql: string, params: BindValues, cb: NativeCallback) {
      assert.ok(cb instanceof Function);
      trackStart(dbId);
      executes.push({ dbId, sql, params, callback: cb instanceof Function });
      queueMicrotask(() => {
        trackEnd(dbId);
        if (overrides.execute) {
          cb(overrides.execute({ dbId, sql, params }));
          return;
        }
        if (sql.includes("powersync_update_hooks('get')")) {
          cb({
            ok: true,
            insertId: 0,
            rowsAffected: 0,
            columnNames: ["powersync_update_hooks"],
            rawRows: [["[]"]],
          });
          return;
        }
        if (sql.includes("powersync_update_hooks('install')")) {
          cb({
            ok: true,
            insertId: 0,
            rowsAffected: 0,
            columnNames: ["powersync_update_hooks"],
            rawRows: [[null]],
          });
          return;
        }
        cb({
          ok: true,
          insertId: 0,
          rowsAffected: 0,
          columnNames: [],
          rawRows: [],
        });
      });
      return Promise.resolve("must-not-await-native-return");
    },
    executeBatch(dbId: string, sql: string, params: BindValueRows, cb: NativeCallback) {
      assert.ok(cb instanceof Function);
      batches.push({ dbId, sql, params, callback: cb instanceof Function });
      queueMicrotask(() => {
        if (overrides.executeBatch) {
          cb(overrides.executeBatch({ dbId, sql, params }));
          return;
        }
        cb({
          ok: true,
          insertId: 0,
          rowsAffected: params?.length ?? 0,
          columnNames: [],
          rawRows: [],
        });
      });
      return Promise.resolve("must-not-await-native-return");
    },
  };

  globalThis.NativeModules = { NativePowerSyncModule: native };
  return {
    opens,
    executes,
    batches,
    closes,
    stats: () => ({ overlappingSameDb, maxConcurrentOpens }),
  };
}

async function openAdapter() {
  const mock = installMockNative();
  const adapter = new LynxDBAdapter({ name: "app.db", dbLocation: "/tmp/ps" });
  await adapter.initialized;
  return { adapter, mock };
}

test("opens 1 write + 5 read connections per file and never loadExtension", async () => {
  const { adapter, mock } = await openAdapter();
  assert.equal(mock.opens.length, 6);
  assert.equal(mock.opens.filter((o) => o.payload.readOnly === false).length, 1);
  assert.equal(mock.opens.filter((o) => o.payload.readOnly === true).length, 5);
  for (const open of mock.opens) {
    assert.equal(open.payload.dbFilename, "app.db");
    assert.equal(open.payload.dbLocation, "/tmp/ps");
    assert.equal(open.callback, true);
  }
  const sql = mock.executes.map((e) => e.sql);
  assert.ok(sql.some((s) => s.includes("PRAGMA busy_timeout = 30000")));
  assert.ok(sql.some((s) => s.includes("PRAGMA cache_size = -51200")));
  assert.ok(sql.some((s) => s.includes("PRAGMA temp_store = memory")));
  const writeDb = mock.opens.find((o) => o.payload.readOnly === false).dbId;
  const writeSql = mock.executes.filter((e) => e.dbId === writeDb).map((e) => e.sql);
  assert.ok(writeSql.some((s) => s.includes("PRAGMA journal_mode = WAL")));
  assert.ok(writeSql.some((s) => s.includes("PRAGMA journal_size_limit = 6291456")));
  assert.ok(writeSql.some((s) => s.includes("PRAGMA synchronous = NORMAL")));
  assert.ok(writeSql.some((s) => s.includes("powersync_update_hooks('install')")));
  const readDb = mock.opens.find((o) => o.payload.readOnly === true).dbId;
  const readSql = mock.executes.filter((e) => e.dbId === readDb).map((e) => e.sql);
  assert.ok(!readSql.some((s) => s.includes("powersync_update_hooks('install')")));
  assert.ok(!sql.some((s) => /loadExtension/i.test(s)));
  assert.equal("loadExtension" in requireNative(), false);
  await adapter.close();
  assert.equal(mock.closes.length, 6);
});

test("Native Module methods are invoked with a callback and the return value is ignored", async () => {
  installMockNative();
  const envelope = await callNative("open", { dbFilename: "x.db", readOnly: true });
  assert.equal(envelope.ok, true);
  assert.match(envelope.dbId, /^db-/);
});

test("throws a JS Error when the envelope is { ok: false }", async () => {
  installMockNative({
    execute: () => ({ ok: false, message: "disk I/O error", code: 778 }),
  });
  await assert.rejects(
    () => callNative("execute", "db-1", "SELECT 1", []),
    (err) => {
      assert.equal(err instanceof Error, true);
      assert.equal(err.message, "disk I/O error");
      assert.equal(err.code, 778);
      return true;
    },
  );
});

test("converts Uint8Array and number[] blobs to ArrayBuffer inbound and ArrayBuffer to Uint8Array outbound", () => {
  const fromBytes = blobToArrayBuffer(new Uint8Array([1, 2, 3]));
  const fromArray = blobToArrayBuffer([4, 5]);
  assert.ok(isArrayBuffer(fromBytes));
  assert.deepEqual([...new Uint8Array(fromBytes)], [1, 2, 3]);
  assert.ok(isArrayBuffer(fromArray));
  assert.deepEqual([...new Uint8Array(fromArray)], [4, 5]);
  const encoded = encodeBindParams(["ok", 1n, new Uint8Array([9]), [7, 8], null]);
  assert.equal(encoded[0], "ok");
  assert.equal(encoded[1], 1n);
  assert.ok(isArrayBuffer(encoded[2]));
  assert.ok(isArrayBuffer(encoded[3]));
  assert.equal(encoded[4], null);
  const out = decodeCell(Uint8Array.from([1, 2]).buffer);
  assert.ok(out instanceof Uint8Array);
  assert.deepEqual([...out], [1, 2]);
});

test("execute sends ArrayBuffers and returns Uint8Array cells", async () => {
  const { adapter, mock } = await openAdapter();
  mock.executes.length = 0;
  const original = globalThis.NativeModules.NativePowerSyncModule.execute;
  globalThis.NativeModules.NativePowerSyncModule.execute = (dbId, sql, params, cb) => {
    original(dbId, sql, params, (envelope) => {
      if (sql.startsWith("INSERT")) {
        assert.ok(params[0] instanceof ArrayBuffer);
        assert.ok(params[1] instanceof ArrayBuffer);
        cb({
          ok: true,
          insertId: 1,
          rowsAffected: 1,
          columnNames: ["blob"],
          rawRows: [[params[0]]],
        });
        return;
      }
      cb(envelope);
    });
    return Promise.resolve("must-not-await-native-return");
  };
  const result = await adapter.execute("INSERT INTO t VALUES (?, ?)", [
    new Uint8Array([1, 2]),
    [3, 4],
  ]);
  assert.ok(result.rows.item(0).blob instanceof Uint8Array);
  assert.deepEqual([...result.rows.item(0).blob], [1, 2]);
  await adapter.close();
});

test("writeLock serializes writers and notifies tablesUpdated from powersync_update_hooks get", async () => {
  const { adapter } = await openAdapter();
  const original = globalThis.NativeModules.NativePowerSyncModule.execute;
  globalThis.NativeModules.NativePowerSyncModule.execute = (dbId, sql, params, cb) => {
    if (sql.includes("powersync_update_hooks('get')")) {
      queueMicrotask(() =>
        cb({
          ok: true,
          insertId: 0,
          rowsAffected: 0,
          columnNames: ["powersync_update_hooks"],
          rawRows: [['["lists"]']],
        }),
      );
      return Promise.resolve("must-not-await-native-return");
    }
    return original(dbId, sql, params, cb);
  };

  const seen = [];
  adapter.registerListener({
    tablesUpdated: (n) => seen.push(n.tables),
  });

  let writerCount = 0;
  let maxWriters = 0;
  await Promise.all([
    adapter.writeLock(async () => {
      writerCount += 1;
      maxWriters = Math.max(maxWriters, writerCount);
      await new Promise((r) => setTimeout(r, 20));
      writerCount -= 1;
    }),
    adapter.writeLock(async () => {
      writerCount += 1;
      maxWriters = Math.max(maxWriters, writerCount);
      writerCount -= 1;
    }),
  ]);
  assert.equal(maxWriters, 1);
  assert.deepEqual(seen, [["lists"], ["lists"]]);
  await adapter.close();
});

test("readLock allows five concurrent readers and a sixth waits", async () => {
  const { adapter } = await openAdapter();
  let active = 0;
  let maxActive = 0;
  let sixthStarted = false;
  const gate =
    Promise.withResolvers instanceof Function
      ? Promise.withResolvers()
      : (() => {
          let resolve;
          const promise = new Promise((r) => (resolve = r));
          return { promise, resolve };
        })();

  const readers = [];
  for (let i = 0; i < 5; i++) {
    readers.push(
      adapter.readLock(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gate.promise;
        active -= 1;
      }),
    );
  }
  await new Promise((r) => setTimeout(r, 30));
  const sixth = adapter.readLock(async () => {
    sixthStarted = true;
    active += 1;
    maxActive = Math.max(maxActive, active);
    active -= 1;
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sixthStarted, false);
  assert.equal(maxActive, 5);
  gate.resolve();
  await Promise.all([...readers, sixth]);
  assert.equal(sixthStarted, true);
  assert.equal(maxActive, 5);
  await adapter.close();
});

test("closes opened dbIds when init fails after write open", async () => {
  const mock = installMockNative({
    execute: ({ sql }) => {
      if (sql.includes("powersync_update_hooks('install')")) {
        return { ok: false, message: "no such function: powersync_update_hooks" };
      }
      return {
        ok: true,
        insertId: 0,
        rowsAffected: 0,
        columnNames: [],
        rawRows: [],
      };
    },
  });
  const adapter = new LynxDBAdapter({ name: "app.db" });
  await assert.rejects(() => adapter.initialized, /no such function: powersync_update_hooks/);
  assert.equal(mock.opens.length, 1);
  assert.deepEqual(
    mock.closes.map((c) => c.dbId),
    mock.opens.map((o) => o.dbId),
  );
});

test("closes already-opened dbIds when a later read open fails", async () => {
  const mock = installMockNative();
  const originalOpen = globalThis.NativeModules.NativePowerSyncModule.open;
  globalThis.NativeModules.NativePowerSyncModule.open = (payload, cb) => {
    if (payload.readOnly === true) {
      queueMicrotask(() => cb({ ok: false, message: "unable to open database file" }));
      return Promise.resolve("must-not-await-native-return");
    }
    return originalOpen(payload, cb);
  };
  const adapter = new LynxDBAdapter({ name: "app.db" });
  await assert.rejects(() => adapter.initialized, /unable to open database file/);
  assert.equal(mock.opens.length, 1);
  assert.equal(mock.opens[0].payload.readOnly, false);
  assert.deepEqual(
    mock.closes.map((c) => c.dbId),
    mock.opens.map((o) => o.dbId),
  );
});

test("executeBatch returns QueryResult without rows", async () => {
  const { adapter, mock } = await openAdapter();
  const result = await adapter.executeBatch("INSERT INTO t VALUES (?)", [[1], [2]]);
  assert.deepEqual(result.array, []);
  assert.equal(result.rowsAffected, 2);
  const iterated = [];
  for (const row of result) {
    iterated.push(row);
  }
  assert.deepEqual(iterated, []);
  assert.equal(mock.batches.length, 1);
  assert.equal(mock.batches[0].sql, "INSERT INTO t VALUES (?)");
  await adapter.close();
});

test("BEGIN IMMEDIATE is issued in JS for writeTransaction", async () => {
  const { adapter, mock } = await openAdapter();
  mock.executes.length = 0;
  await adapter.writeTransaction(async (tx) => {
    await tx.execute("INSERT INTO t VALUES (1)");
  });
  const sql = mock.executes.map((e) => e.sql);
  assert.ok(sql.includes("BEGIN IMMEDIATE"));
  assert.ok(sql.includes("COMMIT"));
  await adapter.close();
});
