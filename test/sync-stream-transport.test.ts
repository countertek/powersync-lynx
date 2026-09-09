import assert from "node:assert/strict";
import { test } from "node:test";

import { LynxRemote } from "../src/sync/LynxRemote.ts";
import { headerMap, preferNdjsonAccept } from "../src/sync/transport/bytes.ts";
import { responseFromLynxFetchSuccess } from "../src/sync/transport/LynxFetchModule.ts";
import { responseFromNativeHttpEnvelope } from "../src/sync/transport/NativeHttpFetch.ts";
import {
  pickSyncStreamTransport,
  syncStreamRequestFromFetch,
} from "../src/sync/transport/SyncStreamTransport.ts";
import {
  chunkReader,
  identifierResponse,
  nativeWithHttp,
  stubConnector,
  withFakeLynxHost,
} from "./remote-harness.ts";

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

const BSON_ACCEPT =
  "application/vnd.powersync.bson-stream;q=0.9, application/x-ndjson;q=0.8";

test("headerMap copies Accept without rewriting BSON or adding Accept-Encoding", () => {
  const mapped = headerMap({ Accept: BSON_ACCEPT });
  assert.equal(mapped.Accept, BSON_ACCEPT);
  assert.equal(mapped["Accept-Encoding"], undefined);
  assert.equal(mapped["accept-encoding"], undefined);
});

test("syncStreamRequestFromFetch names NDJSON Accept policy at the stream seam", () => {
  const request = syncStreamRequestFromFetch({
    resource: "http://127.0.0.1:8080/sync/stream",
    request: { method: "POST", headers: { Accept: BSON_ACCEPT }, body: "{}" },
    expectStreamingResponse: true,
  });
  assert.equal(request.headers.Accept, "application/x-ndjson");
  assert.equal(request.headers["Accept-Encoding"], "identity");
});

test("preferNdjsonAccept is a named rewrite, not implicit headerMap behavior", () => {
  const copied = headerMap({ Accept: BSON_ACCEPT });
  const rewritten = preferNdjsonAccept({ ...copied });
  assert.equal(copied.Accept, BSON_ACCEPT);
  assert.equal(rewritten.Accept, "application/x-ndjson");
  assert.equal(rewritten["Accept-Encoding"], "identity");
});

test("NativeHttpFetch owns the httpFetch envelope and returns a finished Response", async () => {
  await withFakeLynxHost(
    {
      emitter: { addListener() {} },
    },
    async () => {
      const idle = responseFromNativeHttpEnvelope({
        ok: true,
        status: 200,
        statusText: "OK",
        contentType: "application/x-ndjson",
        body: '{"checkpoint":{"last_op_id":"1"}}\n',
        idleComplete: true,
      });
      assert.equal(idle.ok, true);
      assert.equal(idle.status, 200);
      assert.equal(idle.headers.get("content-type"), "application/x-ndjson");
      const idleFirst = await idle.body!.getReader().read();
      assert.equal(idleFirst.done, false);

      const streamed = responseFromNativeHttpEnvelope({
        ok: true,
        status: 200,
        streamingId: "NativePowerSyncHttpStream-own",
        body: "",
      });
      assert.equal(streamed.ok, true);
      assert.equal(streamed.body != null, true);
    },
  );
});

test("LynxFetchModule owns lynxExtension.streamingId and returns a finished Response", async () => {
  await withFakeLynxHost(
    {
      emitter: { addListener() {} },
    },
    async () => {
      const streamed = responseFromLynxFetchSuccess(
        {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/x-ndjson" },
          lynxExtension: { streamingId: "stream-owned" },
        },
        true,
      );
      assert.equal(streamed.ok, true);
      assert.equal(streamed.status, 200);
      assert.equal(streamed.headers.get("content-type"), "application/x-ndjson");
      assert.equal(streamed.body != null, true);

      const buffered = responseFromLynxFetchSuccess(
        {
          status: 200,
          body: '{"ok":1}\n',
        },
        true,
      );
      const first = await buffered.body!.getReader().read();
      assert.equal(new TextDecoder().decode(first.value), '{"ok":1}\n');
    },
  );
});

test("HostFetch returns a finished Response from the Fetch body without sniffing lynxExtension", async () => {
  let sawStreamingIdSniff = false;
  await withFakeLynxHost(
    {
      fetchImpl: async () => {
        const response = identifierResponse({
          contentType: "application/x-ndjson",
          mockBody: chunkReader([new TextEncoder().encode('{"ok":1}\n')]),
        });
        Object.defineProperty(response, "lynxExtension", {
          configurable: true,
          get() {
            sawStreamingIdSniff = true;
            return { streamingId: "host-must-ignore" };
          },
        });
        return response;
      },
    },
    async () => {
      const remote = new LynxRemote(stubConnector(), {
        log() {},
      });
      const response = await remote.fetch({
        resource: "http://127.0.0.1:8080/sync/stream",
        request: { method: "POST", body: "{}" },
        expectStreamingResponse: true,
      });
      assert.equal(response.ok, true);
      assert.equal(response.status, 200);
      const first = await response.body!.getReader().read();
      assert.equal(new TextDecoder().decode(first.value), '{"ok":1}\n');
      assert.equal(sawStreamingIdSniff, false);
    },
  );
});
