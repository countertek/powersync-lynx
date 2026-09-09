import type { NativeModulesHost } from "./adapter/native.ts";

export interface LynxGlobalProps {
  device?: string;
  demoApiUrl?: string;
  powersyncUrl?: string;
}

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
  __globalProps?: LynxGlobalProps;
}

export interface LynxSystemInfo {
  platform?: string;
}

export interface LynxTextCodecHelper {
  decode(buffer: ArrayBuffer): string;
}

declare global {
  var NativeModules: NativeModulesHost | undefined;
  var TextCodecHelper: LynxTextCodecHelper | undefined;
  /** Lynx BTS global — prefer bare `lynx` so the bundler keeps the runtime binding. */
  var lynx: LynxRuntime | undefined;
  var SystemInfo: LynxSystemInfo | undefined;
}
