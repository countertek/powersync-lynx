import { getLynxHost } from "../../host.ts";
import { isFunction } from "../../type-guards.ts";
import { toUint8 } from "./bytes.ts";

interface StreamEmitter {
  addListener(name: string, fn: (payload: unknown) => void): void;
  emit?(name: string, data?: unknown): void;
  trigger?(name: string, params?: unknown): void;
}

const earlyEvents = new Map<string, unknown[]>();
/** Per-emitter names with an attached reader — skip early-capture so emit/trigger cannot leak. */
const liveStreamNames = new WeakMap<object, Set<string>>();
/** Bound unread onData/onError/onEnd before a reader attaches (first-load race). */
const MAX_EARLY_EVENTS_PER_STREAM = 256;
const hookedEmitters = new WeakSet<object>();
const hookedLynxHosts = new WeakSet<object>();
const streamHandlers = new WeakMap<object, Map<string, (payload: unknown) => void>>();
const origAdds = new WeakMap<object, StreamEmitter["addListener"]>();
const slottedNames = new WeakMap<object, Set<string>>();
const foreignListeners = new WeakMap<object, Map<string, Array<(payload: unknown) => void>>>();
const hookedEventMaps = new WeakSet<object>();

/** Native LynxFetchModule names streams `LynxFetchModuleStreamingEvent` + AtomicLong. */
const NATIVE_STREAM_PREFIX = "LynxFetchModuleStreamingEvent";
const NATIVE_STREAM_SLOTS = 64;

function unwrapStreamPayload(payload: unknown): unknown {
  if (!Array.isArray(payload)) {
    return payload;
  }
  for (const item of payload) {
    if (item != null && typeof item === "object" && !Array.isArray(item) && "event" in item) {
      return item;
    }
  }
  return payload.length > 0 ? payload[0] : payload;
}

function isStreamEvent(payload: unknown): boolean {
  const eventPayload = unwrapStreamPayload(payload);
  if (eventPayload == null || typeof eventPayload !== "object") {
    return false;
  }
  const event = (eventPayload as { event?: unknown }).event;
  return event === "onData" || event === "onEnd" || event === "onError";
}

function liveNames(emitter: object): Set<string> {
  let names = liveStreamNames.get(emitter);
  if (names == null) {
    names = new Set();
    liveStreamNames.set(emitter, names);
  }
  return names;
}

function rememberEarly(emitter: object, name: string, payload: unknown): void {
  if (
    liveStreamNames.get(emitter)?.has(name) ||
    streamHandlers.get(emitter)?.has(name) ||
    !isStreamEvent(payload)
  ) {
    return;
  }
  const pending = earlyEvents.get(name);
  if (pending == null) {
    earlyEvents.set(name, [payload]);
    return;
  }
  if (pending.length >= MAX_EARLY_EVENTS_PER_STREAM) {
    return;
  }
  pending.push(payload);
}

function releaseStream(emitter: object, name: string): void {
  liveStreamNames.get(emitter)?.delete(name);
  earlyEvents.delete(name);
}

function abortNativeHttp(streamId: string): void {
  const abortFn = getLynxHost().nativeModules()?.NativePowerSyncModule?.httpFetchAbort;
  if (abortFn == null) {
    return;
  }
  try {
    abortFn(streamId, () => {});
  } catch {
    // Presence-only; PrimJS host methods may throw on unused abort.
  }
}

function drainEarly(name: string, deliver: (payload: unknown) => void): void {
  const pending = earlyEvents.get(name);
  earlyEvents.delete(name);
  if (pending == null) {
    return;
  }
  for (const payload of pending) {
    deliver(payload);
  }
}

function slotListener(emitter: object, name: string): (payload: unknown) => void {
  return (payload: unknown) => {
    const handler = streamHandlers.get(emitter)?.get(name);
    if (handler != null) {
      handler(payload);
    } else {
      rememberEarly(emitter, name, payload);
    }
    const extras = foreignListeners.get(emitter)?.get(name);
    if (extras != null) {
      for (const fn of extras) {
        fn(payload);
      }
    }
  };
}

function ensureSlot(emitter: StreamEmitter, name: string): void {
  let names = slottedNames.get(emitter);
  if (names == null) {
    names = new Set();
    slottedNames.set(emitter, names);
  }
  if (names.has(name)) {
    return;
  }
  const origAdd = origAdds.get(emitter);
  if (origAdd == null) {
    return;
  }
  names.add(name);
  origAdd(name, slotListener(emitter, name));
}

function preSlotNativeStreams(emitter: StreamEmitter): void {
  for (let i = 0; i < NATIVE_STREAM_SLOTS; i++) {
    ensureSlot(emitter, `${NATIVE_STREAM_PREFIX}${i}`);
  }
}

function wrapLynxGetJSModule(): void {
  const host = getLynxHost().runtime();
  if (host == null || !isFunction(host.getJSModule) || hookedLynxHosts.has(host)) {
    return;
  }
  hookedLynxHosts.add(host);
  const orig = host.getJSModule.bind(host);
  host.getJSModule = (name: string) => {
    const mod = orig(name);
    if (name === "GlobalEventEmitter" && mod != null && typeof mod === "object") {
      hookEmitter(mod as StreamEmitter);
    }
    return mod;
  };
}

function lookupEmitters(): StreamEmitter[] {
  const found: StreamEmitter[] = [];
  for (const emitter of getLynxHost().globalEventEmitters()) {
    if (emitter.addListener != null) {
      found.push(emitter as StreamEmitter);
    }
  }
  return found;
}

export function lookupEmitter(): StreamEmitter | undefined {
  return lookupEmitters()[0];
}

function hookEventsMap(emitter: StreamEmitter): void {
  const events = (emitter as { _events?: Map<string, unknown> })._events;
  if (events == null || typeof events.get !== "function" || hookedEventMaps.has(events)) {
    return;
  }
  hookedEventMaps.add(events);
  const origGet = events.get.bind(events);
  events.get = (name: string) => {
    let list = origGet(name);
    if (list == null || (Array.isArray(list) && list.length === 0)) {
      ensureSlot(emitter, String(name));
      list = origGet(name);
    }
    return list;
  };
}

function hookEmitter(emitter: StreamEmitter): void {
  if (hookedEmitters.has(emitter)) {
    hookEventsMap(emitter);
    return;
  }
  hookedEmitters.add(emitter);
  const origAdd = emitter.addListener.bind(emitter);
  origAdds.set(emitter, origAdd);
  const origEmit = isFunction(emitter.emit) ? emitter.emit.bind(emitter) : undefined;
  const origTrigger = isFunction(emitter.trigger) ? emitter.trigger.bind(emitter) : undefined;
  emitter.addListener = (name, fn) => {
    let byName = foreignListeners.get(emitter);
    if (byName == null) {
      byName = new Map();
      foreignListeners.set(emitter, byName);
    }
    let list = byName.get(name);
    if (list == null) {
      list = [];
      byName.set(name, list);
    }
    list.push(fn);
    ensureSlot(emitter, name);
  };
  emitter.emit = (name, data) => {
    rememberEarly(emitter, name, data);
    return origEmit?.(name, data);
  };
  emitter.trigger = (name, params) => {
    rememberEarly(emitter, name, params);
    return origTrigger?.(name, params);
  };
  preSlotNativeStreams(emitter);
  hookEventsMap(emitter);
}

export function enterEarlyCapture(): void {
  wrapLynxGetJSModule();
  for (const emitter of lookupEmitters()) {
    hookEmitter(emitter);
  }
}

function attachStreamHandler(
  emitter: StreamEmitter,
  eventName: string,
  onEvent: (payload: unknown) => void,
): void {
  let handlers = streamHandlers.get(emitter);
  if (handlers == null) {
    handlers = new Map();
    streamHandlers.set(emitter, handlers);
  }
  liveNames(emitter).add(eventName);
  handlers.set(eventName, onEvent);
  ensureSlot(emitter, eventName);
  drainEarly(eventName, onEvent);
}

function nativeStreamNames(): string[] {
  const names: string[] = [];
  for (let i = 0; i < NATIVE_STREAM_SLOTS; i++) {
    names.push(`${NATIVE_STREAM_PREFIX}${i}`);
  }
  return names;
}

function createStreamingReader(
  eventNames: string[],
  abortOnCancel: boolean,
): ReadableStreamDefaultReader<Uint8Array> {
  const queue: Uint8Array[] = [];
  let finished = false;
  let released = false;
  let nativeAborted = false;
  let failure: Error | undefined;
  let wake: (() => void) | undefined;
  wrapLynxGetJSModule();
  const emitters = lookupEmitters();
  if (emitters.length === 0) {
    throw new Error("GlobalEventEmitter is not registered");
  }
  const releaseAttached = (): void => {
    if (released) {
      return;
    }
    released = true;
    for (const emitter of emitters) {
      const handlers = streamHandlers.get(emitter);
      for (const name of eventNames) {
        handlers?.delete(name);
        releaseStream(emitter, name);
      }
    }
  };
  const abortAttached = (): void => {
    if (!abortOnCancel || nativeAborted) {
      return;
    }
    nativeAborted = true;
    for (const name of eventNames) {
      abortNativeHttp(name);
    }
  };
  const onEvent = (payload: unknown) => {
    const eventPayload = unwrapStreamPayload(payload);
    const event =
      eventPayload != null && typeof eventPayload === "object" && "event" in eventPayload
        ? String((eventPayload as { event?: unknown }).event)
        : "";
    const data =
      eventPayload != null && typeof eventPayload === "object" && "data" in eventPayload
        ? (eventPayload as { data?: unknown }).data
        : undefined;
    const error =
      eventPayload != null && typeof eventPayload === "object" && "error" in eventPayload
        ? (eventPayload as { error?: unknown }).error
        : undefined;
    if (event === "onData") {
      queue.push(toUint8(data));
    } else if (event === "onError") {
      // Record failure; onEnd is the terminator (onData* → onError? → onEnd).
      failure = new Error(error == null ? "Lynx HTTP stream error" : String(error));
    } else if (event === "onEnd") {
      finished = true;
      releaseAttached();
    }
    wake?.();
  };
  for (const emitter of emitters) {
    hookEmitter(emitter);
    for (const eventName of eventNames) {
      attachStreamHandler(emitter, eventName, onEvent);
    }
  }
  return {
    async read() {
      for (;;) {
        if (failure != null) {
          throw failure;
        }
        if (queue.length > 0) {
          return { done: false, value: queue.shift()! };
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
      finished = true;
      abortAttached();
      releaseAttached();
      wake?.();
      return Promise.resolve();
    },
    releaseLock() {},
    closed: Promise.resolve(undefined),
  } as ReadableStreamDefaultReader<Uint8Array>;
}

export function streamingReader(eventName: string): ReadableStreamDefaultReader<Uint8Array> {
  return createStreamingReader([eventName], true);
}

/** Native streaming always posts to LynxFetchModuleStreamingEventN and resolves an empty body. */
export function streamingReaderFallback(): ReadableStreamDefaultReader<Uint8Array> {
  return createStreamingReader(nativeStreamNames(), false);
}
