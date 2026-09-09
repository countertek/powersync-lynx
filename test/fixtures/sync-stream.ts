import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { isNonNullObject, isString } from "../../src/type-guards.ts";

export type SyncStreamPath = "streamingId" | "idleComplete";

export interface SyncStreamScenario {
  id: string;
  path: SyncStreamPath;
  chunks: string[];
  events: string[];
  error: string | undefined;
  /** Raw socket/read splits as hex; absent when `chunks` are already wire UTF-8. */
  wireChunksHex: string[] | undefined;
}

export interface SyncStreamFixtureCatalog {
  contentType: string;
  idleCompleteEnvelopeKeys: string[];
  streamingEnvelopeKeys: string[];
  scenarios: SyncStreamScenario[];
}

interface CatalogJson {
  id?: unknown;
  path?: unknown;
  chunks?: unknown;
  events?: unknown;
  error?: unknown;
  wireChunksHex?: unknown;
  contentType?: unknown;
  idleCompleteEnvelopeKeys?: unknown;
  streamingEnvelopeKeys?: unknown;
  scenarios?: unknown;
}

const catalogUrl = new URL("../../shared/fixtures/sync-stream.json", import.meta.url);

export const syncStreamFixturesPath = fileURLToPath(catalogUrl);

export function joinedFixtureBody(scenario: SyncStreamScenario): string {
  return scenario.chunks.join("");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => isString(item));
}

function isCatalogJson(value: unknown): value is CatalogJson {
  return isNonNullObject(value);
}

function parsePath(value: string): SyncStreamPath {
  if (value === "streamingId" || value === "idleComplete") {
    return value;
  }
  throw new Error(`unknown fixture path: ${value}`);
}

function parseScenario(row: CatalogJson): SyncStreamScenario {
  if (!isString(row.id) || row.id.length === 0) {
    throw new Error("fixture scenario id must be a string");
  }
  if (!isStringArray(row.chunks)) {
    throw new Error(`fixture ${row.id} chunks must be strings`);
  }
  if (!isStringArray(row.events)) {
    throw new Error(`fixture ${row.id} events must be strings`);
  }
  if (!isString(row.path)) {
    throw new Error(`fixture ${row.id} path must be a string`);
  }
  const error = row.error;
  const wireChunksHex = isStringArray(row.wireChunksHex) ? row.wireChunksHex : undefined;
  return {
    id: row.id,
    path: parsePath(row.path),
    chunks: row.chunks,
    events: row.events,
    error: isString(error) ? error : undefined,
    wireChunksHex,
  };
}

export function loadSyncStreamFixtures(): SyncStreamFixtureCatalog {
  const parsed: unknown = JSON.parse(readFileSync(syncStreamFixturesPath, "utf8"));
  if (!isCatalogJson(parsed)) {
    throw new Error("sync-stream catalog must be an object");
  }
  if (!isString(parsed.contentType) || parsed.contentType.length === 0) {
    throw new Error("catalog contentType must be a string");
  }
  if (!isStringArray(parsed.idleCompleteEnvelopeKeys)) {
    throw new Error("catalog idleCompleteEnvelopeKeys must be strings");
  }
  if (!isStringArray(parsed.streamingEnvelopeKeys)) {
    throw new Error("catalog streamingEnvelopeKeys must be strings");
  }
  if (!Array.isArray(parsed.scenarios)) {
    throw new Error("catalog scenarios must be an array");
  }
  const scenarios: SyncStreamScenario[] = [];
  for (const item of parsed.scenarios) {
    if (!isCatalogJson(item)) {
      throw new Error("fixture scenario must be an object");
    }
    scenarios.push(parseScenario(item));
  }
  return {
    contentType: parsed.contentType,
    idleCompleteEnvelopeKeys: parsed.idleCompleteEnvelopeKeys,
    streamingEnvelopeKeys: parsed.streamingEnvelopeKeys,
    scenarios,
  };
}

export function requireScenario(catalog: SyncStreamFixtureCatalog, id: string): SyncStreamScenario {
  const found = catalog.scenarios.find((scenario) => scenario.id === id);
  if (found == null) {
    throw new Error(`missing sync-stream scenario: ${id}`);
  }
  return found;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("hex string must have even length");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(byte)) {
      throw new Error(`invalid hex at ${i * 2}`);
    }
    out[i] = byte;
  }
  return out;
}

/** Socket/read pieces: wireChunksHex when present, otherwise UTF-8 of chunks. */
export function fixtureWireBytes(scenario: SyncStreamScenario): Uint8Array[] {
  if (scenario.wireChunksHex != null && scenario.wireChunksHex.length > 0) {
    return scenario.wireChunksHex.map(hexToBytes);
  }
  return scenario.chunks.map((chunk) => new TextEncoder().encode(chunk));
}
