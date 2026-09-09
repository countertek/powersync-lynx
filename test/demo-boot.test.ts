import assert from "node:assert/strict";
import { test } from "node:test";

import { bootDemo } from "../examples/showcase/src/boot.ts";

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
}

test("local UI ready fires while connect() is still pending", async () => {
  const connectGate = deferred<void>();
  const events: string[] = [];
  const finished = bootDemo({
    waitForReady: async () => {
      events.push("db-open");
    },
    fetchCredentials: async () => ({ endpoint: "http://127.0.0.1:8080", token: "tok" }),
    setCredentials: () => {
      events.push("creds");
    },
    connect: async () => {
      events.push("connect-start");
      await connectGate.promise;
      events.push("connect-done");
    },
    onLocalReady: () => {
      events.push("local-ready");
    },
    log: (message) => {
      events.push(`log:${message}`);
    },
    isCancelled: () => false,
    connectLabel: "http://127.0.0.1:8080 as test",
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    events.filter((e) => e === "local-ready" || e === "connect-start" || e === "connect-done"),
    ["local-ready", "connect-start"],
  );
  assert.equal(events.includes("connect-done"), false);

  connectGate.resolve();
  await finished;
  assert.equal(events.includes("connect-done"), true);
  assert.equal(events.includes("log:connect: http://127.0.0.1:8080 as test"), true);
});

test("connect() rejection is logged and does not block local ready", async () => {
  const events: string[] = [];
  await bootDemo({
    waitForReady: async () => {},
    fetchCredentials: async () => ({ endpoint: "http://127.0.0.1:8080", token: "tok" }),
    setCredentials: () => {},
    connect: async () => {
      throw new Error("stream handshake stalled");
    },
    onLocalReady: () => {
      events.push("local-ready");
    },
    log: (message) => {
      events.push(message);
    },
    isCancelled: () => false,
    connectLabel: "unused",
  });
  assert.equal(events.includes("local-ready"), true);
  assert.match(events.join("\n"), /connect skipped: stream handshake stalled/);
});
