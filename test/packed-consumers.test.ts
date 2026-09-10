// @ts-nocheck
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkPackedConsumers } from "../scripts/check-packed-consumers.mjs";

const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

test("web-host attach keeps a literal optional-peer import", () => {
  const attach = readFileSync(path.join(root, "src/web-host/attach.ts"), "utf8");
  assert.match(attach, /await import\("@powersync\/web"\)/);
  assert.match(attach, /@ts-ignore TS2307/);
  assert.doesNotMatch(attach, /@ts-expect-error/);
});

test("packed native and web consumers typecheck optional-peer web-host", async () => {
  const result = await checkPackedConsumers();
  assert.equal(result.tarball.endsWith(".tgz"), true);
});
