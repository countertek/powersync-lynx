import { AbstractStreamingSyncImplementation } from "@powersync/shared-internals";
import type {
  AbstractStreamingSyncImplementationOptions,
  LockOptions,
} from "@powersync/shared-internals";
import { TabCoordinator, type TabSyncClient } from "../tabs.ts";

export class LynxStreamingSyncImplementation extends AbstractStreamingSyncImplementation {
  private readonly tabs: TabCoordinator;
  private readonly tabSyncClient: TabSyncClient;

  constructor(options: AbstractStreamingSyncImplementationOptions, tabs?: TabCoordinator) {
    super(options);
    this.tabs = tabs ?? new TabCoordinator({ name: options.identifier });
    this.tabSyncClient = {
      getSyncStatus: () => this.syncStatus,
      updateSyncStatus: (core, jsState) => {
        if (jsState == null) {
          this.updateSyncStatus(core);
        } else {
          this.updateSyncStatus(core, jsState);
        }
      },
      onStatusChanged: (listener) =>
        this.registerListener({
          statusChanged: listener,
        }),
    };
  }

  obtainLock<T>(lockOptions: LockOptions<T>): Promise<T> {
    return this.tabs.obtainLock(this.tabSyncClient, lockOptions);
  }

  async disconnect(): Promise<void> {
    await super.disconnect();
    this.tabs.leaveSyncLease(this.tabSyncClient);
  }

  async dispose(): Promise<void> {
    await super.dispose();
    this.tabs.disposeSync(this.tabSyncClient);
  }
}
