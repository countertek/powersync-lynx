function getNativeModule() {
  const modules = globalThis.NativeModules;
  const native = modules?.NativePowerSyncModule;
  if (native == null) {
    throw new Error('NativePowerSyncModule is not registered');
  }
  return native;
}

/**
 * Invoke a Native Module method with a function callback. The method return
 * value is ignored (Lynx cannot pass a Promise on this wire).
 */
export function callNative(method, ...args) {
  const native = getNativeModule();
  const fn = native[method];
  if (typeof fn !== 'function') {
    throw new Error(`NativePowerSyncModule.${method} is not available`);
  }
  return new Promise((resolve, reject) => {
    fn.call(native, ...args, (envelope) => {
      if (!envelope || envelope.ok === false) {
        const error = new Error(envelope?.message ?? 'NativePowerSyncModule request failed');
        if (envelope?.code != null) {
          error.code = envelope.code;
        }
        reject(error);
        return;
      }
      resolve(envelope);
    });
  });
}

export function blobToArrayBuffer(value) {
  if (value instanceof ArrayBuffer) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  if (Array.isArray(value) && value.every((n) => typeof n === 'number')) {
    return Uint8Array.from(value).buffer;
  }
  return value;
}

export function encodeBindParams(params) {
  if (params == null) {
    return [];
  }
  return params.map(blobToArrayBuffer);
}

export function encodeBindParamRows(params) {
  if (params == null) {
    return [];
  }
  return params.map(encodeBindParams);
}

export function decodeCell(value) {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return value;
}

export function decodeRawRows(rawRows) {
  return (rawRows ?? []).map((row) => (row ?? []).map(decodeCell));
}
