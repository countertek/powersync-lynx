import type { TabChannel, TabPrimitives } from "../src/tabs.ts";

interface LockRequest {
  tab: FakeTab;
  start(): void;
}

interface OpenChannel {
  tab: FakeTab;
  deliver(message: never): void;
}

/** One browser tab's `navigator.locks` and `BroadcastChannel`, until {@link FakeTab.close}. */
export interface FakeTab extends TabPrimitives {
  /** Closes the tab: its locks are released and its channels go silent. */
  close(): void;
}

/**
 * In-memory stand-in for the origin-wide lock manager and broadcast channels
 * that the tabs of one browser share.
 */
export class FakeTabHub {
  private readonly queues = new Map<string, LockRequest[]>();
  private readonly channels = new Map<string, Set<OpenChannel>>();
  /** Names of the channels ever opened, for asserting that none were. */
  readonly openedChannels: string[] = [];

  tab(): FakeTab {
    const tab: FakeTab = {
      locks: {
        request: (name, callback, signal) => this.request(tab, name, callback, signal),
      },
      channel: (name, receive) => this.open(tab, name, receive),
      close: () => this.closeTab(tab),
    };
    return tab;
  }

  /** Lock names currently held, with or without waiters. */
  heldLocks(): string[] {
    return [...this.queues.keys()];
  }

  private request<T>(
    tab: FakeTab,
    name: string,
    callback: () => Promise<T>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const queue = this.queues.get(name) ?? [];
      this.queues.set(name, queue);
      const request: LockRequest = {
        tab,
        start: () => {
          signal?.removeEventListener("abort", withdraw);
          callback().then(
            (value) => {
              this.leave(name, request);
              resolve(value);
            },
            (error: Error) => {
              this.leave(name, request);
              reject(error);
            },
          );
        },
      };
      const withdraw = () => {
        this.leave(name, request);
        reject(signal?.reason);
      };
      if (signal?.aborted === true) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", withdraw);
      queue.push(request);
      if (queue.length === 1) {
        queueMicrotask(request.start);
      }
    });
  }

  /** Removes a request; when it held the lock, the next one in line gets it. */
  private leave(name: string, request: LockRequest): void {
    const queue = this.queues.get(name);
    if (queue == null) {
      return;
    }
    const index = queue.indexOf(request);
    if (index < 0) {
      return;
    }
    queue.splice(index, 1);
    if (queue.length === 0) {
      this.queues.delete(name);
      return;
    }
    if (index === 0) {
      queueMicrotask(queue[0]!.start);
    }
  }

  private open<Message>(
    tab: FakeTab,
    name: string,
    receive: (message: Message) => void,
  ): TabChannel<Message> {
    this.openedChannels.push(name);
    const peers = this.channels.get(name) ?? new Set<OpenChannel>();
    this.channels.set(name, peers);
    const own: OpenChannel = { tab, deliver: receive };
    peers.add(own);
    return {
      post: (message) => {
        if (!peers.has(own)) {
          return;
        }
        for (const peer of peers) {
          if (peer !== own) {
            queueMicrotask(() => {
              if (peers.has(peer)) {
                // SAFETY: channels of one name carry one message type.
                peer.deliver(message as never);
              }
            });
          }
        }
      },
      close: () => {
        peers.delete(own);
      },
    };
  }

  private closeTab(tab: FakeTab): void {
    for (const peers of this.channels.values()) {
      for (const channel of peers) {
        if (channel.tab === tab) {
          peers.delete(channel);
        }
      }
    }
    for (const [name, queue] of this.queues) {
      for (const request of queue.filter((queued) => queued.tab === tab)) {
        this.leave(name, request);
      }
    }
  }
}
