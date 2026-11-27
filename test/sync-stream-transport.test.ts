import assert from "node:assert/strict";
import { test } from "node:test";

import { LynxRemote } from "../src/sync/LynxRemote.ts";
import { syncStreamResponse } from "../src/sync/transport/response.ts";
import {
  chunkReader,
  identifierResponse,
  nativeWithHttp,
  silentLogger,
  stubConnector,
  withFakeLynxHost,
} from "./remote-harness.ts";

const STREAM_URL = "http://127.0.0.1:8080/sync/stream";
const CHECKPOINT_URL = "http://127.0.0.1:8080/write-checkpoint2.json?client_id=1";
const BSON_ACCEPT = "application/vnd.powersync.bson-stream;q=0.9, application/x-ndjson;q=0.8";

function createRemote(records?: { level: number; message: string }[]): LynxRemote {
  return new LynxRemote(
    stubConnector(),
    records == null
      ? silentLogger
      : {
          log(record) {
            records.push({ level: record.level, message: record.message });
          },
        },
  );
}

test("LynxRemote prefers native-http over LynxFetchModule for streaming on Android", async () => {
  let usedNativeHttp = false;
  await withFakeLynxHost(
    {
      platform: "Android",
      emitter: { addListener() {} },
      nativeModules: {
        LynxFetchModule: {
          fetch() {
            throw new Error("LynxFetchModule must not win over httpFetch");
          },
        },
        NativePowerSyncModule: nativeWithHttp({
          httpFetch(_request, callback) {
            usedNativeHttp = true;
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
      const response = await createRemote().fetch({
        resource: STREAM_URL,
        request: { method: "POST", body: "{}" },
        expectStreamingResponse: true,
      });
      assert.equal(usedNativeHttp, true);
      assert.equal(response.status, 200);
    },
  );
});

test("LynxRemote skips lynx-fetch-module for streaming even on Android without httpFetch", async () => {
  let usedHostFetch = false;
  await withFakeLynxHost(
    {
      platform: "Android",
      nativeModules: {
        LynxFetchModule: {
          fetch() {
            throw new Error("LynxFetchModule must not be picked for streaming");
          },
        },
      },
      fetchImpl: async () => {
        usedHostFetch = true;
        return new Response(null, { status: 200 });
      },
    },
    async () => {
      await createRemote().fetch({
        resource: STREAM_URL,
        request: { method: "POST", body: "{}" },
        expectStreamingResponse: true,
      });
      assert.equal(usedHostFetch, true);
    },
  );
});

test("LynxRemote uses lynx-fetch-module for Android JSON without httpFetch", async () => {
  let usedLynxFetch = false;
  await withFakeLynxHost(
    {
      platform: "Android",
      nativeModules: {
        LynxFetchModule: {
          fetch(_req, onSuccess) {
            usedLynxFetch = true;
            onSuccess({
              status: 200,
              statusText: "OK",
              headers: { "content-type": "application/json" },
              body: '{"data":{"write_checkpoint":"7"}}',
            });
          },
        },
      },
    },
    async () => {
      const response = await createRemote().fetch({
        resource: CHECKPOINT_URL,
        request: { method: "GET" },
        expectStreamingResponse: false,
      });
      assert.equal(usedLynxFetch, true);
      assert.deepEqual(await response.json(), { data: { write_checkpoint: "7" } });
    },
  );
});

test("LynxRemote uses native-http for desktop streaming and JSON and skips LynxFetchModule", async () => {
  for (const platform of ["macOS", "Windows"]) {
    const urls: string[] = [];
    await withFakeLynxHost(
      {
        platform,
        emitter: { addListener() {} },
        nativeModules: {
          LynxFetchModule: {
            fetch() {
              throw new Error("LynxFetchModule must never be used on desktop");
            },
          },
          NativePowerSyncModule: nativeWithHttp({
            httpFetch(request, callback) {
              urls.push(request.url);
              if (request.url.includes("/sync/stream")) {
                callback({
                  ok: true,
                  status: 200,
                  streamingId: "NativePowerSyncHttpStream-desktop",
                  body: "",
                });
                return;
              }
              callback({ ok: true, status: 200, body: '{"data":{}}' });
            },
          }),
        },
        fetchImpl: async () => {
          throw new Error("host-fetch must not win over desktop native-http");
        },
      },
      async () => {
        const remote = createRemote();
        await remote.fetch({
          resource: STREAM_URL,
          request: { method: "POST", body: "{}" },
          expectStreamingResponse: true,
        });
        const json = await remote.fetch({
          resource: CHECKPOINT_URL,
          request: { method: "GET" },
          expectStreamingResponse: false,
        });
        assert.deepEqual(await json.json(), { data: {} });
        assert.deepEqual(urls, [STREAM_URL, CHECKPOINT_URL]);
      },
    );
  }
});

test("LynxRemote preserves host-fetch for iOS JSON while using native-http for iOS streaming", async () => {
  const calls: string[] = [];
  await withFakeLynxHost(
    {
      platform: "iOS",
      emitter: { addListener() {} },
      nativeModules: {
        NativePowerSyncModule: nativeWithHttp({
          httpFetch(_request, callback) {
            calls.push("native-http");
            callback({
              ok: true,
              status: 200,
              streamingId: "NativePowerSyncHttpStream-ios",
              body: "",
            });
          },
        }),
      },
      fetchImpl: async () => {
        calls.push("host-fetch");
        return new Response('{"data":{}}', { status: 200 });
      },
    },
    async () => {
      const remote = createRemote();
      await remote.fetch({
        resource: STREAM_URL,
        request: { method: "POST", body: "{}" },
        expectStreamingResponse: true,
      });
      const json = await remote.fetch({
        resource: CHECKPOINT_URL,
        request: { method: "GET" },
        expectStreamingResponse: false,
      });
      assert.deepEqual(await json.json(), { data: {} });
      assert.deepEqual(calls, ["native-http", "host-fetch"]);
    },
  );
});

test("LynxRemote uses host-fetch when no native HTTP module or only SQL RPC is registered", async () => {
  for (const state of [
    {},
    {
      emitter: { addListener() {} },
      nativeModules: { NativePowerSyncModule: nativeWithHttp({}) },
    },
  ]) {
    let usedHostFetch = false;
    await withFakeLynxHost(
      {
        ...state,
        fetchImpl: async () => {
          usedHostFetch = true;
          return new Response(null, { status: 200 });
        },
      },
      async () => {
        await createRemote().fetch({
          resource: STREAM_URL,
          request: { method: "POST", body: "{}" },
          expectStreamingResponse: true,
        });
        assert.equal(usedHostFetch, true);
      },
    );
  }
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
      await createRemote(records).fetch({
        resource: STREAM_URL,
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

test("LynxRemote rewrites BSON Accept to NDJSON and requests identity Accept-Encoding", async () => {
  let seenHeaders: Record<string, string> | undefined;
  await withFakeLynxHost(
    {
      nativeModules: {
        NativePowerSyncModule: nativeWithHttp({
          httpFetch(request, callback) {
            seenHeaders = request.headers;
            callback({
              ok: true,
              status: 200,
              body: '{"checkpoint":{"last_op_id":"1"}}\n',
              idleComplete: true,
            });
          },
        }),
      },
    },
    async () => {
      await createRemote().fetch({
        resource: STREAM_URL,
        request: { method: "POST", headers: { Accept: BSON_ACCEPT }, body: "{}" },
        expectStreamingResponse: true,
      });
    },
  );
  assert.equal(seenHeaders?.Accept, "application/x-ndjson");
  assert.equal(seenHeaders?.["Accept-Encoding"], "identity");
});

test("NativeHttpFetch handles idle-complete and streaming envelopes through LynxRemote.fetch", async () => {
  let call = 0;
  await withFakeLynxHost(
    {
      emitter: { addListener() {} },
      nativeModules: {
        NativePowerSyncModule: nativeWithHttp({
          httpFetch(_request, callback) {
            call += 1;
            if (call === 1) {
              callback({
                ok: true,
                status: 200,
                statusText: "OK",
                contentType: "application/x-ndjson",
                body: '{"checkpoint":{"last_op_id":"1"}}\n',
                idleComplete: true,
              });
              return;
            }
            callback({
              ok: true,
              status: 200,
              streamingId: "NativePowerSyncHttpStream-own",
              body: "",
            });
          },
        }),
      },
    },
    async () => {
      const remote = createRemote();
      const idle = await remote.fetch({
        resource: STREAM_URL,
        request: { method: "POST", body: "{}" },
        expectStreamingResponse: true,
      });
      assert.equal(idle.ok, true);
      assert.equal(idle.status, 200);
      assert.equal(idle.headers.get("content-type"), "application/x-ndjson");
      const idleFirst = await idle.body!.getReader().read();
      assert.equal(idleFirst.done, false);

      const streamed = await remote.fetch({
        resource: STREAM_URL,
        request: { method: "POST", body: "{}" },
        expectStreamingResponse: true,
      });
      assert.equal(streamed.ok, true);
      assert.equal(streamed.body != null, true);
    },
  );
});

test("LynxFetchModule maps JSON Responses, ignores lynxExtension.streamingId, and honors AbortSignal", async () => {
  let call = 0;
  await withFakeLynxHost(
    {
      platform: "Android",
      nativeModules: {
        LynxFetchModule: {
          fetch(_req, onSuccess) {
            call += 1;
            if (call === 1) {
              onSuccess({
                status: 200,
                statusText: "OK",
                headers: { "content-type": "application/json" },
                lynxExtension: { streamingId: "must-not-subscribe" },
              });
              return;
            }
            if (call === 2) {
              onSuccess({
                status: 200,
                body: '{"ok":1}\n',
              });
              return;
            }
            // Call 3: never settles — AbortSignal must reject immediately.
          },
        },
      },
    },
    async () => {
      const remote = createRemote();
      const ignoredStream = await remote.fetch({
        resource: CHECKPOINT_URL,
        request: { method: "GET" },
        expectStreamingResponse: false,
      });
      assert.equal(ignoredStream.ok, true);
      assert.equal(ignoredStream.status, 200);
      assert.equal(ignoredStream.headers.get("content-type"), "application/json");
      const empty = await ignoredStream.body!.getReader().read();
      assert.equal(empty.done, true);

      const buffered = await remote.fetch({
        resource: CHECKPOINT_URL,
        request: { method: "GET" },
        expectStreamingResponse: false,
      });
      const first = await buffered.body!.getReader().read();
      assert.equal(new TextDecoder().decode(first.value), '{"ok":1}\n');

      const preAborted = new AbortController();
      preAborted.abort();
      await assert.rejects(
        () =>
          remote.fetch({
            resource: CHECKPOINT_URL,
            request: { method: "GET", signal: preAborted.signal },
            expectStreamingResponse: false,
          }),
        { name: "AbortError" },
      );

      const inFlight = new AbortController();
      const pending = remote.fetch({
        resource: CHECKPOINT_URL,
        request: { method: "GET", signal: inFlight.signal },
        expectStreamingResponse: false,
      });
      inFlight.abort();
      await assert.rejects(() => pending, { name: "AbortError" });
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
      const response = await createRemote().fetch({
        resource: STREAM_URL,
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

test("syncStreamResponse accepts a caller-owned reader without GlobalEventEmitter", async () => {
  const reader = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ok":1}\n'));
      controller.close();
    },
  }).getReader();
  const response = syncStreamResponse({
    status: 200,
    statusText: "OK",
    headers: { "Content-Type": "application/x-ndjson" },
    reader,
  });
  assert.equal(response.ok, true);
  assert.equal(response.headers.get("content-type"), "application/x-ndjson");
  const first = await response.body!.getReader().read();
  assert.equal(first.done, false);
  assert.equal(new TextDecoder().decode(first.value), '{"ok":1}\n');
});

test("NativeHttpFetch cancels via httpFetchAbort once", async () => {
  const abortIds: string[] = [];
  await withFakeLynxHost(
    {
      emitter: { addListener() {} },
      nativeModules: {
        NativePowerSyncModule: nativeWithHttp({
          httpFetch(_request, callback) {
            callback({
              ok: true,
              status: 200,
              streamingId: "NativePowerSyncHttpStream-cancel-once",
              body: "",
            });
          },
          httpFetchAbort(streamId, callback) {
            abortIds.push(streamId);
            callback({ ok: true });
          },
        }),
      },
    },
    async () => {
      const response = await createRemote().fetch({
        resource: STREAM_URL,
        request: { method: "POST", body: "{}" },
        expectStreamingResponse: true,
      });
      const reader = response.body!.getReader();
      await reader.cancel();
      await reader.cancel();
      assert.deepEqual(abortIds, ["NativePowerSyncHttpStream-cancel-once"]);
    },
  );
});
