import type { NativePowerSyncModule } from "../src/adapter/native.ts";
import {
  resetLynxHost,
  setLynxHost,
  type HostFetch,
  type LynxGlobalEventEmitter,
  type LynxHost,
  type LynxRuntime,
  type LynxStreamEventPayload,
  type LynxTextCodecHelper,
  type NativeModulesHost,
} from "../src/host.ts";
import type { LynxFetchModule, NativeSyncHttpModule } from "../src/sync/transport/http-types.ts";
import type { TabPrimitives } from "../src/tabs.ts";
import { isFunction } from "../src/type-guards.ts";

export interface FakeLynxHostState {
  nativeModules?: NativeModulesHost;
  runtime?: LynxRuntime;
  emitter?: LynxGlobalEventEmitter;
  platform?: string;
  textCodec?: LynxTextCodecHelper;
  fetchImpl?: HostFetch;
  tabs?: TabPrimitives;
}

export function runtimeFromEmitter(emitter: LynxGlobalEventEmitter): LynxRuntime {
  return {
    getJSModule(name: string) {
      if (name === "GlobalEventEmitter") {
        return emitter;
      }
      return undefined;
    },
    GlobalEventEmitter: emitter,
  };
}

/** Distinct getJSModule vs runtime.GlobalEventEmitter objects (multi-emitter host). */
export function runtimeFromEmitters(
  fromGetJSModule: LynxGlobalEventEmitter,
  fromRuntimeField: LynxGlobalEventEmitter,
): LynxRuntime {
  return {
    getJSModule(name: string) {
      if (name === "GlobalEventEmitter") {
        return fromGetJSModule;
      }
      return undefined;
    },
    GlobalEventEmitter: fromRuntimeField,
  };
}

function addUniqueEmitter(
  found: LynxGlobalEventEmitter[],
  emitter: LynxGlobalEventEmitter | undefined,
): void {
  if (emitter != null && !found.includes(emitter)) {
    found.push(emitter);
  }
}

function collectEmitters(runtime: LynxRuntime | undefined): LynxGlobalEventEmitter[] {
  const found: LynxGlobalEventEmitter[] = [];
  if (runtime == null) {
    return found;
  }
  const getJSModule = runtime.getJSModule;
  if (getJSModule != null) {
    try {
      addUniqueEmitter(found, getJSModule("GlobalEventEmitter"));
    } catch {
      // Ignore throwing runtime stubs in tests.
    }
  }
  addUniqueEmitter(found, runtime.getApp?.()?.GlobalEventEmitter);
  addUniqueEmitter(found, runtime.GlobalEventEmitter);
  return found;
}

export class FakeLynxHost implements LynxHost {
  private readonly modules: NativeModulesHost | undefined;
  private readonly runtimeValue: LynxRuntime | undefined;
  private readonly platformValue: string | undefined;
  private readonly codec: LynxTextCodecHelper | undefined;
  private readonly fetchValue: HostFetch | undefined;
  private readonly tabsValue: TabPrimitives | undefined;
  private readonly hookedRuntimes = new WeakSet<LynxRuntime>();
  private readonly emitterObservers = new Set<(emitter: LynxGlobalEventEmitter) => void>();

  constructor(state: FakeLynxHostState) {
    this.modules = state.nativeModules;
    this.platformValue = state.platform;
    this.codec = state.textCodec;
    this.fetchValue = state.fetchImpl;
    this.tabsValue = state.tabs;
    if (state.runtime != null) {
      this.runtimeValue = state.runtime;
    } else if (state.emitter != null) {
      this.runtimeValue = runtimeFromEmitter(state.emitter);
    }
  }

  private hookRuntime(): void {
    const runtime = this.runtimeValue;
    if (runtime == null || !isFunction(runtime.getJSModule) || this.hookedRuntimes.has(runtime)) {
      return;
    }
    this.hookedRuntimes.add(runtime);
    const orig = runtime.getJSModule.bind(runtime);
    runtime.getJSModule = (name: string) => {
      const mod = orig(name);
      if (name === "GlobalEventEmitter" && mod != null) {
        for (const observer of this.emitterObservers) {
          observer(mod);
        }
      }
      return mod;
    };
  }

  sqlModule(): NativePowerSyncModule | undefined {
    return this.modules?.NativePowerSyncModule;
  }

  syncHttpModule(): NativeSyncHttpModule | undefined {
    const mod = this.modules?.NativePowerSyncModule;
    if (mod == null || mod.httpFetch == null) {
      return undefined;
    }
    const syncHttp: NativeSyncHttpModule = { httpFetch: mod.httpFetch };
    if (mod.httpFetchAbort != null) {
      syncHttp.httpFetchAbort = mod.httpFetchAbort;
    }
    return syncHttp;
  }

  lynxFetchModule(): LynxFetchModule | undefined {
    return this.modules?.LynxFetchModule;
  }

  observeGlobalEventEmitters(
    onEmitter?: (emitter: LynxGlobalEventEmitter) => void,
  ): LynxGlobalEventEmitter[] {
    this.hookRuntime();
    const alreadyObserved = onEmitter != null && this.emitterObservers.has(onEmitter);
    const emitters = collectEmitters(this.runtimeValue);
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
    return this.platformValue;
  }

  textCodec(): LynxTextCodecHelper | undefined {
    return this.codec;
  }

  fetchImpl(): HostFetch | undefined {
    return this.fetchValue;
  }

  tabs(): TabPrimitives | undefined {
    return this.tabsValue;
  }
}

export interface FakeEmitterBag {
  emitter: LynxGlobalEventEmitter;
  listeners: Map<string, Array<(payload: LynxStreamEventPayload) => void>>;
}

export function createFakeEmitter(): FakeEmitterBag {
  const listeners = new Map<string, Array<(payload: LynxStreamEventPayload) => void>>();
  const emitter: LynxGlobalEventEmitter = {
    addListener(eventName, listener) {
      const list = listeners.get(eventName) ?? [];
      list.push(listener);
      listeners.set(eventName, list);
    },
    emit(eventName, payload) {
      const list = listeners.get(eventName) ?? [];
      for (const listener of list) {
        listener(payload);
      }
    },
    trigger(eventName, payload) {
      const list = listeners.get(eventName) ?? [];
      for (const listener of list) {
        listener(payload);
      }
    },
  };
  return { emitter, listeners };
}

export async function withFakeLynxHost(
  state: FakeLynxHostState,
  run: () => Promise<void>,
): Promise<void> {
  setLynxHost(new FakeLynxHost(state));
  try {
    await run();
  } finally {
    resetLynxHost();
  }
}

export function installFakeLynxHost(state: FakeLynxHostState): FakeLynxHost {
  const host = new FakeLynxHost(state);
  setLynxHost(host);
  return host;
}
