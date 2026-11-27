import assert from "node:assert/strict";
import { test } from "node:test";

import { createLynxTextDecoder } from "../src/sync/transport/bytes.ts";
import {
  fixtureWireBytes,
  joinedFixtureBody,
  loadSyncStreamFixtures,
  requireScenario,
} from "./fixtures/sync-stream.ts";

const catalog = loadSyncStreamFixtures();
const splitMultibyte = requireScenario(catalog, "split-multibyte");

test("split-multibyte fixture pins createLynxTextDecoder UTF-8 hold to shared wire bytes", () => {
  assert.equal(splitMultibyte.path, "streamingId");
  assert.ok(splitMultibyte.wireChunksHex != null && splitMultibyte.wireChunksHex.length === 2);
  assert.equal(splitMultibyte.chunks.length, 2);
  assert.deepEqual(splitMultibyte.events, ["onData", "onData", "onEnd"]);

  const wire = fixtureWireBytes(splitMultibyte);
  const decoder = createLynxTextDecoder();
  const first = decoder.decode(wire[0], { stream: true });
  const second = decoder.decode(wire[1], { stream: true });
  const flushed = decoder.decode(undefined, { stream: false });
  assert.equal(first, splitMultibyte.chunks[0]);
  assert.equal(second, splitMultibyte.chunks[1]);
  assert.equal(flushed, "");
  assert.equal(first + second, joinedFixtureBody(splitMultibyte));
});
