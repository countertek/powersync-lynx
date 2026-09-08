/** Copy bytes into a standalone ArrayBuffer (avoids SharedArrayBuffer from `.slice`). */
export function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  // SAFETY: a newly allocated Uint8Array is backed by ArrayBuffer, not SharedArrayBuffer.
  return copy.buffer as ArrayBuffer;
}

export interface ConstructorHost {
  readonly constructor: Function;
}

export type RuntimeValue =
  | null
  | undefined
  | string
  | number
  | boolean
  | bigint
  | symbol
  | ConstructorHost;

export interface CodedFailure {
  readonly code?: number | string;
}

/** True when `value` is a primitive whose boxed constructor is `ctor`. */
export function hasPrimitiveConstructor(
  value: RuntimeValue,
  ctor: StringConstructor,
): value is string;
export function hasPrimitiveConstructor(
  value: RuntimeValue,
  ctor: NumberConstructor,
): value is number;
export function hasPrimitiveConstructor(
  value: RuntimeValue,
  ctor: BooleanConstructor,
): value is boolean;
export function hasPrimitiveConstructor(
  value: RuntimeValue,
  ctor: BigIntConstructor,
): value is bigint;
export function hasPrimitiveConstructor(
  value: RuntimeValue,
  ctor: StringConstructor | NumberConstructor | BooleanConstructor | BigIntConstructor,
): boolean {
  return (
    value !== null &&
    value !== undefined &&
    !(value instanceof Object) &&
    value.constructor === ctor
  );
}

export function isNumberArray(value: ConstructorHost): value is number[] {
  return Array.isArray(value) && value.every((item) => hasPrimitiveConstructor(item, Number));
}

export function errorCode(err: CodedFailure | Error): number | undefined {
  if (!("code" in err)) {
    return undefined;
  }
  // SAFETY: Native Module / WASQLite failures expose `code` as a JSON primitive when present.
  const code = err.code as RuntimeValue;
  return hasPrimitiveConstructor(code, Number) ? code : undefined;
}
