class AbortSignalPolyfill {
    aborted = false;
    reason = undefined;
    onabort = null;
    _listeners = new Set();
    addEventListener(type, listener) {
        if (type === "abort" && listener instanceof Function) {
            this._listeners.add(listener);
        }
    }
    removeEventListener(_type, listener) {
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
            signal._abort(new Error("Timeout waiting for lock"));
        }, ms);
        return signal;
    }
    _abort(reason) {
        if (this.aborted) {
            return;
        }
        this.aborted = true;
        this.reason = reason ?? new Error("Aborted");
        const event = { type: "abort" };
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
    abort(reason) {
        this.signal._abort(reason);
    }
}
if (typeof globalThis.AbortController === "undefined" ||
    typeof globalThis.AbortSignal === "undefined") {
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
export {};
