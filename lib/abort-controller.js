/**
 * Lynx's iOS polyfill list does not include AbortController. Install one when missing.
 * Node and Lynx-for-Web already provide the global; this is a no-op there.
 */
if (typeof globalThis.AbortController !== 'function' || typeof globalThis.AbortSignal !== 'function') {
  class AbortSignalPolyfill {
    aborted = false;
    reason = undefined;
    onabort = null;
    _listeners = new Set();

    addEventListener(type, listener) {
      if (type === 'abort' && typeof listener === 'function') {
        this._listeners.add(listener);
      }
    }

    removeEventListener(type, listener) {
      this._listeners.delete(listener);
    }

    throwIfAborted() {
      if (this.aborted) {
        throw this.reason;
      }
    }

    static abort(reason) {
      const signal = new AbortSignalPolyfill();
      signal._abort(reason);
      return signal;
    }

    static timeout(ms) {
      const signal = new AbortSignalPolyfill();
      setTimeout(() => {
        signal._abort(new Error('Timeout waiting for lock'));
      }, ms);
      return signal;
    }

    _abort(reason) {
      if (this.aborted) {
        return;
      }
      this.aborted = true;
      this.reason = reason ?? new Error('Aborted');
      const event = { type: 'abort' };
      if (typeof this.onabort === 'function') {
        this.onabort(event);
      }
      for (const listener of [...this._listeners]) {
        listener(event);
      }
    }
  }

  class AbortControllerPolyfill {
    signal = new AbortSignalPolyfill();

    abort(reason) {
      this.signal._abort(reason);
    }
  }

  globalThis.AbortSignal = AbortSignalPolyfill;
  globalThis.AbortController = AbortControllerPolyfill;
}
