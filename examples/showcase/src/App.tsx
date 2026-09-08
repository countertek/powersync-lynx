import { useCallback, useEffect, useState } from "@lynx-js/react";

import {
  DEMO_POWERSYNC_URL,
  demoConnector,
  fetchDemoCredentials,
  hasDemoCredentials,
  setConnectorLog,
  setDemoCredentials,
} from "./connector.ts";
import { getDb, waitForDemoReady } from "./database.ts";
import type { TodoRow } from "./schema.ts";
import { deviceId, errorMessage, hostLabel, newId, nowIso, rowArray } from "./util.ts";

import "./App.css";

type Filter = "all" | "active" | "done";

interface LogEntry {
  id: string;
  at: string;
  message: string;
}

interface LynxInputEvent {
  detail: { value: string };
}

interface FatalState {
  title: string;
  detail: string;
}

const TODO_WATCH_SQL = "SELECT * FROM todos ORDER BY created_at";

const MISSING_MODULE_HINT =
  "NativePowerSyncModule is not registered on this host. Lynx Explorer does not ship it. Use the Lynx-for-Web host (attach + WASQLite) or an Autolink native host. See examples/README.md.";

function isMissingNativeModule(message: string): boolean {
  return message.includes("NativePowerSyncModule is not registered");
}

function fatalFromError(err: unknown): FatalState {
  const detail = errorMessage(err);
  if (isMissingNativeModule(detail)) {
    return { title: "NativePowerSyncModule is not registered", detail: MISSING_MODULE_HINT };
  }
  return { title: "Database failed to open", detail };
}

function asTodoRows(value: unknown[]): TodoRow[] {
  return value.filter(
    (row): row is TodoRow =>
      row instanceof Object && "id" in row && "description" in row && "completed" in row,
  );
}

function matchesFilter(todo: TodoRow, filter: Filter): boolean {
  if (filter === "active") {
    return todo.completed === 0;
  }
  if (filter === "done") {
    return todo.completed === 1;
  }
  return true;
}

export function App() {
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState<FatalState | null>(null);
  const [todos, setTodos] = useState<TodoRow[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [draft, setDraft] = useState("");
  const [draftField, setDraftField] = useState(0);
  const [syncLabel, setSyncLabel] = useState("offline");
  const [wantSync, setWantSync] = useState(true);
  const [logOpen, setLogOpen] = useState(true);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const platform = hostLabel();
  const device = deviceId();

  const log = useCallback((message: string) => {
    setLogs((prev) => [{ id: newId(), at: nowIso(), message }, ...prev].slice(0, 40));
  }, []);

  useEffect(() => {
    setConnectorLog(log);
    return () => setConnectorLog(() => {});
  }, [log]);

  useEffect(() => {
    let cancelled = false;
    let lastConnected = false;
    let lastUploading = false;
    let lastDownloading = false;
    let everConnected = false;
    const stopStatus = getDb().registerListener({
      statusChanged(status) {
        const connected = status.connected === true;
        const uploading = status.dataFlowStatus?.uploading === true;
        const downloading = status.dataFlowStatus?.downloading === true;
        if (status.connecting === true) {
          setSyncLabel("connecting");
        } else {
          setSyncLabel(connected ? "connected" : "offline");
        }
        if (connected && !lastConnected) {
          log(everConnected ? "reconnected" : "connected");
          everConnected = true;
        }
        if (!connected && lastConnected) {
          log("disconnected");
        }
        if (uploading && !lastUploading) {
          log("upload in progress");
        }
        if (!uploading && lastUploading) {
          log("upload idle");
        }
        if (downloading && !lastDownloading) {
          log("download in progress");
        }
        if (!downloading && lastDownloading) {
          log("download idle");
        }
        lastConnected = connected;
        lastUploading = uploading;
        lastDownloading = downloading;
      },
    });

    waitForDemoReady()
      .then(async () => {
        if (cancelled) {
          return;
        }
        log("waitForReady: database open");
        try {
          const creds = await fetchDemoCredentials();
          if (cancelled) {
            return;
          }
          if (creds == null) {
            log("token: demo API returned no credentials; staying offline");
            return;
          }
          setDemoCredentials(creds);
          await getDb().connect(demoConnector);
          log(`connect: ${DEMO_POWERSYNC_URL} as ${device}`);
        } catch (err) {
          log(
            `connect skipped: ${errorMessage(err)}. Start the sync profile (examples/README.md). Writes still queue locally.`,
          );
        }
      })
      .then(() => {
        if (!cancelled) {
          setReady(true);
        }
      })
      .catch((err: unknown) => {
        setFatal(fatalFromError(err));
        log(`open failed: ${errorMessage(err)}`);
      });

    return () => {
      cancelled = true;
      stopStatus();
    };
  }, [device, log]);

  useEffect(() => {
    if (!ready) {
      return;
    }
    const abort = new AbortController();
    getDb().watch(
      TODO_WATCH_SQL,
      [],
      {
        onResult(result) {
          if (abort.signal.aborted) {
            return;
          }
          setTodos(asTodoRows(rowArray(result)));
        },
        onError(err) {
          log(`todos watch: ${errorMessage(err)}`);
        },
      },
      { signal: abort.signal },
    );
    return () => abort.abort();
  }, [log, ready]);

  const addTodo = useCallback(async () => {
    const description = draft.trim();
    if (description.length === 0) {
      return;
    }
    try {
      await getDb().execute(
        "INSERT INTO todos (id, description, completed, created_at, completed_at) VALUES (?, ?, ?, ?, ?)",
        [newId(), description, 0, nowIso(), null],
      );
      setDraft("");
      setDraftField((n) => n + 1);
      log(`insert: "${description}"`);
    } catch (err) {
      log(`insert failed: ${errorMessage(err)}`);
    }
  }, [draft, log]);

  const toggleTodo = useCallback(
    async (todo: TodoRow) => {
      const completed = todo.completed ? 0 : 1;
      const completedAt = completed === 1 ? nowIso() : null;
      try {
        await getDb().execute("UPDATE todos SET completed = ?, completed_at = ? WHERE id = ?", [
          completed,
          completedAt,
          todo.id,
        ]);
        log(`toggle: "${todo.description}" -> ${completed === 1 ? "done" : "active"}`);
      } catch (err) {
        log(`toggle failed: ${errorMessage(err)}`);
      }
    },
    [log],
  );

  const deleteTodo = useCallback(
    async (todo: TodoRow) => {
      try {
        await getDb().execute("DELETE FROM todos WHERE id = ?", [todo.id]);
        log(`delete: "${todo.description}"`);
      } catch (err) {
        log(`delete failed: ${errorMessage(err)}`);
      }
    },
    [log],
  );

  const goOffline = useCallback(async () => {
    setWantSync(false);
    try {
      await getDb().disconnect();
      log("offline: disconnected; local writes will queue");
    } catch (err) {
      log(`offline failed: ${errorMessage(err)}`);
    }
  }, [log]);

  const goOnline = useCallback(async () => {
    setWantSync(true);
    try {
      if (!hasDemoCredentials()) {
        const creds = await fetchDemoCredentials();
        if (creds != null) {
          setDemoCredentials(creds);
        }
      }
      await getDb().connect(demoConnector);
      log("reconnect: connect() called");
    } catch (err) {
      log(`reconnect failed: ${errorMessage(err)}`);
    }
  }, [log]);

  const visible = todos.filter((todo) => matchesFilter(todo, filter));

  if (fatal != null) {
    return (
      <view className="Page">
        <view className="Hero">
          <text className="Eyebrow">PowerSync on Lynx</text>
          <text className="Title">{fatal.title}</text>
        </view>
        <view className="Banner Banner--error">
          <text className="BannerText">{fatal.detail}</text>
        </view>
      </view>
    );
  }

  return (
    <scroll-view className="Page" scroll-y>
      <view className="Hero">
        <text className="Eyebrow">PowerSync on Lynx</text>
        <text className="Title">TODO</text>
        <text className="Sub">
          One screen. Add, complete, delete, filter. Device {device} on {platform}.
        </text>
      </view>

      <view className="Row">
        <view className="Pill">
          <text className="PillLabel">DB {ready ? "ready" : "opening"}</text>
        </view>
        <view className="Pill">
          <text className="PillLabel">sync {syncLabel}</text>
        </view>
        <view className="Pill">
          <text className="PillLabel">device {device}</text>
        </view>
      </view>

      <view className="Row">
        <view
          className={wantSync ? "Btn Btn--ghost" : "Btn"}
          bindtap={wantSync ? goOffline : goOnline}
        >
          <text className="BtnLabel">{wantSync ? "Go offline" : "Reconnect"}</text>
        </view>
      </view>

      <view className="Card">
        <text className="CardTitle">Todos</text>
        <view className="Composer">
          <input
            key={draftField}
            className="Field"
            placeholder="What needs doing?"
            default-value=""
            bindinput={(e: LynxInputEvent) => setDraft(e.detail.value)}
          />
          <view className="Btn" bindtap={addTodo}>
            <text className="BtnLabel">Add</text>
          </view>
        </view>
        <view className="Row">
          <view
            className={filter === "all" ? "Btn" : "Btn Btn--ghost"}
            bindtap={() => setFilter("all")}
          >
            <text className="BtnLabel">All</text>
          </view>
          <view
            className={filter === "active" ? "Btn" : "Btn Btn--ghost"}
            bindtap={() => setFilter("active")}
          >
            <text className="BtnLabel">Active</text>
          </view>
          <view
            className={filter === "done" ? "Btn" : "Btn Btn--ghost"}
            bindtap={() => setFilter("done")}
          >
            <text className="BtnLabel">Done</text>
          </view>
        </view>
        {visible.map((todo) => (
          <view key={todo.id} className="Item">
            <view className="ItemMain" bindtap={() => toggleTodo(todo)}>
              <text className={todo.completed ? "ItemTitle ItemTitle--done" : "ItemTitle"}>
                {todo.completed ? "[x] " : "[ ] "}
                {todo.description}
              </text>
            </view>
            <view className="Btn Btn--ghost" bindtap={() => deleteTodo(todo)}>
              <text className="BtnLabel">Delete</text>
            </view>
          </view>
        ))}
      </view>

      <view className="Card">
        <view className="LogHead" bindtap={() => setLogOpen((open) => !open)}>
          <text className="CardTitle">Sync log {logOpen ? "v" : ">"}</text>
          <text className="CardHint">{logs.length} events</text>
        </view>
        {logOpen
          ? logs.map((entry) => (
              <view key={entry.id} className="LogRow">
                <text className="LogAt">{entry.at}</text>
                <text className="LogMsg">{entry.message}</text>
              </view>
            ))
          : null}
      </view>
    </scroll-view>
  );
}
