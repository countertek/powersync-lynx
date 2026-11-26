// @ts-nocheck
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  LYNX_SDK_TARGETS,
  LYNX_SDK_VERSION,
  defaultTargetKey,
  parseArgs,
  resolveSdkOverride,
  sha256File,
} from "../scripts/fetch-lynx-desktop-sdk.mjs";

const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

test("fetch-lynx-desktop-sdk pins Lynx 4.x targets with 64-hex SHA-256 digests", () => {
  assert.match(LYNX_SDK_VERSION, /^4\./);
  for (const key of ["macos-arm64", "windows-x64"]) {
    const target = LYNX_SDK_TARGETS[key];
    assert.ok(target, `missing target ${key}`);
    assert.match(target.assetName, /^lynx_sdk_.*\.zip$/);
    assert.match(target.sha256, /^[0-9a-f]{64}$/);
  }
});

test("fetch-lynx-desktop-sdk parses platform flags and rejects unknown args", () => {
  assert.deepEqual(parseArgs(["--macos-arm64"]).selected, ["macos-arm64"]);
  assert.deepEqual(parseArgs(["--windows-x64"]).selected, ["windows-x64"]);
  assert.deepEqual(parseArgs(["--all"]).selected, ["macos-arm64", "windows-x64"]);
  assert.equal(parseArgs(["--macos-arm64", "--print-dir"]).printDir, true);
  assert.equal(parseArgs(["--help"]).help, true);
  assert.throws(() => parseArgs(["--unknown-flag"]), /Unknown argument/);

  assert.equal(defaultTargetKey("darwin", "arm64"), "macos-arm64");
  assert.equal(defaultTargetKey("win32", "x64"), "windows-x64");
  assert.equal(defaultTargetKey("linux", "x64"), null);
});

test("fetch-lynx-desktop-sdk honors LYNX_SDK_DIR override and verifies directory existence", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ps-lynx-sdk-override-"));
  try {
    assert.equal(resolveSdkOverride({ LYNX_SDK_DIR: dir }), path.resolve(dir));
    assert.equal(resolveSdkOverride({}), null);
    assert.throws(
      () => resolveSdkOverride({ LYNX_SDK_DIR: path.join(dir, "missing") }),
      /non-existent directory/,
    );

    const out = execFileSync(
      process.execPath,
      ["scripts/fetch-lynx-desktop-sdk.mjs", "--macos-arm64", "--print-dir"],
      {
        cwd: root,
        env: { ...process.env, LYNX_SDK_DIR: dir },
        encoding: "utf8",
      },
    );
    assert.equal(out.trim(), path.resolve(dir));

    const sample = path.join(dir, "sample.txt");
    await writeFile(sample, "powersync-lynx\n", "utf8");
    const digest = await sha256File(sample);
    assert.match(digest, /^[0-9a-f]{64}$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
