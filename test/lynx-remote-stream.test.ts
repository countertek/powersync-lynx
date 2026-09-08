import assert from "node:assert/strict";
import { test } from "node:test";

import { LynxRemote } from "../src/sync/LynxRemote.ts";

test("LynxRemote.fetch returns a streaming Response before the body ends", async () => {
  let streamEnded = false;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = ((_url, init) => {
    const extension = (init as { lynxExtension?: { useStreaming?: boolean } } | undefined)?.lynxExtension;
    if (extension?.useStreaming !== true) {
      return new Promise(() => {});
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => "application/x-ndjson" },
      body: {
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
    } as Response);
  }) as typeof fetch;
  try {
    const remote = new LynxRemote({ fetchCredentials: async () => null }, { log() {} });
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
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("identifier fetch uses Response.lynxExtension.streamingId when body is already used", async () => {
  const listeners = new Map<string, (payload: unknown) => void>();
  const previousLynx = (globalThis as { lynx?: unknown }).lynx;
  const previousFetch = globalThis.fetch;
  (globalThis as { lynx?: unknown }).lynx = {
    getJSModule(name: string) {
      if (name !== "GlobalEventEmitter") {
        return undefined;
      }
      return {
        addListener(eventName: string, fn: (payload: unknown) => void) {
          listeners.set(eventName, fn);
          if (eventName === "stream-ios") {
            queueMicrotask(() => fn({ event: "onData", data: '{"ok":1}\n' }));
          }
        },
      };
    },
  };
  globalThis.fetch = ((_url, init) => {
    const extension = (init as { lynxExtension?: { useStreaming?: boolean } } | undefined)?.lynxExtension;
    if (extension?.useStreaming !== true) {
      return new Promise(() => {});
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => "application/x-ndjson" },
      lynxExtension: { streamingId: "stream-ios" },
      get body() {
        throw new Error("body used");
      },
    } as Response);
  }) as typeof fetch;
  try {
    const remote = new LynxRemote({ fetchCredentials: async () => null }, { log() {} });
    const response = await remote.fetch({
      resource: "http://127.0.0.1:8080/sync/stream",
      request: { method: "POST", body: "{}" },
      expectStreamingResponse: true,
    });
    const first = await response.body!.getReader().read();
    assert.equal(first.done, false);
    assert.ok(first.value != null && first.value.byteLength > 0);
  } finally {
    (globalThis as { lynx?: unknown }).lynx = previousLynx;
    globalThis.fetch = previousFetch;
  }
});

test("LynxRemote.fetch reads LynxFetchModule streamingId before the stream ends", async () => {
  const listeners = new Map<string, (payload: unknown) => void>();
  const previousLynx = (globalThis as { lynx?: unknown }).lynx;
  const previousModules = globalThis.NativeModules;
  const previousInfo = (globalThis as { SystemInfo?: { platform?: string } }).SystemInfo;
  (globalThis as { SystemInfo?: { platform?: string } }).SystemInfo = { platform: "Android" };
  (globalThis as { lynx?: unknown }).lynx = {
    getJSModule(name: string) {
      if (name !== "GlobalEventEmitter") {
        return undefined;
      }
      return {
        addListener(eventName: string, fn: (payload: unknown) => void) {
          listeners.set(eventName, fn);
        },
      };
    },
  };
  globalThis.NativeModules = {
    LynxFetchModule: {
      fetch(_request: unknown, resolve: (response: unknown) => void) {
        queueMicrotask(() => {
          resolve({
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/x-ndjson" },
            lynxExtension: { streamingId: "stream-1" },
          });
          queueMicrotask(() => {
            listeners.get("stream-1")?.({ event: "onData", data: '{"ok":1}\n' });
          });
        });
      },
    },
  } as typeof globalThis.NativeModules;
  try {
    const remote = new LynxRemote({ fetchCredentials: async () => null }, { log() {} });
    const response = await remote.fetch({
      resource: "http://127.0.0.1:8080/sync/stream",
      request: { method: "POST", body: "{}" },
      expectStreamingResponse: true,
    });
    const first = await response.body!.getReader().read();
    assert.equal(first.done, false);
    assert.ok(first.value != null && first.value.byteLength > 0);
  } finally {
    (globalThis as { lynx?: unknown }).lynx = previousLynx;
    globalThis.NativeModules = previousModules;
    (globalThis as { SystemInfo?: { platform?: string } }).SystemInfo = previousInfo;
  }
});

test("streaming Response body can be inspected then getReader() without body used", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    const chunk = new TextEncoder().encode("ok\n");
    let bodyReads = 0;
    const stream = {
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
    };
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => "application/x-ndjson" },
      get body() {
        bodyReads += 1;
        if (bodyReads > 1) {
          throw new Error("body used");
        }
        return stream;
      },
    } as Response);
  }) as typeof fetch;
  try {
    const remote = new LynxRemote({ fetchCredentials: async () => null }, { log() {} });
    const response = await remote.fetch({
      resource: "http://127.0.0.1:8080/sync/stream",
      request: { method: "POST", body: "{}" },
      expectStreamingResponse: true,
    });
    assert.equal(Boolean(response.body), true);
    const first = await response.body!.getReader().read();
    assert.equal(first.done, false);
    assert.deepEqual(first.value, new TextEncoder().encode("ok\n"));
  } finally {
    globalThis.fetch = previousFetch;
  }
});

const BSON_STREAM = "application/vnd.powersync.bson-stream";
const NDJSON_LINE = '{"checkpoint":{"last_op_id":"1"}}\n';
/** Real /sync/stream BSON contains 0x0A; NDJSON-splitting it yields unparseable lines. */
const BSON_WITH_NEWLINE = new Uint8Array([0xe9, 0x00, 0x00, 0x00, 0x0a, 0x03, 0x63, 0x6b]);

function headerAccept(headers: unknown): string {
  if (headers == null || typeof headers !== "object" || Array.isArray(headers)) {
    return "";
  }
  const rec = headers as Record<string, unknown>;
  return String(rec.accept ?? rec.Accept ?? "");
}

function serviceFaithfulBody(accept: string): Uint8Array {
  if (accept.includes(BSON_STREAM)) {
    return BSON_WITH_NEWLINE;
  }
  return new TextEncoder().encode(NDJSON_LINE);
}

test("fetchStream yields JSON checkpoint lines when the service honors Accept", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = ((_url, init) => {
    const body = serviceFaithfulBody(headerAccept(init?.headers));
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => "" },
      body: {
        getReader() {
          let sent = false;
          return {
            async read() {
              if (!sent) {
                sent = true;
                return { done: false, value: body };
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
    } as Response);
  }) as typeof fetch;
  try {
    const remote = new LynxRemote(
      { fetchCredentials: async () => ({ endpoint: "http://127.0.0.1:8080", token: "tok" }) },
      { log() {} },
    );
    const stream = await remote.fetchStream({
      path: "/sync/stream",
      data: {},
      abortSignal: new AbortController().signal,
    });
    const first = await stream.next();
    assert.equal(first.done, false);
    assert.equal(typeof first.value, "string");
    assert.deepEqual(JSON.parse(String(first.value)), { checkpoint: { last_op_id: "1" } });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Android LynxFetchModule fetchStream yields JSON checkpoint lines", async () => {
  const previousLynx = (globalThis as { lynx?: unknown }).lynx;
  const previousModules = globalThis.NativeModules;
  const previousInfo = (globalThis as { SystemInfo?: { platform?: string } }).SystemInfo;
  const listeners = new Map<string, (payload: unknown) => void>();
  (globalThis as { SystemInfo?: { platform?: string } }).SystemInfo = { platform: "Android" };
  (globalThis as { lynx?: unknown }).lynx = {
    getJSModule(name: string) {
      if (name !== "GlobalEventEmitter") {
        return undefined;
      }
      return {
        addListener(eventName: string, fn: (payload: unknown) => void) {
          listeners.set(eventName, fn);
        },
      };
    },
  };
  globalThis.NativeModules = {
    LynxFetchModule: {
      fetch(request: { headers?: Record<string, string> }, resolve: (response: unknown) => void) {
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
  } as typeof globalThis.NativeModules;
  try {
    const remote = new LynxRemote(
      { fetchCredentials: async () => ({ endpoint: "http://127.0.0.1:8080", token: "tok" }) },
      { log() {} },
    );
    const stream = await remote.fetchStream({
      path: "/sync/stream",
      data: {},
      abortSignal: new AbortController().signal,
    });
    const first = await stream.next();
    assert.equal(first.done, false);
    assert.equal(typeof first.value, "string");
    assert.deepEqual(JSON.parse(String(first.value)), { checkpoint: { last_op_id: "1" } });
  } finally {
    (globalThis as { lynx?: unknown }).lynx = previousLynx;
    globalThis.NativeModules = previousModules;
    (globalThis as { SystemInfo?: { platform?: string } }).SystemInfo = previousInfo;
  }
});
