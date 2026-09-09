import assert from "node:assert/strict";
import { test } from "node:test";

import { nativeSql } from "../src/adapter/native.ts";
import {
  getLynxHost,
  hostIsAndroid,
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
    assert.equal(host.nativeModules()?.NativePowerSyncModule != null, true);
    assert.equal(host.platform(), "Android");
    assert.equal(hostIsAndroid(host), true);
    assert.equal(host.textCodec()?.decode(new ArrayBuffer(0)), "ok");
    assert.equal(host.fetchImpl(), fetchImpl);
    assert.equal(host.globalEventEmitters().includes(emitter), true);
    const opened = await nativeSql.open({ dbFilename: "host.db", readOnly: false });
    assert.equal(opened.ok, true);
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
      assert.equal(host.nativeModules(), undefined);
      assert.equal(host.platform(), "Android");
      assert.equal(hostIsAndroid(host), true);
      assert.equal(host.runtime(), undefined);
      assert.deepEqual(host.globalEventEmitters(), []);
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

test("fake emitter runtime is stable across LynxHost lookups", () => {
  const { emitter } = createFakeEmitter();
  const host = new FakeLynxHost({ emitter });
  assert.equal(host.runtime(), host.runtime());
  assert.equal(host.runtime()?.getJSModule?.("GlobalEventEmitter"), emitter);
  assert.deepEqual(host.globalEventEmitters(), [emitter]);
});
