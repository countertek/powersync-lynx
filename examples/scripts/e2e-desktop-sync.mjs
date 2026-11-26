#!/usr/bin/env node
/**
 * Automated headless desktop E2E sync verification for:
 *   - Native CMake LynxView host (Windows x64 / macOS arm64)
 *   - Lynxtron Autolink host (Windows x64 / macOS arm64)
 *
 * Launches a deterministic local mock PowerSync + Demo API server speaking the
 * real PowerSync HTTP/NDJSON sync protocol (including split multi-byte UTF-8
 * live pushes, /upload, /write-checkpoint2.json, and abort socket-close checks),
 * runs the showcase host headlessly with --e2e, triggers clean shutdown via
 * --exit-file, and inspects the persisted SQLite DB on disk via node:sqlite.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const SEED_ID = "e2e-seed-1";
const SEED_DESC = "Initial todo €100";
const LIVE_ID = "e2e-live-1";
const LIVE_DESC = "Live push 🚀 €99";
const LOCAL_ID = "e2e-local-1";
const LOCAL_DESC = "Local upload ✨";
const OFFLINE_LOCAL_ID = "e2e-offline-local-1";
const OFFLINE_LOCAL_DESC = "Offline local write";
const OFFLINE_REMOTE_ID = "e2e-offline-remote-1";
const OFFLINE_REMOTE_DESC = "Offline remote 🎉";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Local mock PowerSync sync service + demo API server.
 */
export async function createMockPowerSyncStack() {
  const bucketName = "global";
  let opSeq = 0;
  /** @type {Array<{ op_id: string, op: string, object_type: string, object_id: string, checksum: number, data?: string }>} */
  const oplog = [];
  /** @type {Map<string, Record<string, unknown>>} */
  const todos = new Map();
  let writeCheckpoint = 0;

  const stats = {
    tokenRequests: 0,
    uploadRequests: 0,
    uploadedIds: [],
    writeCheckpointRequests: 0,
    streamOpens: 0,
    stream1OpenedAt: null,
    stream1ClosedAt: null,
    events: [],
  };

  /** @type {Set<{ id: number, res: http.ServerResponse, closed: boolean, closeWaiters: Array<() => void> }>} */
  const activeStreams = new Set();
  /** @type {{ id: number, res: http.ServerResponse, closed: boolean, closeWaiters: Array<() => void> } | null} */
  let firstStream = null;

  let resolveDone;
  let rejectDone;
  const donePromise = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  function appendPutTodo(id, row) {
    const normalized = {
      description: String(row.description ?? ""),
      completed: Number(row.completed ?? 0),
      created_at: String(row.created_at ?? new Date().toISOString()),
      completed_at: row.completed_at ?? null,
    };
    todos.set(id, normalized);
    opSeq += 1;
    const entry = {
      op_id: String(opSeq),
      op: "PUT",
      object_type: "todos",
      object_id: id,
      checksum: 0,
      data: JSON.stringify(normalized),
    };
    oplog.push(entry);
    return entry;
  }

  // Seed initial row before any client connects.
  appendPutTodo(SEED_ID, { description: SEED_DESC, completed: 0 });

  function makeCheckpointObject() {
    const cp = {
      last_op_id: String(opSeq),
      buckets: [
        {
          bucket: bucketName,
          checksum: 0,
          priority: 3,
          count: oplog.length,
        },
      ],
    };
    if (writeCheckpoint > 0) {
      cp.write_checkpoint = String(writeCheckpoint);
    }
    return cp;
  }

  function makeCheckpointDiffObject() {
    const diff = {
      last_op_id: String(opSeq),
      updated_buckets: [
        {
          bucket: bucketName,
          checksum: 0,
          priority: 3,
          count: oplog.length,
        },
      ],
      removed_buckets: [],
    };
    if (writeCheckpoint > 0) {
      diff.write_checkpoint = String(writeCheckpoint);
    }
    return diff;
  }

  function broadcastOps(newEntries, { splitMultibyte = false } = {}) {
    const diffLine = `${JSON.stringify({ checkpoint_diff: makeCheckpointDiffObject() })}\n`;
    const dataLine = `${JSON.stringify({ data: { bucket: bucketName, data: newEntries } })}\n`;
    const completeLine = `${JSON.stringify({ checkpoint_complete: { last_op_id: String(opSeq) } })}\n`;

    for (const stream of activeStreams) {
      if (stream.closed || stream.res.destroyed || stream.res.writableEnded) {
        continue;
      }
      stream.res.write(diffLine);
      if (splitMultibyte) {
        // Split a 3-byte UTF-8 euro (€ = 0xE2 0x82 0xAC) across two TCP writes
        // to verify native shared/utf8_hold.h reassembly over live streams.
        const raw = Buffer.from(dataLine, "utf8");
        const euroIdx = raw.indexOf(Buffer.from([0xe2, 0x82, 0xac]));
        if (euroIdx > 0) {
          stream.res.write(raw.subarray(0, euroIdx + 1));
          setTimeout(() => {
            if (!stream.closed && !stream.res.destroyed && !stream.res.writableEnded) {
              stream.res.write(raw.subarray(euroIdx + 1));
              stream.res.write(completeLine);
            }
          }, 25);
          continue;
        }
      }
      stream.res.write(dataLine);
      stream.res.write(completeLine);
    }
  }

  function waitForFirstStreamClose(timeoutMs = 5000) {
    if (firstStream == null) {
      return Promise.reject(new Error("no /sync/stream #1 was ever opened"));
    }
    if (firstStream.closed) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `/sync/stream #1 TCP socket did not close within ${timeoutMs}ms after disconnect`,
          ),
        );
      }, timeoutMs);
      firstStream.closeWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  let powersyncUrl = "";

  const powersyncServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/write-checkpoint2.json") {
        stats.writeCheckpointRequests += 1;
        writeCheckpoint = Math.max(writeCheckpoint, opSeq);
        writeJson(res, 200, { data: { write_checkpoint: String(writeCheckpoint) } });
        // Push an updated write_checkpoint on open streams so core completes local sync promptly.
        if (activeStreams.size > 0) {
          const diffLine = `${JSON.stringify({ checkpoint_diff: makeCheckpointDiffObject() })}\n`;
          const completeLine = `${JSON.stringify({ checkpoint_complete: { last_op_id: String(opSeq) } })}\n`;
          for (const stream of activeStreams) {
            if (!stream.closed && !stream.res.destroyed && !stream.res.writableEnded) {
              stream.res.write(diffLine);
              stream.res.write(completeLine);
            }
          }
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/sync/stream") {
        const raw = await readBody(req);
        const body = raw.length > 0 ? JSON.parse(raw) : {};
        let afterOp = 0;
        if (Array.isArray(body.buckets)) {
          const globalReq = body.buckets.find((b) => b && b.name === bucketName);
          if (globalReq?.after != null) {
            afterOp = Number(globalReq.after) || 0;
          }
        }

        stats.streamOpens += 1;
        const streamId = stats.streamOpens;
        const streamRec = {
          id: streamId,
          res,
          closed: false,
          closeWaiters: [],
        };
        if (streamId === 1) {
          firstStream = streamRec;
          stats.stream1OpenedAt = Date.now();
        }
        activeStreams.add(streamRec);

        const markClosed = () => {
          if (streamRec.closed) {
            return;
          }
          streamRec.closed = true;
          activeStreams.delete(streamRec);
          if (streamId === 1 && stats.stream1ClosedAt == null) {
            stats.stream1ClosedAt = Date.now();
          }
          for (const waiter of streamRec.closeWaiters.splice(0)) {
            waiter();
          }
        };
        req.on("close", markClosed);
        res.on("close", markClosed);
        req.socket?.on("close", markClosed);

        res.writeHead(200, {
          "content-type": "application/x-ndjson",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.flushHeaders();

        const pendingOps = oplog.filter((entry) => Number(entry.op_id) > afterOp);
        res.write(`${JSON.stringify({ checkpoint: makeCheckpointObject() })}\n`);
        if (pendingOps.length > 0) {
          const dataPayload = {
            bucket: bucketName,
            data: pendingOps,
            ...(afterOp > 0 ? { after: String(afterOp), next_after: String(opSeq) } : {}),
          };
          res.write(`${JSON.stringify({ data: dataPayload })}\n`);
        }
        res.write(`${JSON.stringify({ checkpoint_complete: { last_op_id: String(opSeq) } })}\n`);
        // Keep response open for live streaming pushes & abort testing!
        return;
      }

      writeJson(res, 404, { error: `not found: ${req.method} ${url.pathname}` });
    } catch (err) {
      writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  const demoApiServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        writeJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && url.pathname === "/token") {
        stats.tokenRequests += 1;
        writeJson(res, 200, {
          endpoint: powersyncUrl,
          token: "e2e-mock-jwt-token",
          userId: "e2e-user",
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/upload") {
        stats.uploadRequests += 1;
        const raw = await readBody(req);
        const body = raw.length > 0 ? JSON.parse(raw) : {};
        const crud = Array.isArray(body.crud) ? body.crud : [];
        const newEntries = [];
        for (const entry of crud) {
          if (entry?.table !== "todos" || !entry?.id) {
            continue;
          }
          stats.uploadedIds.push(String(entry.id));
          if (entry.op === "PUT") {
            newEntries.push(appendPutTodo(String(entry.id), entry.opData ?? {}));
          } else if (entry.op === "PATCH") {
            const existing = todos.get(String(entry.id)) ?? {};
            newEntries.push(
              appendPutTodo(String(entry.id), { ...existing, ...(entry.opData ?? {}) }),
            );
          } else if (entry.op === "DELETE") {
            todos.delete(String(entry.id));
            opSeq += 1;
            const delEntry = {
              op_id: String(opSeq),
              op: "REMOVE",
              object_type: "todos",
              object_id: String(entry.id),
              checksum: 0,
            };
            oplog.push(delEntry);
            newEntries.push(delEntry);
          }
        }
        writeCheckpoint = Math.max(writeCheckpoint, opSeq);
        writeJson(res, 200, { ok: true });
        if (newEntries.length > 0) {
          broadcastOps(newEntries);
        }
        return;
      }
      if (req.method === "POST" && url.pathname === "/e2e/event") {
        const raw = await readBody(req);
        const payload = raw.length > 0 ? JSON.parse(raw) : {};
        stats.events.push({ at: Date.now(), ...payload });
        const step = String(payload.step ?? "");
        console.log(`[e2e-server] event: ${step} ${JSON.stringify(payload)}`);

        if (step === "first-sync") {
          writeJson(res, 200, { ok: true });
          // Push live incremental NDJSON update (with split UTF-8 euro!) while stream #1 stays open.
          const liveEntry = appendPutTodo(LIVE_ID, { description: LIVE_DESC, completed: 0 });
          broadcastOps([liveEntry], { splitMultibyte: true });
          return;
        }
        if (step === "disconnected") {
          await waitForFirstStreamClose(5000);
          // Stage offline remote mutation so it converges on reconnect stream #2.
          appendPutTodo(OFFLINE_REMOTE_ID, { description: OFFLINE_REMOTE_DESC, completed: 0 });
          writeJson(res, 200, { ok: true, stream1Closed: true });
          return;
        }
        if (step === "done") {
          writeJson(res, 200, { ok: true });
          resolveDone(payload);
          return;
        }
        if (step === "error") {
          writeJson(res, 200, { ok: true });
          rejectDone(
            new Error(`showcase e2e driver failed: ${payload.message ?? "unknown error"}`),
          );
          return;
        }
        writeJson(res, 200, { ok: true });
        return;
      }
      writeJson(res, 404, { error: `not found: ${req.method} ${url.pathname}` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeJson(res, 500, { error: msg });
      rejectDone(new Error(`e2e server handler error: ${msg}`));
    }
  });

  await new Promise((resolve) => powersyncServer.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => demoApiServer.listen(0, "127.0.0.1", resolve));

  const psAddr = powersyncServer.address();
  const apiAddr = demoApiServer.address();
  powersyncUrl = `http://127.0.0.1:${psAddr.port}`;
  const demoApiUrl = `http://127.0.0.1:${apiAddr.port}`;

  return {
    powersyncUrl,
    demoApiUrl,
    stats,
    donePromise,
    async close() {
      for (const stream of activeStreams) {
        try {
          stream.res.end();
          stream.res.destroy();
        } catch {
          // ignore
        }
      }
      await Promise.all([
        new Promise((resolve) => powersyncServer.close(() => resolve())),
        new Promise((resolve) => demoApiServer.close(() => resolve())),
      ]);
    },
  };
}

function defaultAppDataBase() {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) {
      throw new Error("LOCALAPPDATA is not set on Windows");
    }
    return localAppData;
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support");
  }
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
}

function findPersistedDbPath(device, preferredDirs = []) {
  const filename = `powersync-lynx-todo-${device}.db`;
  const base = defaultAppDataBase();
  for (const dirName of preferredDirs) {
    const candidate = path.join(base, dirName, filename);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  if (fs.existsSync(base)) {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidate = path.join(base, entry.name, filename);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function removeDbFiles(dbPath) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

function verifyPersistedSqlite(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    const bucketsRow = db.prepare("SELECT count(*) AS n FROM ps_buckets").get();
    const bucketCount = Number(bucketsRow?.n ?? 0);
    assert.ok(bucketCount > 0, `expected ps_buckets > 0 on disk, got ${bucketCount}`);

    const crudRow = db.prepare("SELECT count(*) AS n FROM ps_crud").get();
    const crudCount = Number(crudRow?.n ?? 0);
    assert.equal(crudCount, 0, `expected ps_crud == 0 on disk, got ${crudCount}`);

    const dataRows = db.prepare("SELECT id, data FROM ps_data__todos ORDER BY id").all();
    const byId = new Map();
    for (const row of dataRows) {
      const parsed = JSON.parse(String(row.data ?? "{}"));
      byId.set(String(row.id), parsed);
    }

    const expected = new Map([
      [SEED_ID, SEED_DESC],
      [LIVE_ID, LIVE_DESC],
      [LOCAL_ID, LOCAL_DESC],
      [OFFLINE_LOCAL_ID, OFFLINE_LOCAL_DESC],
      [OFFLINE_REMOTE_ID, OFFLINE_REMOTE_DESC],
    ]);
    for (const [id, desc] of expected) {
      const actual = byId.get(id);
      assert.ok(actual != null, `persisted ps_data__todos missing row ${id}`);
      assert.equal(
        actual.description,
        desc,
        `persisted row ${id} description mismatch: ${actual.description} !== ${desc}`,
      );
    }
    console.log(
      `[e2e] verified persisted SQLite DB (${dbPath}): ps_buckets=${bucketCount}, ps_crud=${crudCount}, rows=${byId.size}`,
    );
  } finally {
    db.close();
  }
}

function buildTargetCommand(target, { device, demoApiUrl, powersyncUrl, exitFile, timeoutSec }) {
  if (target === "native") {
    if (process.platform === "win32") {
      const exe = path.join(ROOT, "examples/hosts/windows/build/Release/PowerSyncLynxShowcase.exe");
      if (!fs.existsSync(exe)) {
        throw new Error(`Windows native showcase executable not found at ${exe}`);
      }
      return {
        command: exe,
        args: [
          "--headless",
          "--e2e",
          "--device",
          device,
          "--demo-api-url",
          demoApiUrl,
          "--powersync-url",
          powersyncUrl,
          "--exit-file",
          exitFile,
          "--smoke-test",
          "--smoke-seconds",
          String(timeoutSec + 10),
        ],
        cwd: path.dirname(exe),
        shell: false,
        preferredDirs: ["PowerSyncLynxShowcase"],
      };
    }
    if (process.platform === "darwin") {
      const exe = path.join(
        ROOT,
        "examples/hosts/macos/build/PowerSyncLynxShowcase.app/Contents/MacOS/PowerSyncLynxShowcase",
      );
      if (!fs.existsSync(exe)) {
        throw new Error(`macOS native showcase executable not found at ${exe}`);
      }
      return {
        command: exe,
        args: [
          "--headless",
          "--e2e",
          "--device",
          device,
          "--demo-api-url",
          demoApiUrl,
          "--powersync-url",
          powersyncUrl,
          "--exit-file",
          exitFile,
          "--smoke-test",
          "--smoke-seconds",
          String(timeoutSec + 10),
        ],
        cwd: ROOT,
        shell: false,
        preferredDirs: ["com.powersync.lynx.showcase", "PowerSyncLynxShowcase"],
      };
    }
    throw new Error(`Unsupported platform for native E2E: ${process.platform}`);
  }

  if (target === "lynxtron") {
    const lynxtronDir = path.join(ROOT, "examples/hosts/lynxtron");
    const entry = path.join(lynxtronDir, "dist/desktop/main.js");
    if (!fs.existsSync(entry)) {
      throw new Error(`Lynxtron built entry not found at ${entry}`);
    }
    const cli = path.join(lynxtronDir, "node_modules/@lynx-js/lynxtron/cli.js");
    if (!fs.existsSync(cli)) {
      throw new Error(`Lynxtron CLI not found at ${cli}`);
    }
    return {
      command: process.execPath,
      args: [
        cli,
        "./dist/desktop/main.js",
        "--windowless",
        "--e2e",
        "--device",
        device,
        "--demo-api-url",
        demoApiUrl,
        "--powersync-url",
        powersyncUrl,
        "--exit-file",
        exitFile,
      ],
      cwd: lynxtronDir,
      shell: false,
      preferredDirs:
        process.platform === "darwin"
          ? ["com.lynxjs.Lynxtron", "Lynxtron"]
          : ["lynxtron", "Lynxtron"],
    };
  }

  throw new Error(`Unknown E2E target: ${target}`);
}

async function runTarget(target, { timeoutSec = 45 } = {}) {
  const device = `e2e-${process.platform}-${target}-${Date.now().toString(36)}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-lynx-e2e-"));
  const exitFile = path.join(tmpDir, "exit.signal");
  const stack = await createMockPowerSyncStack();
  let child = null;
  let persistedDb = null;

  console.log(
    `\n=== Running headless E2E (${process.platform}/${process.arch} ${target}) device=${device} ===`,
  );
  console.log(`[e2e] demoApi=${stack.demoApiUrl} powersync=${stack.powersyncUrl}`);

  try {
    const launch = buildTargetCommand(target, {
      device,
      demoApiUrl: stack.demoApiUrl,
      powersyncUrl: stack.powersyncUrl,
      exitFile,
      timeoutSec,
    });

    const outputLines = [];
    child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      shell: launch.shell,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    const onChunk = (streamName) => (chunk) => {
      const text = chunk.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (line.trim().length > 0) {
          outputLines.push(`[${streamName}] ${line}`);
        }
      }
    };
    child.stdout?.on("data", onChunk("stdout"));
    child.stderr?.on("data", onChunk("stderr"));

    let exitInfo = null;
    const exitPromise = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        exitInfo = { code, signal };
        resolve(exitInfo);
      });
    });

    const earlyExitPromise = exitPromise.then((info) => {
      throw new Error(
        `${target} host exited before E2E completed (code=${info.code}, signal=${info.signal})`,
      );
    });

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error(`${target} headless E2E timed out after ${timeoutSec}s`)),
        timeoutSec * 1000,
      );
    });

    let donePayload;
    try {
      donePayload = await Promise.race([stack.donePromise, earlyExitPromise, timeoutPromise]);
    } catch (err) {
      console.error(`[e2e] ${target} server stats: ${JSON.stringify(stack.stats)}`);
      console.error(`[e2e] ${target} host output (last 60 lines):`);
      console.error(outputLines.slice(-60).join("\n"));
      throw err;
    }

    // Trigger clean host shutdown via exit-file and wait for exit code 0.
    fs.writeFileSync(exitFile, "0\n", "utf8");
    const shutdownResult = await Promise.race([exitPromise, sleep(15000).then(() => null)]);
    if (shutdownResult == null) {
      console.error(`[e2e] ${target} host output (last 60 lines):`);
      console.error(outputLines.slice(-60).join("\n"));
      throw new Error(`${target} host did not shut down cleanly within 15s after exit-file`);
    }
    assert.equal(
      shutdownResult.code,
      0,
      `expected clean exit code 0 for ${target}, got code=${shutdownResult.code} signal=${shutdownResult.signal}\n${outputLines.slice(-40).join("\n")}`,
    );

    // Server-side protocol assertions.
    assert.ok(stack.stats.tokenRequests >= 1, "expected at least 1 GET /token request");
    assert.ok(
      stack.stats.streamOpens >= 2,
      `expected >= 2 /sync/stream opens (initial + reconnect), got ${stack.stats.streamOpens}`,
    );
    assert.ok(
      stack.stats.stream1ClosedAt != null,
      "expected /sync/stream #1 TCP socket to close cleanly after db.disconnect()",
    );
    assert.ok(
      stack.stats.uploadedIds.includes(LOCAL_ID),
      `expected /upload to receive ${LOCAL_ID}, got ${JSON.stringify(stack.stats.uploadedIds)}`,
    );
    assert.ok(
      stack.stats.uploadedIds.includes(OFFLINE_LOCAL_ID),
      `expected /upload to receive ${OFFLINE_LOCAL_ID}, got ${JSON.stringify(stack.stats.uploadedIds)}`,
    );
    assert.ok(
      stack.stats.writeCheckpointRequests >= 1,
      "expected at least 1 /write-checkpoint2.json request",
    );
    assert.equal(donePayload.ok, true, "expected done payload ok=true");
    assert.ok(Number(donePayload.bucketCount) > 0, "expected done payload bucketCount > 0");
    assert.equal(Number(donePayload.pendingCrud), 0, "expected done payload pendingCrud == 0");

    // Disk persistence assertion (OS default app-data dir + SQLite tables after shutdown).
    persistedDb = findPersistedDbPath(device, launch.preferredDirs);
    assert.ok(
      persistedDb != null,
      `persisted SQLite file powersync-lynx-todo-${device}.db not found under ${defaultAppDataBase()}`,
    );
    verifyPersistedSqlite(persistedDb);

    console.log(
      `PASS: headless E2E (${target}) — streams=${stack.stats.streamOpens}, uploads=${stack.stats.uploadedIds.length}, core=${donePayload.version}`,
    );
  } finally {
    if (child != null && child.exitCode == null && !child.killed) {
      try {
        child.kill();
      } catch {
        // ignore
      }
    }
    await stack.close();
    if (persistedDb != null) {
      removeDbFiles(persistedDb);
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  let target = "all";
  let timeoutSec = 45;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--target" && i + 1 < argv.length) {
      target = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--target=")) {
      target = arg.slice("--target=".length);
    } else if (arg === "--timeout" && i + 1 < argv.length) {
      timeoutSec = Number(argv[i + 1]) || 45;
      i += 1;
    } else if (arg.startsWith("--timeout=")) {
      timeoutSec = Number(arg.slice("--timeout=".length)) || 45;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  const targets = target === "all" ? ["native", "lynxtron"] : [target];
  return { targets, timeoutSec };
}

const isMain =
  process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const { targets, timeoutSec } = parseArgs(process.argv.slice(2));
  (async () => {
    for (const target of targets) {
      await runTarget(target, { timeoutSec });
    }
    console.log("\nAll headless desktop E2E sync checks passed.");
  })().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}
