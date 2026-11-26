// @ts-nocheck
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  assertTarballDistHygiene,
  checkPackedConsumers,
  EXPECTED_DESKTOP_DIST_FILES,
} from "../scripts/check-packed-consumers.mjs";

const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

test("web-host attach keeps a literal optional-peer import", () => {
  const attach = readFileSync(path.join(root, "src/web-host/attach.ts"), "utf8");
  assert.match(attach, /await import\("@powersync\/web"\)/);
  assert.match(attach, /@ts-ignore TS2307/);
  assert.doesNotMatch(attach, /^\s*\/\/\s*@ts-expect-error\b/m);
});

test("tarball dist/ hygiene rejects stray architectures and enforces required desktop binaries", () => {
  assert.doesNotThrow(() => assertTarballDistHygiene(["src/index.ts", "dist/web-host/factory.js"]));

  assert.throws(
    () => assertTarballDistHygiene(["src/index.ts"]),
    /missing dist\/web-host\/factory\.js/,
  );

  assert.throws(
    () =>
      assertTarballDistHygiene([
        "dist/web-host/factory.js",
        "dist/macos/x64/libpowersync_x64.macos.dylib",
      ]),
    /unexpected dist\/ files.*dist\/macos\/x64\/libpowersync_x64\.macos\.dylib/,
  );

  assert.throws(
    () =>
      assertTarballDistHygiene([
        "dist/web-host/factory.js",
        "dist/linux/x64/libpowersync_x64.linux.so",
      ]),
    /unexpected dist\/ files.*dist\/linux\/x64\/libpowersync_x64\.linux\.so/,
  );

  assert.throws(
    () =>
      assertTarballDistHygiene(["dist/web-host/factory.js", EXPECTED_DESKTOP_DIST_FILES[0]], {
        requireDesktopBinaries: true,
      }),
    /missing required desktop binaries/,
  );

  assert.doesNotThrow(() =>
    assertTarballDistHygiene(["dist/web-host/factory.js", ...EXPECTED_DESKTOP_DIST_FILES], {
      requireDesktopBinaries: true,
    }),
  );
});

test("packed native and web consumers typecheck optional-peer web-host and resolve lynxtron export", async () => {
  const result = await checkPackedConsumers();
  assert.equal(result.tarball.endsWith(".tgz"), true);
});
