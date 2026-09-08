import { LockContext } from "@powersync/common";
import type { QueryResult, RawQueryResult } from "@powersync/common";
import { type BindValueRows, type BindValues, type NativeOkEnvelope } from "./native.js";
export declare class LynxConnection extends LockContext {
    readonly dbId: string;
    constructor(dbId: string);
    executeRaw(query: string, params?: BindValues): Promise<RawQueryResult>;
    executeNativeBatch(query: string, params?: BindValueRows): Promise<QueryResult<never>>;
    refreshSchema(): Promise<void>;
    close(): Promise<NativeOkEnvelope>;
}
