import type { NativeModulesHost } from "../src/adapter/native.ts";
import type {
  LynxGlobalEventEmitter,
  LynxRuntime,
  LynxStreamEventPayload,
  LynxTextCodecHelper,
} from "../src/globals.ts";
import {
  collectGlobalEventEmitters,
  resetLynxHost,
  setLynxHost,
  type HostFetch,
  type LynxHost,
} from "../src/host.ts";

export interface FakeLynxHostState {
  nativeModules?: NativeModulesHost;
  runtime?: LynxRuntime;
  emitter?: LynxGlobalEventEmitter;
  platform?: string;
  textCodec?: LynxTextCodecHelper;
  fetchImpl?: HostFetch;
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

export class FakeLynxHost implements LynxHost {
  private readonly modules: NativeModulesHost | undefined;
  private readonly runtimeValue: LynxRuntime | undefined;
  private readonly platformValue: string | undefined;
  private readonly codec: LynxTextCodecHelper | undefined;
  private readonly fetchValue: HostFetch | undefined;

  constructor(state: FakeLynxHostState) {
    this.modules = state.nativeModules;
    this.platformValue = state.platform;
    this.codec = state.textCodec;
    this.fetchValue = state.fetchImpl;
    if (state.runtime != null) {
      this.runtimeValue = state.runtime;
    } else if (state.emitter != null) {
      this.runtimeValue = runtimeFromEmitter(state.emitter);
    }
  }

  nativeModules(): NativeModulesHost | undefined {
    return this.modules;
  }

  runtime(): LynxRuntime | undefined {
    return this.runtimeValue;
  }

  globalEventEmitters(): LynxGlobalEventEmitter[] {
    return collectGlobalEventEmitters(this.runtimeValue);
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
