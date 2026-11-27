import type { LynxGlobalEventEmitter, LynxRuntime, LynxStreamEventPayload } from "../../globals.ts";
import { getLynxHost, type LynxHost } from "../../host.ts";
import { isFunction, isNonNullObject, isString } from "../../type-guards.ts";
import type {
  NativeHttpFetchEnvelope,
  NativeHttpFetchRequest,
  NativeSyncHttpModule,
} from "./http-types.ts";
import { latin1Bytes, toUint8 } from "./bytes.ts";
import { syncStreamResponse } from "./response.ts";
import type { SyncStreamRequest, SyncStreamTransport } from "./SyncStreamTransport.ts";

export type {
  NativeHttpFetchCallback,
  NativeHttpFetchEnvelope,
  NativeHttpFetchRequest,
  NativeSyncHttpModule,
} from "./http-types.ts";

/** Bound unread onData/onError/onEnd before a reader attaches (first-load race). */
export const MAX_EARLY_EVENTS_PER_STREAM = 256;
const MAX_RETIRED_STREAM_NAMES = 1024;
const EARLY_OVERFLOW_ERROR = "Lynx HTTP stream early-event buffer overflow";

interface StreamEmitter extends LynxGlobalEventEmitter {
  addListener(name: string, fn: (payload: LynxStreamEventPayload) => void): void;
}

function isStreamEmitter(emitter: LynxGlobalEventEmitter): emitter is StreamEmitter {
  return isFunction(emitter.addListener);
}

function unwrapStreamPayload(payload: LynxStreamEventPayload) {
  if (!Array.isArray(payload)) {
    return payload;
  }
  for (const item of payload) {
    if (isNonNullObject(item) && "event" in item) {
      return item;
    }
  }
  return payload.length > 0 ? payload[0] : {};
}

function isStreamEvent(payload: LynxStreamEventPayload): boolean {
  const event = unwrapStreamPayload(payload).event;
  return event === "onData" || event === "onEnd" || event === "onError";
}

function overflowTerminal(): LynxStreamEventPayload[] {
  return [{ event: "onError", error: EARLY_OVERFLOW_ERROR }, { event: "onEnd" }];
}

/**
 * Per-LynxHost stream event broker owning GlobalEventEmitter hooking, bounded
 * early-event capture, retirement of cancelled/aborted stream ids, and reader
 * queues. Scoped to a LynxHost instance so swapping hosts in tests starts clean.
 */
class NativeStreamBroker {
  private readonly host: LynxHost;
  private readonly earlyEvents = new Map<string, LynxStreamEventPayload[]>();
  /**
   * Cancelled or pre-headers-aborted streamingIds. Late native onData/onError/onEnd
   * must not recreate earlyEvents (abort is async). Un-retired when a new reader
   * attaches to that name.
   */
  private readonly retiredStreamNames = new Set<string>();
  private readonly retiredOrder: string[] = [];
  private readonly hookedEmitters = new WeakSet<StreamEmitter>();
  private readonly hookedRuntimes = new WeakSet<LynxRuntime>();
  private readonly streamHandlers = new WeakMap<
    StreamEmitter,
    Map<string, (payload: LynxStreamEventPayload) => void>
  >();
  private readonly origAdds = new WeakMap<StreamEmitter, StreamEmitter["addListener"]>();
  private readonly slottedNames = new WeakMap<StreamEmitter, Set<string>>();

  constructor(host: LynxHost) {
    this.host = host;
  }

  enterEarlyCapture(): void {
    this.wrapLynxGetJSModule();
    for (const emitter of this.lookupEmitters()) {
      this.hookEmitter(emitter);
    }
  }

  retireStream(name: string | undefined): void {
    if (name == null || name.length === 0) {
      return;
    }
    this.earlyEvents.delete(name);
    this.markRetired(name);
  }

  private markRetired(name: string): void {
    if (this.retiredStreamNames.has(name)) {
      return;
    }
    this.retiredStreamNames.add(name);
    this.retiredOrder.push(name);
    while (this.retiredOrder.length > MAX_RETIRED_STREAM_NAMES) {
      const oldest = this.retiredOrder.shift();
      if (oldest != null) {
        this.retiredStreamNames.delete(oldest);
      }
    }
  }

  createReader(eventName: string, onCancel?: () => void): ReadableStreamDefaultReader<Uint8Array> {
    const queue: Uint8Array[] = [];
    let finished = false;
    let released = false;
    let cancelNotified = false;
    let failure: Error | undefined;
    let wake: (() => void) | undefined;
    this.wrapLynxGetJSModule();
    const emitters = this.lookupEmitters();
    if (emitters.length === 0) {
      throw new Error("GlobalEventEmitter is not registered");
    }
    const releaseAttached = (retire: boolean): void => {
      // Always drop handlers. A buffered onEnd can set released before every
      // emitter is bound; cancel must still strip a later stray attachment.
      for (const emitter of emitters) {
        this.streamHandlers.get(emitter)?.delete(eventName);
      }
      this.releaseStream(eventName, retire);
      released = true;
    };
    const abortAttached = (): void => {
      if (cancelNotified) {
        return;
      }
      cancelNotified = true;
      onCancel?.();
    };
    const onEvent = (payload: LynxStreamEventPayload) => {
      const eventPayload = unwrapStreamPayload(payload);
      const event = isString(eventPayload.event) ? eventPayload.event : "";
      const data = eventPayload.data;
      const error = eventPayload.error;
      if (event === "onData") {
        queue.push(toUint8(data));
      } else if (event === "onError") {
        // Record failure; onEnd is the terminator (onData* → onError? → onEnd).
        failure = new Error(error == null ? "Lynx HTTP stream error" : String(error));
      } else if (event === "onEnd") {
        finished = true;
        releaseAttached(false);
      }
      wake?.();
    };
    for (const emitter of emitters) {
      this.hookEmitter(emitter);
      if (released) {
        break;
      }
      this.bindStreamHandler(emitter, eventName, onEvent);
    }
    if (!released) {
      this.drainEarly(eventName, onEvent);
      if (!released && this.handlerStillAttached(emitters, eventName, onEvent)) {
        this.retiredStreamNames.delete(eventName);
      }
    }
    // SAFETY: stream reader implements the ReadableStreamDefaultReader methods AbstractRemote calls.
    return {
      async read() {
        for (;;) {
          if (queue.length > 0) {
            return { done: false, value: queue.shift()! };
          }
          if (failure != null) {
            throw failure;
          }
          if (finished) {
            return { done: true, value: undefined };
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
      cancel() {
        queue.length = 0;
        finished = true;
        abortAttached();
        releaseAttached(true);
        wake?.();
        return Promise.resolve();
      },
      releaseLock() {},
      closed: Promise.resolve(undefined),
    } as ReadableStreamDefaultReader<Uint8Array>;
  }

  private rememberEarly(
    emitter: StreamEmitter,
    name: string,
    payload: LynxStreamEventPayload,
  ): void {
    if (
      this.retiredStreamNames.has(name) ||
      this.streamHandlers.get(emitter)?.has(name) ||
      !isStreamEvent(payload)
    ) {
      return;
    }
    const pending = this.earlyEvents.get(name);
    if (pending == null) {
      this.earlyEvents.set(name, [payload]);
      return;
    }
    if (pending.length >= MAX_EARLY_EVENTS_PER_STREAM) {
      // Bound held; fail the pending reader instead of dropping onEnd/onError.
      this.earlyEvents.set(name, overflowTerminal());
      this.markRetired(name);
      return;
    }
    pending.push(payload);
  }

  private releaseStream(name: string, retire: boolean): void {
    this.earlyEvents.delete(name);
    if (retire) {
      this.retireStream(name);
    }
  }

  private drainEarly(name: string, deliver: (payload: LynxStreamEventPayload) => void): void {
    const pending = this.earlyEvents.get(name);
    this.earlyEvents.delete(name);
    if (pending == null) {
      return;
    }
    for (const payload of pending) {
      deliver(payload);
    }
  }

  private slotListener(
    emitter: StreamEmitter,
    name: string,
  ): (payload: LynxStreamEventPayload) => void {
    return (payload: LynxStreamEventPayload) => {
      const handler = this.streamHandlers.get(emitter)?.get(name);
      if (handler != null) {
        handler(payload);
      } else {
        this.rememberEarly(emitter, name, payload);
      }
    };
  }

  private ensureSlot(emitter: StreamEmitter, name: string): void {
    let names = this.slottedNames.get(emitter);
    if (names == null) {
      names = new Set();
      this.slottedNames.set(emitter, names);
    }
    if (names.has(name)) {
      return;
    }
    const origAdd = this.origAdds.get(emitter);
    if (origAdd == null) {
      return;
    }
    names.add(name);
    origAdd(name, this.slotListener(emitter, name));
  }

  private wrapLynxGetJSModule(): void {
    const runtime = this.host.runtime();
    if (runtime == null || !isFunction(runtime.getJSModule) || this.hookedRuntimes.has(runtime)) {
      return;
    }
    this.hookedRuntimes.add(runtime);
    const orig = runtime.getJSModule.bind(runtime);
    runtime.getJSModule = (name: string) => {
      const mod = orig(name);
      if (name === "GlobalEventEmitter" && mod != null && isStreamEmitter(mod)) {
        this.hookEmitter(mod);
      }
      return mod;
    };
  }

  private lookupEmitters(): StreamEmitter[] {
    const found: StreamEmitter[] = [];
    for (const emitter of this.host.globalEventEmitters()) {
      if (isStreamEmitter(emitter)) {
        found.push(emitter);
      }
    }
    return found;
  }

  private hookEmitter(emitter: StreamEmitter): void {
    if (this.hookedEmitters.has(emitter)) {
      return;
    }
    this.hookedEmitters.add(emitter);
    this.origAdds.set(emitter, emitter.addListener.bind(emitter));
    const origEmit = isFunction(emitter.emit) ? emitter.emit.bind(emitter) : undefined;
    const origTrigger = isFunction(emitter.trigger) ? emitter.trigger.bind(emitter) : undefined;
    emitter.emit = (name, data) => {
      if (data != null) {
        this.rememberEarly(emitter, name, data);
      }
      return origEmit?.(name, data);
    };
    emitter.trigger = (name, params) => {
      if (params != null) {
        this.rememberEarly(emitter, name, params);
      }
      return origTrigger?.(name, params);
    };
  }

  private bindStreamHandler(
    emitter: StreamEmitter,
    eventName: string,
    onEvent: (payload: LynxStreamEventPayload) => void,
  ): void {
    let handlers = this.streamHandlers.get(emitter);
    if (handlers == null) {
      handlers = new Map();
      this.streamHandlers.set(emitter, handlers);
    }
    handlers.set(eventName, onEvent);
    this.ensureSlot(emitter, eventName);
  }

  private handlerStillAttached(
    emitters: readonly StreamEmitter[],
    eventName: string,
    onEvent: (payload: LynxStreamEventPayload) => void,
  ): boolean {
    for (const emitter of emitters) {
      if (this.streamHandlers.get(emitter)?.get(eventName) === onEvent) {
        return true;
      }
    }
    return false;
  }
}

const brokersByHost = new WeakMap<LynxHost, NativeStreamBroker>();

function brokerForHost(host: LynxHost): NativeStreamBroker {
  let broker = brokersByHost.get(host);
  if (broker == null) {
    broker = new NativeStreamBroker(host);
    brokersByHost.set(host, broker);
  }
  return broker;
}

/**
 * HTTP methods live on the NativePowerSyncModule object on iOS, Android, and
 * Desktop (macOS NSURLSession / Windows WinHTTP). Lynx-for-Web stays SQL-only.
 */
export function lookupNativeSyncHttp(): NativeSyncHttpModule | undefined {
  const sql = getLynxHost().nativeModules()?.NativePowerSyncModule;
  if (sql == null) {
    return undefined;
  }
  const httpFetch = sql.httpFetch;
  if (httpFetch == null) {
    return undefined;
  }
  const module: NativeSyncHttpModule = { httpFetch };
  if (sql.httpFetchAbort != null) {
    module.httpFetchAbort = sql.httpFetchAbort;
  }
  return module;
}

export function nativeHttpFetchAvailable(): boolean {
  return lookupNativeSyncHttp() != null;
}

function unwrapNativeEnvelope(envelope: NativeHttpFetchEnvelope): NativeHttpFetchEnvelope {
  if (!Array.isArray(envelope) || envelope.length === 0) {
    return envelope;
  }
  const first = envelope[0];
  if (!isNonNullObject(first)) {
    return {};
  }
  // SAFETY: PrimJS may wrap the httpFetch callback argument in a one-element array.
  return first as NativeHttpFetchEnvelope;
}

function contentTypeFromEnvelope(result: NativeHttpFetchEnvelope): string {
  if (isString(result.contentType) && result.contentType.length > 0) {
    return result.contentType;
  }
  return "application/x-ndjson";
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

interface BufferGlobal {
  Buffer?: {
    from(value: string, encoding: string): Uint8Array;
  };
}

function decodeBase64(text: string): Uint8Array {
  if (text.length === 0) {
    return new Uint8Array(0);
  }
  if (typeof atob !== "undefined" && isFunction(atob)) {
    return latin1Bytes(atob(text));
  }
  // SAFETY: Node test runtime may expose Buffer on globalThis.
  const Buf = (globalThis as BufferGlobal).Buffer;
  if (Buf != null) {
    return new Uint8Array(Buf.from(text, "base64"));
  }
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let outIndex = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = BASE64_ALPHABET.indexOf(clean[i]!);
    const b = BASE64_ALPHABET.indexOf(clean[i + 1] ?? "A");
    const cChar = clean[i + 2];
    const dChar = clean[i + 3];
    const c = cChar == null ? 0 : BASE64_ALPHABET.indexOf(cChar);
    const d = dChar == null ? 0 : BASE64_ALPHABET.indexOf(dChar);
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    out[outIndex++] = (n >> 16) & 0xff;
    if (cChar != null) {
      out[outIndex++] = (n >> 8) & 0xff;
    }
    if (dChar != null) {
      out[outIndex++] = n & 0xff;
    }
  }
  return out.subarray(0, outIndex);
}

/** Native `httpFetch` envelope → finished Response. This module owns the wire shape. */
function responseFromNativeHttpEnvelope(
  result: NativeHttpFetchEnvelope,
  broker: NativeStreamBroker,
  native: NativeSyncHttpModule,
) {
  const status = Number(result.status ?? 0);
  const statusText = String(result.statusText ?? "");
  const headers = { "content-type": contentTypeFromEnvelope(result) };
  const streamingId =
    isString(result.streamingId) && result.streamingId.length > 0 ? result.streamingId : undefined;
  if (streamingId != null) {
    const reader = broker.createReader(streamingId, () => requestNativeAbort(native, streamingId));
    return syncStreamResponse({
      status,
      statusText,
      headers,
      reader,
    });
  }
  const bodyText = isString(result.body) ? result.body : "";
  let bytes = toUint8(bodyText);
  if (bytes.byteLength === 0 && isString(result.bodyBase64) && result.bodyBase64.length > 0) {
    bytes = decodeBase64(result.bodyBase64);
  }
  return syncStreamResponse({
    status,
    statusText,
    headers,
    bytes,
  });
}

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function requestNativeAbort(
  native: NativeSyncHttpModule | undefined,
  streamId: string | undefined,
): void {
  const abortFn = native?.httpFetchAbort;
  if (abortFn == null || streamId == null) {
    return;
  }
  try {
    abortFn(streamId, () => {});
  } catch {
    // Presence-only; PrimJS host methods may throw on unused abort.
  }
}

/**
 * Residual (issue #52 / ADR-0003): `httpFetchAbort` is keyed by `streamingId`,
 * which JS only learns from the one-shot Callback. Abort after dispatch rejects
 * this Promise immediately. Native I/O is cancelled and the stream id is retired
 * when a late Callback delivers `streamingId`. Until then (or if the Callback
 * never fires), native I/O may continue — Promise rejection is not full cancellation.
 */
function fetchViaNativeHttp(request: SyncStreamRequest): Promise<Response> {
  const host = getLynxHost();
  const native = lookupNativeSyncHttp();
  if (native == null) {
    throw new Error("Native Module HTTP (httpFetch) is not registered");
  }
  const broker = brokerForHost(host);
  const httpFetch = native.httpFetch;
  const payload: NativeHttpFetchRequest = {
    method: request.method,
    url: request.url,
    headers: request.headers,
  };
  if (request.body != null) {
    payload.body = request.body;
  }
  const signal = request.signal;
  if (signal != null && signal.aborted) {
    return Promise.reject(abortError());
  }
  // Capture GlobalEventEmitter early — native may emit onData before the Callback returns.
  broker.enterEarlyCapture();
  return new Promise((resolve, reject) => {
    let streamIdForAbort: string | undefined;
    let aborted = false;
    let settled = false;

    const onAbort = (): void => {
      aborted = true;
      broker.retireStream(streamIdForAbort);
      requestNativeAbort(native, streamIdForAbort);
      settleReject(abortError());
    };

    const detachAbort = (): void => {
      if (signal != null) {
        signal.removeEventListener("abort", onAbort);
      }
    };

    const settleReject = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      detachAbort();
      reject(error);
    };

    const settleResolve = (response: Response): void => {
      if (settled) {
        return;
      }
      settled = true;
      detachAbort();
      resolve(response);
    };

    if (signal != null) {
      signal.addEventListener("abort", onAbort);
    }

    // Direct call like SQL RPC (open/execute). Do not use .call/.apply — PrimJS host
    // methods may not be JS Function objects.
    httpFetch(payload, (envelope: NativeHttpFetchEnvelope) => {
      try {
        const result = unwrapNativeEnvelope(envelope);
        const streamingId =
          isString(result.streamingId) && result.streamingId.length > 0
            ? result.streamingId
            : undefined;
        if (streamingId != null) {
          streamIdForAbort = streamingId;
        }
        if (aborted) {
          broker.retireStream(streamIdForAbort);
          requestNativeAbort(native, streamIdForAbort);
          settleReject(abortError());
          return;
        }
        if (result.ok === false) {
          settleReject(new Error(result.message ?? "Native Module HTTP httpFetch failed"));
          return;
        }
        settleResolve(responseFromNativeHttpEnvelope(result, broker, native));
      } catch (err) {
        settleReject(err instanceof Error ? err : new Error("Native Module HTTP httpFetch failed"));
      }
    });
  });
}

/**
 * Native Module HTTP adapter (iOS/Android Autolink + Desktop macOS/Windows).
 * Owns `httpFetch`, `httpFetchAbort`, early-event capture, and GlobalEventEmitter
 * streaming; returns a finished Response.
 */
export const nativeHttpFetchTransport: SyncStreamTransport = {
  name: "native-http",
  fetch: fetchViaNativeHttp,
};
