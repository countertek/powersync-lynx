/**
 * Lynx's iOS polyfill list does not include AbortController. Install one when missing.
 * Node and Lynx-for-Web already provide the global; this is a no-op there.
 *
 * Call `installAbortControllerPolyfill()` from the LynxHost module so install
 * order does not depend on which Client file is imported first.
 */
import { isNonNullObject } from "./type-guards.ts";

type AbortListener = (event: { type: "abort" }) => void;

interface AddEventListenerOptionsLike {
  once?: boolean;
}

class AbortSignalPolyfill {
  aborted = false;
  reason: Error | undefined = undefined;
  onabort: AbortListener | null = null;
  _listeners = new Map<AbortListener, boolean>();

  addEventListener(
    type: string,
    listener: AbortListener,
    options?: boolean | AddEventListenerOptionsLike,
  ): void {
    if (type === "abort" && listener instanceof Function) {
      const once = isNonNullObject(options) && options.once === true;
      this._listeners.set(listener, once);
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

  static any(signals: Iterable<AbortSignal>): AbortSignalPolyfill {
    const combined = new AbortSignalPolyfill();
    const list = Array.from(signals);
    for (const sig of list) {
      if (sig.aborted) {
        combined._abort(sig.reason instanceof Error ? sig.reason : new Error("Aborted"));
        return combined;
      }
    }
    const cleanups: Array<() => void> = [];
    for (const sig of list) {
      const onAbort = () => {
        for (const fn of cleanups) {
          fn();
        }
        combined._abort(sig.reason instanceof Error ? sig.reason : new Error("Aborted"));
      };
      sig.addEventListener("abort", onAbort);
      cleanups.push(() => sig.removeEventListener("abort", onAbort));
    }
    return combined;
  }

  _abort(reason?: Error): void {
    if (this.aborted) {
      return;
    }
    this.aborted = true;
    const err = reason ?? new Error("Aborted");
    if (reason == null) {
      err.name = "AbortError";
    }
    this.reason = err;
    const event = { type: "abort" as const };
    if (this.onabort instanceof Function) {
      this.onabort(event);
    }
    for (const [listener, once] of Array.from(this._listeners.entries())) {
      if (once) {
        this._listeners.delete(listener);
      }
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

/**
 * Lynx 4.2/4.4 `lynx_core.js` ships an `AbortSignal` subclass of its internal
 * EventEmitter whose `removeListener` mutates the listener array with `splice`
 * while `emit` iterates it via `forEach`. When listener #1 removes itself on
 * abort (as `@powersync/shared-internals`'s `crudUploadLoop` does), listener #2
 * (`streamingSync`) is skipped and `db.disconnect()` hangs forever.
 *
 * Feature-detect that exact bug so real Node/browser `AbortController` stays
 * untouched while broken Lynx runtimes get our spec-compliant polyfill.
 */
function nativeAbortControllerIsBroken(): boolean {
  try {
    const controller = new globalThis.AbortController();
    let secondFired = false;
    const first = () => {
      controller.signal.removeEventListener("abort", first);
    };
    const second = () => {
      secondFired = true;
    };
    controller.signal.addEventListener("abort", first);
    controller.signal.addEventListener("abort", second);
    controller.abort();
    return !secondFired;
  } catch {
    return true;
  }
}

/** Idempotent. Safe to call from LynxHost and from leftover side-effect imports. */
export function installAbortControllerPolyfill(): void {
  if (
    typeof globalThis.AbortController === "undefined" ||
    typeof globalThis.AbortSignal === "undefined" ||
    nativeAbortControllerIsBroken()
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
