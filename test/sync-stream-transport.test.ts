import assert from "node:assert/strict";
import { test } from "node:test";

import { LynxRemote } from "../src/sync/LynxRemote.ts";
import {
  pickSyncStreamTransport,
  syncStreamRequestFromFetch,
} from "../src/sync/transport/SyncStreamTransport.ts";
import { nativeWithHttp, stubConnector, withFakeLynxHost } from "./remote-harness.ts";

function streamingRequest(url = "http://127.0.0.1:8080/sync/stream") {
  return syncStreamRequestFromFetch({
    resource: url,
    request: { method: "POST", body: "{}" },
    expectStreamingResponse: true,
  });
}

test("pickSyncStreamTransport prefers native-http when NativePowerSyncModule is present", async () => {
  await withFakeLynxHost(
    {
      platform: "Android",
      nativeModules: {
        LynxFetchModule: {
          fetch() {
            throw new Error("LynxFetchModule must not win over httpFetch");
          },
        },
        NativePowerSyncModule: nativeWithHttp({
          httpFetch(_request, callback) {
            callback({
              ok: true,
              status: 200,
              streamingId: "NativePowerSyncHttpStream0",
              body: "",
            });
          },
        }),
      },
    },
    async () => {
      const picked = pickSyncStreamTransport(streamingRequest());
      assert.equal(picked.name, "native-http");
    },
  );
});

test("pickSyncStreamTransport uses lynx-fetch-module on Android without httpFetch", async () => {
  await withFakeLynxHost(
    {
      platform: "Android",
      nativeModules: {
        LynxFetchModule: {
          fetch() {
            throw new Error("not invoked by pick");
          },
        },
      },
    },
    async () => {
      const picked = pickSyncStreamTransport(streamingRequest());
      assert.equal(picked.name, "lynx-fetch-module");
    },
  );
});

test("pickSyncStreamTransport uses host-fetch when no native HTTP module is present", async () => {
  await withFakeLynxHost(
    {
      fetchImpl: async () => new Response(null, { status: 200 }),
    },
    async () => {
      const picked = pickSyncStreamTransport(streamingRequest());
      assert.equal(picked.name, "host-fetch");
    },
  );
});

test("pickSyncStreamTransport uses host-fetch for SQL-only web even when an emitter exists", async () => {
  await withFakeLynxHost(
    {
      emitter: { addListener() {} },
      nativeModules: {
        NativePowerSyncModule: {
          open(_options, callback) {
            callback({ ok: true, dbId: "web" });
          },
          close(_dbId, callback) {
            callback({ ok: true });
          },
          execute(_dbId, _sql, _params, callback) {
            callback({ ok: true });
          },
          executeBatch(_dbId, _sql, _params, callback) {
            callback({ ok: true });
          },
        },
      },
      fetchImpl: async () => new Response(null, { status: 200 }),
    },
    async () => {
      const picked = pickSyncStreamTransport(streamingRequest());
      assert.equal(picked.name, "host-fetch");
    },
  );
});

test("pickSyncStreamTransport skips native-http when the SQL module has no httpFetch", async () => {
  await withFakeLynxHost(
    {
      nativeModules: {
        NativePowerSyncModule: {
          open(_options, callback) {
            callback({ ok: true, dbId: "ps-1" });
          },
          close(_dbId, callback) {
            callback({ ok: true });
          },
          execute(_dbId, _sql, _params, callback) {
            callback({ ok: true });
          },
          executeBatch(_dbId, _sql, _params, callback) {
            callback({ ok: true });
          },
        },
      },
      fetchImpl: async () => new Response(null, { status: 200 }),
    },
    async () => {
      const picked = pickSyncStreamTransport(streamingRequest());
      assert.equal(picked.name, "host-fetch");
    },
  );
});

test("LynxRemote logs the selected streaming transport instead of FM-PS-LYNX-003", async () => {
  const records: { level: number; message: string }[] = [];
  await withFakeLynxHost(
    {
      nativeModules: {
        NativePowerSyncModule: nativeWithHttp({
          httpFetch(_request, callback) {
            callback({
              ok: true,
              status: 200,
              streamingId: "NativePowerSyncHttpStream9",
              body: "",
            });
          },
        }),
      },
      emitter: {
        addListener() {},
      },
    },
    async () => {
      const remote = new LynxRemote(stubConnector(), {
        log(record) {
          records.push({ level: record.level, message: record.message });
        },
      });
      await remote.fetch({
        resource: "http://127.0.0.1:8080/sync/stream",
        request: { method: "POST", body: "{}" },
        expectStreamingResponse: true,
      });
    },
  );
  assert.equal(
    records.some((record) => record.message.includes("via native-http")),
    true,
  );
  assert.equal(
    records.some((record) => record.message.includes("FM-PS-LYNX-003")),
    false,
  );
});
