import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createLynxTextDecoder } from "../src/sync/text-decoder.ts";
import { trailingIncompleteUtf8Bytes } from "../src/sync/transport/bytes.ts";
import {
  fixtureWireBytes,
  joinedFixtureBody,
  loadSyncStreamFixtures,
  requireScenario,
} from "./fixtures/sync-stream.ts";

const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const catalog = loadSyncStreamFixtures();
const splitMultibyte = requireScenario(catalog, "split-multibyte");

test("split-multibyte fixture pins JS trailingIncompleteUtf8Bytes to shared wire bytes", () => {
  assert.equal(splitMultibyte.path, "streamingId");
  assert.ok(splitMultibyte.wireChunksHex != null && splitMultibyte.wireChunksHex.length === 2);
  assert.equal(splitMultibyte.chunks.length, 2);
  assert.deepEqual(splitMultibyte.events, ["onData", "onData", "onEnd"]);

  const wire = fixtureWireBytes(splitMultibyte);
  assert.equal(trailingIncompleteUtf8Bytes(wire[0]!), 1, "3-byte euro lead is held");
  const joined = new Uint8Array(wire[0]!.length + wire[1]!.length);
  joined.set(wire[0]!, 0);
  joined.set(wire[1]!, wire[0]!.length);
  assert.equal(trailingIncompleteUtf8Bytes(joined), 0);
  assert.equal(new TextDecoder().decode(joined), joinedFixtureBody(splitMultibyte));

  const decoder = createLynxTextDecoder();
  const first = decoder.decode(wire[0], { stream: true });
  const second = decoder.decode(wire[1], { stream: true });
  assert.equal(first, splitMultibyte.chunks[0]);
  assert.equal(second, splitMultibyte.chunks[1]);
});

test("bytes.ts keeps its own hold copy; native sources do not", () => {
  const bytesTs = readFileSync(path.join(root, "src/sync/transport/bytes.ts"), "utf8");
  assert.match(bytesTs, /export function trailingIncompleteUtf8Bytes/);
  assert.match(bytesTs, /0xc0/);

  const java = readFileSync(
    path.join(root, "android/src/main/java/com/powersync/lynx/StreamingHttp.java"),
    "utf8",
  );
  assert.match(java, /static native int trailingIncompleteUtf8Bytes/);
  assert.equal(java.includes("& 0xc0"), false);

  const mm = readFileSync(path.join(root, "ios/src/StreamingHttp.mm"), "utf8");
  assert.match(mm, /ps_utf8_trailing_incomplete/);
  assert.equal(mm.includes("TrailingIncompleteUtf8Bytes"), false);
});
