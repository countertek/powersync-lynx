import type { PowerSyncBackendConnector } from "powersync-lynx";

export const DEMO_API_URL = "http://127.0.0.1:8081";
export const DEMO_POWERSYNC_URL = "http://127.0.0.1:8080";
export const DEMO_USER = "demo-user";

export interface DemoCredentials {
  endpoint: string;
  token: string;
}

type LogFn = (message: string) => void;

let configured: DemoCredentials | null = null;
let logFn: LogFn = () => {};

export function setConnectorLog(fn: LogFn): void {
  logFn = fn;
}

export function setDemoCredentials(next: DemoCredentials | null): void {
  configured = next;
}

export function hasDemoCredentials(): boolean {
  return configured != null;
}

/** Plain { op, table, id, opData } for demo-api. CrudEntry.toJSON() emits { type, data } instead. */
export function crudUploadEntries(
  crud: ReadonlyArray<{
    op: string;
    table: string;
    id: string;
    opData?: Record<string, unknown> | null;
  }>,
): Array<{ op: string; table: string; id: string; opData: Record<string, unknown> | null }> {
  return crud.map((entry) => ({
    op: entry.op,
    table: entry.table,
    id: entry.id,
    opData: entry.opData ?? null,
  }));
}

export async function fetchDemoCredentials(): Promise<DemoCredentials | null> {
  const response = await fetch(`${DEMO_API_URL}/token`);
  if (!response.ok) {
    throw new Error(`demo token endpoint HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  if (!(body instanceof Object) || !("token" in body) || !("endpoint" in body)) {
    throw new Error("demo token endpoint returned an unexpected body");
  }
  const token = String(body.token).trim();
  const endpoint = String(body.endpoint).trim();
  if (token.length === 0 || endpoint.length === 0) {
    throw new Error("demo token endpoint returned an empty token or endpoint");
  }
  return { endpoint, token };
}

/**
 * Demo Connector. fetchCredentials reads a local compose-stack token
 * (HS256 JWT, not a cloud account). uploadData POSTs CRUD to the demo API,
 * which writes Postgres. Without the stack, fetchCredentials returns null
 * and the app stays a local offline queue.
 */
export const demoConnector: PowerSyncBackendConnector = {
  async fetchCredentials() {
    if (configured == null) {
      return null;
    }
    return { endpoint: configured.endpoint, token: configured.token };
  },

  async uploadData(database) {
    const transaction = await database.getNextCrudTransaction();
    if (transaction == null) {
      return;
    }
    logFn(`upload: ${transaction.crud.length} op(s)`);
    const response = await fetch(`${DEMO_API_URL}/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ crud: crudUploadEntries(transaction.crud) }),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`upload HTTP ${response.status}: ${detail}`);
    }
    await transaction.complete();
    logFn("upload: complete");
  },
};
