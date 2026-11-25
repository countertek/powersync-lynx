import { LockType } from "@powersync/shared-internals";
import type { CoreSyncStatus, LockOptions } from "@powersync/shared-internals";

/**
 * Cross-tab primitives and coordinator for a database the web Host helper shares
 * between tabs (`enableMultiTabs`). Native hosts and single-tab web opens never use them.
 */

export interface TabLocks {
  /**
   * Runs `callback` while this context holds the origin-wide exclusive lock `name`.
   * Rejects with the signal's reason when `signal` aborts before the lock is granted.
   */
  request<T>(name: string, callback: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export interface TabChannel<Message> {
  /** Delivers to every other channel of the same name, in this tab and in others. */
  post(message: Message): void;
  close(): void;
}

export interface TabPrimitives {
  locks: TabLocks;
  channel<Message>(name: string, receive: (message: Message) => void): TabChannel<Message>;
}

/** `navigator.locks` + `BroadcastChannel` of the lynx-bg worker; undefined where either is missing. */
export function browserTabPrimitives(): TabPrimitives | undefined {
  const locks = globalThis.navigator?.locks;
  const Channel = globalThis.BroadcastChannel;
  if (locks == null || Channel == null) {
    return undefined;
  }
  return {
    locks: {
      request(name, callback, signal) {
        return signal == null
          ? locks.request(name, callback)
          : locks.request(name, { signal }, callback);
      },
    },
    channel<Message>(name: string, receive: (message: Message) => void) {
      const channel = new Channel(name);
      channel.onmessage = (event: MessageEvent<Message>) => receive(event.data);
      return {
        post(message: Message) {
          channel.postMessage(message);
        },
        close() {
          channel.close();
        },
      };
    },
  };
}

export interface TabDatabaseKey {
  name: string;
  dbLocation?: string;
}

export interface TableChange {
  tables: string[];
}

export interface TabSyncJsState {
  uploading?: boolean;
  downloadError?: Error;
  uploadError?: Error;
}

export interface TabSyncSnapshot {
  core: CoreSyncStatus | null;
  jsState: TabSyncJsState;
}

export interface TabSyncClient {
  getSyncStatus(): TabSyncSnapshot;
  updateSyncStatus(core: CoreSyncStatus | null, jsState?: TabSyncJsState): void;
  onStatusChanged(listener: () => void): () => void;
}

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

interface LeaseClaim {
  held: boolean;
  granted: Promise<void>;
  /** Withdraws a claim that is still queued, or gives up a granted one. */
  end(): void;
}

interface ActiveTabSync {
  client: TabSyncClient;
  locks: TabLocks;
  claim: LeaseClaim | null;
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

/**
 * Coordinates cross-tab table notifications, sync leases, CRUD locks, and follower/leader
 * status relay for one database file (`${name}:${dbLocation ?? ""}`).
 */
export class TabCoordinator {
  readonly fileKey: string;
  private readonly tablesChannelName: string;
  private readonly syncLockName: string;
  private readonly crudLockName: string;
  private sharedWithTabs = false;
  private closed = false;
  private ready: Promise<TabPrimitives | undefined> | null = null;
  private tableChanges: TabChannel<TableChange> | null = null;
  private tabSync: ActiveTabSync | null = null;

  constructor(database: TabDatabaseKey) {
    this.fileKey = `${database.name}:${database.dbLocation ?? ""}`;
    this.tablesChannelName = `powersync-lynx:tables:${this.fileKey}`;
    this.syncLockName = `powersync-lynx:sync:${this.fileKey}`;
    this.crudLockName = `powersync-lynx:crud:${this.fileKey}`;
  }

  /** Marks this database file as shared with other tabs (web `enableMultiTabs`). */
  markShared(): void {
    this.sharedWithTabs = true;
  }

  /**
   * Connects the Adapter lifecycle to this coordinator so cross-tab channels and locks
   * activate once `initialized` settles and the host confirms `multiTab: true`.
   */
  attachAdapter(
    initialized: Promise<void>,
    resolveTabs: () => TabPrimitives | undefined,
    onTableChange: (change: TableChange) => void,
  ): void {
    this.ready = initialized.then(
      () => this.activateTables(resolveTabs, onTableChange),
      () => undefined,
    );
  }

  postTableChange(change: TableChange): void {
    this.tableChanges?.post(change);
  }

  closeTables(): void {
    this.closed = true;
    this.tableChanges?.close();
    this.tableChanges = null;
  }

  /**
   * Acquires a cross-tab sync lease or CRUD lock when this file is shared across tabs,
   * otherwise delegates to `fallback` (in-process mutexes).
   *
   * Only the client holding the sync lease downloads and uploads; the others wait
   * for it and show its status. A waiting tab's writes reach the syncing tab as a
   * cross-tab `ps_crud` table change, which triggers the upload there.
   */
  async obtainLock<T>(
    client: TabSyncClient,
    lockOptions: LockOptions<T>,
    fallback: () => Promise<T>,
  ): Promise<T> {
    const tabs = await this.resolvePrimitives();
    if (tabs == null) {
      return fallback();
    }
    const tabSync = this.joinSync(tabs, client);
    const { signal, callback } = lockOptions;
    const wasHeld = tabSync.claim?.held === true;
    if (!wasHeld && lockOptions.type === LockType.SYNC) {
      this.followSyncingTab(tabSync);
    }
    const held = await this.holdLease(tabSync, signal);
    if (lockOptions.type === LockType.CRUD) {
      if (!held) {
        // Disconnected while another tab syncs: the upload callback stops at its aborted signal.
        return callback();
      }
      return tabSync.locks.request(this.crudLockName, callback, signal);
    }
    if (!held) {
      throw signal?.reason ?? new Error("Sync lease request aborted");
    }
    if (!wasHeld) {
      this.takeOverSync(tabSync);
    }
    return callback();
  }

  leaveSyncLease(client?: TabSyncClient): void {
    const tabSync = this.tabSync;
    if (tabSync == null || (client != null && tabSync.client !== client)) {
      return;
    }
    tabSync.following = false;
    const claim = tabSync.claim;
    tabSync.claim = null;
    claim?.end();
  }

  disposeSync(client?: TabSyncClient): void {
    const tabSync = this.tabSync;
    if (tabSync == null || (client != null && tabSync.client !== client)) {
      return;
    }
    this.leaveSyncLease(client);
    tabSync.stopBroadcasting();
    tabSync.channel.close();
    this.tabSync = null;
  }

  private activateTables(
    resolveTabs: () => TabPrimitives | undefined,
    onTableChange: (change: TableChange) => void,
  ): TabPrimitives | undefined {
    if (this.closed || !this.sharedWithTabs) {
      return undefined;
    }
    const tabs = resolveTabs();
    if (tabs == null) {
      return undefined;
    }
    this.tableChanges = tabs.channel<TableChange>(this.tablesChannelName, onTableChange);
    return tabs;
  }

  private async resolvePrimitives(): Promise<TabPrimitives | undefined> {
    if (this.closed || this.ready == null) {
      return undefined;
    }
    const tabs = await this.ready;
    return this.closed ? undefined : tabs;
  }

  private joinSync(tabs: TabPrimitives, client: TabSyncClient): ActiveTabSync {
    if (this.tabSync != null && this.tabSync.client === client) {
      return this.tabSync;
    }
    if (this.tabSync != null) {
      this.disposeSync();
    }
    const tabSync: ActiveTabSync = {
      client,
      locks: tabs.locks,
      claim: null,
      channel: tabs.channel<TabSyncMessage>(this.syncLockName, (message) =>
        this.receiveFromTab(tabSync, message),
      ),
      stopBroadcasting: client.onStatusChanged(() => {
        if (tabSync.claim?.held === true) {
          tabSync.channel.post(this.statusMessage(tabSync.client));
        }
      }),
      following: false,
      shownConnecting: false,
    };
    this.tabSync = tabSync;
    return tabSync;
  }

  /** Resolves `true` once this client holds the lease, `false` when `signal` aborts first. */
  private holdLease(tabSync: ActiveTabSync, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted === true) {
      return Promise.resolve(false);
    }
    const claim = tabSync.claim ?? this.requestLease(tabSync);
    tabSync.claim = claim;
    return new Promise((resolve, reject) => {
      const onAbort = () => resolve(false);
      signal?.addEventListener("abort", onAbort);
      claim.granted.then(
        () => {
          signal?.removeEventListener("abort", onAbort);
          resolve(true);
        },
        (error: Error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  /**
   * Kept from the first grant until `leaveSyncLease`, across sync iterations, so the role
   * only moves when the holder disconnects or its tab closes.
   */
  private requestLease(tabSync: ActiveTabSync): LeaseClaim {
    const withdrawn = new AbortController();
    let release = (): void => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const claim: LeaseClaim = {
      held: false,
      granted: Promise.resolve(),
      end() {
        claim.held = false;
        withdrawn.abort();
        release();
      },
    };
    claim.granted = new Promise((resolve, reject) => {
      tabSync.locks
        .request(
          this.syncLockName,
          () => {
            if (!withdrawn.signal.aborted) {
              claim.held = true;
              resolve();
            }
            return released;
          },
          withdrawn.signal,
        )
        .catch((error: Error) => {
          if (withdrawn.signal.aborted) {
            // Withdrawn while queued: whoever waited has already been told by its own signal.
            return;
          }
          if (tabSync.claim === claim) {
            tabSync.claim = null;
          }
          reject(error);
        });
    });
    return claim;
  }

  private followSyncingTab(tabSync: ActiveTabSync): void {
    tabSync.following = true;
    tabSync.shownConnecting = false;
    tabSync.channel.post({ type: "status-request" });
  }

  private takeOverSync(tabSync: ActiveTabSync): void {
    tabSync.following = false;
    const { core } = tabSync.client.getSyncStatus();
    tabSync.client.updateSyncStatus(
      core == null ? null : { ...core, connected: false, connecting: true, downloading: null },
      { uploading: false, downloadError: undefined, uploadError: undefined },
    );
  }

  private statusMessage(client: TabSyncClient): TabSyncMessage {
    const { core, jsState } = client.getSyncStatus();
    return {
      type: "status",
      core,
      uploading: jsState.uploading === true,
      downloadError: toTabError(jsState.downloadError),
      uploadError: toTabError(jsState.uploadError),
    };
  }

  private receiveFromTab(tabSync: ActiveTabSync, message: TabSyncMessage): void {
    if (this.tabSync !== tabSync) {
      return;
    }
    if (message.type === "status-request") {
      if (tabSync.claim?.held === true) {
        tabSync.channel.post(this.statusMessage(tabSync.client));
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
      tabSync.client.updateSyncStatus({ ...core, connected: false, connecting: true });
    }
    tabSync.client.updateSyncStatus(core, {
      uploading: message.uploading,
      downloadError: fromTabError(message.downloadError),
      uploadError: fromTabError(message.uploadError),
    });
  }
}
