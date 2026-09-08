import assert from "node:assert/strict";
import { test } from "node:test";

import { crudUploadEntries } from "../examples/showcase/src/connector.ts";

function crudEntryLike(fields: {
  op: string;
  table: string;
  id: string;
  opData?: { description: string; completed: number } | null;
}) {
  return {
    ...fields,
    toJSON() {
      return { op: fields.op, type: fields.table, id: fields.id, data: fields.opData };
    },
  };
}

test("crudUploadEntries keeps table and opData through JSON.stringify", () => {
  const entry = crudEntryLike({
    op: "PUT",
    table: "todos",
    id: "t1",
    opData: { description: "Buy milk", completed: 0 },
  });
  const dropped = JSON.parse(JSON.stringify({ crud: [entry] }));
  assert.equal(dropped.crud[0].opData, undefined);
  assert.deepEqual(dropped.crud[0].data, { description: "Buy milk", completed: 0 });

  const mapped = JSON.parse(JSON.stringify({ crud: crudUploadEntries([entry]) }));
  assert.equal(mapped.crud[0].op, "PUT");
  assert.equal(mapped.crud[0].table, "todos");
  assert.equal(mapped.crud[0].id, "t1");
  assert.deepEqual(mapped.crud[0].opData, { description: "Buy milk", completed: 0 });
  assert.equal(mapped.crud[0].type, undefined);
  assert.equal(mapped.crud[0].data, undefined);
});

test("crudUploadEntries maps missing opData to null for DELETE", () => {
  const entry = crudEntryLike({ op: "DELETE", table: "todos", id: "t1" });
  const mapped = JSON.parse(JSON.stringify({ crud: crudUploadEntries([entry]) }));
  assert.equal(mapped.crud[0].table, "todos");
  assert.equal(mapped.crud[0].opData, null);
});
