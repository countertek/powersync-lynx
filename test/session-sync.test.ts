import assert from "node:assert/strict";
import { test } from "node:test";

import { bootDemo } from "../examples/showcase/src/boot.ts";
import {
  applyLocalReadySyncState,
  checkpointAppliedThisSession,
  createSessionSyncTracker,
} from "../examples/showcase/src/session-sync.ts";

function collectTracker() {
  const logs: string[] = [];
  const labels = {
    sync: "offline",
    hasSynced: "no",
    lastSynced: "never",
    firstSyncDone: false,
  };
  const tracker = createSessionSyncTracker({
    log(message) {
      logs.push(message);
    },
    setSyncLabel(label) {
      labels.sync = label;
    },
    setHasSyncedLabel(label) {
      labels.hasSynced = label;
    },
    setLastSyncedText(text) {
      labels.lastSynced = text;
    },
    setFirstSyncDone(done) {
      labels.firstSyncDone = done;
    },
  });
  return { logs, labels, tracker };
}

test("checkpointAppliedThisSession requires lastSyncedAt to advance past baseline", () => {
  assert.equal(checkpointAppliedThisSession(undefined, undefined), false);
  assert.equal(checkpointAppliedThisSession(1_700_000_000_000, 1_700_000_000_000), false);
  assert.equal(checkpointAppliedThisSession(1_700_000_000_001, 1_700_000_000_000), true);
  assert.equal(checkpointAppliedThisSession(1_700_000_000_000, undefined), true);
});

test("persisted hasSynced plus download-start then error does not log first checkpoint applied", () => {
  const { logs, tracker } = collectTracker();
  const persistedAt = new Date("2026-01-15T12:00:00.000Z");
  tracker.statusChanged({
    connected: true,
    hasSynced: true,
    lastSyncedAt: persistedAt,
    downloading: false,
  });
  tracker.statusChanged({
    connected: true,
    hasSynced: true,
    lastSyncedAt: persistedAt,
    downloading: true,
  });
  tracker.statusChanged({
    connected: true,
    hasSynced: true,
    lastSyncedAt: persistedAt,
    downloading: false,
    downloadError: new Error("stream reset"),
  });
  assert.equal(logs.includes("connected"), true);
  assert.equal(logs.includes("download in progress"), true);
  assert.equal(logs.includes("sync error: stream reset"), true);
  assert.equal(
    logs.includes("first checkpoint applied"),
    false,
    "download-start with persisted hasSynced must not count as this session's checkpoint",
  );

  tracker.statusChanged({
    connected: true,
    hasSynced: true,
    lastSyncedAt: new Date("2026-01-15T12:05:00.000Z"),
    downloading: false,
  });
  assert.equal(logs.includes("first checkpoint applied"), true);
});

test("persisted hasSynced with unavailable credentials still records first sync done on local ready", async () => {
  const { logs, labels, tracker } = collectTracker();
  const persistedAt = new Date("2026-01-15T12:00:00.000Z");
  let connectCalled = false;
  await bootDemo({
    waitForReady: async () => {},
    fetchCredentials: async () => null,
    setCredentials: () => {
      throw new Error("must not set credentials when the demo API returns none");
    },
    connect: async () => {
      connectCalled = true;
    },
    onLocalReady: () => {
      applyLocalReadySyncState(
        tracker,
        {
          connected: false,
          hasSynced: true,
          lastSyncedAt: persistedAt,
        },
        async () => {},
        () => false,
      );
    },
    onConnectSettled: () => {
      logs.push("connect-settled");
    },
    log: (message) => {
      logs.push(`boot:${message}`);
    },
    isCancelled: () => false,
    connectLabel: "unused",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connectCalled, false);
  assert.equal(logs.includes("connect-settled"), false);
  assert.match(logs.join("\n"), /no credentials/);
  assert.equal(logs.includes("first sync done"), true);
  assert.equal(labels.firstSyncDone, true);
  assert.equal(labels.hasSynced, "yes");
  assert.equal(labels.lastSynced, persistedAt.toISOString());
  assert.equal(labels.sync, "offline");
  assert.equal(
    logs.includes("first checkpoint applied"),
    false,
    "seeding persisted currentStatus must not count as this session's checkpoint",
  );
});
