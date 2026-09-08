/** Copy bytes into a standalone ArrayBuffer (avoids SharedArrayBuffer from `.slice`). */
export declare function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer;
export interface ConstructorHost {
    readonly constructor: Function;
}
export type RuntimeValue = null | undefined | string | number | boolean | bigint | symbol | ConstructorHost;
export interface CodedFailure {
    readonly code?: number | string;
}
/** True when `value` is a primitive whose boxed constructor is `ctor`. */
export declare function hasPrimitiveConstructor(value: RuntimeValue, ctor: StringConstructor): value is string;
export declare function hasPrimitiveConstructor(value: RuntimeValue, ctor: NumberConstructor): value is number;
export declare function hasPrimitiveConstructor(value: RuntimeValue, ctor: BooleanConstructor): value is boolean;
export declare function hasPrimitiveConstructor(value: RuntimeValue, ctor: BigIntConstructor): value is bigint;
export declare function isNumberArray(value: ConstructorHost): value is number[];
export declare function errorCode(err: CodedFailure | Error): number | undefined;
