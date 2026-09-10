#!/usr/bin/env node
/**
 * Pack powersync-lynx and typecheck two scratch consumers:
 *
 *   native — tarball only, no @powersync/web
 *   web    — tarball + @powersync/web@2.3.0, imports powersync-lynx/web-host
 *
 * Also checks that the packed factory stays importable and that attach keeps
 * a literal `import("@powersync/web")` for bundler resolution.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { bundleWebHostFactory } from "./bundle-web-host-factory.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configsDir = path.join(root, "scripts/packed-consumers");
const webPeer = "@powersync/web@2.3.0";
const require = createRequire(import.meta.url);

function pnpmArgs(args) {
  try {
    const version = execFileSync("pnpm", ["-v"], { encoding: "utf8" }).trim();
    if (version.startsWith("12.")) {
      return ["pnpm", args];
    }
  } catch {
    // Fall through to corepack so packageManager 12.3.4 is used.
  }
  return ["corepack", ["pnpm", ...args]];
}

function run(command, args, cwd) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const stdout = err instanceof Error && "stdout" in err ? String(err.stdout) : "";
    const stderr = err instanceof Error && "stderr" in err ? String(err.stderr) : "";
    const detail = [stdout, stderr].filter((chunk) => chunk.length > 0).join("\n");
    throw new Error(
      `${command} ${args.join(" ")} failed in ${cwd}${detail ? `\n${detail}` : ""}`,
    );
  }
}

function runPnpm(args, cwd) {
  const [command, pnpmArgv] = pnpmArgs(args);
  return run(command, pnpmArgv, cwd);
}

function packTarball(dest) {
  const packed = runPnpm(["pack", "--pack-destination", dest, "--ignore-scripts"], root);
  const tarball = packed
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.endsWith(".tgz"));
  if (tarball == null) {
    throw new Error(`pnpm pack did not print a tarball path:\n${packed}`);
  }
  return path.isAbsolute(tarball) ? tarball : path.join(dest, path.basename(tarball));
}

function writeConsumerPackage(dest, name) {
  writeFileSync(
    path.join(dest, "package.json"),
    `${JSON.stringify(
      {
        name,
        private: true,
        type: "module",
        packageManager: "pnpm@12.3.4",
      },
      null,
      2,
    )}\n`,
  );
}

function installedWebPeer(dest) {
  return existsSync(path.join(dest, "node_modules/@powersync/web/package.json"));
}

function typecheckConsumer(dest) {
  const tsc = path.join(root, "node_modules/.bin/tsc");
  if (existsSync(tsc) === false) {
    throw new Error("typescript is not installed; run pnpm install");
  }
  run(tsc, ["-p", "tsconfig.json", "--noEmit", "--pretty", "false"], dest);
}

function assertLiteralWebImport(attachSource) {
  if (attachSource.includes('import("@powersync/web")') === false) {
    throw new Error('packed attach.ts must keep a literal import("@powersync/web")');
  }
  if (attachSource.includes("@ts-expect-error")) {
    throw new Error(
      "packed attach.ts must not use @ts-expect-error on the optional peer import",
    );
  }
}

async function assertBundlerResolvesWebImport(attachPath) {
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [attachPath],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    external: ["@powersync/web"],
    logLevel: "silent",
  });
  const text = result.outputFiles[0]?.text ?? "";
  if (text.includes("@powersync/web") === false) {
    throw new Error("bundling packed attach.ts dropped the literal @powersync/web import");
  }
}

async function assertFactoryImportable(packageRoot) {
  const factoryPath = path.join(packageRoot, "dist/web-host/factory.js");
  if (existsSync(factoryPath) === false) {
    throw new Error("published tarball is missing dist/web-host/factory.js");
  }
  const factory = await import(pathToFileURL(factoryPath).href);
  if (factory.default instanceof Function === false) {
    throw new Error("factory.js default export is not a function");
  }
}

async function installConsumer(dest, name, tarball, extraDeps) {
  await cp(path.join(configsDir, name), dest, { recursive: true });
  writeConsumerPackage(dest, `powersync-lynx-${name}-consumer`);
  const deps = [tarball, ...extraDeps];
  runPnpm(["add", ...deps, "--config.auto-install-peers=false"], dest);
  const pkgJson = path.join(dest, "node_modules/powersync-lynx/package.json");
  const pkg = require(pkgJson);
  if (pkg.name !== "powersync-lynx") {
    throw new Error(`${name} consumer resolved unexpected package name ${pkg.name}`);
  }
  return path.join(dest, "node_modules/powersync-lynx");
}

export async function checkPackedConsumers() {
  if (existsSync(path.join(root, "dist/web-host/factory.js")) === false) {
    await bundleWebHostFactory();
  }

  const work = await mkdtemp(path.join(tmpdir(), "ps-lynx-packed-"));
  try {
    const tarball = packTarball(work);
    const nativeDir = path.join(work, "native");
    const webDir = path.join(work, "web");

    const nativePkg = await installConsumer(nativeDir, "native", tarball, []);
    if (installedWebPeer(nativeDir)) {
      throw new Error("native consumer must not install optional @powersync/web");
    }
    if (existsSync(path.join(root, "node_modules/@powersync/web"))) {
      throw new Error("packed-consumer check must not add @powersync/web to the library graph");
    }
    typecheckConsumer(nativeDir);

    const webPkg = await installConsumer(webDir, "web", tarball, [webPeer]);
    if (installedWebPeer(webDir) === false) {
      throw new Error("web consumer must install @powersync/web@2.3.0");
    }
    const webPkgJson = require(path.join(webDir, "node_modules/@powersync/web/package.json"));
    if (webPkgJson.version !== "2.3.0") {
      throw new Error(`web consumer resolved @powersync/web@${webPkgJson.version}, expected 2.3.0`);
    }
    typecheckConsumer(webDir);

    const attachSource = readFileSync(path.join(webPkg, "src/web-host/attach.ts"), "utf8");
    assertLiteralWebImport(attachSource);
    await assertBundlerResolvesWebImport(path.join(webPkg, "src/web-host/attach.ts"));
    await assertFactoryImportable(nativePkg);

    if (existsSync(path.join(root, "node_modules/@powersync/web"))) {
      throw new Error("packed-consumer check must not add @powersync/web to the library graph");
    }

    return {
      tarball,
      nativeDir,
      webDir,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const invoked =
  process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  checkPackedConsumers()
    .then(() => {
      console.log("packed-consumers: native and web typecheck passed");
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      if (err instanceof Error && "stderr" in err && err.stderr) {
        console.error(String(err.stderr));
      }
      if (err instanceof Error && "stdout" in err && err.stdout) {
        console.error(String(err.stdout));
      }
      process.exit(1);
    });
}
