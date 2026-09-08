import crypto from "node:crypto";
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Pool } = require("pg");

const PORT = Number(process.env.TOKEN_PORT ?? process.env.PORT ?? 8081);
const PUBLIC_POWERSYNC_URL = process.env.POWERSYNC_PUBLIC_URL ?? "http://127.0.0.1:8080";
const AUTH_KEY = process.env.PS_CLIENT_AUTH_KEY ?? "";
const USER_ID = process.env.DEMO_USER_ID ?? "demo-user";
const ALLOWED_TABLES = new Set(["todos"]);
const ALLOWED_COLUMNS = new Set([
  "id",
  "description",
  "completed",
  "created_at",
  "completed_at",
]);

const pool = new Pool({
  host: process.env.PGHOST ?? "127.0.0.1",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "postgres",
  password: process.env.PGPASSWORD ?? "postgres",
  database: process.env.PGDATABASE ?? "postgres",
});

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  res.end(payload);
}

function text(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  res.end(body);
}

function mintToken() {
  if (AUTH_KEY.length === 0) {
    throw new Error("PS_CLIENT_AUTH_KEY is not set");
  }
  const key = Buffer.from(AUTH_KEY, "base64url");
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT", kid: "dev-key-1" }),
  ).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      sub: USER_ID,
      iat: now,
      exp: now + 60 * 60 * 12,
      aud: ["powersync-dev", "powersync"],
    }),
  ).toString("base64url");
  const data = `${header}.${payload}`;
  const sig = crypto.createHmac("sha256", key).update(data).digest("base64url");
  return `${data}.${sig}`;
}

function columnValue(row, key) {
  if (Object.hasOwn(row, key) === false) {
    return null;
  }
  const value = row[key];
  if (value === undefined) {
    return null;
  }
  return value;
}

async function applyPut(client, table, id, data) {
  if (table === "todos") {
    await client.query(
      `INSERT INTO todos (id, description, completed, created_at, completed_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         description = EXCLUDED.description,
         completed = EXCLUDED.completed,
         created_at = EXCLUDED.created_at,
         completed_at = EXCLUDED.completed_at`,
      [
        id,
        columnValue(data, "description") ?? "",
        columnValue(data, "completed") ?? 0,
        columnValue(data, "created_at") ?? new Date().toISOString(),
        columnValue(data, "completed_at"),
      ],
    );
  }
}

async function applyPatch(client, table, id, data) {
  const assignments = [];
  const values = [];
  for (const [key, value] of Object.entries(data)) {
    if (ALLOWED_COLUMNS.has(key) === false || key === "id") {
      continue;
    }
    values.push(value);
    assignments.push(`${key} = $${values.length}`);
  }
  if (assignments.length === 0) {
    return;
  }
  values.push(id);
  await client.query(
    `UPDATE ${table} SET ${assignments.join(", ")} WHERE id = $${values.length}`,
    values,
  );
}

async function applyDelete(client, table, id) {
  await client.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
}

async function applyCrud(crud) {
  if (Array.isArray(crud) === false) {
    throw new Error("body.crud must be an array");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const entry of crud) {
      if (!(entry instanceof Object)) {
        throw new Error("crud entry is not an object");
      }
      const table = String(entry.table ?? entry.type ?? "");
      const id = String(entry.id ?? "");
      const op = String(entry.op ?? "");
      if (ALLOWED_TABLES.has(table) === false || id.length === 0) {
        throw new Error(`refusing op on table=${table} id=${id}`);
      }
      const data = entry.opData instanceof Object ? entry.opData : {};
      if (op === "PUT") {
        await applyPut(client, table, id, data);
      } else if (op === "PATCH") {
        await applyPatch(client, table, id, data);
      } else if (op === "DELETE") {
        await applyDelete(client, table, id);
      } else {
        throw new Error(`unknown op ${op}`);
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  if (req.method === "OPTIONS") {
    text(res, 204, "");
    return;
  }
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/token") {
      json(res, 200, {
        endpoint: PUBLIC_POWERSYNC_URL,
        token: mintToken(),
        userId: USER_ID,
        note: "Static HS256 demo JWT for the local compose stack. Not a cloud account.",
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/upload") {
      const raw = await readBody(req);
      const body = raw.length === 0 ? {} : JSON.parse(raw);
      const crud = body instanceof Object ? body.crud : null;
      await applyCrud(crud);
      json(res, 200, { ok: true });
      return;
    }
    text(res, 404, "not found");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    text(res, 500, message);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`demo-api listening on ${PORT}`);
});
