import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const LYNX_SDK_VERSION = "4.2.0";
export const LYNX_SDK_BASE_URL = `https://github.com/lynx-family/lynx/releases/download/${LYNX_SDK_VERSION}`;
export const LYNX_SDK_CACHE_ROOT = path.join(ROOT, "third_party", "lynx-sdk");

export const LYNX_SDK_TARGETS = {
  "macos-arm64": {
    flag: "--macos-arm64",
    assetName: "lynx_sdk_macos_arm64.zip",
    sha256: "bcbc69270ce5b18ae8503c1bcd284197eb220b76acf5807ebab1efb956750469",
    destDir: path.join(LYNX_SDK_CACHE_ROOT, "macos-arm64"),
  },
  "windows-x64": {
    flag: "--windows-x64",
    assetName: "lynx_sdk_windows_x64.zip",
    sha256: "4a5a40ca5af15885f15f74cd1782f4c7780ca17471e4cb70da86a09c093384c4",
    destDir: path.join(LYNX_SDK_CACHE_ROOT, "windows-x64"),
  },
};

const STAMP_FILE = ".lynx-sdk-stamp.json";

export async function sha256File(filePath) {
  try {
    const hash = createHash("sha256");
    await pipeline(fs.createReadStream(filePath), hash);
    return hash.digest("hex");
  } catch {
    return null;
  }
}

async function downloadFile(url, destPath) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || response.body == null) {
    throw new Error(`download failed (${response.status} ${response.statusText}) for ${url}`);
  }
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.tmp-${process.pid}`;
  try {
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tmpPath));
    await fs.promises.rename(tmpPath, destPath);
  } catch (err) {
    try {
      await fs.promises.rm(tmpPath, { force: true });
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === "win32") {
    try {
      execFileSync("tar", ["-xf", zipPath, "-C", destDir], { stdio: "inherit" });
      return;
    } catch {
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Expand-Archive -LiteralPath '${zipPath.replaceAll("'", "''")}' -DestinationPath '${destDir.replaceAll("'", "''")}' -Force`,
        ],
        { stdio: "inherit" },
      );
      return;
    }
  }
  execFileSync("unzip", ["-oq", zipPath, "-d", destDir], { stdio: "inherit" });
}

function normalizeExtractedDir(extractDir) {
  if (fs.existsSync(path.join(extractDir, "include"))) {
    return extractDir;
  }
  const entries = fs
    .readdirSync(extractDir, { withFileTypes: true })
    .filter((entry) => entry.name !== "__MACOSX" && !entry.name.startsWith("."));
  if (entries.length === 1 && entries[0].isDirectory()) {
    const nested = path.join(extractDir, entries[0].name);
    if (fs.existsSync(path.join(nested, "include"))) {
      return nested;
    }
  }
  return extractDir;
}

function readStamp(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, STAMP_FILE), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function defaultTargetKey(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && arch === "arm64") {
    return "macos-arm64";
  }
  if (platform === "win32" && arch === "x64") {
    return "windows-x64";
  }
  return null;
}

export function parseArgs(argv) {
  const selected = [];
  let force = false;
  let printDir = false;

  for (const arg of argv) {
    if (arg === "--macos-arm64") {
      selected.push("macos-arm64");
    } else if (arg === "--windows-x64") {
      selected.push("windows-x64");
    } else if (arg === "--all") {
      selected.push("macos-arm64", "windows-x64");
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--print-dir") {
      printDir = true;
    } else if (arg === "--help" || arg === "-h") {
      return { help: true, selected: [], force: false, printDir: false };
    } else {
      throw new Error(
        `Unknown argument: ${arg}. Expected --macos-arm64, --windows-x64, --all, --force, or --print-dir`,
      );
    }
  }

  const deduped = [...new Set(selected)];
  if (deduped.length === 0) {
    const fallback = defaultTargetKey();
    if (fallback == null) {
      throw new Error(
        `Unsupported host platform ${process.platform}/${process.arch}; pass --macos-arm64 or --windows-x64 explicitly`,
      );
    }
    deduped.push(fallback);
  }

  return { help: false, selected: deduped, force, printDir };
}

export function resolveSdkOverride(env = process.env) {
  const raw = env.LYNX_SDK_DIR?.trim();
  if (!raw) {
    return null;
  }
  const resolved = path.resolve(raw);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`LYNX_SDK_DIR points to a non-existent directory: ${resolved}`);
  }
  return resolved;
}

async function ensureTargetSdk(targetKey, { force = false, quiet = false } = {}) {
  const target = LYNX_SDK_TARGETS[targetKey];
  const stamp = readStamp(target.destDir);
  if (
    !force &&
    stamp != null &&
    stamp.version === LYNX_SDK_VERSION &&
    stamp.sha256 === target.sha256 &&
    fs.existsSync(path.join(target.destDir, "include"))
  ) {
    if (!quiet) {
      console.log(`Lynx Desktop SDK ${LYNX_SDK_VERSION} (${targetKey}) up to date: ${target.destDir}`);
    }
    return target.destDir;
  }

  const downloadsDir = path.join(LYNX_SDK_CACHE_ROOT, "downloads");
  const zipPath = path.join(downloadsDir, `${LYNX_SDK_VERSION}-${target.assetName}`);
  const existingHash = await sha256File(zipPath);
  if (force || existingHash !== target.sha256) {
    const url = `${LYNX_SDK_BASE_URL}/${target.assetName}`;
    if (!quiet) {
      console.log(`Downloading ${url}`);
    }
    await downloadFile(url, zipPath);
    const actualHash = await sha256File(zipPath);
    if (actualHash !== target.sha256) {
      await fs.promises.rm(zipPath, { force: true });
      throw new Error(
        `SHA-256 mismatch for ${target.assetName}: expected ${target.sha256}, got ${actualHash}`,
      );
    }
  } else if (!quiet) {
    console.log(`Verified cached archive ${zipPath}`);
  }

  const stageDir = `${target.destDir}.stage-${process.pid}`;
  await fs.promises.rm(stageDir, { recursive: true, force: true });
  try {
    extractZip(zipPath, stageDir);
    const contentRoot = normalizeExtractedDir(stageDir);
    await fs.promises.rm(target.destDir, { recursive: true, force: true });
    await fs.promises.mkdir(path.dirname(target.destDir), { recursive: true });
    await fs.promises.rename(contentRoot, target.destDir);
    await fs.promises.writeFile(
      path.join(target.destDir, STAMP_FILE),
      `${JSON.stringify(
        {
          version: LYNX_SDK_VERSION,
          target: targetKey,
          assetName: target.assetName,
          sha256: target.sha256,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } finally {
    await fs.promises.rm(stageDir, { recursive: true, force: true });
  }

  if (!quiet) {
    console.log(`Extracted Lynx Desktop SDK ${LYNX_SDK_VERSION} (${targetKey}) to ${target.destDir}`);
  }
  return target.destDir;
}

function printUsage() {
  console.log(
    [
      "Usage: node scripts/fetch-lynx-desktop-sdk.mjs [options]",
      "",
      "Options:",
      "  --macos-arm64   Fetch Lynx Desktop C++ SDK for macOS arm64",
      "  --windows-x64   Fetch Lynx Desktop C++ SDK for Windows x64",
      "  --all           Fetch both macOS arm64 and Windows x64 SDKs",
      "  --force         Re-download and re-extract even if stamp matches",
      "  --print-dir     Print the resolved SDK directory path(s) to stdout",
      "  -h, --help      Show this help message",
      "",
      "Environment:",
      "  LYNX_SDK_DIR    Use a pre-installed local Lynx Desktop SDK directory instead of downloading",
    ].join("\n"),
  );
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    printUsage();
    return;
  }

  const overrideDir = resolveSdkOverride();
  if (overrideDir != null) {
    if (parsed.printDir) {
      console.log(overrideDir);
    } else {
      console.log(`Using LYNX_SDK_DIR override: ${overrideDir}`);
    }
    return;
  }

  const dirs = [];
  for (const targetKey of parsed.selected) {
    const dir = await ensureTargetSdk(targetKey, {
      force: parsed.force,
      quiet: parsed.printDir,
    });
    dirs.push(dir);
  }
  if (parsed.printDir) {
    for (const dir of dirs) {
      console.log(dir);
    }
  }
}

const isMain =
  process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
