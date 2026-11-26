import fs from "node:fs";
import path from "node:path";

export interface HostConfig {
  device: string;
  demoApiUrl: string;
  powersyncUrl: string;
  bundlePath: string;
  windowless: boolean;
}

export interface ShowcaseGlobalProps {
  device: string;
  demoApiUrl: string;
  powersyncUrl: string;
}

const DEFAULT_DEVICE = "lynxtron";
const DEFAULT_DEMO_API_URL = "http://127.0.0.1:8081";
const DEFAULT_POWERSYNC_URL = "http://127.0.0.1:8080";

function readArgValue(argv: readonly string[], flags: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token == null) {
      continue;
    }
    for (const flag of flags) {
      if (token === flag && i + 1 < argv.length) {
        const next = argv[i + 1]?.trim();
        if (next != null && next.length > 0 && !next.startsWith("-")) {
          return next;
        }
      }
      if (token.startsWith(`${flag}=`)) {
        const value = token.slice(flag.length + 1).trim();
        if (value.length > 0) {
          return value;
        }
      }
    }
  }
  return undefined;
}

function hasFlag(argv: readonly string[], flags: readonly string[]): boolean {
  return argv.some((token) => flags.includes(token));
}

function firstNonEmpty(...values: ReadonlyArray<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed != null && trimmed.length > 0) {
      return trimmed;
    }
  }
  return "";
}

function isTruthyEnv(value: string | undefined): boolean {
  if (value == null) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function defaultBundlePath(entryDir: string): string {
  const candidates = [
    // Compiled entry lives at examples/hosts/lynxtron/dist/desktop/main.js
    path.resolve(entryDir, "../../../../showcase/lynx-dist/main.lynx.bundle"),
    // Unbundled source lives at examples/hosts/lynxtron/src/main.ts
    path.resolve(entryDir, "../../../showcase/lynx-dist/main.lynx.bundle"),
    // Fallback relative to CWD when launched from examples/hosts/lynxtron/
    path.resolve(process.cwd(), "../../showcase/lynx-dist/main.lynx.bundle"),
    // Fallback relative to CWD when launched from repository root
    path.resolve(process.cwd(), "examples/showcase/lynx-dist/main.lynx.bundle"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0]!;
}

export function resolveHostConfig(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  entryDir: string,
): HostConfig {
  const device = firstNonEmpty(
    readArgValue(argv, ["--device", "-DemoDevice"]),
    env.DEMO_DEVICE,
    DEFAULT_DEVICE,
  );
  const demoApiUrl = firstNonEmpty(
    readArgValue(argv, ["--demo-api-url", "-DemoApiUrl"]),
    env.DEMO_API_URL,
    DEFAULT_DEMO_API_URL,
  ).replace(/\/$/, "");
  const powersyncUrl = firstNonEmpty(
    readArgValue(argv, ["--powersync-url", "-PowerSyncUrl"]),
    env.POWERSYNC_URL,
    DEFAULT_POWERSYNC_URL,
  ).replace(/\/$/, "");
  const explicitBundle = firstNonEmpty(
    readArgValue(argv, ["--bundle", "-Bundle"]),
    env.LYNX_BUNDLE_PATH,
  );
  const bundlePath =
    explicitBundle.length > 0
      ? path.resolve(process.cwd(), explicitBundle)
      : defaultBundlePath(entryDir);
  const windowless =
    hasFlag(argv, ["--windowless", "--headless"]) || isTruthyEnv(env.LYNXTRON_WINDOWLESS);

  return {
    device,
    demoApiUrl,
    powersyncUrl,
    bundlePath,
    windowless,
  };
}

export function toGlobalProps(config: HostConfig): ShowcaseGlobalProps {
  return {
    device: config.device,
    demoApiUrl: config.demoApiUrl,
    powersyncUrl: config.powersyncUrl,
  };
}
