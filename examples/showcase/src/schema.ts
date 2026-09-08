import { column, Schema, Table } from "powersync-lynx";

export const TODOS_TABLE = "todos";

export const todos = new Table({
  description: column.text,
  completed: column.integer,
  created_at: column.text,
  completed_at: column.text,
});

export const AppSchema = new Schema({
  todos,
});

export type Database = (typeof AppSchema)["types"];
export type TodoRow = Database["todos"];
