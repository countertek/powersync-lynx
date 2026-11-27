import { installAbortControllerPolyfill } from "./abort-controller.ts";
import type { NativePowerSyncModule } from "./adapter/native.ts";
import type { LynxFetchModule, NativeSyncHttpModule } from "./sync/transport/http-types.ts";
import { browserTabPrimitives, type TabPrimitives } from "./tabs.ts";
import { isFunction, isNonNullObject, isString } from "./type-guards.ts";

export interface LynxStreamEventFields {
  event?: string;
  data?: string | Uint8Array | ArrayBuffer;
  error?: string;
}

export type LynxStreamEventPayload = LynxStreamEventFields | readonly LynxStreamEventFields[];

export interface LynxGlobalEventEmitter {
  addListener?(eventName: string, listener: (payload: LynxStreamEventPayload) => void): void;
  emit?(eventName: string, payload: LynxStreamEventPayload): void;
  trigger?(eventName: string, payload: LynxStreamEventPayload): void;
  getJSModule?(name: string): LynxGlobalEventEmitter | undefined;
}

export interface LynxRuntime {
  getJSModule?(name: string): LynxGlobalEventEmitter | undefined;
  getApp?(): { GlobalEventEmitter?: LynxGlobalEventEmitter };
  GlobalEventEmitter?: LynxGlobalEventEmitter;
}

export interface LynxSystemInfo {
  platform?: string;
}

export interface LynxTextCodecHelper {
  decode(buffer: ArrayBuffer): string;
}

export interface NativeModulesHost {
  /** SQL RPC; iOS/Android/Desktop hosts may also carry NativeSyncHttp methods. */
  NativePowerSyncModule?: NativePowerSyncModule & Partial<NativeSyncHttpModule>;
  LynxFetchModule?: LynxFetchModule;
}

/**
 * Module-local PrimJS identifiers so the Lynx bundler keeps `lynx` / `fetch`.
 * Not `declare global` — `@lynx-js/types` already declares those vars (TS2403).
 */
declare const NativeModules: NativeModulesHost | undefined;
declare const TextCodecHelper: LynxTextCodecHelper | undefined;
declare const lynx: LynxRuntime | undefined;
declare const SystemInfo: LynxSystemInfo | undefined;

interface PrimJSGlobalBindings {
  NativeModules?: NativeModulesHost;
  SystemInfo?: LynxSystemInfo;
  TextCodecHelper?: LynxTextCodecHelper;
  lynx?: LynxRuntime;
}

function primJSGlobalThis(): PrimJSGlobalBindings {
  // SAFETY: tests and some hosts put PrimJS bindings on globalThis; Lynx types
  // declare a different shape, so we do not read them as NativeModulesHost.
  return globalThis as PrimJSGlobalBindings;
}

installAbortControllerPolyfill();

/**
 * Host HTTP. PrimJS may put `fetch` on the identifier, not `globalThis`.
 */
export type HostFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * PrimJS / host-global seam for the Client.
 *
 * One interface for SQL RPC, sync HTTP, LynxFetchModule, GlobalEventEmitter
 * observation, platform, text codec, fetch, and cross-tab primitives.
 * Production uses {@link PrimJSLynxHost}; tests install a fake via {@link setLynxHost}.
 * Not the Host helper (WASQLite `attach`).
 */
export interface LynxHost {
  sqlModule(): NativePowerSyncModule | undefined;
  syncHttpModule(): NativeSyncHttpModule | undefined;
  lynxFetchModule(): LynxFetchModule | undefined;
  /**
   * Observe current and future GlobalEventEmitters from the host runtime.
   * Returns all emitters currently known to the host.
   */
  observeGlobalEventEmitters(
    onEmitter?: (emitter: LynxGlobalEventEmitter) => void,
  ): LynxGlobalEventEmitter[];
  platform(): string | undefined;
  textCodec(): LynxTextCodecHelper | undefined;
  fetchImpl(): HostFetch | undefined;
  /** Cross-tab locks and channels; undefined off the web. */
  tabs(): TabPrimitives | undefined;
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

export function hostIsIOS(host: LynxHost = getLynxHost()): boolean {
  const platform = host.platform();
  if (!isString(platform)) {
    return false;
  }
  return platform.toLowerCase() === "ios";
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

function collectRuntimeEmitters(runtime: LynxRuntime | undefined): LynxGlobalEventEmitter[] {
  const found: LynxGlobalEventEmitter[] = [];
  if (runtime == null) {
    return found;
  }
  addUniqueEmitter(found, callGetJSModule(runtime, "GlobalEventEmitter"));
  addUniqueEmitter(found, runtime.getApp?.()?.GlobalEventEmitter);
  addUniqueEmitter(found, runtime.GlobalEventEmitter);
  return found;
}

function extractSyncHttpModule(
  mod: (NativePowerSyncModule & Partial<NativeSyncHttpModule>) | undefined,
): NativeSyncHttpModule | undefined {
  if (mod == null || mod.httpFetch == null) {
    return undefined;
  }
  const syncHttp: NativeSyncHttpModule = { httpFetch: mod.httpFetch };
  if (mod.httpFetchAbort != null) {
    syncHttp.httpFetchAbort = mod.httpFetchAbort;
  }
  return syncHttp;
}

function publishDesktopStreamEmitter(emitter: LynxGlobalEventEmitter): void {
  try {
    // Expose the lexical BTS GlobalEventEmitter non-enumerably on globalThis
    // (scoped per-LynxView / Napi::Env) so Desktop N-API NativePowerSyncModule
    // can resolve it without host wiring even when `lynx` is closure-scoped.
    Object.defineProperty(globalThis, "__psLynxGlobalEventEmitter", {
      value: emitter,
      configurable: true,
      writable: true,
      enumerable: false,
    });
  } catch {
    // Read-only globalThis in restricted test environments.
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

function nativeModulesFromGlobalThis(): NativeModulesHost | undefined {
  const table = primJSGlobalThis().NativeModules;
  if (!isNonNullObject(table)) {
    return undefined;
  }
  // SAFETY: PrimJS NativeModules is a host bag. Lynx's published type shares no
  // keys with NativeModulesHost (TS2559 under rspeedy). Fields are read at runtime.
  return table as NativeModulesHost;
}

function nativeModulesFromBareIdentifier(): NativeModulesHost | undefined {
  try {
    const table = NativeModules;
    if (!isNonNullObject(table)) {
      return undefined;
    }
    // SAFETY: same PrimJS bag as nativeModulesFromGlobalThis; bare identifier is
    // the Lynx binding when it is not on globalThis.
    return table as NativeModulesHost;
  } catch {
    return undefined;
  }
}

/**
 * Production adapter. Each method preserves the PrimJS lookup order for that
 * binding (globalThis, bare identifier, eval) so bundlers keep `lynx` / `fetch`.
 */
export class PrimJSLynxHost implements LynxHost {
  private readonly hookedRuntimes = new WeakSet<LynxRuntime>();
  private readonly emitterObservers = new Set<(emitter: LynxGlobalEventEmitter) => void>();

  private resolveNativeModules(): NativeModulesHost | undefined {
    const fromGlobalThis = nativeModulesFromGlobalThis();
    const fromBinding = nativeModulesFromBareIdentifier();
    let sql = fromGlobalThis?.NativePowerSyncModule ?? fromBinding?.NativePowerSyncModule;
    let fetchMod = fromGlobalThis?.LynxFetchModule ?? fromBinding?.LynxFetchModule;
    let fromEval: NativeModulesHost | undefined;
    if (sql == null && fetchMod == null && fromBinding == null) {
      fromEval = evalBinding<NativeModulesHost>(
        "typeof NativeModules === 'undefined' ? undefined : NativeModules",
      );
      sql = fromEval?.NativePowerSyncModule;
      fetchMod = fromEval?.LynxFetchModule;
    }
    if (sql == null && fetchMod == null) {
      return fromBinding ?? fromEval ?? fromGlobalThis;
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

  private resolveRuntime(): LynxRuntime | undefined {
    try {
      // Bare `lynx` so the Lynx bundler keeps the runtime global (eval/globalThis miss it).
      if (lynx != null) {
        return lynx;
      }
    } catch {
      // Unbound identifier outside Lynx.
    }
    const fromGlobalThis = primJSGlobalThis().lynx;
    if (fromGlobalThis != null) {
      return fromGlobalThis;
    }
    return evalBinding<LynxRuntime>("typeof lynx === 'undefined' ? undefined : lynx");
  }

  private hookRuntimeGetJSModule(runtime: LynxRuntime | undefined): void {
    if (runtime == null || !isFunction(runtime.getJSModule) || this.hookedRuntimes.has(runtime)) {
      return;
    }
    this.hookedRuntimes.add(runtime);
    const orig = runtime.getJSModule.bind(runtime);
    runtime.getJSModule = (name: string) => {
      const mod = orig(name);
      if (name === "GlobalEventEmitter" && mod != null) {
        publishDesktopStreamEmitter(mod);
        for (const observer of this.emitterObservers) {
          observer(mod);
        }
      }
      return mod;
    };
  }

  sqlModule(): NativePowerSyncModule | undefined {
    return this.resolveNativeModules()?.NativePowerSyncModule;
  }

  syncHttpModule(): NativeSyncHttpModule | undefined {
    return extractSyncHttpModule(this.resolveNativeModules()?.NativePowerSyncModule);
  }

  lynxFetchModule(): LynxFetchModule | undefined {
    return this.resolveNativeModules()?.LynxFetchModule;
  }

  observeGlobalEventEmitters(
    onEmitter?: (emitter: LynxGlobalEventEmitter) => void,
  ): LynxGlobalEventEmitter[] {
    const runtime = this.resolveRuntime();
    this.hookRuntimeGetJSModule(runtime);
    const alreadyObserved = onEmitter != null && this.emitterObservers.has(onEmitter);
    const emitters = collectRuntimeEmitters(runtime);
    if (emitters.length > 0) {
      publishDesktopStreamEmitter(emitters[0]!);
    }
    if (onEmitter != null) {
      this.emitterObservers.add(onEmitter);
      if (!alreadyObserved) {
        for (const emitter of emitters) {
          onEmitter(emitter);
        }
      }
    }
    return emitters;
  }

  platform(): string | undefined {
    const fromGlobal = primJSGlobalThis().SystemInfo;
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
    const fromGlobalThis = primJSGlobalThis().TextCodecHelper;
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
    const fromGlobal = globalThis.fetch;
    if (isFunction(fromGlobal)) {
      return fromGlobal;
    }
    try {
      const fromBinding = fetch;
      if (isFunction(fromBinding)) {
        return fromBinding;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  tabs(): TabPrimitives | undefined {
    return browserTabPrimitives();
  }
}
