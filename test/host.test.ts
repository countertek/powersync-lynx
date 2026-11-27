import assert from "node:assert/strict";
import { test } from "node:test";

import { installAbortControllerPolyfill } from "../src/abort-controller.ts";
import { nativeSql } from "../src/adapter/native.ts";
import {
  getLynxHost,
  hostIsAndroid,
  hostIsIOS,
  PrimJSLynxHost,
  resetLynxHost,
  setLynxHost,
} from "../src/host.ts";
import { createFakeEmitter, FakeLynxHost, withFakeLynxHost } from "./fake-lynx-host.ts";
import { nativeWithHttp } from "./remote-harness.ts";

test("default LynxHost is the PrimJS adapter", () => {
  resetLynxHost();
  assert.equal(getLynxHost() instanceof PrimJSLynxHost, true);
});

test("PrimJS adapter reads NativeModules, platform, text codec, and fetch from globalThis", async () => {
  resetLynxHost();
  const previousModules = globalThis.NativeModules;
  const previousInfo = globalThis.SystemInfo;
  const previousCodec = globalThis.TextCodecHelper;
  const previousFetch = globalThis.fetch;
  const previousLynx = globalThis.lynx;
  const { emitter } = createFakeEmitter();
  globalThis.NativeModules = {
    NativePowerSyncModule: nativeWithHttp({}),
  };
  globalThis.SystemInfo = { platform: "Android" };
  globalThis.TextCodecHelper = {
    decode() {
      return "ok";
    },
  };
  globalThis.lynx = {
    getJSModule(name) {
      if (name === "GlobalEventEmitter") {
        return emitter;
      }
      return undefined;
    },
  };
  const fetchImpl = async () => new Response("x");
  globalThis.fetch = fetchImpl;
  try {
    const host = getLynxHost();
    assert.equal(host instanceof PrimJSLynxHost, true);
    assert.equal(host.sqlModule() != null, true);
    assert.equal(host.syncHttpModule(), undefined);
    assert.equal(host.platform(), "Android");
    assert.equal(hostIsAndroid(host), true);
    assert.equal(host.textCodec()?.decode(new ArrayBuffer(0)), "ok");
    assert.equal(host.fetchImpl(), fetchImpl);
    assert.equal(host.observeGlobalEventEmitters().includes(emitter), true);
    const opened = await nativeSql.open({ dbFilename: "host.db", readOnly: false });
    assert.equal(opened.dbId, "test");
    assert.equal(opened.multiTab, false);
  } finally {
    globalThis.NativeModules = previousModules;
    globalThis.SystemInfo = previousInfo;
    globalThis.TextCodecHelper = previousCodec;
    globalThis.fetch = previousFetch;
    globalThis.lynx = previousLynx;
    resetLynxHost();
  }
});

test("fake LynxHost does not read globalThis for native modules or platform", async () => {
  const previousModules = globalThis.NativeModules;
  const previousInfo = globalThis.SystemInfo;
  globalThis.NativeModules = {
    NativePowerSyncModule: nativeWithHttp({}),
  };
  globalThis.SystemInfo = { platform: "iOS" };
  try {
    await withFakeLynxHost({ platform: "Android" }, async () => {
      const host = getLynxHost();
      assert.equal(host instanceof FakeLynxHost, true);
      assert.equal(host.sqlModule(), undefined);
      assert.equal(host.syncHttpModule(), undefined);
      assert.equal(host.lynxFetchModule(), undefined);
      assert.equal(host.platform(), "Android");
      assert.equal(hostIsAndroid(host), true);
      assert.deepEqual(host.observeGlobalEventEmitters(), []);
    });
    assert.equal(getLynxHost() instanceof PrimJSLynxHost, true);
  } finally {
    globalThis.NativeModules = previousModules;
    globalThis.SystemInfo = previousInfo;
    resetLynxHost();
  }
});

test("setLynxHost installs a fake and resetLynxHost restores PrimJS", () => {
  const fake = new FakeLynxHost({ platform: "iOS" });
  setLynxHost(fake);
  assert.equal(getLynxHost(), fake);
  assert.equal(hostIsAndroid(), false);
  resetLynxHost();
  assert.equal(getLynxHost() instanceof PrimJSLynxHost, true);
});

test("observeGlobalEventEmitters notifies observers for current and late emitters", () => {
  const { emitter: initial } = createFakeEmitter();
  const { emitter: late } = createFakeEmitter();
  let useLate = false;
  const runtime = {
    getJSModule(name: string) {
      if (name !== "GlobalEventEmitter") {
        return undefined;
      }
      return useLate ? late : initial;
    },
  };
  const host = new FakeLynxHost({ runtime });
  const observed: unknown[] = [];
  const current = host.observeGlobalEventEmitters((emitter) => {
    observed.push(emitter);
  });
  assert.deepEqual(current, [initial]);
  assert.deepEqual(observed, [initial]);

  useLate = true;
  assert.equal(runtime.getJSModule("GlobalEventEmitter"), late);
  assert.deepEqual(observed, [initial, late]);
});

test("PrimJSLynxHost capability lookups handle sql-only, sync-http, empty, and unset NativeModules", () => {
  const previousModules = globalThis.NativeModules;
  const host = new PrimJSLynxHost();
  try {
    const sqlOnly = nativeWithHttp({});
    globalThis.NativeModules = { NativePowerSyncModule: sqlOnly };
    assert.equal(host.sqlModule(), sqlOnly);
    assert.equal(host.syncHttpModule(), undefined);
    assert.equal(host.lynxFetchModule(), undefined);

    const withHttp = nativeWithHttp({
      httpFetch(_req, cb) {
        cb({ ok: true, status: 200, body: "" });
      },
    });
    globalThis.NativeModules = { NativePowerSyncModule: withHttp };
    assert.equal(host.sqlModule(), withHttp);
    assert.equal(host.syncHttpModule()?.httpFetch, withHttp.httpFetch);

    globalThis.NativeModules = {};
    assert.equal(host.sqlModule(), undefined);
    assert.equal(host.syncHttpModule(), undefined);
    assert.equal(host.lynxFetchModule(), undefined);

    globalThis.NativeModules = undefined;
    assert.equal(host.sqlModule(), undefined);
  } finally {
    globalThis.NativeModules = previousModules;
  }
});

test("hostIsIOS matches iOS case-insensitively and rejects desktop platforms", () => {
  assert.equal(hostIsIOS(new FakeLynxHost({ platform: "iOS" })), true);
  assert.equal(hostIsIOS(new FakeLynxHost({ platform: "ios" })), true);
  assert.equal(hostIsIOS(new FakeLynxHost({ platform: "macOS" })), false);
  assert.equal(hostIsIOS(new FakeLynxHost({ platform: "Windows" })), false);
  assert.equal(hostIsIOS(new FakeLynxHost({ platform: "Android" })), false);
});

test("PrimJSLynxHost.observeGlobalEventEmitters publishes __psLynxGlobalEventEmitter non-enumerably while FakeLynxHost does not", () => {
  const previousLynx = globalThis.lynx;
  const previousPublished = Object.getOwnPropertyDescriptor(
    globalThis,
    "__psLynxGlobalEventEmitter",
  );
  try {
    Reflect.deleteProperty(globalThis, "__psLynxGlobalEventEmitter");
    const { emitter: fakeEmitter } = createFakeEmitter();
    const fakeHost = new FakeLynxHost({ emitter: fakeEmitter });
    assert.deepEqual(fakeHost.observeGlobalEventEmitters(), [fakeEmitter]);
    assert.equal(
      Object.getOwnPropertyDescriptor(globalThis, "__psLynxGlobalEventEmitter"),
      undefined,
    );

    const { emitter: primEmitter } = createFakeEmitter();
    globalThis.lynx = {
      getJSModule(name: string) {
        return name === "GlobalEventEmitter" ? primEmitter : undefined;
      },
    };
    const primHost = new PrimJSLynxHost();
    assert.deepEqual(primHost.observeGlobalEventEmitters(), [primEmitter]);
    const desc = Object.getOwnPropertyDescriptor(globalThis, "__psLynxGlobalEventEmitter");
    assert.equal(desc?.value, primEmitter);
    assert.equal(desc?.enumerable, false);
  } finally {
    globalThis.lynx = previousLynx;
    if (previousPublished == null) {
      Reflect.deleteProperty(globalThis, "__psLynxGlobalEventEmitter");
    } else {
      Object.defineProperty(globalThis, "__psLynxGlobalEventEmitter", previousPublished);
    }
  }
});

test("installAbortControllerPolyfill replaces broken splice-during-emit AbortController and preserves native Node AbortController", () => {
  const OriginalAC = globalThis.AbortController;
  const OriginalAS = globalThis.AbortSignal;
  // Native Node AbortController passes the feature check and is preserved untouched.
  installAbortControllerPolyfill();
  assert.equal(globalThis.AbortController, OriginalAC);
  assert.equal(globalThis.AbortSignal, OriginalAS);

  // Simulate Lynx 4.2/4.4 lynx_core.js AbortSignal where removeEventListener splices during forEach.
  class BrokenSignal {
    aborted = false;
    listeners: Array<() => void> = [];
    addEventListener(_type: string, fn: () => void) {
      this.listeners.push(fn);
    }
    removeEventListener(_type: string, fn: () => void) {
      const idx = this.listeners.indexOf(fn);
      if (idx >= 0) {
        this.listeners.splice(idx, 1);
      }
    }
    dispatch() {
      this.aborted = true;
      this.listeners.forEach((fn) => fn());
    }
  }
  class BrokenController {
    signal = new BrokenSignal();
    abort() {
      this.signal.dispatch();
    }
  }

  try {
    Object.defineProperty(globalThis, "AbortController", {
      value: BrokenController,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "AbortSignal", {
      value: BrokenSignal,
      configurable: true,
      writable: true,
    });

    installAbortControllerPolyfill();
    assert.notEqual(globalThis.AbortController, BrokenController);

    const controller = new globalThis.AbortController();
    let secondFired = false;
    const first = () => controller.signal.removeEventListener("abort", first);
    controller.signal.addEventListener("abort", first);
    controller.signal.addEventListener("abort", () => {
      secondFired = true;
    });
    controller.abort();
    assert.equal(controller.signal.aborted, true);
    assert.equal(secondFired, true);
  } finally {
    Object.defineProperty(globalThis, "AbortController", {
      value: OriginalAC,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "AbortSignal", {
      value: OriginalAS,
      configurable: true,
      writable: true,
    });
  }
});
