#!/usr/bin/env node
/**
 * Publish dry-run against the local Verdaccio (compose profile `registry`).
 *
 *   docker compose --profile registry up -d
 *   pnpm publish-dry-run
 *
 * Publishes powersync-lynx to http://localhost:4873, then installs that
 * artifact into a scratch consumer and checks the TypeScript entry plus the
 * bundled lynx-bg factory are present and importable.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const registry = process.env.PS_LYNX_DRY_RUN_REGISTRY ?? "http://localhost:4873";
const require = createRequire(import.meta.url);

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function registryUp() {
  const response = await fetch(registry).catch(() => null);
  if (response == null || (response.ok === false && response.status !== 404)) {
    throw new Error(
      `Verdaccio is not reachable at ${registry}. From examples/: docker compose --profile registry up -d`,
    );
  }
}

async function main() {
  await registryUp();
  console.log(`publishing powersync-lynx to ${registry}`);
  try {
    process.stdout.write(
      run(
        "pnpm",
        ["publish", "--registry", registry, "--no-git-checks", "--access", "public"],
        root,
      ),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stderr = err instanceof Error && "stderr" in err ? String(err.stderr) : "";
    const combined = `${message}\n${stderr}`;
    if (combined.includes("previously published") || combined.includes("cannot publish over")) {
      console.log("already published on the local registry; continuing with install");
    } else {
      throw err;
    }
  }

  const dest = await mkdtemp(path.join(tmpdir(), "ps-lynx-consumer-"));
  try {
    await writeFile(
      path.join(dest, "package.json"),
      JSON.stringify(
        {
          name: "powersync-lynx-scratch-consumer",
          private: true,
          type: "module",
          packageManager: "pnpm@12.3.4",
        },
        null,
        2,
      ),
    );
    console.log(`installing from ${registry} into ${dest}`);
    process.stdout.write(
      run(
        "pnpm",
        ["add", "powersync-lynx", "--registry", registry, "--config.auto-install-peers=false"],
        dest,
      ),
    );

    const pkgJson = path.join(dest, "node_modules/powersync-lynx/package.json");
    const pkg = require(pkgJson);
    if (pkg.name !== "powersync-lynx") {
      throw new Error(`scratch consumer resolved unexpected package name ${pkg.name}`);
    }
    const indexPath = path.join(dest, "node_modules/powersync-lynx/src/index.ts");
    const factoryPath = path.join(dest, "node_modules/powersync-lynx/dist/web-host/factory.js");
    const { existsSync } = await import("node:fs");
    if (existsSync(indexPath) === false) {
      throw new Error("published tarball is missing src/index.ts");
    }
    if (existsSync(factoryPath) === false) {
      throw new Error("published tarball is missing dist/web-host/factory.js");
    }
    const factory = await import(factoryPath);
    if (factory.default instanceof Function === false) {
      throw new Error("factory.js default export is not a function");
    }
    console.log("publish-dry-run: scratch consumer installed powersync-lynx");
    console.log(`  src/index.ts: ${indexPath}`);
    console.log(`  dist/web-host/factory.js: ${factoryPath}`);
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
