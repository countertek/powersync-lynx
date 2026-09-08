declare module "powersync-lynx/web-host" {
  export interface LynxViewHost {
    nativeModulesMap?: { NativePowerSyncModule?: string } | null;
    onNativeModulesCall?: unknown;
    url?: string;
  }

  export interface AttachHandle {
    detach(): void;
  }

  export function attach(lynxView: LynxViewHost): AttachHandle;
}
