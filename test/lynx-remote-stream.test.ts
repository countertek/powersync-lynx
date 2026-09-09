import assert from "node:assert/strict";
import { test } from "node:test";

import { isString } from "../src/type-guards.ts";
import { LynxRemote } from "../src/sync/LynxRemote.ts";
import type { LynxStreamEventPayload } from "../src/globals.ts";
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

test("identifier fetch uses Response.lynxExtension.streamingId when body is already used", async () => {
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
      queueMicrotask(() => {
        for (const fn of listeners.get("stream-ios") ?? []) {
          fn({ event: "onData", data: '{"ok":1}\n' });
        }
      });
      const first = await response.body!.getReader().read();
      assert.equal(first.done, false);
      assert.ok(first.value != null && first.value.byteLength > 0);
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

test("LynxRemote.fetch applies idle-complete raw NDJSON body without streamingId", async () => {
  // Legacy LynxFetchModule path when NativePowerSyncModule.httpFetch is absent.
  const ndjson = '{"checkpoint":{"last_op_id":"1"}}\n{"data":{"bucket":"a","data":[]}}\n';
  const body = new TextEncoder().encode(ndjson);
  let requestedStreaming = false;
  await withFakeLynxHost(
    {
      platform: "Android",
      nativeModules: {
        LynxFetchModule: {
          fetch(
            request: { lynxExtension?: Record<string, boolean> },
            resolve: (response: LynxFetchSuccessPayload) => void,
          ) {
            requestedStreaming = request.lynxExtension?.enableFetchAPIStandardStreaming === true;
            queueMicrotask(() => {
              resolve({
                status: 200,
                statusText: "OK",
                headers: { "content-type": "application/x-ndjson" },
                body,
              });
            });
          },
        },
      },
    },
    async () => {
      const remote = new LynxRemote(stubConnector(), silentLogger);
      const response = await remote.fetch({
        resource: "http://10.0.2.2:8080/sync/stream",
        request: { method: "POST", body: "{}" },
        expectStreamingResponse: true,
      });
      assert.equal(
        requestedStreaming,
        false,
        "Android must force idle-complete, not Lynx streaming flags",
      );
      assert.equal(response.ok, true);
      const reader = response.body!.getReader();
      const first = await reader.read();
      assert.equal(first.done, false);
      assert.ok(first.value != null);
      assert.equal(new TextDecoder().decode(first.value), ndjson);
      const second = await reader.read();
      assert.equal(second.done, true);
    },
  );
});

test("LynxRemote.fetch reads LynxFetchModule streamingId before the stream ends", async () => {
  const { emitter, listeners } = createFakeEmitter();
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
            queueMicrotask(() => {
              resolve({
                status: 200,
                statusText: "OK",
                headers: { "content-type": "application/x-ndjson" },
                lynxExtension: { streamingId: "stream-1" },
              });
              queueMicrotask(() => {
                for (const fn of listeners.get("stream-1") ?? []) {
                  fn({ event: "onData", data: '{"ok":1}\n' });
                }
              });
            });
          },
        },
      },
    },
    async () => {
      const remote = new LynxRemote(stubConnector(), silentLogger);
      const response = await remote.fetch({
        resource: "http://127.0.0.1:8080/sync/stream",
        request: { method: "POST", body: "{}" },
        expectStreamingResponse: true,
      });
      const first = await response.body!.getReader().read();
      assert.equal(first.done, false);
      assert.ok(first.value != null && first.value.byteLength > 0);
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

test("identifier fetchStream keeps NDJSON native delivered before addListener without emit", async () => {
  const listeners = new Map<string, (payload: LynxStreamEventPayload) => void>();
  const previousLynx = globalThis.lynx;
  const previousFetch = globalThis.fetch;
  globalThis.lynx = {
    getJSModule(name: string) {
      if (name !== "GlobalEventEmitter") {
        return undefined;
      }
      return {
        addListener(eventName: string, fn: (payload: LynxStreamEventPayload) => void) {
          listeners.set(eventName, fn);
        },
      };
    },
  };
  globalThis.fetch = async (_url, init) => {
    if (!lynxStreamingRequested(init)) {
      return hangResponse();
    }
    queueMicrotask(() => {
      const streamingId = "LynxFetchModuleStreamingEvent0";
      listeners.get(streamingId)?.({ event: "onData", data: NDJSON_LINE });
      listeners.get(streamingId)?.({ event: "onEnd" });
    });
    return identifierResponse({
      contentType: "application/x-ndjson",
      streamingId: "LynxFetchModuleStreamingEvent0",
      bodyUsedError: true,
    });
  };
  try {
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
      "checkpoint must not be dropped if native onData raced ahead of addListener without emit",
    );
    assert.deepEqual(JSON.parse(String(first.value)), { checkpoint: { last_op_id: "1" } });
  } finally {
    globalThis.lynx = previousLynx;
    globalThis.fetch = previousFetch;
  }
});

test("identifier fetchStream keeps NDJSON that arrived before addListener", async () => {
  const listeners = new Map<string, (payload: LynxStreamEventPayload) => void>();
  const previousLynx = globalThis.lynx;
  const previousFetch = globalThis.fetch;
  globalThis.lynx = {
    getJSModule(name: string) {
      if (name !== "GlobalEventEmitter") {
        return undefined;
      }
      return {
        addListener(eventName: string, fn: (payload: LynxStreamEventPayload) => void) {
          listeners.set(eventName, fn);
        },
        emit(eventName: string, payload: LynxStreamEventPayload) {
          listeners.get(eventName)?.(payload);
        },
      };
    },
  };
  globalThis.fetch = async (_url, init) => {
    if (!lynxStreamingRequested(init)) {
      return hangResponse();
    }
    queueMicrotask(() => {
      globalThis.lynx?.getJSModule?.("GlobalEventEmitter")?.emit?.("stream-early", {
        event: "onData",
        data: NDJSON_LINE,
      });
      globalThis.lynx
        ?.getJSModule?.("GlobalEventEmitter")
        ?.emit?.("stream-early", { event: "onEnd" });
    });
    return identifierResponse({
      contentType: "application/x-ndjson",
      streamingId: "stream-early",
      bodyUsedError: true,
    });
  };
  try {
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
      "checkpoint must not be dropped if onData raced ahead of addListener",
    );
    assert.deepEqual(JSON.parse(String(first.value)), { checkpoint: { last_op_id: "1" } });
  } finally {
    globalThis.lynx = previousLynx;
    globalThis.fetch = previousFetch;
  }
});

test("Android fetchStream keeps NDJSON that arrived before addListener", async () => {
  const listeners = new Map<string, (payload: LynxStreamEventPayload) => void>();
  const previousLynx = globalThis.lynx;
  const previousModules = globalThis.NativeModules;
  const previousInfo = globalThis.SystemInfo;
  globalThis.SystemInfo = { platform: "Android" };
  globalThis.lynx = {
    getJSModule(name: string) {
      if (name !== "GlobalEventEmitter") {
        return undefined;
      }
      return {
        addListener(eventName: string, fn: (payload: LynxStreamEventPayload) => void) {
          listeners.set(eventName, fn);
        },
        emit(eventName: string, payload: LynxStreamEventPayload) {
          listeners.get(eventName)?.(payload);
        },
      };
    },
  };
  assignNativeModules({
    LynxFetchModule: {
      fetch(
        request: { headers?: Record<string, string> },
        resolve: (response: LynxFetchSuccessPayload) => void,
      ) {
        const body = serviceFaithfulBody(headerAccept(request.headers));
        queueMicrotask(() => {
          globalThis.lynx?.getJSModule?.("GlobalEventEmitter")?.emit?.("stream-early-and", {
            event: "onData",
            data: body,
          });
          globalThis.lynx
            ?.getJSModule?.("GlobalEventEmitter")
            ?.emit?.("stream-early-and", { event: "onEnd" });
          resolve({
            status: 200,
            statusText: "OK",
            lynxExtension: { streamingId: "stream-early-and" },
          });
        });
      },
    },
  });
  try {
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
      "checkpoint must not be dropped if onData raced ahead of addListener",
    );
    assert.deepEqual(JSON.parse(String(first.value)), { checkpoint: { last_op_id: "1" } });
  } finally {
    globalThis.lynx = previousLynx;
    globalThis.NativeModules = previousModules;
    globalThis.SystemInfo = previousInfo;
  }
});

test("Android LynxFetchModule fetchStream yields JSON checkpoint lines", async () => {
  const previousLynx = globalThis.lynx;
  const previousModules = globalThis.NativeModules;
  const previousInfo = globalThis.SystemInfo;
  const listeners = new Map<string, (payload: LynxStreamEventPayload) => void>();
  globalThis.SystemInfo = { platform: "Android" };
  globalThis.lynx = {
    getJSModule(name: string) {
      if (name !== "GlobalEventEmitter") {
        return undefined;
      }
      return {
        addListener(eventName: string, fn: (payload: LynxStreamEventPayload) => void) {
          listeners.set(eventName, fn);
        },
      };
    },
  };
  assignNativeModules({
    LynxFetchModule: {
      fetch(
        request: { headers?: Record<string, string> },
        resolve: (response: LynxFetchSuccessPayload) => void,
      ) {
        const body = serviceFaithfulBody(headerAccept(request.headers));
        queueMicrotask(() => {
          resolve({
            status: 200,
            statusText: "OK",
            lynxExtension: { streamingId: "stream-ndjson" },
          });
          queueMicrotask(() => {
            listeners.get("stream-ndjson")?.({ event: "onData", data: body });
            listeners.get("stream-ndjson")?.({ event: "onEnd" });
          });
        });
      },
    },
  });
  try {
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
  } finally {
    globalThis.lynx = previousLynx;
    globalThis.NativeModules = previousModules;
    globalThis.SystemInfo = previousInfo;
  }
});

test("identifier fetchStream keeps NDJSON when Lynx emit applies params array", async () => {
  type Slot = { listener: (payload: LynxStreamEventPayload) => void };
  const previousLynx = globalThis.lynx;
  const previousFetch = globalThis.fetch;
  const events = new Map<string, Slot[]>();
  const emitter = {
    _events: events,
    addListener(eventName: string, fn: (payload: LynxStreamEventPayload) => void) {
      const list = events.get(eventName) ?? [];
      list.push({ listener: fn });
      events.set(eventName, list);
    },
    emit(eventName: string, payload: LynxStreamEventPayload) {
      const list = events.get(eventName);
      if (list == null) {
        return;
      }
      const first = Array.isArray(payload) ? payload[0] : payload;
      if (first == null) {
        return;
      }
      for (const slot of list) {
        slot.listener(first);
      }
    },
  };
  globalThis.lynx = {
    getJSModule(name: string) {
      if (name !== "GlobalEventEmitter") {
        return undefined;
      }
      return emitter;
    },
  };
  globalThis.fetch = async (_url, init) => {
    if (!lynxStreamingRequested(init)) {
      return hangResponse();
    }
    queueMicrotask(() => {
      globalThis.lynx
        ?.getJSModule?.("GlobalEventEmitter")
        ?.emit?.("LynxFetchModuleStreamingEvent3", [{ event: "onData", data: NDJSON_LINE }]);
    });
    return identifierResponse({
      contentType: "application/x-ndjson",
      streamingId: "LynxFetchModuleStreamingEvent3",
      bodyUsedError: true,
    });
  };
  try {
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
      "checkpoint must not be dropped if Lynx emit(name, [map]) raced ahead",
    );
    assert.deepEqual(JSON.parse(String(first.value)), { checkpoint: { last_op_id: "1" } });
  } finally {
    globalThis.lynx = previousLynx;
    globalThis.fetch = previousFetch;
  }
});

test("Android fetchStream keeps NDJSON when native sendGlobalEvent passes an array", async () => {
  const listeners = new Map<string, (payload: LynxStreamEventPayload) => void>();
  const previousLynx = globalThis.lynx;
  const previousModules = globalThis.NativeModules;
  const previousInfo = globalThis.SystemInfo;
  globalThis.SystemInfo = { platform: "Android" };
  globalThis.lynx = {
    getJSModule(name: string) {
      if (name !== "GlobalEventEmitter") {
        return undefined;
      }
      return {
        addListener(eventName: string, fn: (payload: LynxStreamEventPayload) => void) {
          listeners.set(eventName, fn);
        },
      };
    },
  };
  assignNativeModules({
    LynxFetchModule: {
      fetch(
        request: { headers?: Record<string, string> },
        resolve: (response: LynxFetchSuccessPayload) => void,
      ) {
        const body = serviceFaithfulBody(headerAccept(request.headers));
        queueMicrotask(() => {
          const streamingId = "LynxFetchModuleStreamingEvent0";
          listeners.get(streamingId)?.([{ event: "onData", data: body }]);
          resolve({
            status: 200,
            statusText: "OK",
            lynxExtension: { streamingId },
          });
        });
      },
    },
  });
  try {
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
      "checkpoint must not be dropped if native sendGlobalEvent passed [map]",
    );
    assert.deepEqual(JSON.parse(String(first.value)), { checkpoint: { last_op_id: "1" } });
  } finally {
    globalThis.lynx = previousLynx;
    globalThis.NativeModules = previousModules;
    globalThis.SystemInfo = previousInfo;
  }
});

test("Android fetchStream keeps NDJSON native delivered before addListener without emit", async () => {
  const listeners = new Map<string, (payload: LynxStreamEventPayload) => void>();
  const previousLynx = globalThis.lynx;
  const previousModules = globalThis.NativeModules;
  const previousInfo = globalThis.SystemInfo;
  globalThis.SystemInfo = { platform: "Android" };
  globalThis.lynx = {
    getJSModule(name: string) {
      if (name !== "GlobalEventEmitter") {
        return undefined;
      }
      return {
        addListener(eventName: string, fn: (payload: LynxStreamEventPayload) => void) {
          listeners.set(eventName, fn);
        },
      };
    },
  };
  assignNativeModules({
    LynxFetchModule: {
      fetch(
        request: { headers?: Record<string, string> },
        resolve: (response: LynxFetchSuccessPayload) => void,
      ) {
        const body = serviceFaithfulBody(headerAccept(request.headers));
        queueMicrotask(() => {
          // Native LynxFetchModule names the stream and invokes stored listeners; it does not call emit().
          const streamingId = "LynxFetchModuleStreamingEvent0";
          listeners.get(streamingId)?.({ event: "onData", data: body });
          resolve({
            status: 200,
            statusText: "OK",
            lynxExtension: { streamingId },
          });
        });
      },
    },
  });
  try {
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
      "checkpoint must not be dropped if native onData raced ahead of addListener without emit",
    );
    assert.deepEqual(JSON.parse(String(first.value)), { checkpoint: { last_op_id: "1" } });
  } finally {
    globalThis.lynx = previousLynx;
    globalThis.NativeModules = previousModules;
    globalThis.SystemInfo = previousInfo;
  }
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

test("identifier fetchStream keeps incremental NDJSON when Response has no streamingId", async () => {
  const listeners = new Map<string, (payload: LynxStreamEventPayload) => void>();
  const previousLynx = globalThis.lynx;
  const previousFetch = globalThis.fetch;
  globalThis.lynx = {
    getJSModule(name: string) {
      if (name !== "GlobalEventEmitter") {
        return undefined;
      }
      return {
        addListener(eventName: string, fn: (payload: LynxStreamEventPayload) => void) {
          listeners.set(eventName, fn);
        },
      };
    },
  };
  globalThis.fetch = async (_url, init) => {
    if (!lynxStreamingRequested(init)) {
      return hangResponse();
    }
    return identifierResponse({
      contentType: "application/x-ndjson",
      bodyUsedError: true,
    });
  };
  try {
    const remote = new LynxRemote(demoConnector("http://127.0.0.1:8080"), silentLogger);
    const stream = await remote.fetchStream({
      path: "/sync/stream",
      data: {},
      abortSignal: new AbortController().signal,
    });
    queueMicrotask(() => {
      listeners.get("LynxFetchModuleStreamingEvent0")?.({ event: "onData", data: NDJSON_LINE });
      listeners.get("LynxFetchModuleStreamingEvent0")?.({ event: "onEnd" });
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
      "incremental checkpoint must not be dropped when identifier fetch has no streamingId",
    );
    assert.deepEqual(JSON.parse(String(first.value)), { checkpoint: { last_op_id: "1" } });
  } finally {
    globalThis.lynx = previousLynx;
    globalThis.fetch = previousFetch;
  }
});

test("identifier fetchStream keeps incremental NDJSON when Response.body is an empty stream", async () => {
  const listeners = new Map<string, (payload: LynxStreamEventPayload) => void>();
  const previousLynx = globalThis.lynx;
  const previousFetch = globalThis.fetch;
  globalThis.lynx = {
    getJSModule(name: string) {
      if (name !== "GlobalEventEmitter") {
        return undefined;
      }
      return {
        addListener(eventName: string, fn: (payload: LynxStreamEventPayload) => void) {
          listeners.set(eventName, fn);
        },
      };
    },
  };
  globalThis.fetch = async (_url, init) => {
    if (!lynxStreamingRequested(init)) {
      return hangResponse();
    }
    return identifierResponse({
      contentType: "application/x-ndjson",
      mockBody: chunkReader([]),
    });
  };
  try {
    const remote = new LynxRemote(demoConnector("http://127.0.0.1:8080"), silentLogger);
    const stream = await remote.fetchStream({
      path: "/sync/stream",
      data: {},
      abortSignal: new AbortController().signal,
    });
    queueMicrotask(() => {
      listeners.get("LynxFetchModuleStreamingEvent0")?.({ event: "onData", data: NDJSON_LINE });
      listeners.get("LynxFetchModuleStreamingEvent0")?.({ event: "onEnd" });
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
      "incremental checkpoint must not be dropped when identifier fetch returns an empty standard body",
    );
    assert.deepEqual(JSON.parse(String(first.value)), { checkpoint: { last_op_id: "1" } });
  } finally {
    globalThis.lynx = previousLynx;
    globalThis.fetch = previousFetch;
  }
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
