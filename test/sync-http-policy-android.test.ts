// @ts-nocheck
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const javaDir = path.join(root, "android/src/main/java/com/powersync/lynx");
const consumers = ["IdleCompleteHttp.java", "StreamingHttp.java", "NativeSyncHttp.java"];

test("C header and Android SyncHttpPolicy.java stay equal", () => {
  const out = execFileSync("node", ["scripts/gen-sync-http-policy-java.mjs", "--check"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.match(out, /ok: SyncHttpPolicy\.java matches shared\/sync_http_policy\.h/);
});

test("Android HTTP consumers read SyncHttpPolicy instead of copied literals", () => {
  for (const file of consumers) {
    const src = readFileSync(path.join(javaDir, file), "utf8");
    assert.match(src, /SyncHttpPolicy\./, `${file} must reference SyncHttpPolicy`);
    assert.equal(
      /static\s+final\s+long/.test(src),
      false,
      `${file} must not redeclare long policy constants`,
    );
    assert.equal(
      /static\s+final\s+String\s+STREAM_EVENT_PREFIX/.test(src),
      false,
      `${file} must not redeclare STREAM_EVENT_PREFIX`,
    );
    assert.equal(
      src.includes('"NativePowerSyncHttpStream"'),
      false,
      `${file} must not hard-code NativePowerSyncHttpStream`,
    );
  }
});
