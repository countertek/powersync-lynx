// @ts-nocheck
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "vite";
import { attach } from "../src/web-host/attach.ts";
import { MODULE_NAME } from "../src/web-host/page-rpc.ts";
import { bundleWebHostFactory } from "../scripts/bundle-web-host-factory.mjs";

const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

await bundleWebHostFactory();

test("attach factory URL is executable ESM after a Vite library build", async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), "ps-lynx-factory-"));
  try {
    await build({
      configFile: false,
      root,
      logLevel: "silent",
      build: {
        outDir,
        emptyOutDir: true,
        write: true,
        lib: {
          entry: path.join(root, "src/web-host/attach.ts"),
          formats: ["es"],
          fileName: () => "attach.js",
        },
        rollupOptions: {
          external: ["@powersync/web"],
        },
      },
    });
    const built = path.join(outDir, "attach.js");
    const builtAttach = await import(built);
    const lynxView = { nativeModulesMap: {} };
    builtAttach.attach(lynxView);
    const factoryUrl = lynxView.nativeModulesMap[MODULE_NAME];
    assert.equal(factoryUrl.constructor, String);
    assert.doesNotMatch(factoryUrl, /^blob:/);
    const factory = await import(factoryUrl);
    assert.equal(factory.default instanceof Function, true);
    const methods = factory.default({}, () => {});
    assert.equal(methods.open instanceof Function, true);
    assert.equal(methods.execute instanceof Function, true);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("in-repo attach factory URL loads as ESM", async () => {
  const lynxView = { nativeModulesMap: {} };
  attach(lynxView);
  const factoryUrl = lynxView.nativeModulesMap[MODULE_NAME];
  const factory = await import(factoryUrl);
  assert.equal(factory.default instanceof Function, true);
  const methods = factory.default({}, () => {});
  assert.equal(methods.open instanceof Function, true);
  assert.equal(methods.execute instanceof Function, true);
});
