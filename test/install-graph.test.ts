import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function collectPackageNames(node, names = new Set()) {
  if (!(node instanceof Object)) {
    return names;
  }
  if (
    node.name instanceof Object === false &&
    node.name != null &&
    node.name.constructor === String
  ) {
    names.add(node.name);
  }
  const deps = node.dependencies;
  if (deps instanceof Object) {
    for (const [name, child] of Object.entries(deps)) {
      names.add(name);
      collectPackageNames(child, names);
    }
  }
  return names;
}

test("android consumer-rules.pro keeps Autolink provider and Native Module", () => {
  const rules = readFileSync(path.join(root, "android/consumer-rules.pro"), "utf8");
  assert.match(rules, /com\.powersync\.lynx\.LynxLibraryProviderImpl/);
  assert.match(rules, /com\.powersync\.lynx\.NativePowerSyncModule/);
  assert.match(rules, /com\.powersync\.lynx\.PsSqlEngine/);
});

test("package.json keeps @powersync/web as an optional peer only", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.packageManager, "pnpm@12.3.4");
  assert.equal(Object.hasOwn(pkg.dependencies ?? {}, "@powersync/web"), false);
  assert.equal(pkg.peerDependencies["@powersync/web"], "^2.3.0");
  assert.equal(pkg.peerDependenciesMeta["@powersync/web"]?.optional, true);
});

test("pnpm native install graph excludes optional web peer and WASM", () => {
  const raw = execFileSync("pnpm", ["list", "--depth", "Infinity", "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  const trees = JSON.parse(raw);
  const roots = Array.isArray(trees) ? trees : [trees];
  const names = new Set();
  for (const tree of roots) {
    collectPackageNames(tree, names);
  }

  assert.ok(names.has("@powersync/common"), "native install must include @powersync/common");
  assert.ok(
    names.has("@powersync/shared-internals"),
    "native install must include @powersync/shared-internals",
  );
  assert.equal(
    names.has("@powersync/web"),
    false,
    "optional @powersync/web peer must not be installed",
  );
  assert.equal(names.has("@journeyapps/wa-sqlite"), false, "WASM wa-sqlite must not be installed");

  assert.equal(existsSync(path.join(root, "node_modules", "@powersync", "web")), false);
  assert.equal(existsSync(path.join(root, "node_modules", "@journeyapps")), false);

  const virtual = path.join(root, "node_modules", ".pnpm");
  const virtualEntries = existsSync(virtual) ? readdirSync(virtual) : [];
  assert.equal(
    virtualEntries.some(
      (entry) => entry.startsWith("@powersync+web@") || entry.startsWith("@journeyapps+wa-sqlite@"),
    ),
    false,
    "virtual store must not materialize @powersync/web or wa-sqlite",
  );
});
