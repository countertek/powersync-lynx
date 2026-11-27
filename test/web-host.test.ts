// @ts-nocheck
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";

import { Schema, Table, column } from "../src/index.ts";
import { LynxDBAdapter } from "../src/adapter/LynxDBAdapter.ts";
import { PowerSyncDatabase } from "../src/PowerSyncDatabase.ts";
import { attach } from "../src/web-host/index.ts";
import { attachWithLoader } from "../src/web-host/attach.ts";
import { decodeCloneable, encodeCloneable } from "../src/web-host/cloneable.ts";
import createFactory from "../src/web-host/factory.ts";
import { MODULE_NAME } from "../src/web-host/page-rpc.ts";
import { resetLynxHost } from "../src/host.ts";
import { installFakeLynxHost } from "./fake-lynx-host.ts";
import { FakeTabHub } from "./fake-tabs.ts";

interface WebCalls {
  constructs: object[];
  closes: object[];
  locks: object[];
  executeRaw: object[];
  executeBatch: object[];
}

afterEach(() => {
  resetLynxHost();
  delete globalThis.NativeModules;
});

function attachHost(options, loader, previousCall) {
  const lynxView = { nativeModulesMap: {}, onNativeModulesCall: previousCall };
  const handle = attachWithLoader(lynxView, options, loader);
  return {
    lynxView,
    handle,
    call(name, data, moduleName = MODULE_NAME) {
      return lynxView.onNativeModulesCall(name, data, moduleName);
    },
  };
}

function defaultSqlResult(sql, params) {
  return {
    insertId: 1,
    rowsAffected: 1,
    columnNames: ["n"],
    rawRows: [[params?.[0] ?? 0]],
  };
}

function mockWeb(calls: WebCalls, handleSql, options = {}) {
  calls.constructs = [];
  calls.closes = [];
  calls.locks = [];
  calls.executeRaw = [];
  calls.executeBatch = [];

  class WASQLiteOpenFactory {
    constructor(options) {
      calls.constructs.push(options);
    }
    openDB() {
      return {
        async readLock(fn) {
          calls.locks.push("read");
          return fn(tx);
        },
        async writeLock(fn) {
          calls.locks.push("write");
          try {
            return await fn(tx);
          } finally {
            if (options.consumeWriteHooks === true) {
              await tx.executeRaw("SELECT powersync_update_hooks('get')", []);
            }
          }
        },
        async close() {
          calls.closes.push(true);
        },
      };
    }
  }

  const tx = {
    async executeRaw(sql, params) {
      calls.executeRaw.push({ sql, params });
      if (handleSql instanceof Function) {
        return handleSql(sql, params);
      }
      return defaultSqlResult(sql, params);
    },
    async executeBatch(sql, params) {
      calls.executeBatch.push({ sql, params });
      if (handleSql instanceof Function) {
        let rowsAffected = 0;
        let insertId = 0;
        for (const row of params ?? []) {
          const result = handleSql(sql, row);
          rowsAffected += result.rowsAffected ?? 0;
          insertId = result.insertId ?? insertId;
        }
        return { insertId, rowsAffected, array: [] };
      }
      return { insertId: 2, rowsAffected: params?.length ?? 0, array: [] };
    },
  };

  return {
    WASQLiteOpenFactory,
    createConsoleLogger() {
      return { log() {} };
    },
  };
}

function loadMock(calls, handleSql, options) {
  const web = mockWeb(calls, handleSql, options);
  return async () => web;
}

function sqliteBinds(params) {
  if (!Array.isArray(params)) {
    return [];
  }
  return params.map((value) => (value instanceof Uint8Array ? Buffer.from(value) : value));
}

function runSqlite(db, sql, params) {
  const stmt = db.prepare(sql);
  stmt.setReturnArrays(true);
  const binds = sqliteBinds(params);
  const columns = stmt.columns();
  if (columns.length > 0) {
    const rawRows = stmt.all(...binds);
    return {
      insertId: 0,
      rowsAffected: 0,
      columnNames: columns.map((column) => column.name),
      rawRows,
    };
  }
  const info = stmt.run(...binds);
  return {
    insertId: Number(info.lastInsertRowid),
    rowsAffected: info.changes,
    columnNames: [],
    rawRows: [],
  };
}

function leaseRecoveringLoadWeb() {
  const db = new DatabaseSync(":memory:");
  const tx = {
    async executeRaw(sql, params) {
      return runSqlite(db, sql, params);
    },
    async executeBatch(sql, params) {
      let rowsAffected = 0;
      let insertId = 0;
      for (const row of params ?? []) {
        const result = runSqlite(db, sql, row);
        rowsAffected += result.rowsAffected;
        insertId = result.insertId;
      }
      return { insertId, rowsAffected, columnNames: [], rawRows: [] };
    },
  };
  class WASQLiteOpenFactory {
    openDB() {
      return {
        async readLock(fn) {
          if (db.isTransaction) {
            db.exec("ROLLBACK");
          }
          return fn(tx);
        },
        async writeLock(fn) {
          if (db.isTransaction) {
            db.exec("ROLLBACK");
          }
          return fn(tx);
        },
        async close() {
          db.close();
        },
      };
    }
  }
  return async () => ({ WASQLiteOpenFactory });
}

function installHostHelper(handleSql, options, attachOptions, tabs) {
  const calls = {};
  const host = attachHost(attachOptions, loadMock(calls, handleSql, options));
  const hop = (name, data) => host.call(name, data);
  installFakeLynxHost({
    nativeModules: { NativePowerSyncModule: createFactory({}, hop) },
    tabs,
  });
  return calls;
}

function appSqlHandler(store = { lists: [] }) {
  function ok(columnNames, rawRows, extra = {}) {
    return { insertId: 0, rowsAffected: 0, columnNames, rawRows, ...extra };
  }
  return function handleSql(sql, params) {
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
  };
}

function hookTrackingSqlHandler(store = { lists: [] }) {
  const dirty = [];
  const base = appSqlHandler(store);
  return function handleSql(sql, params) {
    if (sql.includes("powersync_update_hooks('get')")) {
      const tables = dirty.splice(0, dirty.length);
      return {
        insertId: 0,
        rowsAffected: 0,
        columnNames: ["powersync_update_hooks"],
        rawRows: [[JSON.stringify(tables)]],
      };
    }
    const result = base(sql, params);
    if (/INSERT INTO lists/i.test(sql) || /UPDATE lists/i.test(sql)) {
      if (!dirty.includes("lists")) {
        dirty.push("lists");
      }
    }
    return result;
  };
}

function queryRows(result) {
  if (result == null) {
    return [];
  }
  if (Array.isArray(result.array)) {
    return result.array;
  }
  return result.rows?._array ?? [];
}

function waitUntil(predicate, timeoutMs = 1000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve(undefined);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("timed out waiting for watch snapshot"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

test("encode/decode ArrayBuffer, Uint8Array, and bigint both directions", () => {
  const buf = new Uint8Array([0, 255, 16]).buffer;
  const u8 = new Uint8Array([7, 8, 9]);
  const encoded = encodeCloneable({ blob: buf, bytes: u8, n: 9n, nested: [1n, buf] });
  assert.deepEqual(encoded.blob, { __psAb: true, u8: [0, 255, 16] });
  assert.deepEqual(encoded.bytes, { __psAb: true, u8: [7, 8, 9] });
  assert.deepEqual(encoded.n, { __psBig: true, v: "9" });
  assert.equal(encoded.nested[0].__psBig, true);
  const decoded = decodeCloneable(encoded);
  assert.equal(decoded.n, 9n);
  assert.ok(decoded.blob instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(decoded.blob)], [0, 255, 16]);
  assert.ok(decoded.bytes instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(decoded.bytes)], [7, 8, 9]);
  assert.equal(decoded.nested[0], 1n);
});

test("attach merges nativeModulesMap and wraps onNativeModulesCall; detach restores", async () => {
  const previous = async (name, data, moduleName) => ({ from: "prev", name, moduleName, data });
  const lynxView = {
    nativeModulesMap: { bridge: "bridge://x", OtherMod: "other.js" },
    onNativeModulesCall: previous,
  };

  const { detach } = attach(lynxView);
  const factoryUrl = lynxView.nativeModulesMap[MODULE_NAME];
  assert.equal(lynxView.nativeModulesMap.bridge, "bridge://x");
  assert.equal(lynxView.nativeModulesMap.OtherMod, "other.js");
  assert.ok(factoryUrl.constructor === String);
  assert.match(factoryUrl, /factory\.js$/);
  assert.doesNotMatch(factoryUrl, /^blob:/);
  assert.equal(factoryUrl, new URL("../dist/web-host/factory.js", import.meta.url).href);
  assert.notEqual(lynxView.onNativeModulesCall, previous);

  const passthrough = await lynxView.onNativeModulesCall("ping", { a: 1 }, "bridge");
  assert.deepEqual(passthrough, {
    from: "prev",
    name: "ping",
    moduleName: "bridge",
    data: { a: 1 },
  });

  detach();
  assert.equal(lynxView.onNativeModulesCall, previous);
  assert.equal(lynxView.nativeModulesMap.bridge, "bridge://x");
  assert.equal(lynxView.nativeModulesMap.OtherMod, "other.js");
  assert.equal(lynxView.nativeModulesMap[MODULE_NAME], undefined);
});

test("detach unwraps only when still current; reverse order restores", () => {
  const original = () => "orig";
  const lynxView = { nativeModulesMap: {}, onNativeModulesCall: original };
  const first = attach(lynxView);
  const firstHandler = lynxView.onNativeModulesCall;
  const second = attach(lynxView);
  const secondHandler = lynxView.onNativeModulesCall;
  assert.notEqual(firstHandler, secondHandler);

  first.detach();
  assert.equal(lynxView.onNativeModulesCall, secondHandler);
  assert.ok(lynxView.nativeModulesMap[MODULE_NAME]);

  second.detach();
  assert.equal(lynxView.onNativeModulesCall, firstHandler);
  first.detach();
  assert.equal(lynxView.onNativeModulesCall, original);
  assert.equal(lynxView.nativeModulesMap[MODULE_NAME], undefined);
});

test("one WASQLiteOpenFactory per dbFilename+dbLocation; extra opens refcount", async () => {
  const calls = {};
  const options = { vfs: "IDBBatchAtomicVFS", additionalReaders: 4 };
  const host = attachHost(options, loadMock(calls));

  const ids = [];
  for (let i = 0; i < 6; i++) {
    const open = await host.call("open", { dbFilename: "app.db", readOnly: i !== 0 });
    assert.equal(open.ok, true);
    ids.push(open.dbId);
  }

  assert.equal(calls.constructs.length, 1);
  assert.equal(calls.constructs[0].open.dbFilename, "app.db");
  assert.equal(calls.constructs[0].open.vfs, "IDBBatchAtomicVFS");
  assert.equal(calls.constructs[0].open.additionalReaders, 4);
  assert.equal("encryptionKey" in calls.constructs[0].open, false);
  assert.equal("ssrMode" in calls.constructs[0].open, false);
  assert.equal(new Set(ids).size, 6);

  const other = await host.call("open", { dbFilename: "app.db", dbLocation: "other" });
  assert.equal(other.ok, true);
  assert.equal(calls.constructs.length, 2);

  for (let i = 0; i < 5; i++) {
    const closed = await host.call("close", ids[i]);
    assert.equal(closed.ok, true);
  }
  assert.equal(calls.closes.length, 0);
  const closedExec = await host.call("execute", {
    dbId: ids[0],
    sql: "select 1",
    params: [],
  });
  assert.equal(closedExec.ok, false);
  assert.match(closedExec.message, /unknown dbId/);

  const stillOpen = await host.call("execute", {
    dbId: ids[5],
    sql: "select 1",
    params: [],
  });
  assert.equal(stillOpen.ok, true);

  await host.call("close", ids[5]);
  assert.equal(calls.closes.length, 1);
  const afterLastClose = await host.call("execute", {
    dbId: ids[5],
    sql: "select 1",
    params: [],
  });
  assert.equal(afterLastClose.ok, false);
  assert.match(afterLastClose.message, /unknown dbId/);

  const otherExec = await host.call("execute", {
    dbId: other.dbId,
    sql: "select 1",
    params: [],
  });
  assert.equal(otherExec.ok, true);
  const otherClosed = await host.call("close", other.dbId);
  assert.equal(otherClosed.ok, true);
  assert.equal(calls.closes.length, 2);
});

test("separate attach instances isolate state and AttachOptions", async () => {
  const callsA = {};
  const callsB = {};
  const hostA = attachHost({ vfs: "IDBBatchAtomicVFS", enableMultiTabs: true }, loadMock(callsA));
  const hostB = attachHost({ vfs: "OPFSCoopSyncVFS", enableMultiTabs: false }, loadMock(callsB));

  const openA = await hostA.call("open", { dbFilename: "shared.db" });
  const openB1 = await hostB.call("open", { dbFilename: "shared.db" });
  const openB2 = await hostB.call("open", { dbFilename: "shared.db", readOnly: true });

  assert.equal(openA.ok, true);
  assert.equal(openB1.ok, true);
  assert.equal(openB2.ok, true);
  assert.equal(openA.dbId, "ps-1");
  assert.equal(openB1.dbId, "ps-1");
  assert.equal(openB2.dbId, "ps-2");
  assert.equal(openA.multiTab, true);
  assert.equal(openB1.multiTab, undefined);
  assert.equal(callsA.constructs.length, 1);
  assert.equal(callsB.constructs.length, 1);
  assert.equal(callsA.constructs[0].open.vfs, "IDBBatchAtomicVFS");
  assert.equal(callsB.constructs[0].open.vfs, "OPFSCoopSyncVFS");

  // Host A cannot see connections opened on Host B.
  const crossLookup = await hostA.call("execute", {
    dbId: openB2.dbId,
    sql: "select 1",
    params: [],
  });
  assert.equal(crossLookup.ok, false);
  assert.match(crossLookup.message, /unknown dbId/);

  // Closing Host A does not close or affect Host B.
  const closedA = await hostA.call("close", openA.dbId);
  assert.equal(closedA.ok, true);
  assert.equal(callsA.closes.length, 1);
  assert.equal(callsB.closes.length, 0);

  const execB = await hostB.call("execute", {
    dbId: openB1.dbId,
    sql: "select 1",
    params: [42],
  });
  assert.equal(execB.ok, true);
  assert.deepEqual(execB.rawRows, [[42]]);

  // Two attached views receive distinct handlers and detach independently.
  assert.notEqual(hostA.lynxView.onNativeModulesCall, hostB.lynxView.onNativeModulesCall);
  hostA.handle.detach();
  assert.equal(hostA.lynxView.onNativeModulesCall, undefined);
  assert.ok(hostB.lynxView.onNativeModulesCall instanceof Function);
  hostB.handle.detach();
});

test("open tells the Adapter when WASQLite shares the file between tabs", async (context) => {
  const loadWeb = loadMock({});
  const openWith = async (options) => {
    const host = attachHost(options, loadWeb);
    const open = await host.call("open", { dbFilename: "app.db" });
    assert.equal(open.ok, true);
    return open.multiTab;
  };

  assert.equal(await openWith({ enableMultiTabs: true }), true);
  assert.equal(await openWith({ enableMultiTabs: false }), undefined);
  // Node has no SharedWorker, so the official default for an omitted flag is off.
  assert.equal(await openWith(undefined), undefined);

  // Where SharedWorker exists (desktop Chromium), the official default is on.
  globalThis.SharedWorker = class {};
  context.after(() => {
    delete globalThis.SharedWorker;
  });
  assert.equal(await openWith(undefined), true);
  assert.equal(await openWith({ enableMultiTabs: false }), undefined);
});

test("an Adapter opened through a multi-tab Host helper exchanges table changes with other tabs", async () => {
  const hub = new FakeTabHub();
  installHostHelper(hookTrackingSqlHandler(), undefined, { enableMultiTabs: true }, hub.tab());
  const received = [];
  hub.tab().channel("powersync-lynx:tables:app.db:", (change) => received.push(change));

  const adapter = new LynxDBAdapter({ name: "app.db" });
  await adapter.initialized;
  await adapter.execute("INSERT INTO lists (id, name) VALUES (?, ?)", ["list-1", "Groceries"]);
  await waitUntil(() => received.length > 0);

  assert.deepEqual(received, [{ tables: ["lists"] }]);
  await adapter.close();
});

test("readOnly routes execute to readLock+executeRaw; writes use writeLock", async () => {
  const calls = {};
  const host = attachHost(undefined, loadMock(calls));

  const write = await host.call("open", { dbFilename: "w.db" });
  const read = await host.call("open", { dbFilename: "w.db", readOnly: true });
  assert.equal(calls.constructs.length, 1);

  await host.call("execute", { dbId: write.dbId, sql: "select 1", params: [1] });
  await host.call("execute", { dbId: read.dbId, sql: "select 1", params: [2] });
  await host.call("executeBatch", {
    dbId: write.dbId,
    sql: "insert",
    params: [[1], [2]],
  });

  assert.deepEqual(calls.locks, ["write", "read", "write"]);
  assert.equal(calls.executeRaw.filter((call) => call.sql === "select 1").length, 2);
  assert.ok(calls.executeRaw.some((call) => call.sql === "BEGIN IMMEDIATE"));
  assert.ok(calls.executeRaw.some((call) => call.sql === "COMMIT"));
  assert.equal(calls.executeBatch.length, 1);
});

test("page catch returns ok:false envelope with optional code", async () => {
  const loadWeb = async () => ({
    WASQLiteOpenFactory: class {
      constructor() {}
      openDB() {
        return {
          async writeLock() {
            const err = new Error("boom");
            err.code = 19;
            throw err;
          },
        };
      }
    },
    createConsoleLogger() {
      return { log() {} };
    },
  });
  const host = attachHost(undefined, loadWeb);
  const opened = await host.call("open", { dbFilename: "x.db" });
  const result = await host.call("execute", { dbId: opened.dbId, sql: "x", params: [] });
  assert.equal(result.ok, false);
  assert.equal(result.message, "boom");
  assert.equal(result.code, 19);
});

test("JS BEGIN/INSERT/COMMIT RPCs keep one WASQLite lease so COMMIT is active", async () => {
  const host = attachHost(undefined, leaseRecoveringLoadWeb());
  const opened = await host.call("open", { dbFilename: "txn.db" });
  assert.equal(opened.ok, true);

  const created = await host.call("execute", {
    dbId: opened.dbId,
    sql: "CREATE TABLE t(x INTEGER)",
    params: [],
  });
  assert.equal(created.ok, true);

  const begin = await host.call("execute", {
    dbId: opened.dbId,
    sql: "BEGIN IMMEDIATE",
    params: [],
  });
  assert.equal(begin.ok, true);

  const inserted = await host.call("execute", {
    dbId: opened.dbId,
    sql: "INSERT INTO t VALUES (1)",
    params: [],
  });
  assert.equal(inserted.ok, true);

  const committed = await host.call("execute", {
    dbId: opened.dbId,
    sql: "COMMIT",
    params: [],
  });
  assert.equal(committed.ok, true, committed.message);

  const selected = await host.call("execute", {
    dbId: opened.dbId,
    sql: "SELECT x FROM t",
    params: [],
  });
  assert.equal(selected.ok, true);
  assert.deepEqual(selected.rawRows, [[1]]);
});

test("JS BEGIN/INSERT/ROLLBACK RPCs roll the insert back", async () => {
  const host = attachHost(undefined, leaseRecoveringLoadWeb());
  const opened = await host.call("open", { dbFilename: "rollback.db" });
  assert.equal(opened.ok, true);
  const created = await host.call("execute", {
    dbId: opened.dbId,
    sql: "CREATE TABLE t(x INTEGER)",
    params: [],
  });
  assert.equal(created.ok, true);
  const begin = await host.call("execute", {
    dbId: opened.dbId,
    sql: "BEGIN IMMEDIATE",
    params: [],
  });
  assert.equal(begin.ok, true);
  const inserted = await host.call("execute", {
    dbId: opened.dbId,
    sql: "INSERT INTO t VALUES (1)",
    params: [],
  });
  assert.equal(inserted.ok, true);
  const rolledBack = await host.call("execute", {
    dbId: opened.dbId,
    sql: "ROLLBACK",
    params: [],
  });
  assert.equal(rolledBack.ok, true, rolledBack.message);
  const selected = await host.call("execute", {
    dbId: opened.dbId,
    sql: "SELECT x FROM t",
    params: [],
  });
  assert.equal(selected.ok, true);
  assert.deepEqual(selected.rawRows, []);
});

test("executeBatch rolls back earlier rows on the first error", async () => {
  const host = attachHost(undefined, leaseRecoveringLoadWeb());
  const opened = await host.call("open", { dbFilename: "batch.db" });
  assert.equal(opened.ok, true);
  const created = await host.call("execute", {
    dbId: opened.dbId,
    sql: "CREATE TABLE ids(id INTEGER PRIMARY KEY)",
    params: [],
  });
  assert.equal(created.ok, true);
  const batched = await host.call("executeBatch", {
    dbId: opened.dbId,
    sql: "INSERT INTO ids(id) VALUES(?)",
    params: [[1], [1]],
  });
  assert.equal(batched.ok, false);
  const selected = await host.call("execute", {
    dbId: opened.dbId,
    sql: "SELECT count(*) FROM ids",
    params: [],
  });
  assert.equal(selected.ok, true);
  assert.deepEqual(selected.rawRows, [[0]]);
});

test("malformed tagged bigint resolves ok:false instead of rejecting", async () => {
  const host = attachHost(undefined, loadMock({}));
  const result = await host.call("execute", { __psBig: true, v: "invalid" });
  assert.equal(result.ok, false);
  assert.equal(result.message.constructor, String);
  assert.ok(result.message.length > 0);
});

test("malformed tagged ArrayBuffer resolves ok:false instead of rejecting", async () => {
  const host = attachHost(undefined, loadMock({}));
  const result = await host.call("execute", { __psAb: true, u8: ["nope"] });
  assert.equal(result.ok, false);
  assert.equal(result.message.constructor, String);
});

test("factory encodes params and decodes envelopes; Adapter sees ArrayBuffer/bigint", async () => {
  const calls = {};
  const host = attachHost(undefined, loadMock(calls));
  const handler = async (name, data) => host.call(name, data);
  const methods = createFactory({}, handler);

  const opened = await new Promise((resolve) => methods.open({ dbFilename: "c.db" }, resolve));
  assert.equal(opened.ok, true);

  const blob = new Uint8Array([7, 8]).buffer;
  const exec = await new Promise((resolve) =>
    methods.execute(opened.dbId, "select ?", [blob, 99n], resolve),
  );
  assert.equal(exec.ok, true);
  const sent = calls.executeRaw[0].params;
  assert.ok(sent[0] instanceof Uint8Array);
  assert.deepEqual([...sent[0]], [7, 8]);
  assert.equal(sent[1], 99n);
  assert.equal(exec.rawRows[0][0] instanceof ArrayBuffer, true);
  assert.deepEqual([...new Uint8Array(exec.rawRows[0][0])], [7, 8]);
});

test("factory methods return immediately and invoke the callback later", async () => {
  const calls = {};
  const host = attachHost(undefined, loadMock(calls));
  const handler = (name, data) => host.call(name, data);
  const methods = createFactory({}, handler);

  let callbackRan = false;
  const done = new Promise((resolve) => {
    const ret = methods.open({ dbFilename: "async.db" }, (env) => {
      callbackRan = true;
      resolve(env);
    });
    assert.equal(ret, undefined);
    assert.equal(callbackRan, false);
  });
  const env = await done;
  assert.equal(callbackRan, true);
  assert.equal(env.ok, true);
});

test("wrapped onNativeModulesCall dispatches NativePowerSyncModule and falls through", async () => {
  const calls = {};
  const previous = async () => ({ from: "prev" });
  const host = attachHost(undefined, loadMock(calls), previous);

  const opened = await host.call("open", { dbFilename: "wrap.db" }, MODULE_NAME);
  assert.equal(opened.ok, true);
  assert.equal(calls.constructs.length, 1);

  const other = await host.call("ping", { a: 1 }, "bridge");
  assert.deepEqual(other, { from: "prev" });
});

test("unknown method and missing dbFilename return ok:false envelopes", async () => {
  const host = attachHost(undefined, loadMock({}));
  const missing = await host.call("open", {});
  assert.equal(missing.ok, false);
  assert.match(missing.message, /dbFilename/);

  const unknown = await host.call("vacuum", {});
  assert.equal(unknown.ok, false);
  assert.match(unknown.message, /unknown method/);
});

test("last close then reopen constructs a new WASQLiteOpenFactory", async () => {
  const calls = {};
  const host = attachHost(undefined, loadMock(calls));
  const first = await host.call("open", { dbFilename: "reopen.db" });
  assert.equal(first.ok, true);
  assert.equal(calls.constructs.length, 1);

  const closed = await host.call("close", first.dbId);
  assert.equal(closed.ok, true);
  assert.equal(calls.closes.length, 1);
  const stale = await host.call("execute", {
    dbId: first.dbId,
    sql: "select 1",
    params: [],
  });
  assert.equal(stale.ok, false);
  assert.match(stale.message, /unknown dbId/);

  const second = await host.call("open", { dbFilename: "reopen.db" });
  assert.equal(second.ok, true);
  assert.equal(calls.constructs.length, 2);
  assert.notEqual(second.dbId, first.dbId);
});

test("Lynx-bundle Adapter runs SQL RPC through the Host helper factory", async () => {
  const store = { lists: [] };
  const calls = installHostHelper(appSqlHandler(store));
  const adapter = new LynxDBAdapter({ name: "app.db", dbLocation: "/tmp/ps" });
  await adapter.initialized;

  assert.equal(calls.constructs.length, 1);
  assert.equal(calls.constructs[0].open.dbFilename, "app.db");
  assert.equal(calls.constructs[0].open.dbLocation, "/tmp/ps");
  assert.equal(calls.closes.length, 0);

  const inserted = await adapter.execute("INSERT INTO lists (id, name) VALUES (?, ?)", [
    "list-1",
    "Groceries",
  ]);
  assert.equal(inserted.rowsAffected, 1);

  const rows = await adapter.getAll("SELECT id, name FROM lists");
  assert.deepEqual(rows, [{ id: "list-1", name: "Groceries" }]);

  const batch = await adapter.executeBatch("INSERT INTO lists (id, name) VALUES (?, ?)", [
    ["list-2", "Hardware"],
    ["list-3", "Pharmacy"],
  ]);
  assert.equal(batch.rowsAffected, 2);
  assert.equal(calls.executeBatch.length, 1);

  await adapter.close();
  assert.equal(calls.closes.length, 1);
});

test("last close keeps dbId when adapter.close rejects so retry can finish", async () => {
  let closeAttempts = 0;
  let constructCount = 0;
  const tx = {
    async executeRaw(sql, params) {
      return defaultSqlResult(sql, params);
    },
    async executeBatch() {
      return { insertId: 0, rowsAffected: 0, array: [] };
    },
  };
  const loadWeb = async () => ({
    WASQLiteOpenFactory: class {
      constructor() {
        constructCount += 1;
      }
      openDB() {
        return {
          async readLock(fn) {
            return fn(tx);
          },
          async writeLock(fn) {
            return fn(tx);
          },
          async close() {
            closeAttempts += 1;
            if (closeAttempts === 1) {
              throw new Error("worker already dead");
            }
          },
        };
      }
    },
    createConsoleLogger() {
      return { log() {} };
    },
  });

  const host = attachHost(undefined, loadWeb);
  const opened = await host.call("open", { dbFilename: "retry-close.db" });
  assert.equal(opened.ok, true);
  assert.equal(constructCount, 1);

  const first = await host.call("close", opened.dbId);
  assert.equal(first.ok, false);
  assert.equal(first.message, "worker already dead");
  // dbId remains registered so caller can still observe it and retry close.
  const stillReachable = await host.call("execute", {
    dbId: opened.dbId,
    sql: "select 1",
    params: [],
  });
  assert.equal(stillReachable.ok, true);

  const retry = await host.call("close", opened.dbId);
  assert.equal(retry.ok, true, retry.message);
  assert.equal(closeAttempts, 2);
  const afterClose = await host.call("execute", {
    dbId: opened.dbId,
    sql: "select 1",
    params: [],
  });
  assert.equal(afterClose.ok, false);
  assert.match(afterClose.message, /unknown dbId/);

  const reopened = await host.call("open", { dbFilename: "retry-close.db" });
  assert.equal(reopened.ok, true);
  assert.equal(constructCount, 2);
});

test("duplicate close of one dbId does not close a sibling file share", async () => {
  const calls = {};
  const host = attachHost(undefined, loadMock(calls));
  const first = await host.call("open", { dbFilename: "share.db" });
  const sibling = await host.call("open", { dbFilename: "share.db", readOnly: true });
  assert.equal(first.ok, true);
  assert.equal(sibling.ok, true);
  assert.equal(calls.constructs.length, 1);

  const [closeA, closeB] = await Promise.all([
    host.call("close", first.dbId),
    host.call("close", first.dbId),
  ]);
  const okCount = [closeA, closeB].filter((result) => result.ok === true).length;
  const failCount = [closeA, closeB].filter((result) => result.ok === false).length;
  assert.equal(okCount, 1);
  assert.equal(failCount, 1);
  assert.ok(
    [closeA, closeB].some((result) => result.ok === false && /unknown dbId/.test(result.message)),
  );
  assert.equal(calls.closes.length, 0);

  const closedFirst = await host.call("execute", {
    dbId: first.dbId,
    sql: "select 1",
    params: [1],
  });
  assert.equal(closedFirst.ok, false);
  assert.match(closedFirst.message, /unknown dbId/);

  const executed = await host.call("execute", {
    dbId: sibling.dbId,
    sql: "select 1",
    params: [1],
  });
  assert.equal(executed.ok, true, executed.message);

  const siblingClosed = await host.call("close", sibling.dbId);
  assert.equal(siblingClosed.ok, true, siblingClosed.message);
  assert.equal(calls.closes.length, 1);

  const closedSibling = await host.call("execute", {
    dbId: sibling.dbId,
    sql: "select 1",
    params: [1],
  });
  assert.equal(closedSibling.ok, false);
  assert.match(closedSibling.message, /unknown dbId/);

  const reopened = await host.call("open", { dbFilename: "share.db" });
  assert.equal(reopened.ok, true);
  assert.equal(calls.constructs.length, 2);
});

test("Lynx-bundle PowerSyncDatabase works through the Host helper", async () => {
  const store = { lists: [] };
  const calls = installHostHelper(appSqlHandler(store));
  const db = new PowerSyncDatabase({
    schema: new Schema({
      lists: new Table({ name: column.text }),
    }),
    database: { dbFilename: "app.db" },
  });
  try {
    await db.waitForReady();
    const inserted = await db.execute("INSERT INTO lists (id, name) VALUES (?, ?)", [
      "list-1",
      "Groceries",
    ]);
    assert.equal(inserted.rowsAffected, 1);
    const rows = await db.getAll("SELECT id, name FROM lists");
    assert.deepEqual(rows, [{ id: "list-1", name: "Groceries" }]);
    await db.close();
    assert.equal(calls.closes.length, 1);
  } finally {
    db.triggersImpl?.dispose();
  }
});

test("watch refreshes after writeTransaction when WASQLite writeLock consumes hooks", async () => {
  const store = { lists: [] };
  installHostHelper(hookTrackingSqlHandler(store), { consumeWriteHooks: true });
  const db = new PowerSyncDatabase({
    schema: new Schema({
      lists: new Table({ name: column.text }),
    }),
    database: { dbFilename: "watch.db" },
  });
  const abort = new AbortController();
  try {
    await db.waitForReady();
    const snapshots = [];
    db.watch(
      "SELECT id, name FROM lists",
      [],
      {
        onResult(result) {
          snapshots.push(queryRows(result));
        },
      },
      { tables: ["lists"], throttleMs: 0, signal: abort.signal },
    );
    await waitUntil(() => snapshots.length >= 1);
    assert.deepEqual(snapshots.at(-1), []);

    await db.writeTransaction(async (tx) => {
      await tx.execute("INSERT INTO lists (id, name) VALUES (?, ?)", ["list-1", "Groceries"]);
    });

    await waitUntil(() => snapshots.some((rows) => rows.some((row) => row.name === "Groceries")));

    await db.execute("INSERT INTO lists (id, name) VALUES (?, ?)", ["list-2", "Hardware"]);
    await waitUntil(() => snapshots.some((rows) => rows.some((row) => row.name === "Hardware")));
    assert.equal(store.lists.length, 2);
  } finally {
    abort.abort();
    await db.close();
    db.triggersImpl?.dispose();
  }
});
