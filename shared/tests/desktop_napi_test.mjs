import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const addonPath = process.env.PS_DESKTOP_NAPI_ADDON
  ?? path.resolve("shared/build/desktop_napi_test.node");
const fixturesPath = process.env.PS_SYNC_STREAM_FIXTURES_PATH
  ?? path.resolve("shared/fixtures/sync-stream.json");

const addon = require(addonPath);
const catalog = JSON.parse(fs.readFileSync(fixturesPath, "utf8"));
const scenarios = new Map(catalog.scenarios.map((s) => [s.id, s]));

function rpc(fn, ...args) {
  return new Promise((resolve) => {
    fn(...args, (envelope) => resolve(envelope));
  });
}

function startReplayServer(config) {
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": config.contentType ?? catalog.contentType });
      let i = 0;
      const writeNext = () => {
        if (i >= config.chunks.length) {
          if (!config.holdOpen) {
            res.end();
          }
          return;
        }
        res.write(config.chunks[i]);
        i += 1;
        if (config.gapMs) {
          setTimeout(writeNext, config.gapMs);
        } else {
          writeNext();
        }
      };
      writeNext();
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        url: (p) => `http://127.0.0.1:${addr.port}${p}`,
        close: () =>
          new Promise((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("timed out waiting for condition");
}

// 1. SQL RPC: open, execute, blobs, BigInt, strict tagged bigint validation, batch, close
{
  const inst = addon.createBoundModule();
  const mod = inst.native;
  try {
    const opened = await rpc(mod.open, { dbFilename: ":memory:", readOnly: false });
    assert.equal(opened.ok, true, opened.message);
    const dbId = opened.dbId;

    const created = await rpc(
      mod.execute,
      dbId,
      "CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT, payload BLOB)",
      [],
    );
    assert.equal(created.ok, true, created.message);

    const big = 9007199254740993n;
    const blob = new Uint8Array([1, 2, 3, 4]).buffer;
    const inserted = await rpc(
      mod.execute,
      dbId,
      "INSERT INTO items(id, name, payload) VALUES (?, ?, ?)",
      [big, "alpha", blob],
    );
    assert.equal(inserted.ok, true, inserted.message);

    const taggedOk = await rpc(
      mod.execute,
      dbId,
      "INSERT INTO items(id, name, payload) VALUES (?, ?, NULL)",
      [{ __psBig: true, v: "9007199254740995" }, "beta"],
    );
    assert.equal(taggedOk.ok, true, taggedOk.message);

    // Strict decimal validation: reject trailing garbage like "99abc" (matches iOS/Android).
    const taggedBad = await rpc(
      mod.execute,
      dbId,
      "SELECT ?",
      [{ __psBig: true, v: "99abc" }],
    );
    assert.equal(taggedBad.ok, false);
    assert.match(taggedBad.message, /invalid tagged bigint/);

    const queried = await rpc(
      mod.execute,
      dbId,
      "SELECT id, name, payload FROM items ORDER BY id ASC",
      [],
    );
    assert.equal(queried.ok, true, queried.message);
    assert.deepEqual(queried.columnNames, ["id", "name", "payload"]);
    assert.equal(queried.rawRows.length, 2);
    assert.equal(queried.rawRows[0][0], big);
    assert.equal(queried.rawRows[0][1], "alpha");
    assert.deepEqual(Array.from(new Uint8Array(queried.rawRows[0][2])), [1, 2, 3, 4]);
    assert.equal(queried.rawRows[1][0], 9007199254740995n);

    const batched = await rpc(
      mod.executeBatch,
      dbId,
      "INSERT INTO items(id, name) VALUES (?, ?)",
      [
        [1, "one"],
        [2, "two"],
      ],
    );
    assert.equal(batched.ok, true, batched.message);
    assert.equal(batched.rowsAffected, 2);

    const closed = await rpc(mod.close, dbId);
    assert.equal(closed.ok, true);
  } finally {
    inst.shutdown();
  }
  console.log("ok: desktop N-API SQL RPC + strict tagged bigint");
}

// 2. Sync HTTP: GlobalEventEmitter streaming (split-multibyte), abort, and C host override precedence
if (process.platform === "darwin" || process.platform === "win32") {
  const split = scenarios.get("split-multibyte");
  const checkpoint = scenarios.get("checkpoint-ops");
  const wireBuffers = split.wireChunksHex.map((hex) => Buffer.from(hex, "hex"));

  const inst = addon.createBoundModule();
  const mod = inst.native;
  const jsEvents = [];
  let resolveCount = 0;

  const emitter = {
    trigger(name, payload) {
      jsEvents.push({ streamId: name, ...payload });
    },
  };
  globalThis.lynx = {
    getJSModule(name) {
      if (name === "GlobalEventEmitter") {
        resolveCount += 1;
        return emitter;
      }
      return undefined;
    },
  };

  try {
    // 2a. Streaming via cached GlobalEventEmitter across multiple chunks.
    const server = await startReplayServer({ chunks: wireBuffers, gapMs: 30 });
    try {
      const env = await rpc(mod.httpFetch, {
        method: "POST",
        url: server.url("/sync/stream"),
        headers: { Accept: "application/x-ndjson" },
        body: "{}",
      });
      assert.equal(env.ok, true, env.message);
      assert.equal(env.status, 200);
      assert.ok(env.streamingId.startsWith("NativePowerSyncHttpStream"));
      await waitFor(() => jsEvents.some((e) => e.event === "onEnd"));
      const joined = jsEvents
        .filter((e) => e.event === "onData")
        .map((e) => e.data)
        .join("");
      assert.equal(joined, split.chunks.join(""));
      // Emitter must be resolved once per httpFetch, not once per onData chunk.
      assert.equal(resolveCount, 1);
    } finally {
      await server.close();
    }
    console.log("ok: desktop N-API streaming + cached GlobalEventEmitter");

    // 2b. C host override takes precedence over PrimJS GlobalEventEmitter (ADR-0003).
    jsEvents.length = 0;
    inst.enableSharedOverride(true);
    const overrideServer = await startReplayServer({
      chunks: checkpoint.chunks.map((c) => Buffer.from(c, "utf8")),
    });
    try {
      const env = await rpc(mod.httpFetch, {
        method: "POST",
        url: overrideServer.url("/sync/stream"),
        body: "{}",
      });
      assert.equal(env.ok, true, env.message);
      let overrideEvents = [];
      await waitFor(() => {
        overrideEvents = overrideEvents.concat(inst.takeOverrideEvents());
        return overrideEvents.some((e) => e.event === "onEnd");
      });
      assert.equal(jsEvents.length, 0, "JS GlobalEventEmitter must not shadow C host override");
      const joined = overrideEvents
        .filter((e) => e.event === "onData")
        .map((e) => e.data)
        .join("");
      assert.equal(joined, checkpoint.chunks.join(""));
    } finally {
      inst.enableSharedOverride(false);
      await overrideServer.close();
    }
    console.log("ok: desktop N-API C host override beats PrimJS GlobalEventEmitter");

    // 2c. Hold-open stream + httpFetchAbort cancellation.
    jsEvents.length = 0;
    const holdServer = await startReplayServer({
      chunks: checkpoint.chunks.map((c) => Buffer.from(c, "utf8")),
      holdOpen: true,
    });
    try {
      const env = await rpc(mod.httpFetch, {
        method: "POST",
        url: holdServer.url("/sync/stream"),
        body: "{}",
      });
      assert.equal(env.ok, true, env.message);
      await waitFor(() => jsEvents.some((e) => e.event === "onData"));
      const abortRes = await rpc(mod.httpFetchAbort, env.streamingId);
      assert.equal(abortRes.ok, true);
      await waitFor(() => jsEvents.some((e) => e.event === "onEnd"));
      assert.ok(jsEvents.some((e) => e.event === "onError"));
    } finally {
      await holdServer.close();
    }
    console.log("ok: desktop N-API httpFetchAbort cancels live stream");
  } finally {
    delete globalThis.lynx;
    inst.shutdown();
  }
}

console.log("all desktop N-API tests passed");
