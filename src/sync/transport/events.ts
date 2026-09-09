import type { LynxGlobalEventEmitter, LynxRuntime, LynxStreamEventPayload } from "../../globals.ts";
import { getLynxHost } from "../../host.ts";
import { isFunction, isNonNullObject, isString } from "../../type-guards.ts";
import { toUint8 } from "./bytes.ts";

interface StreamEmitter extends LynxGlobalEventEmitter {
  addListener(name: string, fn: (payload: LynxStreamEventPayload) => void): void;
  _events?: EmitterEventsMap;
}

interface EmitterEventsMap {
  get(name: string): object | undefined;
}

const earlyEvents = new Map<string, LynxStreamEventPayload[]>();
/** Per-emitter names with an attached reader — skip early-capture so emit/trigger cannot leak. */
const liveStreamNames = new WeakMap<StreamEmitter, Set<string>>();
/**
 * Cancelled streamingIds. Late native onError/onEnd must not recreate earlyEvents
 * (Android abort is async). Un-retired when a new reader attaches to that name.
 */
const retiredStreamNames = new Set<string>();
const retiredOrder: string[] = [];
/** Bound unread onData/onError/onEnd before a reader attaches (first-load race). */
export const MAX_EARLY_EVENTS_PER_STREAM = 256;
const MAX_RETIRED_STREAM_NAMES = 1024;
const EARLY_OVERFLOW_ERROR = "Lynx HTTP stream early-event buffer overflow";
const hookedEmitters = new WeakSet<StreamEmitter>();
const hookedLynxHosts = new WeakSet<LynxRuntime>();
const streamHandlers = new WeakMap<
  StreamEmitter,
  Map<string, (payload: LynxStreamEventPayload) => void>
>();
const origAdds = new WeakMap<StreamEmitter, StreamEmitter["addListener"]>();
const slottedNames = new WeakMap<StreamEmitter, Set<string>>();
const foreignListeners = new WeakMap<
  StreamEmitter,
  Map<string, Array<(payload: LynxStreamEventPayload) => void>>
>();
const hookedEventMaps = new WeakSet<EmitterEventsMap>();

/** Native LynxFetchModule names streams `LynxFetchModuleStreamingEvent` + AtomicLong. */
const NATIVE_STREAM_PREFIX = "LynxFetchModuleStreamingEvent";
const NATIVE_STREAM_SLOTS = 64;

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

function liveNames(emitter: StreamEmitter): Set<string> {
  let names = liveStreamNames.get(emitter);
  if (names == null) {
    names = new Set();
    liveStreamNames.set(emitter, names);
  }
  return names;
}

function overflowTerminal(): LynxStreamEventPayload[] {
  return [{ event: "onError", error: EARLY_OVERFLOW_ERROR }, { event: "onEnd" }];
}

function retireStream(name: string): void {
  if (retiredStreamNames.has(name)) {
    return;
  }
  retiredStreamNames.add(name);
  retiredOrder.push(name);
  while (retiredOrder.length > MAX_RETIRED_STREAM_NAMES) {
    const oldest = retiredOrder.shift();
    if (oldest != null) {
      retiredStreamNames.delete(oldest);
    }
  }
}

function rememberEarly(
  emitter: StreamEmitter,
  name: string,
  payload: LynxStreamEventPayload,
): void {
  if (
    retiredStreamNames.has(name) ||
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
    // Bound held; fail the pending reader instead of dropping onEnd/onError.
    earlyEvents.set(name, overflowTerminal());
    retireStream(name);
    return;
  }
  pending.push(payload);
}

function releaseStream(emitter: StreamEmitter, name: string, retire: boolean): void {
  liveStreamNames.get(emitter)?.delete(name);
  earlyEvents.delete(name);
  if (retire) {
    retireStream(name);
  }
}

function retireNames(names: readonly string[]): void {
  for (const name of names) {
    earlyEvents.delete(name);
    retireStream(name);
  }
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

function drainEarly(name: string, deliver: (payload: LynxStreamEventPayload) => void): void {
  const pending = earlyEvents.get(name);
  earlyEvents.delete(name);
  if (pending == null) {
    return;
  }
  for (const payload of pending) {
    deliver(payload);
  }
}

function slotListener(
  emitter: StreamEmitter,
  name: string,
): (payload: LynxStreamEventPayload) => void {
  return (payload: LynxStreamEventPayload) => {
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
    if (name === "GlobalEventEmitter" && mod != null && isStreamEmitter(mod)) {
      hookEmitter(mod);
    }
    return mod;
  };
}

function lookupEmitters(): StreamEmitter[] {
  const found: StreamEmitter[] = [];
  for (const emitter of getLynxHost().globalEventEmitters()) {
    if (isStreamEmitter(emitter)) {
      found.push(emitter);
    }
  }
  return found;
}

export function lookupEmitter(): StreamEmitter | undefined {
  return lookupEmitters()[0];
}

function hookEventsMap(emitter: StreamEmitter): void {
  const events = emitter._events;
  if (events == null || !isFunction(events.get) || hookedEventMaps.has(events)) {
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
    if (data != null) {
      rememberEarly(emitter, name, data);
    }
    return origEmit?.(name, data);
  };
  emitter.trigger = (name, params) => {
    if (params != null) {
      rememberEarly(emitter, name, params);
    }
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

function bindStreamHandler(
  emitter: StreamEmitter,
  eventName: string,
  onEvent: (payload: LynxStreamEventPayload) => void,
): void {
  let handlers = streamHandlers.get(emitter);
  if (handlers == null) {
    handlers = new Map();
    streamHandlers.set(emitter, handlers);
  }
  liveNames(emitter).add(eventName);
  handlers.set(eventName, onEvent);
  ensureSlot(emitter, eventName);
}

function handlerStillAttached(
  emitters: readonly StreamEmitter[],
  eventName: string,
  onEvent: (payload: LynxStreamEventPayload) => void,
): boolean {
  for (const emitter of emitters) {
    if (streamHandlers.get(emitter)?.get(eventName) === onEvent) {
      return true;
    }
  }
  return false;
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
  const releaseAttached = (retire: boolean): void => {
    if (retire) {
      retireNames(eventNames);
    }
    // Always drop handlers. A buffered onEnd can set released before every
    // emitter is bound; cancel must still strip a later stray attachment.
    for (const emitter of emitters) {
      const handlers = streamHandlers.get(emitter);
      for (const name of eventNames) {
        handlers?.delete(name);
        releaseStream(emitter, name, false);
      }
    }
    released = true;
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
    hookEmitter(emitter);
    if (released) {
      break;
    }
    for (const eventName of eventNames) {
      bindStreamHandler(emitter, eventName, onEvent);
    }
  }
  if (!released) {
    for (const eventName of eventNames) {
      drainEarly(eventName, onEvent);
      if (released) {
        break;
      }
      if (handlerStillAttached(emitters, eventName, onEvent)) {
        retiredStreamNames.delete(eventName);
      }
    }
  }
  // SAFETY: stream reader implements the ReadableStreamDefaultReader methods AbstractRemote calls.
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
      releaseAttached(abortOnCancel);
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
