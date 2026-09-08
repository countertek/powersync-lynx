// @ts-nocheck
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function packedPaths(tarball) {
  const listing = execFileSync("tar", ["tzf", tarball], { encoding: "utf8" });
  return listing
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^package\//, ""));
}

test("packed tarball ships iOS build inputs and omits host/build residue", async () => {
  const dest = await mkdtemp(path.join(tmpdir(), "ps-lynx-pack-"));
  try {
    const packed = execFileSync("pnpm", ["pack", "--pack-destination", dest], {
      cwd: root,
      encoding: "utf8",
    });
    const tarball = packed
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.endsWith(".tgz"));
    assert.ok(tarball, packed);
    const archive = path.isAbsolute(tarball) ? tarball : path.join(dest, path.basename(tarball));
    const files = packedPaths(archive);
    const has = (name) =>
      files.includes(name) || files.some((file) => file === name || file.startsWith(`${name}/`));

    assert.equal(
      has("scripts/fetch-native-deps.mjs"),
      true,
      "podspec prepare_command needs fetch-native-deps.mjs",
    );
    assert.equal(has("third_party/sqlite/sqlite3.c"), true, "podspec source_files needs sqlite3.c");
    assert.equal(has("third_party/sqlite/sqlite3.h"), true, "podspec source_files needs sqlite3.h");
    assert.equal(has("ios/powersync-lynx.podspec"), true);
    assert.equal(
      has("dist/web-host/factory.js"),
      true,
      "attach factory URL needs the bundled ESM entry",
    );

    assert.equal(
      files.some((file) => file.startsWith("android/host/")),
      false,
      "android host test stubs must not ship",
    );
    assert.equal(
      files.some((file) => file.startsWith("shared/build/")),
      false,
      "shared/build residue must not ship",
    );
    assert.equal(
      files.some((file) => file.startsWith("ios/tests/")),
      false,
      "ios test harness must not ship",
    );
    assert.equal(
      files.some((file) => file.startsWith("shared/tests/")),
      false,
      "shared C++ tests must not ship",
    );
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
});
