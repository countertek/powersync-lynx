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

test("identifier fetchStream keeps NDJSON native delivered before addListener without emit", async () => {
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
        },
      };
    },
  };
  globalThis.fetch = ((_url, init) => {
    const extension = (init as { lynxExtension?: { useStreaming?: boolean } } | undefined)?.lynxExtension;
    if (extension?.useStreaming !== true) {
      return new Promise(() => {});
    }
    queueMicrotask(() => {
      const streamingId = "LynxFetchModuleStreamingEvent0";
      listeners.get(streamingId)?.({ event: "onData", data: NDJSON_LINE });
      listeners.get(streamingId)?.({ event: "onEnd" });
    });
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => "application/x-ndjson" },
      lynxExtension: { streamingId: "LynxFetchModuleStreamingEvent0" },
      get body() {
        throw new Error("body used");
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
    (globalThis as { lynx?: unknown }).lynx = previousLynx;
    globalThis.fetch = previousFetch;
  }
});

test("identifier fetchStream keeps NDJSON that arrived before addListener", async () => {
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
        },
        emit(eventName: string, payload: unknown) {
          listeners.get(eventName)?.(payload);
        },
      };
    },
  };
  globalThis.fetch = ((_url, init) => {
    const extension = (init as { lynxExtension?: { useStreaming?: boolean } } | undefined)?.lynxExtension;
    if (extension?.useStreaming !== true) {
      return new Promise(() => {});
    }
    queueMicrotask(() => {
      const emitter = (
        globalThis as {
          lynx?: { getJSModule?: (name: string) => { emit?: (eventName: string, payload: unknown) => void } };
        }
      ).lynx?.getJSModule?.("GlobalEventEmitter");
      emitter?.emit?.("stream-early", { event: "onData", data: NDJSON_LINE });
      emitter?.emit?.("stream-early", { event: "onEnd" });
    });
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => "application/x-ndjson" },
      lynxExtension: { streamingId: "stream-early" },
      get body() {
        throw new Error("body used");
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
    const first = await Promise.race([
      stream.next(),
      new Promise<{ done: true; value: undefined }>((resolve) => {
        setTimeout(() => resolve({ done: true, value: undefined }), 80);
      }),
    ]);
    assert.equal(first.done, false, "checkpoint must not be dropped if onData raced ahead of addListener");
    assert.deepEqual(JSON.parse(String(first.value)), { checkpoint: { last_op_id: "1" } });
  } finally {
    (globalThis as { lynx?: unknown }).lynx = previousLynx;
    globalThis.fetch = previousFetch;
  }
});

test("Android fetchStream keeps NDJSON that arrived before addListener", async () => {
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
        emit(eventName: string, payload: unknown) {
          listeners.get(eventName)?.(payload);
        },
      };
    },
  };
  globalThis.NativeModules = {
    LynxFetchModule: {
      fetch(request: { headers?: Record<string, string> }, resolve: (response: unknown) => void) {
        const body = serviceFaithfulBody(headerAccept(request.headers));
        queueMicrotask(() => {
          const emitter = (
            globalThis as {
              lynx?: { getJSModule?: (name: string) => { emit?: (eventName: string, payload: unknown) => void } };
            }
          ).lynx?.getJSModule?.("GlobalEventEmitter");
          emitter?.emit?.("stream-early-and", { event: "onData", data: body });
          emitter?.emit?.("stream-early-and", { event: "onEnd" });
          resolve({
            status: 200,
            statusText: "OK",
            lynxExtension: { streamingId: "stream-early-and" },
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
    const first = await Promise.race([
      stream.next(),
      new Promise<{ done: true; value: undefined }>((resolve) => {
        setTimeout(() => resolve({ done: true, value: undefined }), 80);
      }),
    ]);
    assert.equal(first.done, false, "checkpoint must not be dropped if onData raced ahead of addListener");
    assert.deepEqual(JSON.parse(String(first.value)), { checkpoint: { last_op_id: "1" } });
  } finally {
    (globalThis as { lynx?: unknown }).lynx = previousLynx;
    globalThis.NativeModules = previousModules;
    (globalThis as { SystemInfo?: { platform?: string } }).SystemInfo = previousInfo;
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

test("identifier fetchStream keeps NDJSON when Lynx emit applies params array", async () => {
  type Slot = { listener: (this: unknown, ...args: unknown[]) => void };
  const previousLynx = (globalThis as { lynx?: unknown }).lynx;
  const previousFetch = globalThis.fetch;
  const events = new Map<string, Slot[]>();
  const emitter = {
    _events: events,
    addListener(eventName: string, fn: (payload: unknown) => void) {
      const list = events.get(eventName) ?? [];
      list.push({ listener: fn });
      events.set(eventName, list);
    },
    emit(eventName: string, params: unknown[]) {
      const list = events.get(eventName);
      if (list == null) {
        return;
      }
      for (const slot of list) {
        slot.listener.apply(this, params);
      }
    },
  };
  (globalThis as { lynx?: unknown }).lynx = {
    getJSModule(name: string) {
      if (name !== "GlobalEventEmitter") {
        return undefined;
      }
      return emitter;
    },
  };
  globalThis.fetch = ((_url, init) => {
    const extension = (init as { lynxExtension?: { useStreaming?: boolean } } | undefined)?.lynxExtension;
    if (extension?.useStreaming !== true) {
      return new Promise(() => {});
    }
    queueMicrotask(() => {
      const emitter = (
        globalThis as {
          lynx?: { getJSModule?: (name: string) => { emit?: (eventName: string, params: unknown[]) => void } };
        }
      ).lynx?.getJSModule?.("GlobalEventEmitter");
      emitter?.emit?.("LynxFetchModuleStreamingEvent3", [{ event: "onData", data: NDJSON_LINE }]);
    });
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => "application/x-ndjson" },
      lynxExtension: { streamingId: "LynxFetchModuleStreamingEvent3" },
      get body() {
        throw new Error("body used");
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
    const first = await Promise.race([
      stream.next(),
      new Promise<{ done: true; value: undefined }>((resolve) => {
        setTimeout(() => resolve({ done: true, value: undefined }), 80);
      }),
    ]);
    assert.equal(first.done, false, "checkpoint must not be dropped if Lynx emit(name, [map]) raced ahead");
    assert.deepEqual(JSON.parse(String(first.value)), { checkpoint: { last_op_id: "1" } });
  } finally {
    (globalThis as { lynx?: unknown }).lynx = previousLynx;
    globalThis.fetch = previousFetch;
  }
});

test("Android fetchStream keeps NDJSON when native sendGlobalEvent passes an array", async () => {
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
      fetch(request: { headers?: Record<string, string> }, resolve: (response: unknown) => void) {
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
    const first = await Promise.race([
      stream.next(),
      new Promise<{ done: true; value: undefined }>((resolve) => {
        setTimeout(() => resolve({ done: true, value: undefined }), 80);
      }),
    ]);
    assert.equal(first.done, false, "checkpoint must not be dropped if native sendGlobalEvent passed [map]");
    assert.deepEqual(JSON.parse(String(first.value)), { checkpoint: { last_op_id: "1" } });
  } finally {
    (globalThis as { lynx?: unknown }).lynx = previousLynx;
    globalThis.NativeModules = previousModules;
    (globalThis as { SystemInfo?: { platform?: string } }).SystemInfo = previousInfo;
  }
});

test("Android fetchStream keeps NDJSON native delivered before addListener without emit", async () => {
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
      fetch(request: { headers?: Record<string, string> }, resolve: (response: unknown) => void) {
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
    (globalThis as { lynx?: unknown }).lynx = previousLynx;
    globalThis.NativeModules = previousModules;
    (globalThis as { SystemInfo?: { platform?: string } }).SystemInfo = previousInfo;
  }
});

const WRITE_CHECKPOINT_JSON = '{"data":{"write_checkpoint":"12"}}';
/** gzip of WRITE_CHECKPOINT_JSON — what OkHttp may hand JS without Accept-Encoding: identity. */
const WRITE_CHECKPOINT_GZIP = new Uint8Array([
  31, 139, 8, 0, 0, 0, 0, 0, 0, 19, 171, 86, 74, 73, 44, 73, 84, 178, 170, 86, 42, 47, 202, 44, 73,
  141, 79, 206, 72, 77, 206, 46, 200, 207, 204, 43, 81, 178, 82, 50, 52, 82, 170, 173, 5, 0, 217,
  204, 34, 231, 34, 0, 0, 0,
]);

function requestAcceptEncoding(headers: unknown): string {
  if (headers == null || typeof headers !== "object" || Array.isArray(headers)) {
    return "";
  }
  const rec = headers as Record<string, unknown>;
  return String(rec["accept-encoding"] ?? rec["Accept-Encoding"] ?? "");
}

test("Android write-checkpoint json() parses when native would otherwise return gzip", async () => {
  const previousLynx = (globalThis as { lynx?: unknown }).lynx;
  const previousModules = globalThis.NativeModules;
  const previousInfo = (globalThis as { SystemInfo?: { platform?: string } }).SystemInfo;
  (globalThis as { SystemInfo?: { platform?: string } }).SystemInfo = { platform: "Android" };
  (globalThis as { lynx?: unknown }).lynx = {
    getJSModule() {
      return { addListener() {} };
    },
  };
  globalThis.NativeModules = {
    LynxFetchModule: {
      fetch(request: { headers?: Record<string, string> }, resolve: (response: unknown) => void) {
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
  } as typeof globalThis.NativeModules;
  try {
    const remote = new LynxRemote(
      { fetchCredentials: async () => ({ endpoint: "http://127.0.0.1:8080", token: "tok" }) },
      { log() {} },
    );
    const decoded = await remote.fetchAndDecodeJson({
      path: "/write-checkpoint2.json?client_id=1",
    });
    assert.deepEqual(decoded, { data: { write_checkpoint: "12" } });
  } finally {
    (globalThis as { lynx?: unknown }).lynx = previousLynx;
    globalThis.NativeModules = previousModules;
    (globalThis as { SystemInfo?: { platform?: string } }).SystemInfo = previousInfo;
  }
});

test("Android LynxFetchModule JSON fetch exposes json() for checkpoint-request", async () => {
  const previousLynx = (globalThis as { lynx?: unknown }).lynx;
  const previousModules = globalThis.NativeModules;
  const previousInfo = (globalThis as { SystemInfo?: { platform?: string } }).SystemInfo;
  (globalThis as { SystemInfo?: { platform?: string } }).SystemInfo = { platform: "Android" };
  (globalThis as { lynx?: unknown }).lynx = {
    getJSModule() {
      return { addListener() {} };
    },
  };
  globalThis.NativeModules = {
    LynxFetchModule: {
      fetch(_request: unknown, resolve: (response: unknown) => void) {
        queueMicrotask(() => {
          resolve({
            status: 200,
            statusText: "OK",
            body: '{"data":{"checkpoint_request_id":"ck1"}}',
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
    const decoded = await remote.fetchAndDecodeJson({
      path: "/sync/checkpoint-request",
      method: "POST",
      body: "{}",
    });
    assert.deepEqual(decoded, { data: { checkpoint_request_id: "ck1" } });
  } finally {
    (globalThis as { lynx?: unknown }).lynx = previousLynx;
    globalThis.NativeModules = previousModules;
    (globalThis as { SystemInfo?: { platform?: string } }).SystemInfo = previousInfo;
  }
});
