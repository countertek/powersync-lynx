import type { PowerSyncDatabase } from "powersync-lynx";

import { newId, nowIso } from "./util.ts";

const SEED_LISTS = [
  { name: "Groceries", owner: "demo" },
  { name: "Weekend project", owner: "demo" },
  { name: "Showcase", owner: "demo" },
] as const;

const SEED_TODOS: ReadonlyArray<{ list: string; description: string; completed: boolean }> = [
  { list: "Groceries", description: "Oat milk", completed: false },
  { list: "Groceries", description: "Coffee beans", completed: true },
  { list: "Groceries", description: "Limes", completed: false },
  { list: "Weekend project", description: "Sketch the Lynx layout", completed: true },
  { list: "Weekend project", description: "Wire watch() to the list pane", completed: false },
  { list: "Showcase", description: "Open the DB", completed: true },
  { list: "Showcase", description: "Declare Schema", completed: true },
  { list: "Showcase", description: "Connect with a Connector", completed: false },
  { list: "Showcase", description: "Subscribe to a Sync Stream", completed: false },
];

export async function seedIfEmpty(database: PowerSyncDatabase): Promise<boolean> {
  const existing = await database.getOptional<{ id: string }>("SELECT id FROM lists LIMIT 1");
  if (existing != null) {
    return false;
  }

  const createdAt = nowIso();
  const listIds = new Map<string, string>();

  await database.writeTransaction(async (tx) => {
    for (const list of SEED_LISTS) {
      const id = newId();
      listIds.set(list.name, id);
      await tx.execute("INSERT INTO lists (id, name, created_at, owner_id) VALUES (?, ?, ?, ?)", [
        id,
        list.name,
        createdAt,
        list.owner,
      ]);
    }
    for (const todo of SEED_TODOS) {
      const listId = listIds.get(todo.list);
      if (listId == null) {
        continue;
      }
      const completedAt = todo.completed ? createdAt : null;
      await tx.execute(
        "INSERT INTO todos (id, list_id, description, completed, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?)",
        [newId(), listId, todo.description, todo.completed ? 1 : 0, createdAt, completedAt],
      );
    }
  });

  return true;
}
