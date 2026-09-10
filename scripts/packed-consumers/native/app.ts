import { PowerSyncDatabase, Schema, Table, column } from "powersync-lynx";
import { attach, type LynxViewHost } from "powersync-lynx/web-host";

const schema = new Schema({
  items: new Table({
    title: column.text,
  }),
});

export function createDb(): PowerSyncDatabase {
  return new PowerSyncDatabase({
    schema,
    database: { dbFilename: "native.db" },
  });
}

export function attachHost(view: LynxViewHost) {
  return attach(view);
}
