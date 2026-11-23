import { AbstractStreamingSyncImplementation, LockType, Mutex } from "@powersync/shared-internals";
import type {
  AbstractStreamingSyncImplementationOptions,
  CoreSyncStatus,
  LockOptions,
} from "@powersync/shared-internals";
import { sharedTabs, type TabChannel, type TabPrimitives } from "../tabs.ts";
import { SyncTabLease } from "./SyncTabLease.ts";

const LOCKS = new Map<string, Map<LockType, Mutex>>();

interface TabError {
  name: string;
  message: string;
}

/** What the syncing tab tells the tabs that wait for the sync lease. */
type TabSyncMessage =
  | {
      type: "status";
      core: CoreSyncStatus | null;
      uploading: boolean;
      downloadError: TabError | null;
      uploadError: TabError | null;
    }
  | { type: "status-request" };

interface TabSync {
  locks: TabPrimitives["locks"];
  lease: SyncTabLease;
  channel: TabChannel<TabSyncMessage>;
  stopBroadcasting: () => void;
  /** Whether this client is waiting for the lease and shows the syncing tab's status. */
  following: boolean;
  /** Whether a followed status has already been shown as a connection attempt. */
  shownConnecting: boolean;
}

function toTabError(error: Error | undefined): TabError | null {
  return error == null ? null : { name: error.name, message: error.message };
}

function fromTabError(error: TabError | null): Error | undefined {
  if (error == null) {
    return undefined;
  }
  const revived = new Error(error.message);
  revived.name = error.name;
  return revived;
}

export class LynxStreamingSyncImplementation extends AbstractStreamingSyncImplementation {
  locks: Map<LockType, Mutex>;
  private tabSync: TabSync | null = null;

  constructor(options: AbstractStreamingSyncImplementationOptions) {
    super(options);
    this.locks = new Map();
    this.initLocks();
  }

  initLocks(): void {
    const { identifier } = this.options;
    if (identifier && LOCKS.has(identifier)) {
      const existing = LOCKS.get(identifier);
      if (existing) {
        this.locks = existing;
        return;
      }
    }

    this.locks = new Map();
    this.locks.set(LockType.CRUD, new Mutex());
    this.locks.set(LockType.SYNC, new Mutex());

    if (identifier) {
      LOCKS.set(identifier, this.locks);
    }
  }

  async obtainLock<T>(lockOptions: LockOptions<T>): Promise<T> {
    const tabs = await sharedTabs(this.options.identifier);
    if (tabs != null) {
      return this.obtainTabLock(this.joinTabs(tabs), lockOptions);
    }
    const lock = this.locks.get(lockOptions.type);
    if (!lock) {
      throw new Error(`Lock type ${lockOptions.type} not found`);
    }
    return lock.runExclusive(async () => {
      return lockOptions.callback();
    }, lockOptions.signal);
  }

  async disconnect(): Promise<void> {
    await super.disconnect();
    this.leaveSyncLease();
  }

  async dispose(): Promise<void> {
    await super.dispose();
    this.leaveSyncLease();
    this.tabSync?.stopBroadcasting();
    this.tabSync?.channel.close();
    this.tabSync = null;
  }

  /**
   * Locks for a database that other tabs share (web `enableMultiTabs`).
   *
   * Only the client holding the sync lease downloads and uploads; the others wait
   * for it and show its status. A waiting tab's writes reach the syncing tab as a
   * cross-tab `ps_crud` table change, which triggers the upload there.
   */
  private async obtainTabLock<T>(tabSync: TabSync, lockOptions: LockOptions<T>): Promise<T> {
    const { lease, locks } = tabSync;
    const { signal, callback } = lockOptions;
    const wasHeld = lease.held;
    if (!wasHeld && lockOptions.type === LockType.SYNC) {
      this.followSyncingTab(tabSync);
    }
    const held = await lease.hold(signal);
    if (lockOptions.type === LockType.CRUD) {
      if (!held) {
        // Disconnected while another tab syncs: the upload callback stops at its aborted signal.
        return callback();
      }
      return locks.request(`powersync-lynx:crud:${this.options.identifier}`, callback, signal);
    }
    if (!held) {
      throw signal?.reason ?? new Error("Sync lease request aborted");
    }
    if (!wasHeld) {
      this.takeOverSync(tabSync);
    }
    return callback();
  }

  private joinTabs(tabs: TabPrimitives): TabSync {
    if (this.tabSync != null) {
      return this.tabSync;
    }
    const name = `powersync-lynx:sync:${this.options.identifier}`;
    const lease = new SyncTabLease(tabs.locks, name);
    const tabSync: TabSync = {
      locks: tabs.locks,
      lease,
      channel: tabs.channel<TabSyncMessage>(name, (message) => this.receiveFromTab(message)),
      stopBroadcasting: this.registerListener({
        statusChanged: () => {
          if (lease.held) {
            tabSync.channel.post(this.statusMessage());
          }
        },
      }),
      following: false,
      shownConnecting: false,
    };
    this.tabSync = tabSync;
    return tabSync;
  }

  private leaveSyncLease(): void {
    const tabSync = this.tabSync;
    if (tabSync == null) {
      return;
    }
    tabSync.following = false;
    tabSync.lease.drop();
  }

  private followSyncingTab(tabSync: TabSync): void {
    tabSync.following = true;
    tabSync.shownConnecting = false;
    tabSync.channel.post({ type: "status-request" });
  }

  private takeOverSync(tabSync: TabSync): void {
    tabSync.following = false;
    const core = this.syncStatus.core;
    this.updateSyncStatus(
      core == null ? null : { ...core, connected: false, connecting: true, downloading: null },
      { uploading: false, downloadError: undefined, uploadError: undefined },
    );
  }

  private statusMessage(): TabSyncMessage {
    const { core, jsState } = this.syncStatus;
    return {
      type: "status",
      core,
      uploading: jsState.uploading === true,
      downloadError: toTabError(jsState.downloadError),
      uploadError: toTabError(jsState.uploadError),
    };
  }

  private receiveFromTab(message: TabSyncMessage): void {
    const tabSync = this.tabSync;
    if (tabSync == null) {
      return;
    }
    if (message.type === "status-request") {
      if (tabSync.lease.held) {
        tabSync.channel.post(this.statusMessage());
      }
      return;
    }
    if (!tabSync.following) {
      return;
    }
    const { core } = message;
    if (core != null && !tabSync.shownConnecting) {
      // `connect()` resolves on a connecting -> settled transition; a tab that joins an
      // established sync would otherwise never show one.
      tabSync.shownConnecting = true;
      this.updateSyncStatus({ ...core, connected: false, connecting: true });
    }
    this.updateSyncStatus(core, {
      uploading: message.uploading,
      downloadError: fromTabError(message.downloadError),
      uploadError: fromTabError(message.uploadError),
    });
  }
}
