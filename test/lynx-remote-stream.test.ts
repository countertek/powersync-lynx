import assert from "node:assert/strict";
import { test } from "node:test";

import { isString } from "../src/type-guards.ts";
import { LynxRemote } from "../src/sync/LynxRemote.ts";
import { MAX_EARLY_EVENTS_PER_STREAM } from "../src/sync/transport/events.ts";
import type { LynxFetchSuccessPayload } from "../src/sync/transport/http-types.ts";
import type {
  NativeHttpFetchCallback,
  NativeHttpFetchEnvelope,
  NativeHttpFetchRequest,
} from "../src/sync/transport/http-types.ts";
import {
  assignNativeModules,
  chunkReader,
  createFakeEmitter,
  demoConnector,
  identifierResponse,
  hangResponse,
  lynxStreamingRequested,
  nativeWithHttp,
  runtimeFromEmitters,
  silentLogger,
  stubConnector,
  withFakeLynxHost,
} from "./remote-harness.ts";

test("LynxRemote.fetch returns a streaming Response before the body ends", async () => {
  let streamEnded = false;
  await withFakeLynxHost(
    {
      fetchImpl: async (_url, init) => {
        if (!lynxStreamingRequested(init)) {
          return hangResponse();
        }
        return identifierResponse({
          contentType: "application/x-ndjson",
          mockBody: {
            getReader() {
              let sent = false;
              return {
                async read() {
                  if (!sent) {
                    sent = true;
                    return { done: false, value: new TextEncoder().encode('{"checkpoint":1}\n') };
                  }
                  streamEnded = true;
                  return { done: true, value: undefined };
                },
                cancel() {
                  return Promise.resolve();
                },
                releaseLock() {},
              };
            },
          },
        });
      },
    },
    async () => {
      const remote = new LynxRemote(stubConnector(), silentLogger);
      const raced = await Promise.race([
        remote
          .fetch({
            resource: "http://127.0.0.1:8080/sync/stream",
            request: { method: "POST", body: "{}" },
            expectStreamingResponse: true,
          })
          .then((response) => response),
        new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), 80);
        }),
      ]);
      assert.ok(raced != null, "fetch() must return before the live /sync/stream body ends");
      assert.equal(raced.status, 200);
      assert.equal(streamEnded, false);
      const first = await raced.body!.getReader().read();
      assert.equal(first.done, false);
    },
  );
});

test("HostFetch does not subscribe to lynxExtension.streamingId when body is unusable", async () => {
  const { emitter, listeners } = createFakeEmitter();
  await withFakeLynxHost(
    {
      emitter,
      fetchImpl: async (_url, init) => {
        if (!lynxStreamingRequested(init)) {
          return hangResponse();
        }
        return identifierResponse({
          contentType: "application/x-ndjson",
          streamingId: "stream-ios",
          bodyUsedError: true,
        });
      },
    },
    async () => {
      const remote = new LynxRemote(stubConnector(), silentLogger);
      const response = await remote.fetch({
        resource: "http://127.0.0.1:8080/sync/stream",
        request: { method: "POST", body: "{}" },
        expectStreamingResponse: true,
      });
      assert.equal(listeners.has("stream-ios"), false);
      const first = await response.body!.getReader().read();
      assert.equal(first.done, true, "unusable Fetch body is empty bytes, not a named stream");
    },
  );
});

test("nativeHttpFetch gate accepts module without typeof===function on httpFetch", async () => {
  // PrimJS host methods often report typeof !== "function"; the old gate skipped httpFetch.
  const ndjson = '{"checkpoint":{"last_op_id":"1"}}\n';
  let invoked = false;
  function hostMethod(_request: NativeHttpFetchRequest, callback: NativeHttpFetchCallback): void {
    invoked = true;
    queueMicrotask(() => {
      callback({
        ok: true,
        status: 200,
        statusText: "OK",
        contentType: "application/x-ndjson",
        body: ndjson,
        idleComplete: true,
      });
    });
  }
  Object.defineProperty(hostMethod, Symbol.toStringTag, { value: "HostFunction" });
  await withFakeLynxHost(
    {
      platform: "Android",
      nativeModules: {
        LynxFetchModule: {
          fetch() {
            throw new Error("LynxFetchModule must not be used when httpFetch is present");
          },
        },
        NativePowerSyncModule: nativeWithHttp({
          httpFetch: hostMethod,
        }),
      },
    },
    async () => {
      const remote = new LynxRemote(stubConnector(), silentLogger);
      const response = await remote.fetch({
        resource: "http://10.0.2.2:8080/sync/stream",
        request: { method: "POST", body: "{}" },
        expectStreamingResponse: true,
      });
      assert.equal(invoked, true);
      const first = await response.body!.getReader().read();
      assert.equal(new TextDecoder().decode(first.value), ndjson);
    },
  );
});

test("LynxRemote.fetch applies NativePowerSyncModule.httpFetch UTF-8 body (device shape)", async () => {
  // Real LynxFetchModule drops large byte[] / customInfo; httpFetch returns strings only.
  const { emitter } = createFakeEmitter();
  const ndjson = '{"checkpoint":{"last_op_id":"1"}}\n{"data":{"bucket":"a","data":[]}}\n';
  let sawHttpFetch = false;
  let sawLynxFetch = false;
  await withFakeLynxHost(
    {
      platform: "Android",
      emitter,
      nativeModules: {
        LynxFetchModule: {
          fetch(
            _request: NativeHttpFetchRequest,
            resolve: (response: LynxFetchSuccessPayload) => void,
          ) {
            sawLynxFetch = true;
            queueMicrotask(() => resolve({ status: 500, body: new ArrayBuffer(0) }));
          },
        },
        NativePowerSyncModule: nativeWithHttp({
          httpFetch(
            request: { url?: string; body?: string },
            callback: (envelope: NativeHttpFetchEnvelope) => void,
          ) {
            sawHttpFetch = true;
            assert.ok(String(request.url).includes("/sync/stream"));
            assert.equal(isString(request.body), true);
            queueMicrotask(() => {
              callback({
                ok: true,
                status: 200,
                statusText: "OK",
                contentType: "application/x-ndjson",
                body: ndjson,
                bodyBase64: Buffer.from(ndjson, "utf8").toString("base64"),
                idleComplete: true,
              });
            });
          },
        }),
      },
    },
    async () => {
      const remote = new LynxRemote(stubConnector(), silentLogger);
      const response = await remote.fetch({
        resource: "http://10.0.2.2:8080/sync/stream",
        request: { method: "POST", body: "{}" },
        expectStreamingResponse: true,
      });
      assert.equal(sawHttpFetch, true);
      assert.equal(
        sawLynxFetch,
        false,
        "must not fall back to LynxFetchModule for Android streams",
      );
      assert.equal(response.ok, true);
      const reader = response.body!.getReader();
      const first = await reader.read();
      assert.equal(first.done, false);
      assert.equal(new TextDecoder().decode(first.value), ndjson);
      const second = await reader.read();
      assert.equal(second.done, true);
    },
  );
});

test("Android fetchStream applies httpFetch string NDJSON through PowerSync line split", async () => {
  const { emitter } = createFakeEmitter();
  const line = '{"checkpoint":{"last_op_id":"1"}}\n';
  await withFakeLynxHost(
    {
      platform: "Android",
      emitter,
      nativeModules: {
        NativePowerSyncModule: nativeWithHttp({
          httpFetch(
            _request: NativeHttpFetchRequest,
            callback: (envelope: NativeHttpFetchEnvelope) => void,
          ) {
            queueMicrotask(() => {
              callback({
                ok: true,
                status: 200,
                statusText: "OK",
                contentType: "application/x-ndjson",
                body: line,
                idleComplete: true,
              });
            });
          },
        }),
      },
    },
    async () => {
      const remote = new LynxRemote(demoConnector("http://10.0.2.2:8080"), silentLogger);
      const stream = await remote.fetchStream({
        path: "/sync/stream",
        data: {},
        abortSignal: new AbortController().signal,
      });
      const first = await stream.next();
      assert.equal(first.done, false);
      assert.deepEqual(JSON.parse(String(first.value)), { checkpoint: { last_op_id: "1" } });
    },
  );
});

test("iOS LynxRemote.fetch uses NativePowerSyncModule.httpFetch like Android", async () => {
  const ndjson = '{"checkpoint":{"last_op_id":"1"}}\n';
  let sawHttpFetch = false;
  await withFakeLynxHost(
    {
      platform: "iOS",
      fetchImpl: async () => {
        throw new Error("identifier fetch must not run when httpFetch is present");
      },
      nativeModules: {
        NativePowerSyncModule: nativeWithHttp({
          httpFetch(
            request: { url?: string },
            callback: (envelope: NativeHttpFetchEnvelope) => void,
          ) {
            sawHttpFetch = true;
            assert.ok(String(request.url).includes("/sync/stream"));
            queueMicrotask(() => {
              callback({
                ok: true,
                status: 200,
                statusText: "OK",
                contentType: "application/x-ndjson",
                body: ndjson,
                bodyBase64: Buffer.from(ndjson, "utf8").toString("base64"),
                idleComplete: true,
              });
            });
          },
        }),
      },
    },
    async () => {
      const remote = new LynxRemote(stubConnector(), silentLogger);
      const response = await remote.fetch({
        resource: "http://127.0.0.1:8080/sync/stream",
        request: { method: "POST", body: "{}" },
        expectStreamingResponse: true,
      });
      assert.equal(sawHttpFetch, true);
      assert.equal(response.ok, true);
      const first = await response.body!.getReader().read();
      assert.equal(new TextDecoder().decode(first.value), ndjson);
    },
  );
});

test("httpFetch incremental streamingId applies onData chunks before onEnd", async () => {
  // Device path: one-shot Callback returns streamingId; chunks are UTF-8 strings on GlobalEventEmitter.
  const { emitter, listeners } = createFakeEmitter();
  const chunk1 = '{"checkpoint":{"last_op_id":"1"}}\n';
  const chunk2 = '{"data":{"bucket":"a","data":[]}}\n';
  let aborted: string | undefined;
  await withFakeLynxHost(
    {
      platform: "Android",
      emitter,
      nativeModules: {
        NativePowerSyncModule: nativeWithHttp({
          httpFetch(
            _request: NativeHttpFetchRequest,
            callback: (envelope: NativeHttpFetchEnvelope) => void,
          ) {
            const streamingId = "NativePowerSyncHttpStream0";
            queueMicrotask(() => {
              callback({
                ok: true,
                status: 200,
                statusText: "OK",
                contentType: "application/x-ndjson",
                body: "",
                streamingId,
                idleComplete: false,
              });
              queueMicrotask(() => {
                for (const fn of listeners.get(streamingId) ?? []) {
                  fn({ event: "onData", data: chunk1 });
                }
                queueMicrotask(() => {
                  for (const fn of listeners.get(streamingId) ?? []) {
                    fn({ event: "onData", data: chunk2 });
                  }
                  queueMicrotask(() => {
                    for (const fn of listeners.get(streamingId) ?? []) {
                      fn({ event: "onEnd" });
                    }
                  });
                });
              });
            });
          },
          httpFetchAbort(streamId: string, callback: (envelope: NativeHttpFetchEnvelope) => void) {
            aborted = streamId;
            callback({ ok: true });
          },
        }),
      },
    },
    async () => {
      const remote = new LynxRemote(stubConnector(), silentLogger);
      const response = await remote.fetch({
        resource: "http://10.0.2.2:8080/sync/stream",
        request: { method: "POST", body: "{}" },
        expectStreamingResponse: true,
      });
      assert.equal(response.ok, true);
      const reader = response.body!.getReader();
      const first = await reader.read();
      assert.equal(first.done, false);
      assert.equal(new TextDecoder().decode(first.value), chunk1);
      const second = await reader.read();
      assert.equal(second.done, false);
      assert.equal(new TextDecoder().decode(second.value), chunk2);
      const third = await reader.read();
      assert.equal(third.done, true);
      assert.equal(aborted, undefined);
    },
  );
});

test("httpFetchAbort runs when the streaming reader is cancelled after the first chunk", async () => {
  const { emitter, listeners } = createFakeEmitter();
  const streamingId = "NativePowerSyncHttpStream-abort";
  const abortIds: string[] = [];
  await withFakeLynxHost(
    {
      platform: "Android",
      emitter,
      nativeModules: {
        NativePowerSyncModule: nativeWithHttp({
          httpFetch(_request, callback) {
            queueMicrotask(() => {
              callback({
                ok: true,
                status: 200,
                statusText: "OK",
                contentType: "application/x-ndjson",
                body: "",
                streamingId,
                idleComplete: false,
              });
              queueMicrotask(() => {
                for (const fn of listeners.get(streamingId) ?? []) {
                  fn({ event: "onData", data: '{"checkpoint":{"last_op_id":"1"}}\n' });
                }
              });
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
      const remote = new LynxRemote(stubConnector(), silentLogger);
      const response = await remote.fetch({
        resource: "http://10.0.2.2:8080/sync/stream",
        request: { method: "POST", body: "{}" },
        expectStreamingResponse: true,
      });
      const reader = response.body!.getReader();
      const first = await reader.read();
      assert.equal(first.done, false);
      await reader.cancel();
      assert.deepEqual(abortIds, [streamingId]);
    },
  );
});

test("httpFetchAbort runs when fetchStream is aborted after the first chunk", async () => {
  const { emitter, listeners } = createFakeEmitter();
  const streamingId = "NativePowerSyncHttpStream-fetchStream-abort";
  const abortIds: string[] = [];
  await withFakeLynxHost(
    {
      platform: "iOS",
      emitter,
      nativeModules: {
        NativePowerSyncModule: nativeWithHttp({
          httpFetch(_request, callback) {
            queueMicrotask(() => {
              callback({
                ok: true,
                status: 200,
                contentType: "application/x-ndjson",
                body: "",
                streamingId,
                idleComplete: false,
              });
              queueMicrotask(() => {
                for (const fn of listeners.get(streamingId) ?? []) {
                  fn([{ event: "onData", data: '{"checkpoint":{"last_op_id":"9"}}\n' }]);
                }
              });
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
      const remote = new LynxRemote(demoConnector("http://127.0.0.1:8080"), silentLogger);
      const controller = new AbortController();
      const stream = await remote.fetchStream({
        path: "/sync/stream",
        data: {},
        abortSignal: controller.signal,
      });
      const first = await Promise.race([
        stream.next(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
      ]);
      assert.equal(first.done, false);
      controller.abort();
      const deadline = Date.now() + 500;
      while (abortIds.length === 0 && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(abortIds.length >= 1, "httpFetchAbort must run after fetchStream abort");
      assert.ok(abortIds.every((id) => id === streamingId));
    },
  );
});

test("second streaming reader does not replay already-consumed chunks", async () => {
  const { emitter } = createFakeEmitter();
  const streamingId = "NativePowerSyncHttpStream-replay";
  await withFakeLynxHost(
    {
      platform: "Android",
      emitter,
      nativeModules: {
        NativePowerSyncModule: nativeWithHttp({
          httpFetch(_request, callback) {
            queueMicrotask(() => {
              callback({
                ok: true,
                status: 200,
                statusText: "OK",
                contentType: "application/x-ndjson",
                body: "",
                streamingId,
                idleComplete: false,
              });
            });
          },
        }),
      },
    },
    async () => {
      const remote = new LynxRemote(stubConnector(), silentLogger);
      const firstResponse = await remote.fetch({
        resource: "http://10.0.2.2:8080/sync/stream",
        request: { method: "POST", body: "{}" },
        expectStreamingResponse: true,
      });
      const firstReader = firstResponse.body!.getReader();
      emitter.emit?.(streamingId, { event: "onData", data: "chunk-1\n" });
      const first = await firstReader.read();
      assert.equal(new TextDecoder().decode(first.value), "chunk-1\n");
      emitter.emit?.(streamingId, { event: "onEnd" });
      const ended = await firstReader.read();
      assert.equal(ended.done, true);

      const secondResponse = await remote.fetch({
        resource: "http://10.0.2.2:8080/sync/stream",
        request: { method: "POST", body: "{}" },
        expectStreamingResponse: true,
      });
      const secondReader = secondResponse.body!.getReader();
      const pending = secondReader.read();
      const raced = await Promise.race([
        pending.then((result) => ({ kind: "read" as const, result })),
        new Promise<{ kind: "timeout" }>((resolve) => {
          setTimeout(() => resolve({ kind: "timeout" }), 50);
        }),
      ]);
      assert.equal(raced.kind, "timeout", "second reader must not replay chunk-1");
      emitter.emit?.(streamingId, { event: "onData", data: "chunk-2\n" });
      const next = await pending;
      assert.equal(next.done, false);
      assert.equal(new TextDecoder().decode(next.value), "chunk-2\n");
      await secondReader.cancel();
    },
  );
});

test("early-event buffer overflow fails the reader instead of hanging", async () => {
  const { emitter } = createFakeEmitter();
  const streamingId = "NativePowerSyncHttpStream-overflow";
  await withFakeLynxHost(
    {
      platform: "Android",
      emitter,
      nativeModules: {
        NativePowerSyncModule: nativeWithHttp({
          httpFetch(_request, callback) {
            for (let i = 0; i < MAX_EARLY_EVENTS_PER_STREAM + 1; i++) {
              emitter.emit?.(streamingId, { event: "onData", data: `line-${i}\n` });
            }
            emitter.emit?.(streamingId, { event: "onEnd" });
            callback({
              ok: true,
              status: 200,
              statusText: "OK",
              contentType: "application/x-ndjson",
              body: "",
              streamingId,
              idleComplete: false,
            });
          },
        }),
      },
    },
    async () => {
      const remote = new LynxRemote(stubConnector(), silentLogger);
      const response = await remote.fetch({
        resource: "http://10.0.2.2:8080/sync/stream",
        request: { method: "POST", body: "{}" },
        expectStreamingResponse: true,
      });
      const reader = response.body!.getReader();
      await assert.rejects(
        () =>
          Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error("reader hung after early-event overflow")), 200);
            }),
          ]),
        /overflow/,
      );
    },
  );
});

test("overflow then cancel does not let delayed terminals pollute a later reader", async () => {
  const { emitter } = createFakeEmitter();
  const streamingId = "NativePowerSyncHttpStream-overflow-late";
  const abortIds: string[] = [];
  await withFakeLynxHost(
    {
      platform: "Android",
      emitter,
      nativeModules: {
        NativePowerSyncModule: nativeWithHttp({
          httpFetch(_request, callback) {
            for (let i = 0; i < MAX_EARLY_EVENTS_PER_STREAM + 1; i++) {
              emitter.emit?.(streamingId, { event: "onData", data: `line-${i}\n` });
            }
            callback({
              ok: true,
              status: 200,
              statusText: "OK",
              contentType: "application/x-ndjson",
              body: "",
              streamingId,
              idleComplete: false,
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
      const remote = new LynxRemote(stubConnector(), silentLogger);
      const firstResponse = await remote.fetch({
        resource: "http://10.0.2.2:8080/sync/stream",
        request: { method: "POST", body: "{}" },
        expectStreamingResponse: true,
      });
      const firstReader = firstResponse.body!.getReader();
      await assert.rejects(() => firstReader.read(), /overflow/);
      await firstReader.cancel();
      assert.deepEqual(abortIds, [streamingId]);
      emitter.emit?.(streamingId, { event: "onError", error: "aborted" });
      emitter.emit?.(streamingId, { event: "onEnd" });

      const secondResponse = await remote.fetch({
        resource: "http://10.0.2.2:8080/sync/stream",
        request: { method: "POST", body: "{}" },
        expectStreamingResponse: true,
      });
      const secondReader = secondResponse.body!.getReader();
      const pending = secondReader.read();
      const raced = await Promise.race([
        pending.then(
          (result) => ({ kind: "read" as const, result }),
          () => ({ kind: "error" as const }),
        ),
        new Promise<{ kind: "timeout" }>((resolve) => {
          setTimeout(() => resolve({ kind: "timeout" }), 50);
        }),
      ]);
      assert.equal(raced.kind, "timeout", "stale overflow/abort terminals must not replay");
      emitter.emit?.(streamingId, { event: "onData", data: "chunk-2\n" });
      const next = await pending;
      assert.equal(next.done, false);
      assert.equal(new TextDecoder().decode(next.value), "chunk-2\n");
      await secondReader.cancel();
    },
  );
});

test("buffered onEnd on one of two emitters does not accept late data on the other", async () => {
  const { emitter: emitterA } = createFakeEmitter();
  const { emitter: emitterB } = createFakeEmitter();
  const streamingId = "NativePowerSyncHttpStream-two-emitters-end";
  await withFakeLynxHost(
    {
      platform: "Android",
      runtime: runtimeFromEmitters(emitterA, emitterB),
      nativeModules: {
        NativePowerSyncModule: nativeWithHttp({
          httpFetch(_request, callback) {
            emitterA.emit?.(streamingId, { event: "onEnd" });
            callback({
              ok: true,
              status: 200,
              statusText: "OK",
              contentType: "application/x-ndjson",
              body: "",
              streamingId,
              idleComplete: false,
            });
          },
          httpFetchAbort(_streamId, callback) {
            callback({ ok: true });
          },
        }),
      },
    },
    async () => {
      const remote = new LynxRemote(stubConnector(), silentLogger);
      const response = await remote.fetch({
        resource: "http://10.0.2.2:8080/sync/stream",
        request: { method: "POST", body: "{}" },
        expectStreamingResponse: true,
      });
      const reader = response.body!.getReader();
      const first = await reader.read();
      assert.equal(first.done, true);
      await reader.cancel();
      emitterB.emit?.(streamingId, { event: "onData", data: "late\n" });
      const next = await reader.read();
      assert.equal(
        next.done,
        true,
        "late onData on the second emitter must not reopen a finished reader",
      );
    },
  );
});

test("overflow on one of two emitters does not keep a handler on the other", async () => {
  const { emitter: emitterA } = createFakeEmitter();
  const { emitter: emitterB } = createFakeEmitter();
  const streamingId = "NativePowerSyncHttpStream-two-emitters-overflow";
  const abortIds: string[] = [];
  await withFakeLynxHost(
    {
      platform: "Android",
      runtime: runtimeFromEmitters(emitterA, emitterB),
      nativeModules: {
        NativePowerSyncModule: nativeWithHttp({
          httpFetch(_request, callback) {
            for (let i = 0; i < MAX_EARLY_EVENTS_PER_STREAM + 1; i++) {
              emitterA.emit?.(streamingId, { event: "onData", data: `line-${i}\n` });
            }
            callback({
              ok: true,
              status: 200,
              statusText: "OK",
              contentType: "application/x-ndjson",
              body: "",
              streamingId,
              idleComplete: false,
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
      const remote = new LynxRemote(stubConnector(), silentLogger);
      const firstResponse = await remote.fetch({
        resource: "http://10.0.2.2:8080/sync/stream",
        request: { method: "POST", body: "{}" },
        expectStreamingResponse: true,
      });
      const firstReader = firstResponse.body!.getReader();
      await assert.rejects(
        () =>
          Promise.race([
            firstReader.read(),
            new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error("reader hung after two-emitter overflow")), 200);
            }),
          ]),
        /overflow/,
      );
      await firstReader.cancel();
      assert.deepEqual(abortIds, [streamingId]);
      emitterB.emit?.(streamingId, { event: "onData", data: "late\n" });
      emitterB.emit?.(streamingId, { event: "onError", error: "aborted" });
      emitterB.emit?.(streamingId, { event: "onEnd" });
      await assert.rejects(() => firstReader.read(), /overflow/);

      const secondResponse = await remote.fetch({
        resource: "http://10.0.2.2:8080/sync/stream",
        request: { method: "POST", body: "{}" },
        expectStreamingResponse: true,
      });
      const secondReader = secondResponse.body!.getReader();
      const pending = secondReader.read();
      const raced = await Promise.race([
        pending.then(
          (result) => ({ kind: "read" as const, result }),
          () => ({ kind: "error" as const }),
        ),
        new Promise<{ kind: "timeout" }>((resolve) => {
          setTimeout(() => resolve({ kind: "timeout" }), 50);
        }),
      ]);
      assert.equal(
        raced.kind,
        "timeout",
        "stale overflow terminals on the second emitter must not replay",
      );
      emitterB.emit?.(streamingId, { event: "onData", data: "chunk-2\n" });
      const next = await pending;
      assert.equal(next.done, false);
      assert.equal(new TextDecoder().decode(next.value), "chunk-2\n");
      await secondReader.cancel();
    },
  );
});

test("cancelled stream late onError/onEnd does not pollute a later reader", async () => {
  const { emitter } = createFakeEmitter();
  const streamingId = "NativePowerSyncHttpStream-late-cancel";
  await withFakeLynxHost(
    {
      platform: "Android",
      emitter,
      nativeModules: {
        NativePowerSyncModule: nativeWithHttp({
          httpFetch(_request, callback) {
            queueMicrotask(() => {
              callback({
                ok: true,
                status: 200,
                statusText: "OK",
                contentType: "application/x-ndjson",
                body: "",
                streamingId,
                idleComplete: false,
              });
            });
          },
          httpFetchAbort(_streamId, callback) {
            callback({ ok: true });
          },
        }),
      },
    },
    async () => {
      const remote = new LynxRemote(stubConnector(), silentLogger);
      const firstResponse = await remote.fetch({
        resource: "http://10.0.2.2:8080/sync/stream",
        request: { method: "POST", body: "{}" },
        expectStreamingResponse: true,
      });
      const firstReader = firstResponse.body!.getReader();
      emitter.emit?.(streamingId, { event: "onData", data: "chunk-1\n" });
      const first = await firstReader.read();
      assert.equal(new TextDecoder().decode(first.value), "chunk-1\n");
      await firstReader.cancel();
      emitter.emit?.(streamingId, { event: "onError", error: "aborted" });
      emitter.emit?.(streamingId, { event: "onEnd" });

      const secondResponse = await remote.fetch({
        resource: "http://10.0.2.2:8080/sync/stream",
        request: { method: "POST", body: "{}" },
        expectStreamingResponse: true,
      });
      const secondReader = secondResponse.body!.getReader();
      const pending = secondReader.read();
      const raced = await Promise.race([
        pending.then(
          (result) => ({ kind: "read" as const, result }),
          () => ({ kind: "error" as const }),
        ),
        new Promise<{ kind: "timeout" }>((resolve) => {
          setTimeout(() => resolve({ kind: "timeout" }), 50);
        }),
      ]);
      assert.equal(raced.kind, "timeout", "late aborted onError/onEnd must not replay");
      emitter.emit?.(streamingId, { event: "onData", data: "chunk-2\n" });
      const next = await pending;
      assert.equal(next.done, false);
      assert.equal(new TextDecoder().decode(next.value), "chunk-2\n");
      await secondReader.cancel();
    },
  );
});

test("pre-aborted httpFetch signal does not start a native request", async () => {
  let fetches = 0;
  await withFakeLynxHost(
    {
      platform: "iOS",
      nativeModules: {
        NativePowerSyncModule: nativeWithHttp({
          httpFetch() {
            fetches += 1;
          },
        }),
      },
    },
    async () => {
      const remote = new LynxRemote(stubConnector(), silentLogger);
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        () =>
          remote.fetch({
            resource: "http://127.0.0.1:8080/sync/stream",
            request: { method: "POST", body: "{}", signal: controller.signal },
            expectStreamingResponse: true,
          }),
        /Aborted/,
      );
      assert.equal(fetches, 0);
    },
  );
});

test("httpFetch streamingId onError then onEnd fails the reader", async () => {
  const { emitter, listeners } = createFakeEmitter();
  await withFakeLynxHost(
    {
      platform: "iOS",
      emitter,
      nativeModules: {
        NativePowerSyncModule: nativeWithHttp({
          httpFetch(_request, callback) {
            const streamingId = "NativePowerSyncHttpStream-err";
            queueMicrotask(() => {
              callback({
                ok: true,
                status: 200,
                statusText: "OK",
                contentType: "application/x-ndjson",
                body: "",
                streamingId,
                idleComplete: false,
              });
              queueMicrotask(() => {
                for (const fn of listeners.get(streamingId) ?? []) {
                  fn({ event: "onError", error: "stream reset" });
                }
                for (const fn of listeners.get(streamingId) ?? []) {
                  fn({ event: "onEnd" });
                }
              });
            });
          },
        }),
      },
    },
    async () => {
      const remote = new LynxRemote(stubConnector(), silentLogger);
      const response = await remote.fetch({
        resource: "http://127.0.0.1:8080/sync/stream",
        request: { method: "POST", body: "{}" },
        expectStreamingResponse: true,
      });
      const reader = response.body!.getReader();
      await assert.rejects(() => reader.read(), /stream reset/);
    },
  );
});

test("httpFetch incremental fetchStream yields NDJSON lines as chunks arrive", async () => {
  const { emitter, listeners } = createFakeEmitter();
  await withFakeLynxHost(
    {
      platform: "iOS",
      emitter,
      nativeModules: {
        NativePowerSyncModule: nativeWithHttp({
          httpFetch(
            _request: NativeHttpFetchRequest,
            callback: (envelope: NativeHttpFetchEnvelope) => void,
          ) {
            const streamingId = "NativePowerSyncHttpStream7";
            queueMicrotask(() => {
              callback({
                ok: true,
                status: 200,
                contentType: "application/x-ndjson",
                body: "",
                streamingId,
                idleComplete: false,
              });
              queueMicrotask(() => {
                for (const fn of listeners.get(streamingId) ?? []) {
                  // Array shape matches native sendGlobalEvent(name, [map]).
                  fn([{ event: "onData", data: '{"checkpoint":{"last_op_id":"9"}}\n' }]);
                }
              });
            });
          },
        }),
      },
    },
    async () => {
      const remote = new LynxRemote(demoConnector("http://127.0.0.1:8080"), silentLogger);
      const stream = await remote.fetchStream({
        path: "/sync/stream",
        data: {},
        abortSignal: new AbortController().signal,
      });
      const first = await Promise.race([
        stream.next(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
      ]);
      assert.equal(first.done, false);
      assert.deepEqual(JSON.parse(String(first.value)), { checkpoint: { last_op_id: "9" } });
    },
  );
});

test("streaming Response body can be inspected then getReader() without body used", async () => {
  await withFakeLynxHost(
    {
      fetchImpl: async () => {
        const chunk = new TextEncoder().encode("ok\n");
        return identifierResponse({
          contentType: "application/x-ndjson",
          inspectOnce: true,
          mockBody: {
            getReader() {
              let sent = false;
              return {
                async read() {
                  if (!sent) {
                    sent = true;
                    return { done: false, value: chunk };
                  }
                  return { done: true, value: undefined };
                },
                cancel() {
                  return Promise.resolve();
                },
                releaseLock() {},
              };
            },
          },
        });
      },
    },
    async () => {
      const remote = new LynxRemote(stubConnector(), silentLogger);
      const response = await remote.fetch({
        resource: "http://127.0.0.1:8080/sync/stream",
        request: { method: "POST", body: "{}" },
        expectStreamingResponse: true,
      });
      assert.equal(Boolean(response.body), true);
      const first = await response.body!.getReader().read();
      assert.equal(first.done, false);
      assert.deepEqual(first.value, new TextEncoder().encode("ok\n"));
    },
  );
});

const BSON_STREAM = "application/vnd.powersync.bson-stream";
const NDJSON_LINE = '{"checkpoint":{"last_op_id":"1"}}\n';
/** Real /sync/stream BSON contains 0x0A; NDJSON-splitting it yields unparseable lines. */
const BSON_WITH_NEWLINE = new Uint8Array([0xe9, 0x00, 0x00, 0x00, 0x0a, 0x03, 0x63, 0x6b]);

function headerAccept(headers: HeadersInit | undefined): string {
  if (headers == null || Array.isArray(headers)) {
    return "";
  }
  if (headers instanceof Headers) {
    return headers.get("accept") ?? headers.get("Accept") ?? "";
  }
  return String(headers.accept ?? headers.Accept ?? "");
}

function serviceFaithfulBody(accept: string): Uint8Array {
  if (accept.includes(BSON_STREAM)) {
    return BSON_WITH_NEWLINE;
  }
  return new TextEncoder().encode(NDJSON_LINE);
}

test("fetchStream yields JSON checkpoint lines when the service honors Accept", async () => {
  await withFakeLynxHost(
    {
      fetchImpl: async (_url, init) => {
        const body = serviceFaithfulBody(headerAccept(init?.headers));
        return identifierResponse({
          mockBody: chunkReader([body]),
        });
      },
    },
    async () => {
      const remote = new LynxRemote(demoConnector("http://127.0.0.1:8080"), silentLogger);
      const stream = await remote.fetchStream({
        path: "/sync/stream",
        data: {},
        abortSignal: new AbortController().signal,
      });
      const first = await stream.next();
      assert.equal(first.done, false);
      assert.equal(isString(first.value), true);
      assert.deepEqual(JSON.parse(String(first.value)), { checkpoint: { last_op_id: "1" } });
    },
  );
});

test("HostFetch fetchStream uses Response.body and ignores lynxExtension.streamingId", async () => {
  const { emitter } = createFakeEmitter();
  await withFakeLynxHost(
    {
      emitter,
      fetchImpl: async (_url, init) => {
        if (!lynxStreamingRequested(init)) {
          return hangResponse();
        }
        return identifierResponse({
          contentType: "application/x-ndjson",
          streamingId: "must-not-subscribe",
          mockBody: chunkReader([new TextEncoder().encode(NDJSON_LINE)]),
        });
      },
    },
    async () => {
      const remote = new LynxRemote(demoConnector("http://127.0.0.1:8080"), silentLogger);
      const stream = await remote.fetchStream({
        path: "/sync/stream",
        data: {},
        abortSignal: new AbortController().signal,
      });
      emitter.emit?.("must-not-subscribe", { event: "onData", data: "from-events\n" });
      const first = await stream.next();
      assert.equal(first.done, false);
      assert.deepEqual(JSON.parse(String(first.value)), { checkpoint: { last_op_id: "1" } });
    },
  );
});

const WRITE_CHECKPOINT_JSON = '{"data":{"write_checkpoint":"12"}}';
/** gzip of WRITE_CHECKPOINT_JSON — what OkHttp may hand JS without Accept-Encoding: identity. */
const WRITE_CHECKPOINT_GZIP = new Uint8Array([
  31, 139, 8, 0, 0, 0, 0, 0, 0, 19, 171, 86, 74, 73, 44, 73, 84, 178, 170, 86, 42, 47, 202, 44, 73,
  141, 79, 206, 72, 77, 206, 46, 200, 207, 204, 43, 81, 178, 82, 50, 52, 82, 170, 173, 5, 0, 217,
  204, 34, 231, 34, 0, 0, 0,
]);

function requestAcceptEncoding(headers: Record<string, string> | undefined): string {
  if (headers == null) {
    return "";
  }
  return String(headers["accept-encoding"] ?? headers["Accept-Encoding"] ?? "");
}

test("Android write-checkpoint json() parses when native would otherwise return gzip", async () => {
  const previousLynx = globalThis.lynx;
  const previousModules = globalThis.NativeModules;
  const previousInfo = globalThis.SystemInfo;
  globalThis.SystemInfo = { platform: "Android" };
  globalThis.lynx = {
    getJSModule() {
      return { addListener() {} };
    },
  };
  assignNativeModules({
    LynxFetchModule: {
      fetch(
        request: { headers?: Record<string, string> },
        resolve: (response: LynxFetchSuccessPayload) => void,
      ) {
        const identity = requestAcceptEncoding(request.headers).toLowerCase().includes("identity");
        queueMicrotask(() => {
          resolve({
            status: 200,
            statusText: "OK",
            body: identity ? WRITE_CHECKPOINT_JSON : WRITE_CHECKPOINT_GZIP,
          });
        });
      },
    },
  });
  try {
    const remote = new LynxRemote(demoConnector("http://127.0.0.1:8080"), silentLogger);
    const decoded = await remote.fetchAndDecodeJson({
      path: "/write-checkpoint2.json?client_id=1",
    });
    assert.deepEqual(decoded, { data: { write_checkpoint: "12" } });
  } finally {
    globalThis.lynx = previousLynx;
    globalThis.NativeModules = previousModules;
    globalThis.SystemInfo = previousInfo;
  }
});

test("Android write-checkpoint json() parses gzip even when identity was requested", async () => {
  const previousLynx = globalThis.lynx;
  const previousModules = globalThis.NativeModules;
  const previousInfo = globalThis.SystemInfo;
  globalThis.SystemInfo = { platform: "Android" };
  globalThis.lynx = {
    getJSModule() {
      return { addListener() {} };
    },
  };
  assignNativeModules({
    LynxFetchModule: {
      fetch(
        _request: { headers?: Record<string, string> },
        resolve: (response: LynxFetchSuccessPayload) => void,
      ) {
        queueMicrotask(() => {
          resolve({
            status: 200,
            statusText: "OK",
            body: WRITE_CHECKPOINT_GZIP,
          });
        });
      },
    },
  });
  try {
    const remote = new LynxRemote(demoConnector("http://127.0.0.1:8080"), silentLogger);
    const decoded = await remote.fetchAndDecodeJson({
      path: "/write-checkpoint2.json?client_id=1",
    });
    assert.deepEqual(decoded, { data: { write_checkpoint: "12" } });
  } finally {
    globalThis.lynx = previousLynx;
    globalThis.NativeModules = previousModules;
    globalThis.SystemInfo = previousInfo;
  }
});

test("host-fetch fetchStream applies NDJSON body when GlobalEventEmitter is present", async () => {
  // Lynx-for-Web: SQL NativePowerSyncModule has no httpFetch; lynx-bg still has
  // GlobalEventEmitter. Discarding Response.body for that emitter is the A↔B
  // download regression. Native streamingId remains a separate path (see
  // "httpFetch incremental streamingId applies onData chunks before onEnd").
  const { emitter } = createFakeEmitter();
  await withFakeLynxHost(
    {
      emitter,
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
      fetchImpl: async (_url, init) => {
        if (!lynxStreamingRequested(init)) {
          return hangResponse();
        }
        return identifierResponse({
          contentType: "application/x-ndjson",
          mockBody: chunkReader([new TextEncoder().encode(NDJSON_LINE)]),
        });
      },
    },
    async () => {
      const remote = new LynxRemote(demoConnector("http://127.0.0.1:8080"), silentLogger);
      const stream = await remote.fetchStream({
        path: "/sync/stream",
        data: {},
        abortSignal: new AbortController().signal,
      });
      const first = await Promise.race([
        stream.next(),
        new Promise<{ done: true; value: undefined }>((resolve) => {
          setTimeout(() => resolve({ done: true, value: undefined }), 80);
        }),
      ]);
      assert.equal(
        first.done,
        false,
        "Lynx-for-Web host-fetch must apply Response.body, not wait on GlobalEventEmitter",
      );
      assert.deepEqual(JSON.parse(String(first.value)), { checkpoint: { last_op_id: "1" } });
    },
  );
});

function gzipAsBinaryString(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) {
    text += String.fromCharCode(byte);
  }
  return text;
}

test("identifier write-checkpoint json() parses when touching body would yield undefined", async () => {
  const previousFetch = globalThis.fetch;
  const previousInfo = globalThis.SystemInfo;
  globalThis.SystemInfo = { platform: "iOS" };
  globalThis.fetch = async () => {
    let bodyTouched = false;
    const response = identifierResponse({
      contentType: "application/json",
      inspectOnce: true,
      mockBody: chunkReader([]),
      text: async () => {
        if (bodyTouched) {
          return "undefined";
        }
        return WRITE_CHECKPOINT_JSON;
      },
    });
    Object.defineProperty(response, "body", {
      configurable: true,
      get() {
        bodyTouched = true;
        return chunkReader([]);
      },
    });
    Object.defineProperty(response, "json", {
      value: async () => JSON.parse(bodyTouched ? "undefined" : WRITE_CHECKPOINT_JSON),
    });
    return response;
  };
  try {
    const remote = new LynxRemote(demoConnector("http://127.0.0.1:8080"), silentLogger);
    const decoded = await remote.fetchAndDecodeJson({
      path: "/write-checkpoint2.json?client_id=1",
    });
    assert.deepEqual(decoded, { data: { write_checkpoint: "12" } });
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.SystemInfo = previousInfo;
  }
});

test("Android write-checkpoint json() parses gzip delivered as a binary string", async () => {
  const previousLynx = globalThis.lynx;
  const previousModules = globalThis.NativeModules;
  const previousInfo = globalThis.SystemInfo;
  globalThis.SystemInfo = { platform: "Android" };
  globalThis.lynx = {
    getJSModule() {
      return { addListener() {} };
    },
  };
  assignNativeModules({
    LynxFetchModule: {
      fetch(
        _request: { headers?: Record<string, string> },
        resolve: (response: LynxFetchSuccessPayload) => void,
      ) {
        queueMicrotask(() => {
          resolve({
            status: 200,
            statusText: "OK",
            body: gzipAsBinaryString(WRITE_CHECKPOINT_GZIP),
          });
        });
      },
    },
  });
  try {
    const remote = new LynxRemote(demoConnector("http://127.0.0.1:8080"), silentLogger);
    const decoded = await remote.fetchAndDecodeJson({
      path: "/write-checkpoint2.json?client_id=1",
    });
    assert.deepEqual(decoded, { data: { write_checkpoint: "12" } });
  } finally {
    globalThis.lynx = previousLynx;
    globalThis.NativeModules = previousModules;
    globalThis.SystemInfo = previousInfo;
  }
});

test("Android LynxFetchModule JSON fetch exposes json() for checkpoint-request", async () => {
  const previousLynx = globalThis.lynx;
  const previousModules = globalThis.NativeModules;
  const previousInfo = globalThis.SystemInfo;
  globalThis.SystemInfo = { platform: "Android" };
  globalThis.lynx = {
    getJSModule() {
      return { addListener() {} };
    },
  };
  assignNativeModules({
    LynxFetchModule: {
      fetch(
        _request: NativeHttpFetchRequest,
        resolve: (response: LynxFetchSuccessPayload) => void,
      ) {
        queueMicrotask(() => {
          resolve({
            status: 200,
            statusText: "OK",
            body: '{"data":{"checkpoint_request_id":"ck1"}}',
          });
        });
      },
    },
  });
  try {
    const remote = new LynxRemote(demoConnector("http://127.0.0.1:8080"), silentLogger);
    const decoded = await remote.fetchAndDecodeJson({
      path: "/sync/checkpoint-request",
      method: "POST",
      body: "{}",
    });
    assert.deepEqual(decoded, { data: { checkpoint_request_id: "ck1" } });
  } finally {
    globalThis.lynx = previousLynx;
    globalThis.NativeModules = previousModules;
    globalThis.SystemInfo = previousInfo;
  }
});
