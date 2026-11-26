import assert from "node:assert/strict";
import { test } from "node:test";
import { LynxDBAdapter } from "../src/adapter/LynxDBAdapter.ts";
import {
  NativeModuleError,
  type BindValueRows,
  type BindValues,
  type NativeCallback,
  type NativePowerSyncModule,
  type NativeWireEnvelope,
  type OpenPayload,
} from "../src/adapter/native.ts";
import { withFakeLynxHost } from "./fake-lynx-host.ts";

interface ExecuteRequest {
  dbId: string;
  sql: string;
  params: BindValues;
}

interface BatchRequest {
  dbId: string;
  sql: string;
  params: BindValueRows;
}

interface NativeOverrides {
  open?: NativePowerSyncModule["open"];
  close?: NativePowerSyncModule["close"];
  execute?: (request: ExecuteRequest) => NativeWireEnvelope;
  executeBatch?: (request: BatchRequest) => NativeWireEnvelope;
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

function createFakeSqlModule(overrides: NativeOverrides = {}) {
  let nextId = 1;
  const opens: OpenCall[] = [];
  const executes: ExecuteCall[] = [];
  const batches: BatchCall[] = [];
  const closes: CloseCall[] = [];

  const native: NativePowerSyncModule = {
    open(payload: OpenPayload, cb: NativeCallback) {
      if (overrides.open != null) {
        overrides.open(payload, cb);
        return;
      }
      const dbId = `db-${nextId++}`;
      opens.push({ payload, dbId, callback: cb instanceof Function });
      queueMicrotask(() => {
        cb({ ok: true, dbId });
      });
      // Native modules are callback-only; return a bogus Promise-like value to prove it is ignored.
      return Promise.resolve("must-not-await-native-return") as unknown as void;
    },
    close(dbId: string, cb: NativeCallback) {
      closes.push({ dbId, callback: cb instanceof Function });
      if (overrides.close != null) {
        overrides.close(dbId, cb);
        return;
      }
      queueMicrotask(() => cb({ ok: true }));
      return Promise.resolve("must-not-await-native-return") as unknown as void;
    },
    execute(dbId: string, sql: string, params: BindValues, cb: NativeCallback) {
      assert.ok(cb instanceof Function);
      executes.push({ dbId, sql, params, callback: cb instanceof Function });
      queueMicrotask(() => {
        if (overrides.execute != null) {
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
      return Promise.resolve("must-not-await-native-return") as unknown as void;
    },
    executeBatch(dbId: string, sql: string, params: BindValueRows, cb: NativeCallback) {
      assert.ok(cb instanceof Function);
      batches.push({ dbId, sql, params, callback: cb instanceof Function });
      queueMicrotask(() => {
        if (overrides.executeBatch != null) {
          cb(overrides.executeBatch({ dbId, sql, params }));
          return;
        }
        cb({
          ok: true,
          insertId: 0,
          rowsAffected: params.length,
          columnNames: [],
          rawRows: [],
        });
      });
      return Promise.resolve("must-not-await-native-return") as unknown as void;
    },
  };

  return { native, opens, executes, batches, closes };
}

async function withAdapter(
  overrides: NativeOverrides,
  run: (ctx: {
    adapter: LynxDBAdapter;
    mock: ReturnType<typeof createFakeSqlModule>;
  }) => Promise<void>,
): Promise<void> {
  const mock = createFakeSqlModule(overrides);
  await withFakeLynxHost({ nativeModules: { NativePowerSyncModule: mock.native } }, async () => {
    const adapter = new LynxDBAdapter({ name: "app.db", dbLocation: "/tmp/ps" });
    await adapter.initialized;
    await run({ adapter, mock });
  });
}

test("opens 1 write + 5 read connections per file and never calls loadExtension", async () => {
  await withAdapter({}, async ({ adapter, mock }) => {
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
    const writeDb = mock.opens.find((o) => o.payload.readOnly === false)?.dbId;
    assert.ok(writeDb != null);
    const writeSql = mock.executes.filter((e) => e.dbId === writeDb).map((e) => e.sql);
    assert.ok(writeSql.some((s) => s.includes("PRAGMA journal_mode = WAL")));
    assert.ok(writeSql.some((s) => s.includes("PRAGMA journal_size_limit = 6291456")));
    assert.ok(writeSql.some((s) => s.includes("PRAGMA synchronous = NORMAL")));
    assert.ok(writeSql.some((s) => s.includes("powersync_update_hooks('install')")));
    const readDb = mock.opens.find((o) => o.payload.readOnly === true)?.dbId;
    assert.ok(readDb != null);
    const readSql = mock.executes.filter((e) => e.dbId === readDb).map((e) => e.sql);
    assert.ok(!readSql.some((s) => s.includes("powersync_update_hooks('install')")));
    assert.ok(!sql.some((s) => /loadExtension/i.test(s)));
    assert.equal("loadExtension" in mock.native, false);
    await adapter.close();
    assert.equal(mock.closes.length, 6);
  });
});

test("rejects with NativeModuleError when Native Module returns { ok: false, code }", async () => {
  await withAdapter(
    {
      execute: ({ sql }) => {
        if (sql.startsWith("SELECT fail")) {
          return { ok: false, message: "disk I/O error", code: 778 };
        }
        if (sql.includes("powersync_update_hooks('get')")) {
          return {
            ok: true,
            insertId: 0,
            rowsAffected: 0,
            columnNames: ["powersync_update_hooks"],
            rawRows: [["[]"]],
          };
        }
        return { ok: true, insertId: 0, rowsAffected: 0, columnNames: [], rawRows: [] };
      },
    },
    async ({ adapter }) => {
      await assert.rejects(
        () => adapter.execute("SELECT fail"),
        (err: unknown) => {
          assert.ok(err instanceof NativeModuleError);
          assert.equal(err.message, "disk I/O error");
          assert.equal(err.code, 778);
          return true;
        },
      );
      await adapter.close();
    },
  );
});

test("fails init when NativePowerSyncModule is not registered or open omits dbId", async () => {
  await withFakeLynxHost({ nativeModules: {} }, async () => {
    const adapter = new LynxDBAdapter({ name: "missing.db" });
    await assert.rejects(() => adapter.initialized, {
      message: "NativePowerSyncModule is not registered",
    });
  });

  const noDbId = createFakeSqlModule({
    open(_payload, cb) {
      queueMicrotask(() => cb({ ok: true }));
    },
  });
  await withFakeLynxHost(
    { nativeModules: { NativePowerSyncModule: noDbId.native } },
    async () => {
      const adapter = new LynxDBAdapter({ name: "no-id.db" });
      await assert.rejects(() => adapter.initialized, {
        message: "NativePowerSyncModule.open did not return dbId",
      });
    },
  );
});

test("encodes Uint8Array, number[], and BigInt inbound and decodes ArrayBuffer and tagged BigInt outbound", async () => {
  let sawInsertParams: BindValues = [];
  await withAdapter(
    {
      execute: ({ sql, params }) => {
        if (sql.includes("powersync_update_hooks('get')")) {
          return {
            ok: true,
            insertId: 0,
            rowsAffected: 0,
            columnNames: ["powersync_update_hooks"],
            rawRows: [["[]"]],
          };
        }
        if (sql.startsWith("INSERT")) {
          sawInsertParams = params;
          return {
            ok: true,
            insertId: 1,
            rowsAffected: 1,
            columnNames: ["blob", "big", "snowflake"],
            rawRows: [
              [params[0] as ArrayBuffer, { __psBig: true, v: "9007199254740993" }, "9007199254740993"],
            ],
          };
        }
        return { ok: true, insertId: 0, rowsAffected: 0, columnNames: [], rawRows: [] };
      },
    },
    async ({ adapter }) => {
      const result = await adapter.execute("INSERT INTO t VALUES (?, ?, ?, ?)", [
        new Uint8Array([1, 2]),
        [3, 4],
        9007199254740993n,
        null,
      ]);
      assert.ok(sawInsertParams[0] instanceof ArrayBuffer);
      assert.deepEqual([...new Uint8Array(sawInsertParams[0])], [1, 2]);
      assert.ok(sawInsertParams[1] instanceof ArrayBuffer);
      assert.deepEqual([...new Uint8Array(sawInsertParams[1])], [3, 4]);
      assert.deepEqual(sawInsertParams[2], { __psBig: true, v: "9007199254740993" });
      assert.equal(sawInsertParams[3], null);

      const row = result.rows?.item(0) as {
        blob: Uint8Array;
        big: bigint;
        snowflake: string;
      };
      assert.ok(row.blob instanceof Uint8Array);
      assert.deepEqual([...row.blob], [1, 2]);
      assert.equal(row.big, 9007199254740993n);
      assert.equal(row.snowflake, "9007199254740993");
      await adapter.close();
    },
  );
});

test("writeLock serializes writers and notifies tablesUpdated from powersync_update_hooks get", async () => {
  await withAdapter(
    {
      execute: ({ sql }) => {
        if (sql.includes("powersync_update_hooks('get')")) {
          return {
            ok: true,
            insertId: 0,
            rowsAffected: 0,
            columnNames: ["powersync_update_hooks"],
            rawRows: [['["lists"]']],
          };
        }
        return { ok: true, insertId: 0, rowsAffected: 0, columnNames: [], rawRows: [] };
      },
    },
    async ({ adapter }) => {
      const seen: string[][] = [];
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
    },
  );
});

test("readLock allows five concurrent readers and a sixth waits", async () => {
  await withAdapter({}, async ({ adapter }) => {
    let active = 0;
    let maxActive = 0;
    let sixthStarted = false;
    let releaseGate = (): void => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const readers: Promise<void>[] = [];
    for (let i = 0; i < 5; i++) {
      readers.push(
        adapter.readLock(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await gate;
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
    releaseGate();
    await Promise.all([...readers, sixth]);
    assert.equal(sixthStarted, true);
    assert.equal(maxActive, 5);
    await adapter.close();
  });
});

test("closes opened dbIds when init fails after write open", async () => {
  const mock = createFakeSqlModule({
    execute: ({ sql }) => {
      if (sql.includes("powersync_update_hooks('install')")) {
        return { ok: false, message: "no such function: powersync_update_hooks" };
      }
      return { ok: true, insertId: 0, rowsAffected: 0, columnNames: [], rawRows: [] };
    },
  });
  await withFakeLynxHost({ nativeModules: { NativePowerSyncModule: mock.native } }, async () => {
    const adapter = new LynxDBAdapter({ name: "app.db" });
    await assert.rejects(() => adapter.initialized, /no such function: powersync_update_hooks/);
    assert.equal(mock.opens.length, 1);
    assert.deepEqual(
      mock.closes.map((c) => c.dbId),
      mock.opens.map((o) => o.dbId),
    );
  });
});

test("closes already-opened dbIds when a later read open fails", async () => {
  let nextId = 1;
  const opens: OpenCall[] = [];
  const mock = createFakeSqlModule({
    open(payload, cb) {
      if (payload.readOnly) {
        queueMicrotask(() => cb({ ok: false, message: "unable to open database file" }));
        return;
      }
      const dbId = `db-${nextId++}`;
      opens.push({ payload, dbId, callback: cb instanceof Function });
      queueMicrotask(() => cb({ ok: true, dbId }));
    },
  });
  await withFakeLynxHost({ nativeModules: { NativePowerSyncModule: mock.native } }, async () => {
    const adapter = new LynxDBAdapter({ name: "app.db" });
    await assert.rejects(() => adapter.initialized, /unable to open database file/);
    assert.equal(opens.length, 1);
    assert.equal(opens[0]!.payload.readOnly, false);
    assert.deepEqual(
      mock.closes.map((c) => c.dbId),
      opens.map((o) => o.dbId),
    );
  });
});

test("executeBatch encodes row params and returns QueryResult without rows", async () => {
  await withAdapter({}, async ({ adapter, mock }) => {
    const result = await adapter.executeBatch("INSERT INTO t VALUES (?, ?)", [
      [1n, new Uint8Array([9])],
      [2n, [7, 8]],
    ]);
    assert.deepEqual(result.rows?._array ?? [], []);
    assert.equal(result.rowsAffected, 2);
    assert.equal(mock.batches.length, 1);
    assert.equal(mock.batches[0]!.sql, "INSERT INTO t VALUES (?, ?)");
    assert.deepEqual(mock.batches[0]!.params[0]![0], { __psBig: true, v: "1" });
    assert.ok(mock.batches[0]!.params[0]![1] instanceof ArrayBuffer);
    assert.ok(mock.batches[0]!.params[1]![1] instanceof ArrayBuffer);
    await adapter.close();
  });
});

test("partial close retries only remaining native connections", async () => {
  let failReaderId = "";
  let failReaderCloses = 0;
  await withAdapter(
    {
      close(dbId, cb) {
        queueMicrotask(() => {
          if (dbId === failReaderId && failReaderCloses === 0) {
            failReaderCloses += 1;
            cb({ ok: false, message: "reader close failed" });
            return;
          }
          cb({ ok: true });
        });
      },
    },
    async ({ adapter, mock }) => {
      const writeDbId = mock.opens.find((open) => open.payload.readOnly === false)!.dbId;
      failReaderId = mock.opens.find((open) => open.payload.readOnly === true)!.dbId;

      await assert.rejects(() => adapter.close(), /reader close failed/);
      assert.equal(mock.closes.length, mock.opens.length);
      assert.equal(mock.closes.filter((close) => close.dbId === writeDbId).length, 1);
      assert.equal(mock.closes.filter((close) => close.dbId === failReaderId).length, 1);

      const afterFirst = mock.closes.length;
      await adapter.close();
      assert.deepEqual(
        mock.closes.slice(afterFirst).map((close) => close.dbId),
        [failReaderId],
      );
    },
  );
});

test("close nulls connections so a second close cannot re-close dbIds", async () => {
  await withAdapter({}, async ({ adapter, mock }) => {
    await adapter.close();
    assert.equal(mock.closes.length, 6);
    await assert.rejects(() => adapter.close(), /not open/);
    assert.equal(mock.closes.length, 6);
  });
});

test("BEGIN IMMEDIATE is issued in JS for writeTransaction", async () => {
  await withAdapter({}, async ({ adapter, mock }) => {
    mock.executes.length = 0;
    await adapter.writeTransaction(async (tx) => {
      await tx.execute("INSERT INTO t VALUES (1)");
    });
    const sql = mock.executes.map((e) => e.sql);
    assert.ok(sql.includes("BEGIN IMMEDIATE"));
    assert.ok(sql.includes("COMMIT"));
    await adapter.close();
  });
});
