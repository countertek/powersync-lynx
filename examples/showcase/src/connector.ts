import type { PowerSyncBackendConnector } from "powersync-lynx";

export interface DemoCredentials {
  endpoint: string;
  token: string;
}

let configured: DemoCredentials | null = null;

export function setDemoCredentials(next: DemoCredentials | null): void {
  if (next == null) {
    configured = null;
    return;
  }
  const endpoint = next.endpoint.trim();
  const token = next.token.trim();
  configured = endpoint.length > 0 && token.length > 0 ? { endpoint, token } : null;
}

export function hasDemoCredentials(): boolean {
  return configured != null;
}

/**
 * Showcase Connector. Without credentials, `fetchCredentials` returns null
 * (signed out). `uploadData` drains the local CRUD queue; it does not POST
 * to an app backend.
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
    await transaction.complete();
  },
};
