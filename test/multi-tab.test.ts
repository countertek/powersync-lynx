import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { SyncStreamConnectionMethod } from "@powersync/common";
import type { PowerSyncLogger } from "@powersync/common";
import {
  LockType,
  SqliteBucketStorage,
  resolveSyncOptions,
  type CoreSyncStatus,
} from "@powersync/shared-internals";
import { LynxDBAdapter } from "../src/adapter/LynxDBAdapter.ts";
import type {
  BindValues,
  NativePowerSyncModule,
  NativeWireEnvelope,
} from "../src/adapter/native.ts";
import { resetLynxHost } from "../src/host.ts";
import { LynxRemote } from "../src/sync/LynxRemote.ts";
import { LynxStreamingSyncImplementation } from "../src/sync/LynxStreamingSyncImplementation.ts";
import { sharedTabs } from "../src/tabs.ts";
import { installFakeLynxHost } from "./fake-lynx-host.ts";
import { FakeTabHub, type FakeTab } from "./fake-tabs.ts";
import { silentLogger, stubConnector } from "./remote-harness.ts";

const DATABASE = "app.db";
const FULL_SYNC_PRIORITY = 2147483647;

/** The SQLite file every tab reaches through its own connections. */
interface SharedDatabase {
  native: NativePowerSyncModule;
  /** Ids of the `ps_crud` rows not uploaded yet. */
  crud: number[];
  /** Connection ids opened so far, in order. */
  opened: string[];
  /** Connection ids on which a sync iteration was started. */
  syncStarts: string[];
}

function rows(columnNames: string[], rawRows: Array<Array<string | number>>): NativeWireEnvelope {
  return { ok: true, insertId: 0, rowsAffected: 0, columnNames, rawRows };
}

function sharedDatabase(multiTab: boolean): SharedDatabase {
  let nextCrudId = 1;
  const changedTables = new Map<string, string[]>();
  const database: SharedDatabase = {
    crud: [],
    opened: [],
    syncStarts: [],
    native: {
      open(_options, callback) {
        const dbId = `db-${database.opened.length + 1}`;
        database.opened.push(dbId);
        queueMicrotask(() =>
          callback(multiTab ? { ok: true, dbId, multiTab } : { ok: true, dbId }),
        );
      },
      close(_dbId, callback) {
        queueMicrotask(() => callback({ ok: true }));
      },
      execute(dbId, sql, params, callback) {
        queueMicrotask(() => callback(run(dbId, sql, params)));
      },
      executeBatch(_dbId, _sql, _params, callback) {
        queueMicrotask(() => callback(rows([], [])));
      },
    },
  };

  function run(dbId: string, sql: string, params: BindValues): NativeWireEnvelope {
    if (sql.includes("powersync_update_hooks('get')")) {
      const tables = changedTables.get(dbId) ?? [];
      changedTables.delete(dbId);
      return rows(["powersync_update_hooks"], [[JSON.stringify(tables)]]);
    }
    if (sql.includes("powersync_control")) {
      const operation = params[0];
      if (operation === "start") {
        database.syncStarts.push(dbId);
      }
      return rows(["r"], [[operation === "target_checkpoint_request_id" ? "0" : "[]"]]);
    }
    if (sql.includes("INSERT INTO lists")) {
      database.crud.push(nextCrudId++);
      changedTables.set(dbId, ["lists", "ps_crud"]);
      return rows([], []);
    }
    if (sql.includes("DELETE FROM ps_crud")) {
      database.crud = database.crud.filter((id) => id > Number(params[0]));
      changedTables.set(dbId, ["ps_crud"]);
      return rows([], []);
    }
    if (sql.includes("SELECT * FROM ps_crud")) {
      const id = database.crud[0];
      if (id == null) {
        return rows(["id", "tx_id", "data"], []);
      }
      const data = JSON.stringify({ op: "PUT", type: "lists", id: `list-${id}`, data: {} });
      return rows(["id", "tx_id", "data"], [[id, id, data]]);
    }
    if (sql.includes("SELECT EXISTS")) {
      return rows(["r"], [[1]]);
    }
    return rows([], []);
  }

  return database;
}

interface Upload {
  tab: string;
  crudId: number;
}

interface Tab {
  label: string;
  tabs: FakeTab;
  adapter: LynxDBAdapter;
  sync: StatusSync;
  /** The connection that carries this tab's writes and sync iterations. */
  writeConnection: string;
}

/** Lets a test play the sync core, which is what reports status in production. */
class StatusSync extends LynxStreamingSyncImplementation {
  report(core: CoreSyncStatus): void {
    this.updateSyncStatus(core);
  }
}

interface Browser {
  hub: FakeTabHub;
  database: SharedDatabase;
  uploads: Upload[];
  open(label: string): Promise<Tab>;
}

/** A browser whose tabs are closed again when the test ends, pass or fail. */
function browser(context: TestContext, multiTab: boolean): Browser {
  const opened: Tab[] = [];
  context.after(() => closeAll(opened));
  const hub = new FakeTabHub();
  const database = sharedDatabase(multiTab);
  const uploads: Upload[] = [];
  const logger: PowerSyncLogger = silentLogger;
  return {
    hub,
    database,
    uploads,
    async open(label) {
      const tabs = hub.tab();
      installFakeLynxHost({ nativeModules: { NativePowerSyncModule: database.native }, tabs });
      const firstConnection = database.opened.length;
      const adapter = new LynxDBAdapter({ name: DATABASE });
      await adapter.initialized;
      const storage = new SqliteBucketStorage(adapter, logger);
      const sync = new StatusSync({
        adapter: storage,
        subscriptions: [],
        connector: {
          ...stubConnector(),
          async uploadCrud() {
            const next = await storage.nextCrudItem();
            if (next == null) {
              return;
            }
            uploads.push({ tab: label, crudId: next.clientId });
            await adapter.execute("DELETE FROM ps_crud WHERE id <= ?", [next.clientId]);
          },
        },
        identifier: DATABASE,
        logger,
        remote: new LynxRemote(stubConnector(), logger),
        serializedSchema: null,
      });
      const tab = {
        label,
        tabs,
        adapter,
        sync,
        writeConnection: database.opened[firstConnection]!,
      };
      opened.push(tab);
      return tab;
    },
  };
}

const syncOptions = resolveSyncOptions(
  { retryDelayMs: 60_000, crudUploadThrottleMs: 1, checkpointMode: "legacy" },
  SyncStreamConnectionMethod.HTTP,
);

interface ConnectAttempt {
  /** Settles like `connect()`: once the client shows a settled connection attempt. */
  connected: Promise<void>;
}

/** Starts this tab's sync client and waits until it has asked for its locks. */
async function connect(tab: Tab): Promise<ConnectAttempt> {
  const connected = tab.sync.connect(syncOptions);
  await sharedTabs(DATABASE);
  await settle();
  return { connected };
}

function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
}

async function until(description: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting until ${description}`);
    }
    await settle();
  }
}

async function insertList(tab: Tab): Promise<void> {
  await tab.adapter.execute("INSERT INTO lists (id) VALUES (uuid())");
}

function core(fields: Partial<CoreSyncStatus>): CoreSyncStatus {
  return {
    connected: false,
    connecting: false,
    priority_status: [],
    downloading: null,
    streams: [],
    ...fields,
  };
}

async function closeAll(tabs: Tab[]): Promise<void> {
  for (const tab of tabs) {
    await tab.sync.disconnect();
    await tab.sync.dispose();
    await tab.adapter.close();
  }
  resetLynxHost();
}

test("only one tab runs sync iterations on a database shared between tabs", async (context) => {
  const { database, open } = browser(context, true);
  const one = await open("one");
  await connect(one);
  const two = await open("two");
  await connect(two);

  // The first iteration has ended (the fake core opens no stream) and `one` sits in its
  // retry delay: it still owns sync, so `two` must not start an iteration of its own.
  await until("tab one started syncing", () => database.syncStarts.length > 0);
  await settle();
  assert.deepEqual(database.syncStarts, [one.writeConnection]);
});

test("a table change written in one tab reaches the other tab's listeners", async (context) => {
  const { open } = browser(context, true);
  const one = await open("one");
  const two = await open("two");
  const seenByOne: string[][] = [];
  const seenByTwo: string[][] = [];
  one.adapter.registerListener({ tablesUpdated: ({ tables }) => seenByOne.push(tables) });
  two.adapter.registerListener({ tablesUpdated: ({ tables }) => seenByTwo.push(tables) });

  await insertList(two);
  await until("tab one saw the change", () => seenByOne.length > 0);

  assert.deepEqual(seenByOne, [["lists", "ps_crud"]]);
  assert.deepEqual(seenByTwo, [["lists", "ps_crud"]]);
});

test("a write in the tab that does not sync is uploaded once, by the syncing tab", async (context) => {
  const { uploads, database, open } = browser(context, true);
  const one = await open("one");
  await connect(one);
  const two = await open("two");
  await connect(two);

  await insertList(two);
  await until("the write was uploaded", () => database.crud.length === 0);
  await settle();

  assert.deepEqual(uploads, [{ tab: "one", crudId: 1 }]);
});

test("when the syncing tab closes, the waiting tab takes over sync and uploads", async (context) => {
  const { uploads, database, open } = browser(context, true);
  const one = await open("one");
  await connect(one);
  const two = await open("two");
  await connect(two);
  await until("tab one started syncing", () => database.syncStarts.length > 0);

  // A write that tab one never got to upload.
  database.crud.push(41);
  one.tabs.close();

  await until("tab two started syncing", () => database.syncStarts.includes(two.writeConnection));
  await until("the pending write was uploaded", () => database.crud.length === 0);
  assert.deepEqual(uploads, [{ tab: "two", crudId: 41 }]);

  await insertList(two);
  await until("tab two's own write was uploaded", () => uploads.length === 2);
  assert.equal(uploads[1]?.tab, "two");
});

test("the sync role moves when the syncing tab disconnects", async (context) => {
  const { database, open } = browser(context, true);
  const one = await open("one");
  await connect(one);
  const two = await open("two");
  await connect(two);
  await until("tab one started syncing", () => database.syncStarts.length > 0);
  await settle();
  assert.deepEqual(database.syncStarts, [one.writeConnection]);

  await one.sync.disconnect();

  await until("tab two started syncing", () => database.syncStarts.includes(two.writeConnection));
});

test("a tab that waits for the sync role shows the syncing tab's status", async (context) => {
  const { open } = browser(context, true);
  const one = await open("one");
  await connect(one);
  const lastSyncedAt = new Date(1_700_000_000_000);
  one.sync.report(
    core({
      connected: true,
      priority_status: [
        {
          priority: FULL_SYNC_PRIORITY,
          has_synced: true,
          last_synced_at: lastSyncedAt.getTime() * 1000,
        },
      ],
    }),
  );

  // Tab two joins after tab one is already connected.
  const two = await open("two");
  const { connected } = await connect(two);
  await connected;

  assert.equal(two.sync.syncStatus.connected, true);
  assert.equal(two.sync.syncStatus.connecting, false);
  assert.equal(two.sync.syncStatus.hasSynced, true);
  assert.deepEqual(two.sync.syncStatus.lastSyncedAt, lastSyncedAt);

  one.sync.report(core({ connected: false, connecting: true }));
  await until("tab two saw the reconnect", () => two.sync.syncStatus.connecting);
  assert.equal(two.sync.syncStatus.connected, false);
});

test("disconnecting a waiting tab ends its connect attempt without uploading", async (context) => {
  const { uploads, database, open } = browser(context, true);
  const one = await open("one");
  await connect(one);
  const two = await open("two");
  await connect(two);
  await until("tab one started syncing", () => database.syncStarts.length > 0);

  await two.sync.disconnect();

  assert.deepEqual(database.syncStarts, [one.writeConnection]);
  assert.deepEqual(uploads, []);
});

test("a database that is not shared between tabs keeps per-client sync and no channels", async (context) => {
  const { hub, database, open } = browser(context, false);
  const one = await open("one");
  await connect(one);
  await until("the client started syncing", () => database.syncStarts.length > 0);
  const seen: string[][] = [];
  one.adapter.registerListener({ tablesUpdated: ({ tables }) => seen.push(tables) });

  await insertList(one);

  assert.deepEqual(seen, [["lists", "ps_crud"]]);
  assert.deepEqual(hub.openedChannels, []);
  assert.deepEqual(hub.heldLocks(), []);
});

test("without a shared database, clients of one identifier still exclude each other in-process", async () => {
  const options = {
    adapter: new SqliteBucketStorage(new LynxDBAdapter({ name: "unopened.db" }), silentLogger),
    subscriptions: [],
    connector: { ...stubConnector(), uploadCrud: async () => {} },
    identifier: "local.db",
    logger: silentLogger,
    remote: new LynxRemote(stubConnector(), silentLogger),
    serializedSchema: null,
  };
  const first = new LynxStreamingSyncImplementation(options);
  const second = new LynxStreamingSyncImplementation(options);
  const order: string[] = [];
  let finishFirst = (): void => {};
  const firstRuns = first.obtainLock({
    type: LockType.SYNC,
    callback: () =>
      new Promise<void>((resolve) => {
        order.push("first starts");
        finishFirst = () => {
          order.push("first ends");
          resolve();
        };
      }),
  });
  const secondRuns = second.obtainLock({
    type: LockType.SYNC,
    callback: async () => {
      order.push("second starts");
    },
  });

  await settle();
  assert.deepEqual(order, ["first starts"]);
  finishFirst();
  await Promise.all([firstRuns, secondRuns]);
  assert.deepEqual(order, ["first starts", "first ends", "second starts"]);
});
