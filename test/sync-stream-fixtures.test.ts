import assert from "node:assert/strict";
import { test } from "node:test";

import { LynxRemote } from "../src/sync/LynxRemote.ts";
import type {
  NativeHttpFetchCallback,
  NativeHttpFetchEnvelope,
  NativeHttpFetchRequest,
} from "../src/sync/transport/http-types.ts";
import { responseFromNativeHttpEnvelope } from "../src/sync/transport/NativeHttpFetch.ts";
import type { LynxStreamEventPayload } from "../src/globals.ts";
import {
  joinedFixtureBody,
  loadSyncStreamFixtures,
  requireScenario,
  type SyncStreamScenario,
} from "./fixtures/sync-stream.ts";
import {
  createFakeEmitter,
  nativeWithHttp,
  silentLogger,
  stubConnector,
  withFakeLynxHost,
} from "./remote-harness.ts";

const catalog = loadSyncStreamFixtures();
const checkpointOps = requireScenario(catalog, "checkpoint-ops");
const errorThenEnd = requireScenario(catalog, "error-then-end");
const idleComplete = requireScenario(catalog, "idle-complete");

const STREAM_ID = "NativePowerSyncHttpStream-fixture";

function emitPayload(
  listeners: Map<string, Array<(payload: LynxStreamEventPayload) => void>>,
  payload: LynxStreamEventPayload,
): void {
  for (const fn of listeners.get(STREAM_ID) ?? []) {
    fn(payload);
  }
}

function replayStreamingEvents(
  scenario: SyncStreamScenario,
  listeners: Map<string, Array<(payload: LynxStreamEventPayload) => void>>,
): void {
  let chunkIndex = 0;
  for (const event of scenario.events) {
    if (event === "onData") {
      const data = scenario.chunks[chunkIndex] ?? "";
      chunkIndex += 1;
      emitPayload(listeners, { event: "onData", data });
    } else if (event === "onError") {
      emitPayload(listeners, { event: "onError", error: scenario.error ?? "stream error" });
    } else if (event === "onEnd") {
      emitPayload(listeners, { event: "onEnd" });
    }
  }
}

function streamingHttpFetch(
  scenario: SyncStreamScenario,
  listeners: Map<string, Array<(payload: LynxStreamEventPayload) => void>>,
): (request: NativeHttpFetchRequest, callback: NativeHttpFetchCallback) => void {
  return (_request, callback) => {
    queueMicrotask(() => {
      callback({
        ok: true,
        status: 200,
        statusText: "OK",
        contentType: catalog.contentType,
        body: "",
        streamingId: STREAM_ID,
        idleComplete: false,
      });
      queueMicrotask(() => {
        replayStreamingEvents(scenario, listeners);
      });
    });
  };
}

async function readUtf8Chunks(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string[]> {
  const parts: string[] = [];
  const decoder = new TextDecoder();
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    if (next.value != null) {
      parts.push(decoder.decode(next.value));
    }
  }
  return parts;
}

test("shared NDJSON catalog covers checkpoint-ops, error-then-end, and idle-complete", () => {
  assert.equal(catalog.contentType, "application/x-ndjson");
  assert.equal(checkpointOps.path, "streamingId");
  assert.equal(checkpointOps.chunks.length, 2);
  assert.equal(checkpointOps.chunks[0]?.includes('"checkpoint"'), true);
  assert.equal(checkpointOps.chunks[1]?.includes('"data"'), true);
  assert.deepEqual(checkpointOps.events, ["onData", "onData", "onEnd"]);
  assert.equal(errorThenEnd.path, "streamingId");
  assert.deepEqual(errorThenEnd.events, ["onData", "onError", "onEnd"]);
  assert.equal(idleComplete.path, "idleComplete");
  assert.deepEqual(idleComplete.events, []);
  for (const key of ["body", "bodyBase64", "idleComplete"] as const) {
    assert.equal(catalog.idleCompleteEnvelopeKeys.includes(key), true, key);
  }
  assert.equal(catalog.idleCompleteEnvelopeKeys.includes("streamingId"), false);
  assert.equal(catalog.streamingEnvelopeKeys.includes("streamingId"), true);
});

test("fixture checkpoint-ops streams onData chunks on streamingId before onEnd", async () => {
  const { emitter, listeners } = createFakeEmitter();
  await withFakeLynxHost(
    {
      platform: "Android",
      emitter,
      nativeModules: {
        NativePowerSyncModule: nativeWithHttp({
          httpFetch: streamingHttpFetch(checkpointOps, listeners),
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
      assert.equal(response.ok, true);
      const reader = response.body!.getReader();
      const first = await reader.read();
      assert.equal(first.done, false);
      assert.equal(new TextDecoder().decode(first.value), checkpointOps.chunks[0]);
      const second = await reader.read();
      assert.equal(second.done, false);
      assert.equal(new TextDecoder().decode(second.value), checkpointOps.chunks[1]);
      const end = await reader.read();
      assert.equal(end.done, true);
    },
  );
});

test("fixture error-then-end records onError then waits for onEnd", async () => {
  const { emitter, listeners } = createFakeEmitter();
  await withFakeLynxHost(
    {
      platform: "iOS",
      emitter,
      nativeModules: {
        NativePowerSyncModule: nativeWithHttp({
          httpFetch: streamingHttpFetch(errorThenEnd, listeners),
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

test("fixture idle-complete envelope is UTF-8 body without streamingId", async () => {
  const ndjson = joinedFixtureBody(idleComplete);
  const envelope: NativeHttpFetchEnvelope = {
    ok: true,
    status: 200,
    statusText: "OK",
    contentType: catalog.contentType,
    body: ndjson,
    bodyBase64: Buffer.from(ndjson, "utf8").toString("base64"),
    idleComplete: true,
  };
  const mapped = responseFromNativeHttpEnvelope(envelope);
  assert.equal(mapped.ok, true);
  assert.equal(mapped.status, 200);
  assert.equal(mapped.headers.get("content-type"), catalog.contentType);

  await withFakeLynxHost(
    {
      platform: "Android",
      nativeModules: {
        NativePowerSyncModule: nativeWithHttp({
          httpFetch(_request, callback) {
            queueMicrotask(() => {
              callback(envelope);
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
      assert.equal(response.ok, true);
      const parts = await readUtf8Chunks(response.body!.getReader());
      assert.equal(parts.join(""), ndjson);
    },
  );
});
