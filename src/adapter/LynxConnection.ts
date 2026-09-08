import { LockContext, queryResultWithoutRows } from "@powersync/common";
import type { QueryResult, RawQueryResult } from "@powersync/common";
import {
  callNative,
  decodeRawRows,
  encodeBindParams,
  encodeBindParamRows,
  type BindValueRows,
  type BindValues,
  type NativeOkEnvelope,
} from "./native.js";

export class LynxConnection extends LockContext {
  readonly dbId: string;

  constructor(dbId: string) {
    super();
    this.dbId = dbId;
  }

  async executeRaw(query: string, params?: BindValues): Promise<RawQueryResult> {
    const envelope = await callNative("execute", this.dbId, query, encodeBindParams(params));
    return {
      insertId: envelope.insertId,
      rowsAffected: envelope.rowsAffected,
      columnNames: envelope.columnNames ?? [],
      rawRows: decodeRawRows(envelope.rawRows),
    };
  }

  async executeNativeBatch(query: string, params?: BindValueRows): Promise<QueryResult<never>> {
    const envelope = await callNative(
      "executeBatch",
      this.dbId,
      query,
      encodeBindParamRows(params),
    );
    return queryResultWithoutRows({
      rowsAffected: envelope.rowsAffected ?? 0,
    });
  }

  async refreshSchema(): Promise<void> {
    await this.get("PRAGMA table_info('sqlite_master')");
  }

  close(): Promise<NativeOkEnvelope> {
    return callNative("close", this.dbId);
  }
}
