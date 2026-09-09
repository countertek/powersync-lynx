/** Type-predicate probes for host/wire values. `typeof` is allowed only in these guards. */

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

export type HostCallable = (...args: never[]) => void;

export function isFunction(value: unknown): value is HostCallable {
  return typeof value === "function";
}

export function isNonNullObject(value: unknown): value is object {
  return value != null && typeof value === "object";
}
