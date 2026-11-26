import type { PowerSyncBackendConnector, PowerSyncDatabase } from "powersync-lynx";

import type { TodoRow } from "./schema.ts";
import { demoApiUrl, demoFetch, deviceId, errorMessage, nowIso } from "./util.ts";

interface E2eSummaryRow {
  id: string;
  description: string;
  completed: number;
}

const E2E_SEED_ID = "e2e-seed-1";
const E2E_SEED_DESC = "Initial todo €100";
const E2E_LIVE_ID = "e2e-live-1";
const E2E_LIVE_DESC = "Live push 🚀 €99";
const E2E_LOCAL_ID = "e2e-local-1";
const E2E_LOCAL_DESC = "Local upload ✨";
const E2E_OFFLINE_LOCAL_ID = "e2e-offline-local-1";
const E2E_OFFLINE_LOCAL_DESC = "Offline local write";
const E2E_OFFLINE_REMOTE_ID = "e2e-offline-remote-1";
const E2E_OFFLINE_REMOTE_DESC = "Offline remote 🎉";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`timeout after ${ms}ms waiting for ${label}`)), ms);
    }),
  ]);
}

async function waitUntil<T>(
  check: () => Promise<T | null | undefined | false>,
  label: string,
  timeoutMs = 15000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== null && value !== undefined && value !== false) {
      return value;
    }
    await sleep(100);
  }
  throw new Error(`timeout after ${timeoutMs}ms waiting for ${label}`);
}

async function postEvent(step: string, payload: Record<string, unknown>): Promise<void> {
  const response = await demoFetch(`${demoApiUrl()}/e2e/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device: deviceId(), step, ...payload }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`e2e event '${step}' HTTP ${response.status}: ${detail}`);
  }
}

async function queryCount(db: PowerSyncDatabase, sql: string): Promise<number> {
  const row = await db.getOptional<{ n?: number }>(sql);
  return Number(row?.n ?? 0);
}

async function queryTodos(db: PowerSyncDatabase): Promise<E2eSummaryRow[]> {
  const rows = await db.getAll<TodoRow>("SELECT id, description, completed FROM todos ORDER BY id");
  return rows.map((row) => ({
    id: String(row.id),
    description: String(row.description ?? ""),
    completed: Number(row.completed ?? 0),
  }));
}

let started = false;

/**
 * Automated opt-in headless E2E sync verification driver.
 * Runs only when host globalProps passes `{ e2e: true }`.
 */
export async function runShowcaseE2e(
  db: PowerSyncDatabase,
  connector: PowerSyncBackendConnector,
  log: (message: string) => void,
): Promise<void> {
  if (started) {
    return;
  }
  started = true;

  try {
    log("e2e: awaiting first sync");
    await withTimeout(db.waitForFirstSync(), 15000, "waitForFirstSync");

    const versionRow = await db.getOptional<{ version?: string }>(
      "SELECT powersync_rs_version() AS version",
    );
    const version = String(versionRow?.version ?? "");
    if (version.length === 0) {
      throw new Error("powersync_rs_version() returned empty string");
    }

    const bucketCount = await waitUntil(async () => {
      const n = await queryCount(db, "SELECT count(*) AS n FROM ps_buckets");
      return n > 0 ? n : null;
    }, "ps_buckets > 0");

    const seedRow = await waitUntil(async () => {
      const row = await db.getOptional<TodoRow>("SELECT * FROM todos WHERE id = ?", [E2E_SEED_ID]);
      return row != null && row.description === E2E_SEED_DESC ? row : null;
    }, `seed row ${E2E_SEED_ID}`);

    log(`e2e: first sync ok (core=${version}, buckets=${bucketCount})`);
    await postEvent("first-sync", {
      version,
      bucketCount,
      seedDescription: seedRow.description,
    });

    // Server pushes E2E_LIVE_ID over the still-open /sync/stream #1.
    const liveRow = await waitUntil(async () => {
      const row = await db.getOptional<TodoRow>("SELECT * FROM todos WHERE id = ?", [E2E_LIVE_ID]);
      return row != null && row.description === E2E_LIVE_DESC ? row : null;
    }, `live push row ${E2E_LIVE_ID}`);
    log(`e2e: live push received (${liveRow.description})`);
    await postEvent("live-received", {
      id: liveRow.id,
      description: liveRow.description,
    });

    // Local CRUD insert -> uploadData() -> /upload -> /write-checkpoint2.json -> ps_crud drains.
    await db.execute(
      "INSERT INTO todos (id, description, completed, created_at, completed_at) VALUES (?, ?, ?, ?, ?)",
      [E2E_LOCAL_ID, E2E_LOCAL_DESC, 0, nowIso(), null],
    );
    await waitUntil(async () => {
      const pending = await queryCount(db, "SELECT count(*) AS n FROM ps_crud");
      return pending === 0 ? true : null;
    }, "ps_crud drain after local upload");
    const localRow = await db.getOptional<TodoRow>("SELECT * FROM todos WHERE id = ?", [
      E2E_LOCAL_ID,
    ]);
    if (localRow == null || localRow.description !== E2E_LOCAL_DESC) {
      throw new Error(`local uploaded row ${E2E_LOCAL_ID} missing after upload`);
    }
    log("e2e: local CRUD uploaded and drained");
    await postEvent("crud-uploaded", { id: E2E_LOCAL_ID });

    // Disconnect -> triggers AbortSignal -> httpFetchAbort -> server observes TCP close.
    await db.disconnect();
    log("e2e: disconnected");
    await postEvent("disconnected", {});

    // Offline local write -> queues in ps_crud while disconnected.
    await db.execute(
      "INSERT INTO todos (id, description, completed, created_at, completed_at) VALUES (?, ?, ?, ?, ?)",
      [E2E_OFFLINE_LOCAL_ID, E2E_OFFLINE_LOCAL_DESC, 0, nowIso(), null],
    );
    const pendingCrud = await queryCount(db, "SELECT count(*) AS n FROM ps_crud");
    if (pendingCrud < 1) {
      throw new Error(`expected pending ps_crud >= 1 while offline, got ${pendingCrud}`);
    }
    log(`e2e: offline write queued (ps_crud=${pendingCrud})`);
    await postEvent("offline-queued", { pendingCrud });

    // Reconnect -> opens /sync/stream #2, uploads offline mutation, downloads remote push.
    await db.connect(connector);
    log("e2e: reconnected");

    await waitUntil(async () => {
      const pending = await queryCount(db, "SELECT count(*) AS n FROM ps_crud");
      if (pending !== 0) {
        return null;
      }
      const remote = await db.getOptional<TodoRow>("SELECT * FROM todos WHERE id = ?", [
        E2E_OFFLINE_REMOTE_ID,
      ]);
      if (remote == null || remote.description !== E2E_OFFLINE_REMOTE_DESC) {
        return null;
      }
      const offlineLocal = await db.getOptional<TodoRow>("SELECT * FROM todos WHERE id = ?", [
        E2E_OFFLINE_LOCAL_ID,
      ]);
      if (offlineLocal == null || offlineLocal.description !== E2E_OFFLINE_LOCAL_DESC) {
        return null;
      }
      return true;
    }, "reconnect convergence");

    const finalBuckets = await queryCount(db, "SELECT count(*) AS n FROM ps_buckets");
    const finalCrud = await queryCount(db, "SELECT count(*) AS n FROM ps_crud");
    const finalTodos = await queryTodos(db);

    await db.disconnect();
    await db.close();

    log(`e2e: done (buckets=${finalBuckets}, crud=${finalCrud}, todos=${finalTodos.length})`);
    await postEvent("done", {
      ok: true,
      version,
      bucketCount: finalBuckets,
      pendingCrud: finalCrud,
      todos: finalTodos,
    });
  } catch (err) {
    const message = errorMessage(err);
    log(`e2e failed: ${message}`);
    try {
      await postEvent("error", { message });
    } catch {
      // ignore reporting error if server already stopped
    }
  }
}
