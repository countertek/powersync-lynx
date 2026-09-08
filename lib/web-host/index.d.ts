/**
 * Host-page types for `powersync-lynx/web-host`.
 * Do not re-export WASQLiteVFS — import it from `@powersync/web` when overriding `vfs`.
 */

export interface LynxViewHost {
  nativeModulesMap?: Record<string, string> | null;
  onNativeModulesCall?:
    | ((name: string, data: unknown, moduleName: string) => unknown | Promise<unknown>)
    | null;
}

/**
 * Official WASQLite / WebSpecificOpenOptions fields except `encryptionKey`.
 * Omit any field → official `@powersync/web` defaults. `ssrMode` is not accepted.
 */
export interface AttachOptions {
  vfs?: string;
  useWebWorker?: boolean;
  enableMultiTabs?: boolean;
  worker?: string | URL | ((options: unknown) => Worker | SharedWorker);
  additionalReaders?: number;
  temporaryStorage?: string;
  cacheSizeKb?: number;
  databaseWorkerLogLevel?: number;
  disableSSRWarning?: boolean;
}

export interface AttachHandle {
  detach(): void;
}

export function attach(lynxView: LynxViewHost, options?: AttachOptions): AttachHandle;
