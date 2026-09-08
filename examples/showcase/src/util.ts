export function newId(): string {
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

export function hostLabel(): string {
  try {
    const info = SystemInfo as { platform?: string };
    if (info.platform != null && info.platform.length > 0) {
      return info.platform;
    }
  } catch {
    // SystemInfo is a Lynx global; some hosts omit it.
  }
  return "unknown";
}

function globalProps(): {
  device?: string;
  demoApiUrl?: string;
  powersyncUrl?: string;
} {
  try {
    return lynx.__globalProps ?? {};
  } catch {
    return {};
  }
}

function defaultLoopbackHost(): string {
  return hostLabel().toLowerCase() === "android" ? "10.0.2.2" : "127.0.0.1";
}

/** demo-api origin. Native hosts inject this; Android emulator is 10.0.2.2. */
export function demoApiUrl(): string {
  const fromHost = globalProps().demoApiUrl?.trim();
  if (fromHost != null && fromHost.length > 0) {
    return fromHost.replace(/\/$/, "");
  }
  return `http://${defaultLoopbackHost()}:8081`;
}

/** PowerSync origin used by connect(). Native hosts inject this. */
export function demoPowersyncUrl(): string {
  const fromHost = globalProps().powersyncUrl?.trim();
  if (fromHost != null && fromHost.length > 0) {
    return fromHost.replace(/\/$/, "");
  }
  return `http://${defaultLoopbackHost()}:8080`;
}

export function deviceId(): string {
  const device = globalProps().device?.trim();
  if (device != null && device.length > 0) {
    return device;
  }
  const platform = hostLabel().toLowerCase();
  if (platform === "ios") {
    return "ios";
  }
  if (platform === "android") {
    return "android";
  }
  return "web";
}

export interface QueryRows {
  array?: unknown[];
  rows?: { _array?: unknown[] };
}

export function rowArray(result: QueryRows): unknown[] {
  if (result.array != null) {
    return result.array;
  }
  return result.rows?._array ?? [];
}

type LynxFetchNative = {
  fetch(
    request: Record<string, unknown>,
    resolve: (response: { status?: number; body?: ArrayBuffer | Uint8Array | string }) => void,
    reject: (error: { message?: string }) => void,
  ): void;
};

function lynxFetchNative(): LynxFetchNative | undefined {
  try {
    const fromGlobal = (globalThis as unknown as { NativeModules?: { LynxFetchModule?: LynxFetchNative } })
      .NativeModules?.LynxFetchModule;
    if (fromGlobal != null) {
      return fromGlobal;
    }
  } catch {
    // PrimJS may not put NativeModules on globalThis.
  }
  try {
    return (NativeModules as { LynxFetchModule?: LynxFetchNative }).LynxFetchModule;
  } catch {
    return undefined;
  }
}

function encodeUtf8(text: string): ArrayBuffer {
  const Encoder = (globalThis as unknown as { TextEncoder?: typeof TextEncoder }).TextEncoder;
  if (typeof Encoder === "function") {
    const bytes = new Encoder().encode(text);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
  }
  const bytes = [];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 128) {
      bytes.push(code);
    } else {
      bytes.push(63);
    }
  }
  return Uint8Array.from(bytes).buffer;
}

function decodeBody(body: ArrayBuffer | Uint8Array | string | undefined): string {
  if (body == null) {
    return "";
  }
  if (typeof body === "string") {
    return body;
  }
  const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : body;
  const Decoder = (globalThis as unknown as { TextDecoder?: typeof TextDecoder }).TextDecoder;
  if (typeof Decoder === "function") {
    return new Decoder().decode(bytes);
  }
  let out = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    out += String.fromCharCode(bytes[i]!);
  }
  return out;
}

/** Android PrimJS fetch(url, init) throws Request. Token GET fetch(url) still works. */
export async function demoFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const native = hostLabel().toLowerCase() === "android" ? lynxFetchNative() : undefined;
  if (native == null) {
    return fetch(url, init);
  }
  const headers: Record<string, string> = {};
  const rawHeaders = init.headers;
  if (rawHeaders != null && !(rawHeaders instanceof Headers) && !Array.isArray(rawHeaders)) {
    for (const [key, value] of Object.entries(rawHeaders)) {
      headers[key] = String(value);
    }
  }
  const payload: Record<string, unknown> = {
    method: String(init.method ?? "GET"),
    url,
    headers,
    lynxExtension: { enableFetchAPIStandardStreaming: true },
  };
  if (typeof init.body === "string") {
    payload.body = encodeUtf8(init.body);
  }
  const result = await new Promise<{ status?: number; body?: ArrayBuffer | Uint8Array | string }>((resolve, reject) => {
    native.fetch(
      payload,
      resolve,
      (error) => reject(new Error(error?.message ?? "LynxFetchModule.fetch failed")),
    );
  });
  const status = Number(result.status ?? 0);
  const textBody = decodeBody(result.body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    async text() {
      return textBody;
    },
    async json() {
      return JSON.parse(textBody) as unknown;
    },
  } as Response;
}
