/**
 * Lynx's iOS polyfill list does not include AbortController. Install one when missing.
 * Node and Lynx-for-Web already provide the global; this is a no-op there.
 *
 * Call `installAbortControllerPolyfill()` from the LynxHost module so install
 * order does not depend on which Client file is imported first.
 */
type AbortListener = (event: { type: "abort" }) => void;

class AbortSignalPolyfill {
  aborted = false;
  reason: Error | undefined = undefined;
  onabort: AbortListener | null = null;
  _listeners = new Set<AbortListener>();

  addEventListener(type: string, listener: AbortListener): void {
    if (type === "abort" && listener instanceof Function) {
      this._listeners.add(listener);
    }
  }

  removeEventListener(_type: string, listener: AbortListener): void {
    this._listeners.delete(listener);
  }

  throwIfAborted(): void {
    if (this.aborted) {
      throw this.reason;
    }
  }

  static abort(reason?: Error): AbortSignalPolyfill {
    const signal = new AbortSignalPolyfill();
    signal._abort(reason);
    return signal;
  }

  static timeout(ms: number): AbortSignalPolyfill {
    const signal = new AbortSignalPolyfill();
    setTimeout(() => {
      signal._abort(new Error("Timeout waiting for lock"));
    }, ms);
    return signal;
  }

  _abort(reason?: Error): void {
    if (this.aborted) {
      return;
    }
    this.aborted = true;
    this.reason = reason ?? new Error("Aborted");
    const event = { type: "abort" as const };
    if (this.onabort instanceof Function) {
      this.onabort(event);
    }
    for (const listener of Array.from(this._listeners)) {
      listener(event);
    }
  }
}

class AbortControllerPolyfill {
  signal = new AbortSignalPolyfill();

  abort(reason?: Error): void {
    this.signal._abort(reason);
  }
}

/** Idempotent. Safe to call from LynxHost and from leftover side-effect imports. */
export function installAbortControllerPolyfill(): void {
  if (
    typeof globalThis.AbortController === "undefined" ||
    typeof globalThis.AbortSignal === "undefined"
  ) {
    Object.defineProperty(globalThis, "AbortSignal", {
      value: AbortSignalPolyfill,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "AbortController", {
      value: AbortControllerPolyfill,
      configurable: true,
      writable: true,
    });
  }
}

installAbortControllerPolyfill();
