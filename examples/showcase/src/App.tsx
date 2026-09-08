import { useCallback, useEffect, useState } from "@lynx-js/react";

import { demoConnector, hasDemoCredentials, setDemoCredentials } from "./connector.ts";
import { db } from "./database.ts";
import { seedIfEmpty } from "./seed.ts";
import type { ListRow, TodoRow } from "./schema.ts";
import { errorMessage, hostLabel, newId, nowIso, rowArray } from "./util.ts";

import "./App.css";

interface LogEntry {
  id: string;
  at: string;
  message: string;
}

interface LynxInputEvent {
  detail: { value: string };
}

const LIST_WATCH_SQL = "SELECT * FROM lists ORDER BY created_at";
const TODO_WATCH_SQL = "SELECT * FROM todos WHERE list_id = ? ORDER BY created_at";

function asListRows(value: unknown[]): ListRow[] {
  return value.filter(
    (row): row is ListRow => row instanceof Object && "id" in row && "name" in row,
  );
}

function asTodoRows(value: unknown[]): TodoRow[] {
  return value.filter(
    (row): row is TodoRow =>
      row instanceof Object && "id" in row && "list_id" in row && "description" in row,
  );
}

export function App() {
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [lists, setLists] = useState<ListRow[]>([]);
  const [todos, setTodos] = useState<TodoRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [listDraft, setListDraft] = useState("");
  const [todoDraft, setTodoDraft] = useState("");
  const [listField, setListField] = useState(0);
  const [todoField, setTodoField] = useState(0);
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [syncLabel, setSyncLabel] = useState("offline demo");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const platform = hostLabel();

  const log = useCallback((message: string) => {
    setLogs((prev) => [{ id: newId(), at: nowIso(), message }, ...prev].slice(0, 24));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const stopStatus = db.registerListener({
      statusChanged(status) {
        const connected = status.connected ? "connected" : "not connected";
        setSyncLabel(status.connecting ? "connecting" : connected);
      },
    });
    (async () => {
      try {
        await db.waitForReady();
        if (cancelled) {
          return;
        }
        log("waitForReady: database open");
        const seeded = await seedIfEmpty(db);
        log(
          seeded
            ? "writeTransaction: seeded lists + todos"
            : "seed skipped (lists already present)",
        );
        const first = await db.getOptional<ListRow>(
          "SELECT * FROM lists ORDER BY created_at LIMIT 1",
        );
        if (first != null) {
          setSelectedId(first.id);
          log(`get: first list "${first.name}"`);
        }
        const all = await db.getAll<ListRow>("SELECT * FROM lists ORDER BY created_at");
        log(`getAll: ${all.length} lists`);
        setReady(true);
      } catch (err) {
        const message = errorMessage(err);
        setFatal(
          `${message}\n\nNativePowerSyncModule is not registered on this host. Lynx Explorer does not ship it. Use the Lynx-for-Web host (attach + WASQLite) or an Autolink native host. See examples/README.md.`,
        );
        log(`open failed: ${message}`);
      }
    })();
    return () => {
      cancelled = true;
      stopStatus();
    };
  }, [log]);

  useEffect(() => {
    if (!ready) {
      return;
    }
    const abort = new AbortController();
    db.watch(
      LIST_WATCH_SQL,
      [],
      {
        onResult(result) {
          const next = asListRows(rowArray(result));
          setLists(next);
        },
        onError(err) {
          log(`lists watch: ${errorMessage(err)}`);
        },
      },
      { signal: abort.signal },
    );
    return () => abort.abort();
  }, [log, ready]);

  useEffect(() => {
    if (!ready || selectedId == null) {
      setTodos([]);
      return;
    }
    const abort = new AbortController();
    db.watch(
      TODO_WATCH_SQL,
      [selectedId],
      {
        onResult(result) {
          setTodos(asTodoRows(rowArray(result)));
        },
        onError(err) {
          log(`todos watch: ${errorMessage(err)}`);
        },
      },
      { signal: abort.signal },
    );
    return () => abort.abort();
  }, [log, ready, selectedId]);

  const addList = useCallback(async () => {
    const name = listDraft.trim();
    if (name.length === 0) {
      return;
    }
    const id = newId();
    await db.execute("INSERT INTO lists (id, name, created_at, owner_id) VALUES (?, ?, ?, ?)", [
      id,
      name,
      nowIso(),
      "demo",
    ]);
    setListDraft("");
    setListField((n) => n + 1);
    setSelectedId(id);
    log(`execute: inserted list "${name}"`);
  }, [listDraft, log]);

  const addTodo = useCallback(async () => {
    if (selectedId == null) {
      return;
    }
    const description = todoDraft.trim();
    if (description.length === 0) {
      return;
    }
    await db.execute(
      "INSERT INTO todos (id, list_id, description, completed, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?)",
      [newId(), selectedId, description, 0, nowIso(), null],
    );
    setTodoDraft("");
    setTodoField((n) => n + 1);
    log(`execute: inserted todo "${description}"`);
  }, [log, selectedId, todoDraft]);

  const toggleTodo = useCallback(
    async (todo: TodoRow) => {
      const completed = todo.completed ? 0 : 1;
      const completedAt = completed === 1 ? nowIso() : null;
      await db.writeTransaction(async (tx) => {
        await tx.execute("UPDATE todos SET completed = ?, completed_at = ? WHERE id = ?", [
          completed,
          completedAt,
          todo.id,
        ]);
      });
      log(`writeTransaction: toggled "${todo.description}"`);
    },
    [log],
  );

  const addBatch = useCallback(async () => {
    if (selectedId == null) {
      return;
    }
    const createdAt = nowIso();
    await db.writeTransaction(async (tx) => {
      for (const description of ["Batch item A", "Batch item B", "Batch item C"]) {
        await tx.execute(
          "INSERT INTO todos (id, list_id, description, completed, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?)",
          [newId(), selectedId, description, 0, createdAt, null],
        );
      }
    });
    log("writeTransaction: inserted 3 batch todos");
  }, [log, selectedId]);

  const connectLive = useCallback(async () => {
    setDemoCredentials({ endpoint, token });
    if (!hasDemoCredentials()) {
      log("connect skipped: endpoint and token are required");
      return;
    }
    try {
      await db.connect(demoConnector);
      log("connect: Connector attached (HTTP). Live streaming is not verified on this host.");
      setSyncLabel("connecting");
      try {
        const sub = await db.syncStream("todos").subscribe();
        log('syncStream("todos").subscribe() returned');
        const timeout = new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("waitForFirstSync timed out")), 4000);
        });
        await Promise.race([sub.waitForFirstSync(), timeout]);
        log("waitForFirstSync: resolved");
      } catch (err) {
        log(
          `sync subscribe / waitForFirstSync: ${errorMessage(err)} (not verified on a live host)`,
        );
      }
    } catch (err) {
      log(`connect failed: ${errorMessage(err)}`);
    }
  }, [endpoint, log, token]);

  const selected = lists.find((row) => row.id === selectedId) ?? null;

  if (fatal != null) {
    return (
      <view className="Page">
        <view className="Hero">
          <text className="Eyebrow">PowerSync on Lynx</text>
          <text className="Title">Native Module missing</text>
        </view>
        <view className="Banner Banner--error">
          <text className="BannerText">{fatal}</text>
        </view>
      </view>
    );
  }

  return (
    <scroll-view className="Page" scroll-y>
      <view className="Hero">
        <text className="Eyebrow">PowerSync on Lynx</text>
        <text className="Title">Todo showcase</text>
        <text className="Sub">
          Schema, local CRUD, watch, Connector, and Sync Stream subscribe on {platform}
        </text>
      </view>

      <view className="Row">
        <view className="Pill">
          <text className="PillLabel">DB {ready ? "ready" : "opening"}</text>
        </view>
        <view className="Pill">
          <text className="PillLabel">sync {syncLabel}</text>
        </view>
        <view className="Pill Pill--warn">
          <text className="PillLabel">live stream unverified</text>
        </view>
      </view>

      <view className="Banner">
        <text className="BannerText">
          Verified here: SQL RPC, CRUD, watch, and the sync subscribe call path. Not verified: live
          /sync/stream incremental delivery or disconnect cancellation on a physical iOS / Android /
          Windows / macOS device.
        </text>
      </view>

      <view className="Grid">
        <view className="Card">
          <text className="CardTitle">Lists</text>
          <view className="Composer">
            <input
              key={listField}
              className="Field"
              placeholder="New list"
              default-value=""
              bindinput={(e: LynxInputEvent) => setListDraft(e.detail.value)}
            />
            <view className="Btn" bindtap={addList}>
              <text className="BtnLabel">Add</text>
            </view>
          </view>
          {lists.map((list) => (
            <view
              key={list.id}
              className={selectedId === list.id ? "Item Item--active" : "Item"}
              bindtap={() => setSelectedId(list.id)}
            >
              <text className="ItemTitle">{list.name}</text>
              <text className="ItemMeta">{list.created_at}</text>
            </view>
          ))}
        </view>

        <view className="Card">
          <text className="CardTitle">{selected != null ? selected.name : "Todos"}</text>
          <view className="Composer">
            <input
              key={todoField}
              className="Field"
              placeholder="New todo"
              default-value=""
              bindinput={(e: LynxInputEvent) => setTodoDraft(e.detail.value)}
            />
            <view className="Btn" bindtap={addTodo}>
              <text className="BtnLabel">Add</text>
            </view>
          </view>
          <view className="Btn Btn--ghost" bindtap={addBatch}>
            <text className="BtnLabel">writeTransaction batch</text>
          </view>
          {todos.map((todo) => (
            <view key={todo.id} className="Item" bindtap={() => toggleTodo(todo)}>
              <text className={todo.completed ? "ItemTitle ItemTitle--done" : "ItemTitle"}>
                {todo.completed ? "✓ " : "○ "}
                {todo.description}
              </text>
            </view>
          ))}
        </view>
      </view>

      <view className="Card">
        <text className="CardTitle">Connector</text>
        <text className="CardHint">
          Default is offline demo (fetchCredentials returns null). Optional live connect needs a
          PowerSync Service endpoint and JWT. uploadData completes locally; it does not POST to an
          app backend.
        </text>
        <input
          className="Field"
          placeholder="PowerSync endpoint"
          bindinput={(e: LynxInputEvent) => setEndpoint(e.detail.value)}
        />
        <input
          className="Field"
          placeholder="PowerSync JWT"
          bindinput={(e: LynxInputEvent) => setToken(e.detail.value)}
        />
        <view className="Btn" bindtap={connectLive}>
          <text className="BtnLabel">connect + subscribe</text>
        </view>
      </view>

      <view className="Card">
        <text className="CardTitle">Workflow log</text>
        {logs.map((entry) => (
          <view key={entry.id} className="LogRow">
            <text className="LogAt">{entry.at}</text>
            <text className="LogMsg">{entry.message}</text>
          </view>
        ))}
      </view>
    </scroll-view>
  );
}
