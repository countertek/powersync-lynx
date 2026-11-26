import { useCallback, useEffect, useState } from "@lynx-js/react";

import {
  demoConnector,
  demoPowersyncUrl,
  fetchDemoCredentials,
  hasDemoCredentials,
  setConnectorLog,
  setDemoCredentials,
} from "./connector.ts";
import { bootDemo } from "./boot.ts";
import { getDb, setClientLog, waitForDemoReady } from "./database.ts";
import { runShowcaseE2e } from "./e2e-driver.ts";
import type { TodoRow } from "./schema.ts";
import { createSessionSyncTracker, applyLocalReadySyncState } from "./session-sync.ts";
import { deviceId, e2eMode, errorMessage, hostLabel, newId, nowIso, rowArray } from "./util.ts";

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

function padTwo(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function formatClockTime(value: string): string {
  if (value === "never" || value.trim().length === 0) {
    return "Never";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return `${padTwo(parsed.getHours())}:${padTwo(parsed.getMinutes())}:${padTwo(parsed.getSeconds())}`;
}

function formatEventCount(count: number): string {
  if (count === 1) {
    return "1 event";
  }
  return `${count} events`;
}

function syncDotClass(syncLabel: string): string {
  if (syncLabel === "connected") {
    return "StatusDot StatusDot--ok";
  }
  if (syncLabel === "connecting") {
    return "StatusDot StatusDot--pending";
  }
  return "StatusDot StatusDot--idle";
}

export function App() {
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState<FatalState | null>(null);
  const [todos, setTodos] = useState<TodoRow[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [draft, setDraft] = useState("");
  const [draftField, setDraftField] = useState(0);
  const [syncLabel, setSyncLabel] = useState("offline");
  const [hasSyncedLabel, setHasSyncedLabel] = useState("no");
  const [lastSyncedText, setLastSyncedText] = useState("never");
  const [firstSyncDone, setFirstSyncDone] = useState(false);
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
    setClientLog(log);
    return () => {
      setConnectorLog(() => {});
      setClientLog(() => {});
    };
  }, [log]);

  useEffect(() => {
    let cancelled = false;
    let stopStatus = () => {};

    const tracker = createSessionSyncTracker({
      log,
      setSyncLabel,
      setHasSyncedLabel,
      setLastSyncedText,
      setFirstSyncDone,
    });

    bootDemo({
      waitForReady: waitForDemoReady,
      fetchCredentials: fetchDemoCredentials,
      setCredentials: setDemoCredentials,
      connect: () => getDb().connect(demoConnector),
      onLocalReady: () => {
        stopStatus = getDb().registerListener({
          statusChanged(status) {
            tracker.statusChanged(status);
          },
        });
        applyLocalReadySyncState(
          tracker,
          getDb().currentStatus,
          () => getDb().waitForFirstSync(),
          () => cancelled,
        );
        setReady(true);
      },
      onConnectSettled: () => {
        if (e2eMode()) {
          void runShowcaseE2e(getDb(), demoConnector, log);
        }
      },
      log,
      isCancelled: () => cancelled,
      connectLabel: `${demoPowersyncUrl()} as ${device}`,
    }).catch((err: unknown) => {
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

  const activeCount = todos.filter((todo) => todo.completed === 0).length;
  const doneCount = todos.length - activeCount;
  const visible = todos.filter((todo) => matchesFilter(todo, filter));
  const canAdd = ready && draft.trim().length > 0;
  const formattedLastSynced = formatClockTime(lastSyncedText);

  if (fatal != null) {
    return (
      <page className="PageRoot">
        <scroll-view className="Page" scroll-y>
          <view className="PageFrame">
            <view className="Container">
              <view className="Hero">
                <text className="Eyebrow">PowerSync on Lynx</text>
                <text className="Title" accessibility-heading>
                  {fatal.title}
                </text>
              </view>
              <view className="Banner Banner--error">
                <text className="BannerText">{fatal.detail}</text>
              </view>
            </view>
          </view>
        </scroll-view>
      </page>
    );
  }

  return (
    <page className="PageRoot">
      <scroll-view className="Page" scroll-y>
        <view className="PageFrame">
          <view className="Container">
            <view className="Hero">
              <text className="Eyebrow">PowerSync on Lynx</text>
              <text className="Title" accessibility-heading>
                TODO
              </text>
              <text className="Sub">
                Local-first SQLite with live sync on device {device} ({platform}).
              </text>
            </view>

            <view className="StatusCard">
              <view className="StatusHeader">
                <view className="StatusBadges">
                  <view className="StatusChip">
                    <view
                      className={ready ? "StatusDot StatusDot--ok" : "StatusDot StatusDot--pending"}
                    />
                    <text className="StatusChipText">DB {ready ? "ready" : "opening"}</text>
                  </view>
                  <view className="StatusChip StatusChip--last">
                    <view className={syncDotClass(syncLabel)} />
                    <text className="StatusChipText">Sync {syncLabel}</text>
                  </view>
                </view>
                <view
                  className={wantSync ? "ActionBtn" : "ActionBtn ActionBtn--accent"}
                  accessibility-element
                  accessibility-traits="button"
                  accessibility-label={wantSync ? "Go offline" : "Reconnect"}
                  bindtap={() => {
                    void (wantSync ? goOffline() : goOnline());
                  }}
                >
                  <text
                    className={
                      wantSync ? "ActionBtnLabel" : "ActionBtnLabel ActionBtnLabel--accent"
                    }
                  >
                    {wantSync ? "Go offline" : "Reconnect"}
                  </text>
                </view>
              </view>

              <view className="StatusMeta">
                <view className="StatusItem">
                  <text className="StatusKey">First sync</text>
                  <text className="StatusVal">
                    {firstSyncDone ? "first sync done" : "awaiting first sync"}
                  </text>
                </view>
                <view className="StatusItem">
                  <text className="StatusKey">Last synced</text>
                  <text className="StatusVal">{formattedLastSynced}</text>
                </view>
                <view className="StatusItem">
                  <text className="StatusKey">Has synced</text>
                  <text className="StatusVal">{hasSyncedLabel}</text>
                </view>
                <view className="StatusItem StatusItem--last">
                  <text className="StatusKey">Device</text>
                  <text className="StatusVal">
                    {device} · {platform}
                  </text>
                </view>
              </view>
            </view>

            <view className="Card">
              <view className="CardHeader">
                <text className="CardTitle" accessibility-heading>
                  Todos
                </text>
                <text className="CardMeta">
                  {activeCount} active · {doneCount} done
                </text>
              </view>

              <view className="Composer">
                <input
                  key={draftField}
                  className="Field"
                  placeholder="Add a task, e.g. Buy milk"
                  placeholder-color="#8b9cb8"
                  default-value=""
                  confirm-type="done"
                  accessibility-label="New todo"
                  bindinput={(e: LynxInputEvent) => setDraft(e.detail.value)}
                  bindconfirm={() => {
                    void addTodo();
                  }}
                />
                <view
                  className={canAdd ? "PrimaryBtn" : "PrimaryBtn PrimaryBtn--disabled"}
                  accessibility-element
                  accessibility-traits={canAdd ? "button" : "disabled"}
                  accessibility-label="Add todo"
                  bindtap={() => {
                    if (canAdd) {
                      void addTodo();
                    }
                  }}
                >
                  <text
                    className={
                      canAdd ? "PrimaryBtnLabel" : "PrimaryBtnLabel PrimaryBtnLabel--disabled"
                    }
                  >
                    Add
                  </text>
                </view>
              </view>

              <view className="Segmented">
                <view
                  className={filter === "all" ? "Segment Segment--active" : "Segment"}
                  accessibility-element
                  accessibility-traits={filter === "all" ? "selected" : "button"}
                  accessibility-label={`All todos, ${todos.length}`}
                  bindtap={() => setFilter("all")}
                >
                  <text
                    className={
                      filter === "all" ? "SegmentLabel SegmentLabel--active" : "SegmentLabel"
                    }
                  >
                    All
                  </text>
                  <text
                    className={
                      filter === "all" ? "SegmentCount SegmentCount--active" : "SegmentCount"
                    }
                  >
                    {todos.length}
                  </text>
                </view>
                <view
                  className={filter === "active" ? "Segment Segment--active" : "Segment"}
                  accessibility-element
                  accessibility-traits={filter === "active" ? "selected" : "button"}
                  accessibility-label={`Active todos, ${activeCount}`}
                  bindtap={() => setFilter("active")}
                >
                  <text
                    className={
                      filter === "active" ? "SegmentLabel SegmentLabel--active" : "SegmentLabel"
                    }
                  >
                    Active
                  </text>
                  <text
                    className={
                      filter === "active" ? "SegmentCount SegmentCount--active" : "SegmentCount"
                    }
                  >
                    {activeCount}
                  </text>
                </view>
                <view
                  className={
                    filter === "done"
                      ? "Segment Segment--last Segment--active"
                      : "Segment Segment--last"
                  }
                  accessibility-element
                  accessibility-traits={filter === "done" ? "selected" : "button"}
                  accessibility-label={`Done todos, ${doneCount}`}
                  bindtap={() => setFilter("done")}
                >
                  <text
                    className={
                      filter === "done" ? "SegmentLabel SegmentLabel--active" : "SegmentLabel"
                    }
                  >
                    Done
                  </text>
                  <text
                    className={
                      filter === "done" ? "SegmentCount SegmentCount--active" : "SegmentCount"
                    }
                  >
                    {doneCount}
                  </text>
                </view>
              </view>

              {visible.length === 0 ? (
                <view className="EmptyState">
                  <text className="EmptyTitle">
                    {todos.length === 0
                      ? "No todos yet"
                      : filter === "active"
                        ? "No active todos"
                        : "No completed todos"}
                  </text>
                  <text className="EmptyBody">
                    {todos.length === 0
                      ? "Add a task above. Writes save locally right away and sync when connected."
                      : filter === "active"
                        ? "All tasks are marked done."
                        : "Complete a task to see it here."}
                  </text>
                  {todos.length > 0 ? (
                    <view
                      className="ActionBtn EmptyAction"
                      accessibility-element
                      accessibility-traits="button"
                      accessibility-label="Show all todos"
                      bindtap={() => setFilter("all")}
                    >
                      <text className="ActionBtnLabel">Show all</text>
                    </view>
                  ) : null}
                </view>
              ) : (
                <view className="List">
                  {visible.map((todo, index) => {
                    const isDone = todo.completed === 1;
                    const isLast = index === visible.length - 1;
                    const label = todo.description ?? "Untitled todo";
                    return (
                      <view key={todo.id} className={isLast ? "Item Item--last" : "Item"}>
                        <view
                          className="ItemMain"
                          accessibility-element
                          accessibility-role-description="checkbox"
                          accessibility-label={label}
                          accessibility-value={isDone ? "checked" : "unchecked"}
                          bindtap={() => {
                            void toggleTodo(todo);
                          }}
                        >
                          <view className={isDone ? "Checkbox Checkbox--checked" : "Checkbox"}>
                            {isDone ? <text className="CheckboxMark">✓</text> : null}
                          </view>
                          <text className={isDone ? "ItemTitle ItemTitle--done" : "ItemTitle"}>
                            {label}
                          </text>
                        </view>
                        <view
                          className="DeleteBtn"
                          accessibility-element
                          accessibility-traits="button"
                          accessibility-label={`Delete ${label}`}
                          bindtap={() => {
                            void deleteTodo(todo);
                          }}
                        >
                          <text className="DeleteBtnLabel">Delete</text>
                        </view>
                      </view>
                    );
                  })}
                </view>
              )}
            </view>

            <view className="Card Card--last">
              <view
                className="LogHead"
                accessibility-element
                accessibility-traits="button"
                accessibility-label={logOpen ? "Hide sync log" : "Show sync log"}
                bindtap={() => setLogOpen((open) => !open)}
              >
                <view className="LogHeadLeft">
                  <text className="CardTitle" accessibility-heading>
                    Sync log
                  </text>
                  <view className="CountBadge">
                    <text className="CountBadgeText">{formatEventCount(logs.length)}</text>
                  </view>
                </view>
                <text className="LogToggle">{logOpen ? "Hide ▾" : "Show ▸"}</text>
              </view>

              {logOpen ? (
                <view className="LogBody">
                  {logs.length === 0 ? (
                    <text className="LogEmpty">No sync events yet.</text>
                  ) : (
                    logs.map((entry, index) => (
                      <view
                        key={entry.id}
                        className={index === logs.length - 1 ? "LogRow LogRow--last" : "LogRow"}
                      >
                        <text className="LogAt">{formatClockTime(entry.at)}</text>
                        <text className="LogMsg">{entry.message}</text>
                      </view>
                    ))
                  )}
                </view>
              ) : null}
            </view>
          </view>
        </view>
      </scroll-view>
    </page>
  );
}
