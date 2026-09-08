// @ts-nocheck
import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema, Table, column, SyncStreamConnectionMethod } from "../lib/index.js";
import { PowerSyncDatabase } from "../lib/PowerSyncDatabase.js";
import { LynxRemote } from "../lib/sync/LynxRemote.js";
import { LynxStreamingSyncImplementation } from "../lib/sync/LynxStreamingSyncImplementation.js";
import type { BindValueRows, OpenPayload } from "../lib/adapter/native.js";

function installAppNative(store: { lists: { id: string; name: string }[] } = { lists: [] }) {
  let nextId = 1;
  const opens: { payload: OpenPayload; dbId: string }[] = [];
  const closes: { dbId: string }[] = [];
  const batches: { sql: string; params: BindValueRows }[] = [];

  function ok(columnNames, rawRows, extra = {}) {
    return { ok: true, insertId: 0, rowsAffected: 0, columnNames, rawRows, ...extra };
  }

  function handleExecute(sql, params) {
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
    if (/INSERT INTO lists/i.test(sql)) {
      store.lists.push({ id: params?.[0], name: params?.[1] });
      return ok([], [], { insertId: store.lists.length, rowsAffected: 1 });
    }
    if (/SELECT .*FROM lists/i.test(sql)) {
      return ok(
        ["id", "name"],
        store.lists.map((row) => [row.id, row.name]),
      );
    }
    return ok([], []);
  }

  globalThis.NativeModules = {
    NativePowerSyncModule: {
      open(payload, cb) {
        const dbId = `db-${nextId++}`;
        opens.push({ payload, dbId });
        queueMicrotask(() => cb({ ok: true, dbId }));
      },
      close(dbId, cb) {
        closes.push({ dbId });
        queueMicrotask(() => cb({ ok: true }));
      },
      execute(_dbId, sql, params, cb) {
        queueMicrotask(() => cb(handleExecute(sql, params)));
      },
      executeBatch(_dbId, sql, params, cb) {
        batches.push({ sql, params });
        queueMicrotask(() => {
          for (const row of params ?? []) {
            handleExecute(sql, row);
          }
          cb({
            ok: true,
            insertId: 0,
            rowsAffected: params?.length ?? 0,
            columnNames: [],
            rawRows: [],
          });
        });
      },
    },
  };
  return { opens, closes, batches, store };
}

test("barrel re-exports common names and default connect method is HTTP", () => {
  assert.equal(Schema instanceof Function, true);
  assert.equal(Table instanceof Function, true);
  assert.equal(column.text instanceof Object, true);
  const getter = Object.getOwnPropertyDescriptor(
    PowerSyncDatabase.prototype,
    "defaultConnectionMethod",
  )?.get;
  assert.equal(getter instanceof Function, true);
  assert.equal(getter.call({}), SyncStreamConnectionMethod.HTTP);
});

test("app constructs PowerSyncDatabase and uses official SQL including executeBatch QueryResult", async () => {
  const mock = installAppNative();
  const AppSchema = new Schema({
    lists: new Table({ name: column.text }),
  });
  const db = new PowerSyncDatabase({
    schema: AppSchema,
    database: { dbFilename: "app.db", dbLocation: "/tmp/ps" },
  });
  try {
    await db.waitForReady();
    assert.equal(db.defaultConnectionMethod, SyncStreamConnectionMethod.HTTP);
    assert.equal(mock.opens.length, 6);
    assert.equal(mock.opens.filter((open) => open.payload.readOnly === false).length, 1);
    assert.equal(mock.opens.filter((open) => open.payload.readOnly === true).length, 5);

    const inserted = await db.execute("INSERT INTO lists (id, name) VALUES (?, ?)", [
      "list-1",
      "Groceries",
    ]);
    assert.equal(inserted.rowsAffected, 1);

    const rows = await db.getAll("SELECT id, name FROM lists");
    assert.deepEqual(rows, [{ id: "list-1", name: "Groceries" }]);

    const batch = await db.executeBatch("INSERT INTO lists (id, name) VALUES (?, ?)", [
      ["list-2", "Hardware"],
      ["list-3", "Pharmacy"],
    ]);
    assert.deepEqual(batch.array, []);
    assert.equal(batch.rowsAffected, 2);
    const iterated = [];
    for (const row of batch) {
      iterated.push(row);
    }
    assert.deepEqual(iterated, []);
    assert.equal(mock.batches.length, 1);

    const all = await db.getAll("SELECT id, name FROM lists");
    assert.deepEqual(all, [
      { id: "list-1", name: "Groceries" },
      { id: "list-2", name: "Hardware" },
      { id: "list-3", name: "Pharmacy" },
    ]);

    const impl = db.generateSyncStreamImplementation(
      { fetchCredentials: async () => null, uploadData: async () => {} },
      {},
    );
    assert.ok(impl instanceof LynxStreamingSyncImplementation);
    assert.ok(impl.options.remote instanceof LynxRemote);
    assert.match(impl.options.remote.getUserAgent(), /powersync-lynx/);

    await db.close();
    assert.equal(mock.closes.length, 6);
  } finally {
    db.triggersImpl?.dispose();
  }
});

test("LynxRemote createTextDecoder uses TextCodecHelper UTF-8", () => {
  const decoded = [];
  globalThis.TextCodecHelper = {
    decode(buf) {
      decoded.push(buf);
      return new TextDecoder().decode(buf);
    },
  };
  const remote = new LynxRemote({ fetchCredentials: async () => null }, { log() {} });
  const decoder = remote.createTextDecoder();
  const bytes = new TextEncoder().encode("hello");
  assert.equal(decoder.decode(bytes), "hello");
  assert.equal(decoded.length, 1);
  assert.ok(decoded[0] instanceof ArrayBuffer);
});
