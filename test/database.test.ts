import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema, Table, column, SyncStreamConnectionMethod } from "../src/index.ts";
import { PowerSyncDatabase } from "../src/PowerSyncDatabase.ts";
import { LynxRemote } from "../src/sync/LynxRemote.ts";
import { LynxStreamingSyncImplementation } from "../src/sync/LynxStreamingSyncImplementation.ts";
import type {
  BindValueRows,
  BindValues,
  NativeCell,
  NativePowerSyncModule,
  NativeWireEnvelope,
  OpenPayload,
} from "../src/adapter/native.ts";
import { withFakeLynxHost } from "./fake-lynx-host.ts";

function createAppNative(store: { lists: { id: string; name: string }[] } = { lists: [] }) {
  let nextId = 1;
  const opens: { payload: OpenPayload; dbId: string }[] = [];
  const closes: { dbId: string }[] = [];
  const batches: { sql: string; params: BindValueRows }[] = [];

  function ok(
    columnNames: string[],
    rawRows: NativeCell[][],
    extra: Partial<NativeWireEnvelope> = {},
  ): NativeWireEnvelope {
    return { ok: true, insertId: 0, rowsAffected: 0, columnNames, rawRows, ...extra };
  }

  function handleExecute(sql: string, params: BindValues): NativeWireEnvelope {
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
      store.lists.push({ id: String(params[0]), name: String(params[1]) });
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

  const native: NativePowerSyncModule = {
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
        for (const row of params) {
          handleExecute(sql, row);
        }
        cb({
          ok: true,
          insertId: 0,
          rowsAffected: params.length,
          columnNames: [],
          rawRows: [],
        });
      });
    },
  };
  return { native, opens, closes, batches, store };
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
  assert.equal(getter?.call({}), SyncStreamConnectionMethod.HTTP);
});

test("app constructs PowerSyncDatabase and uses official SQL including executeBatch QueryResult", async () => {
  const mock = createAppNative();
  await withFakeLynxHost({ nativeModules: { NativePowerSyncModule: mock.native } }, async () => {
    const AppSchema = new Schema({
      lists: new Table({ name: column.text }),
    });
    const db = new PowerSyncDatabase({
      schema: AppSchema,
      database: { dbFilename: "app.db", dbLocation: "/tmp/ps" },
    });
    await db.waitForReady();
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
    assert.deepEqual(batch.rows?._array ?? [], []);
    assert.equal(batch.rowsAffected, 2);
    assert.equal(mock.batches.length, 1);

    const all = await db.getAll("SELECT id, name FROM lists");
    assert.deepEqual(all, [
      { id: "list-1", name: "Groceries" },
      { id: "list-2", name: "Hardware" },
      { id: "list-3", name: "Pharmacy" },
    ]);

    const protectedDb = db as unknown as {
      defaultConnectionMethod: SyncStreamConnectionMethod;
      generateSyncStreamImplementation(
        connector: { fetchCredentials(): Promise<null>; uploadData(): Promise<void> },
        options: Record<string, unknown>,
      ): LynxStreamingSyncImplementation;
    };
    assert.equal(protectedDb.defaultConnectionMethod, SyncStreamConnectionMethod.HTTP);
    const impl = protectedDb.generateSyncStreamImplementation(
      { fetchCredentials: async () => null, uploadData: async () => {} },
      {},
    );
    assert.ok(impl instanceof LynxStreamingSyncImplementation);
    const { remote } = (impl as unknown as { options: { remote: LynxRemote } }).options;
    assert.ok(remote instanceof LynxRemote);
    assert.match(remote.getUserAgent(), /powersync-lynx/);

    await db.close();
    assert.equal(mock.closes.length, 6);
  });
});

test("LynxRemote createTextDecoder uses TextCodecHelper UTF-8", async () => {
  const decoded: ArrayBuffer[] = [];
  await withFakeLynxHost(
    {
      textCodec: {
        decode(buf) {
          decoded.push(buf);
          return new TextDecoder().decode(buf);
        },
      },
    },
    async () => {
      const remote = new LynxRemote(
        { fetchCredentials: async () => null, uploadData: async () => {} },
        { log() {} },
      );
      const decoder = remote.createTextDecoder();
      const bytes = new TextEncoder().encode("hello");
      assert.equal(decoder.decode(bytes), "hello");
      assert.equal(decoded.length, 1);
      assert.ok(decoded[0] instanceof ArrayBuffer);
    },
  );
});
