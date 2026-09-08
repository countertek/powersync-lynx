import { LockContext, queryResultWithoutRows } from "@powersync/common";
import { callNative, decodeRawRows, encodeBindParams, encodeBindParamRows, } from "./native.js";
export class LynxConnection extends LockContext {
    dbId;
    constructor(dbId) {
        super();
        this.dbId = dbId;
    }
    async executeRaw(query, params) {
        const envelope = await callNative("execute", this.dbId, query, encodeBindParams(params));
        return {
            insertId: envelope.insertId,
            rowsAffected: envelope.rowsAffected,
            columnNames: envelope.columnNames ?? [],
            rawRows: decodeRawRows(envelope.rawRows),
        };
    }
    async executeNativeBatch(query, params) {
        const envelope = await callNative("executeBatch", this.dbId, query, encodeBindParamRows(params));
        return queryResultWithoutRows({
            rowsAffected: envelope.rowsAffected ?? 0,
        });
    }
    async refreshSchema() {
        await this.get("PRAGMA table_info('sqlite_master')");
    }
    close() {
        return callNative("close", this.dbId);
    }
}
