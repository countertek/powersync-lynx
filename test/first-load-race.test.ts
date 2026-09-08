import assert from "node:assert/strict";
import { test } from "node:test";

import { runExclusive } from "../examples/showcase/src/boot.ts";

test("runExclusive coalesces concurrent first-load callers", async () => {
  let n = 0;
  const boot = runExclusive(async () => {
    n += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await Promise.all([boot(), boot(), boot()]);
  assert.equal(n, 1);
});

test("runExclusive retries after a failed first load", async () => {
  let n = 0;
  const boot = runExclusive(async () => {
    n += 1;
    if (n === 1) {
      throw new Error("boom");
    }
  });
  await assert.rejects(() => boot(), /boom/);
  await boot();
  assert.equal(n, 2);
});

test("TOCTOU empty-check duplicates without exclusive and does not with it", async () => {
  async function naiveSeed(rows: string[]): Promise<void> {
    const existing = rows.length;
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (existing === 0) {
      rows.push("todo");
    }
  }

  const duplicated: string[] = [];
  await Promise.all([naiveSeed(duplicated), naiveSeed(duplicated)]);
  assert.equal(duplicated.length, 2);

  const once: string[] = [];
  const seed = runExclusive(async () => {
    if (once.length === 0) {
      once.push("todo");
    }
  });
  await Promise.all([seed(), seed()]);
  assert.equal(once.length, 1);
});
