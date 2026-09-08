import { column, Schema, Table } from "powersync-lynx";

export const LISTS_TABLE = "lists";
export const TODOS_TABLE = "todos";

export const lists = new Table({
  name: column.text,
  created_at: column.text,
  owner_id: column.text,
});

export const todos = new Table(
  {
    list_id: column.text,
    description: column.text,
    completed: column.integer,
    created_at: column.text,
    completed_at: column.text,
  },
  { indexes: { list: ["list_id"] } },
);

export const AppSchema = new Schema({
  lists,
  todos,
});

export type Database = (typeof AppSchema)["types"];
export type ListRow = Database["lists"];
export type TodoRow = Database["todos"];
