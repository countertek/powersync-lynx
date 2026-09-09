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

/**
 * Do not `declare global` NativeModules / TextCodecHelper / lynx / SystemInfo
 * here. `@lynx-js/types` already declares those vars; a second declaration is
 * TS2403 under rspeedy `pluginTypeCheck`. PrimJS lookup lives in `host.ts`.
 */
