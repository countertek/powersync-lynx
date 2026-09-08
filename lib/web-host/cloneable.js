/**
 * Lynx-for-Web NativeModulesCall data is Cloneable (primitives / objects / arrays).
 * Native BindValue also includes ArrayBuffer and bigint; tag those for the hop.
 */

const AB_TAG = '__psAb';
const BIG_TAG = '__psBig';

export function encodeCloneable(value) {
  if (value === null || typeof value === 'undefined') {
    return value;
  }
  if (typeof value === 'bigint') {
    return { [BIG_TAG]: true, v: value.toString(10) };
  }
  if (value instanceof ArrayBuffer) {
    return { [AB_TAG]: true, u8: Array.from(new Uint8Array(value)) };
  }
  if (Array.isArray(value)) {
    return value.map(encodeCloneable);
  }
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      out[key] = encodeCloneable(value[key]);
    }
    return out;
  }
  return value;
}

export function decodeCloneable(value) {
  if (value === null || typeof value === 'undefined') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(decodeCloneable);
  }
  if (typeof value === 'object') {
    if (value[AB_TAG] === true && Array.isArray(value.u8)) {
      return Uint8Array.from(value.u8).buffer;
    }
    if (value[BIG_TAG] === true && typeof value.v === 'string') {
      return BigInt(value.v);
    }
    const out = {};
    for (const key of Object.keys(value)) {
      out[key] = decodeCloneable(value[key]);
    }
    return out;
  }
  return value;
}
