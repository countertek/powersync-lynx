import { installAbortControllerPolyfill } from "./abort-controller.ts";
import "./globals.ts";
import type { NativeModulesHost, NativePowerSyncModule } from "./adapter/native.ts";
import type { LynxFetchModule } from "./sync/transport/http-types.ts";
import type {
  LynxGlobalEventEmitter,
  LynxRuntime,
  LynxSystemInfo,
  LynxTextCodecHelper,
} from "./globals.ts";
import { isNonNullObject, isString } from "./type-guards.ts";

installAbortControllerPolyfill();

/**
 * Host HTTP. PrimJS may put `fetch` on the identifier, not `globalThis`.
 */
export type HostFetch = (input: string, init?: RequestInit) => Promise<Response>;

export function isHostFetch(value: unknown): value is HostFetch {
  return typeof value === "function";
}

/**
 * PrimJS / host-global seam for the Client.
 *
 * One interface for Native Module lookup, GlobalEventEmitter, platform,
 * text codec, and fetch. Production uses {@link PrimJSLynxHost}; tests install
 * a fake via {@link setLynxHost}. Not the Host helper (WASQLite `attach`).
 */
export interface LynxHost {
  nativeModules(): NativeModulesHost | undefined;
  runtime(): LynxRuntime | undefined;
  globalEventEmitters(): LynxGlobalEventEmitter[];
  platform(): string | undefined;
  textCodec(): LynxTextCodecHelper | undefined;
  fetchImpl(): HostFetch | undefined;
}

let installed: LynxHost | undefined;

export function getLynxHost(): LynxHost {
  if (installed == null) {
    installed = new PrimJSLynxHost();
  }
  return installed;
}

export function setLynxHost(host: LynxHost): void {
  installed = host;
}

export function resetLynxHost(): void {
  installed = undefined;
}

export function hostIsAndroid(host: LynxHost = getLynxHost()): boolean {
  const platform = host.platform();
  if (!isString(platform)) {
    return false;
  }
  return platform.toLowerCase() === "android";
}

export function collectGlobalEventEmitters(
  runtime: LynxRuntime | undefined,
): LynxGlobalEventEmitter[] {
  const found: LynxGlobalEventEmitter[] = [];
  if (runtime == null) {
    return found;
  }
  addUniqueEmitter(found, callGetJSModule(runtime, "GlobalEventEmitter"));
  addUniqueEmitter(found, runtime.getApp?.()?.GlobalEventEmitter);
  addUniqueEmitter(found, runtime.GlobalEventEmitter);
  return found;
}

function addUniqueEmitter(
  found: LynxGlobalEventEmitter[],
  emitter: LynxGlobalEventEmitter | undefined,
): void {
  if (emitter != null && !found.includes(emitter)) {
    found.push(emitter);
  }
}

function callGetJSModule(runtime: LynxRuntime, name: string): LynxGlobalEventEmitter | undefined {
  const getJSModule = runtime.getJSModule;
  if (getJSModule == null) {
    return undefined;
  }
  try {
    return getJSModule(name);
  } catch {
    return undefined;
  }
}

/**
 * Last-rung PrimJS lookup. Host bindings often exist as identifiers, not on globalThis.
 */
function evalBinding<T>(source: string): T | undefined {
  try {
    // SAFETY: eval reads a PrimJS identifier; T is the known host binding type.
    return (0, eval)(source) as T | undefined;
  } catch {
    return undefined;
  }
}

function tableHasModules(host: NativeModulesHost | undefined): host is NativeModulesHost {
  return host != null && (host.NativePowerSyncModule != null || host.LynxFetchModule != null);
}

/**
 * Lynx's published `NativeModules` type (rspeedy / `@lynx-js/types`) does not
 * overlap {@link NativeModulesHost} — assigning it directly is TS2559. Probe
 * the PrimJS bag as `unknown` and read our fields at runtime.
 */
function asNativeModulesTable(value: unknown): NativeModulesHost | undefined {
  if (!isNonNullObject(value)) {
    return undefined;
  }
  // SAFETY: PrimJS NativeModules is a host bag; Lynx's type has no shared keys.
  return value as NativeModulesHost;
}

function readBareNativeModules(): unknown {
  try {
    return NativeModules as unknown;
  } catch {
    return undefined;
  }
}

function nativeModuleField<K extends "NativePowerSyncModule" | "LynxFetchModule">(
  table: NativeModulesHost | undefined,
  field: K,
): NativeModulesHost[K] {
  if (table == null) {
    return undefined;
  }
  return table[field];
}

/**
 * Production adapter. Each method preserves the PrimJS lookup order for that
 * binding (globalThis, bare identifier, eval) so bundlers keep `lynx` / `fetch`.
 */
export class PrimJSLynxHost implements LynxHost {
  nativeModules(): NativeModulesHost | undefined {
    const sql = this.lookupNativePowerSyncModule();
    const fetchMod = this.lookupLynxFetchModule();
    if (sql == null && fetchMod == null) {
      return this.lookupNativeModulesTable();
    }
    const host: NativeModulesHost = {};
    if (sql != null) {
      host.NativePowerSyncModule = sql;
    }
    if (fetchMod != null) {
      host.LynxFetchModule = fetchMod;
    }
    return host;
  }

  runtime(): LynxRuntime | undefined {
    try {
      // Bare `lynx` so the Lynx bundler keeps the runtime global (eval/globalThis miss it).
      if (lynx != null) {
        return lynx;
      }
    } catch {
      // Unbound identifier outside Lynx.
    }
    if (globalThis.lynx != null) {
      return globalThis.lynx;
    }
    return evalBinding<LynxRuntime>("typeof lynx === 'undefined' ? undefined : lynx");
  }

  globalEventEmitters(): LynxGlobalEventEmitter[] {
    return collectGlobalEventEmitters(this.runtime());
  }

  platform(): string | undefined {
    const fromGlobal = globalThis.SystemInfo;
    if (isString(fromGlobal?.platform)) {
      return fromGlobal.platform;
    }
    try {
      if (isString(SystemInfo?.platform)) {
        return SystemInfo.platform;
      }
    } catch {
      // Unbound identifier outside Lynx.
    }
    const fromEval = evalBinding<LynxSystemInfo>(
      "typeof SystemInfo === 'undefined' ? undefined : SystemInfo",
    );
    if (isString(fromEval?.platform)) {
      return fromEval.platform;
    }
    return undefined;
  }

  textCodec(): LynxTextCodecHelper | undefined {
    const fromGlobalThis = globalThis.TextCodecHelper;
    if (fromGlobalThis != null) {
      return fromGlobalThis;
    }
    try {
      if (TextCodecHelper != null) {
        return TextCodecHelper;
      }
    } catch {
      // Unbound identifier outside Lynx.
    }
    return evalBinding<LynxTextCodecHelper>(
      "typeof TextCodecHelper === 'undefined' ? undefined : TextCodecHelper",
    );
  }

  fetchImpl(): HostFetch | undefined {
    const fromGlobal = globalThis.fetch as unknown;
    if (isHostFetch(fromGlobal)) {
      return fromGlobal;
    }
    try {
      const fromBinding = fetch as unknown;
      if (isHostFetch(fromBinding)) {
        return fromBinding;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private lookupNativeModulesTable(): NativeModulesHost | undefined {
    const fromGlobalThis = asNativeModulesTable(globalThis.NativeModules as unknown);
    if (tableHasModules(fromGlobalThis)) {
      return fromGlobalThis;
    }
    const fromBinding = asNativeModulesTable(readBareNativeModules());
    if (tableHasModules(fromBinding)) {
      return fromBinding;
    }
    if (fromBinding != null) {
      return fromBinding;
    }
    const fromEval = evalBinding<NativeModulesHost>(
      "typeof NativeModules === 'undefined' ? undefined : NativeModules",
    );
    if (fromEval != null) {
      return fromEval;
    }
    return fromGlobalThis;
  }

  private lookupNativePowerSyncModule(): NativePowerSyncModule | undefined {
    const fromGlobalThis = nativeModuleField(
      asNativeModulesTable(globalThis.NativeModules as unknown),
      "NativePowerSyncModule",
    );
    if (fromGlobalThis != null) {
      return fromGlobalThis;
    }
    const fromBinding = nativeModuleField(
      asNativeModulesTable(readBareNativeModules()),
      "NativePowerSyncModule",
    );
    if (fromBinding != null) {
      return fromBinding;
    }
    const table = evalBinding<NativeModulesHost>(
      "typeof NativeModules === 'undefined' ? undefined : NativeModules",
    );
    return nativeModuleField(table, "NativePowerSyncModule");
  }

  private lookupLynxFetchModule(): LynxFetchModule | undefined {
    const fromGlobalThis = nativeModuleField(
      asNativeModulesTable(globalThis.NativeModules as unknown),
      "LynxFetchModule",
    );
    if (fromGlobalThis != null) {
      return fromGlobalThis;
    }
    const fromBinding = nativeModuleField(
      asNativeModulesTable(readBareNativeModules()),
      "LynxFetchModule",
    );
    if (fromBinding != null) {
      return fromBinding;
    }
    const table = evalBinding<NativeModulesHost>(
      "typeof NativeModules === 'undefined' ? undefined : NativeModules",
    );
    return nativeModuleField(table, "LynxFetchModule");
  }
}

export type { LynxGlobalEventEmitter, LynxRuntime, LynxTextCodecHelper } from "./globals.ts";
