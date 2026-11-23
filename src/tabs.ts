/**
 * Cross-tab primitives for a database the web Host helper shares between tabs
 * (`enableMultiTabs`). Native hosts and single-tab web opens never use them.
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

const sharedByDatabase = new Map<string, Promise<TabPrimitives | undefined>>();

/**
 * The Adapter announces, per database name, whether its file is shared with other tabs.
 * Returns the function that withdraws the announcement.
 */
export function announceSharedTabs(
  database: string,
  tabs: Promise<TabPrimitives | undefined>,
): () => void {
  sharedByDatabase.set(database, tabs);
  return () => {
    if (sharedByDatabase.get(database) === tabs) {
      sharedByDatabase.delete(database);
    }
  };
}

/** Resolves to the primitives when `database` is open and shared with other tabs. */
export async function sharedTabs(database: string | undefined): Promise<TabPrimitives | undefined> {
  if (database == null) {
    return undefined;
  }
  return sharedByDatabase.get(database);
}
