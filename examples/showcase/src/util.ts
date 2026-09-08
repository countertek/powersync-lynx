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
