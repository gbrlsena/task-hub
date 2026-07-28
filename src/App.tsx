import { useEffect, useMemo, useState } from "react";
import {
  clearToken,
  getFolder,
  saveToken,
  syncOpenTasks,
  tokenStatus,
  type FolderRef,
} from "./api";
import {
  cacheTasks,
  clearTasks,
  dueReminderSubjectIds,
  getCachedTasks,
  lastFetchedAt,
  pruneStale,
  TASK_TTL_MS,
  type CachedTask,
} from "./db";
import { groupBySprint, pickCurrentGroupIndex } from "./sprint";
import { buildTaskTree } from "./task";
import TaskCard from "./TaskCard";
import "./App.css";

type Screen = { kind: "loading" } | { kind: "token" } | { kind: "board" };

const DEFAULT_FOLDER_ID = "90118026854";
const FOLDER_KEY = "taskhub.folderId";

function loadFolderId(): string {
  return localStorage.getItem(FOLDER_KEY) ?? DEFAULT_FOLDER_ID;
}

/** Aceita a URL do folder (.../v/f/{id}/...) ou o id cru. */
function parseFolderId(input: string): string | null {
  const s = input.trim();
  const fromUrl = s.match(/\/f\/(\d+)/);
  if (fromUrl) return fromUrl[1];
  if (/^\d+$/.test(s)) return s;
  return null;
}

function fmtDM(d: Date): string {
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });

  // Tela de token
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);

  // Board (folder)
  const [folderId, setFolderId] = useState<string>(loadFolderId());
  const [folder, setFolder] = useState<FolderRef | null>(null);
  const [editingBoard, setEditingBoard] = useState(false);
  const [folderInput, setFolderInput] = useState("");
  const [boardError, setBoardError] = useState<string | null>(null);

  // Sync / cache
  const [tasks, setTasks] = useState<CachedTask[]>([]);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [dueIds, setDueIds] = useState<Set<string>>(new Set());

  // Navegação de sprint
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const groups = useMemo(() => groupBySprint(tasks), [tasks]);

  const currentIndex = useMemo(() => {
    if (groups.length === 0) return -1;
    const i = selectedKey ? groups.findIndex((g) => g.key === selectedKey) : -1;
    return i >= 0 ? i : pickCurrentGroupIndex(groups);
  }, [groups, selectedKey]);

  const current = currentIndex >= 0 ? groups[currentIndex] : null;

  const tree = useMemo(
    () => buildTaskTree(current ? current.tasks : []),
    [current],
  );
  const getChildren = (id: string) => tree.childrenByParent.get(id) ?? [];

  async function reloadDue() {
    setDueIds(await dueReminderSubjectIds(Date.now()));
  }

  // Tela inicial: existe token salvo?
  useEffect(() => {
    tokenStatus()
      .then((has) => setScreen(has ? { kind: "board" } : { kind: "token" }))
      .catch(() => setScreen({ kind: "token" }));
  }, []);

  // Ao entrar no board (ou trocar de folder): nome do folder + cache + lembretes.
  useEffect(() => {
    if (screen.kind !== "board") return;
    let alive = true;

    getFolder(folderId)
      .then((f) => alive && setFolder(f))
      .catch(() => alive && setFolder(null));

    Promise.all([getCachedTasks(), lastFetchedAt(), dueReminderSubjectIds(Date.now())])
      .then(([rows, last, due]) => {
        if (!alive) return;
        setTasks(rows);
        setLastSync(last);
        setDueIds(due);
      })
      .catch(() => {});

    return () => {
      alive = false;
    };
  }, [screen.kind, folderId]);

  async function reloadCache() {
    setTasks(await getCachedTasks());
    setLastSync(await lastFetchedAt());
    await reloadDue();
  }

  async function handleSync() {
    setSyncing(true);
    setSyncError(null);
    try {
      const fetched = await syncOpenTasks(folderId);
      const now = Date.now();
      await cacheTasks(fetched, now);
      await pruneStale(now);
      await reloadCache();
    } catch (err) {
      setSyncError(String(err));
    } finally {
      setSyncing(false);
    }
  }

  async function handleApplyFolder(e: React.FormEvent) {
    e.preventDefault();
    const id = parseFolderId(folderInput);
    if (!id) {
      setBoardError("Não reconheci um id ou URL de folder do ClickUp.");
      return;
    }
    localStorage.setItem(FOLDER_KEY, id);
    setBoardError(null);
    setEditingBoard(false);
    setFolderInput("");
    setFolder(null);
    setSelectedKey(null);
    await clearTasks();
    setTasks([]);
    setLastSync(null);
    setFolderId(id);
  }

  async function handleSaveToken(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setTokenError(null);
    try {
      await saveToken(token);
      setToken("");
      setScreen({ kind: "board" });
    } catch (err) {
      setTokenError(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleChangeToken() {
    await clearToken();
    setTasks([]);
    setLastSync(null);
    setSyncError(null);
    setScreen({ kind: "token" });
  }

  if (screen.kind === "loading") {
    return (
      <main className="app">
        <p className="muted">Carregando…</p>
      </main>
    );
  }

  if (screen.kind === "token") {
    return (
      <main className="app">
        <header className="app-header">
          <h1>Task Hub</h1>
          <p className="muted">Conecte seu ClickUp para começar.</p>
        </header>

        <form className="token-form" onSubmit={handleSaveToken}>
          <label htmlFor="token">Token pessoal do ClickUp</label>
          <input
            id="token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="pk_…"
            value={token}
            onChange={(e) => setToken(e.currentTarget.value)}
          />
          <p className="hint">
            Gere em ClickUp → Settings → Apps → API Token. O token começa com{" "}
            <code>pk_</code> e fica guardado no cofre de credenciais do sistema —
            nunca em arquivo ou log.
          </p>
          {tokenError && <p className="error">{tokenError}</p>}
          <button type="submit" disabled={saving || token.trim() === ""}>
            {saving ? "Salvando…" : "Salvar e conectar"}
          </button>
        </form>
      </main>
    );
  }

  // screen.kind === "board"
  return (
    <main className="app">
      <header className="app-header">
        <h1>Task Hub</h1>
      </header>

      <section className="board-bar">
        <div className="board-id">
          <span className="muted">Board</span>
          <span className="board-name">{folder?.name ?? `folder ${folderId}`}</span>
          {folder?.space_name && <span className="muted">{folder.space_name}</span>}
        </div>
        <button className="link" onClick={() => setEditingBoard((v) => !v)}>
          {editingBoard ? "cancelar" : "trocar"}
        </button>
      </section>

      {editingBoard && (
        <form className="board-edit" onSubmit={handleApplyFolder}>
          <input
            placeholder="Cole a URL ou o id do folder do ClickUp"
            value={folderInput}
            onChange={(e) => setFolderInput(e.currentTarget.value)}
          />
          {boardError && <p className="error">{boardError}</p>}
          <button type="submit">Aplicar board</button>
        </form>
      )}

      <section className="sync-panel">
        <div className="sync-stats">
          <span className="sync-count">{tasks.length} tasks</span>
          <span className="muted">{formatLastSync(lastSync)}</span>
        </div>
        {syncError && <p className="error">{syncError}</p>}
        <button onClick={handleSync} disabled={syncing}>
          {syncing ? "Sincronizando…" : "Sincronizar tarefas"}
        </button>
      </section>

      {groups.length === 0 && !syncing && (
        <p className="muted">Nenhuma task em cache. Clique em “Sincronizar”.</p>
      )}

      {current && (
        <>
          <nav className="sprint-nav">
            <button
              className="nav-arrow"
              disabled={currentIndex <= 0}
              onClick={() => setSelectedKey(groups[currentIndex - 1].key)}
              aria-label="Sprint anterior"
            >
              ‹
            </button>
            <div className="sprint-nav-label">
              <span className="sprint-title">{current.title}</span>
              {current.meta.kind === "sprint" && (
                <span className="muted">
                  {fmtDM(current.meta.startsAt)}–{fmtDM(current.meta.endsAt)}
                </span>
              )}
              <span className="muted">
                {current.tasks.length} tasks · {currentIndex + 1}/{groups.length}
              </span>
            </div>
            <button
              className="nav-arrow"
              disabled={currentIndex >= groups.length - 1}
              onClick={() => setSelectedKey(groups[currentIndex + 1].key)}
              aria-label="Próxima sprint"
            >
              ›
            </button>
          </nav>

          <ul className="task-list">
            {tree.roots.map((t) => (
              <TaskCard
                key={t.id}
                task={t}
                getChildren={getChildren}
                dueIds={dueIds}
                onRemindersChanged={reloadDue}
              />
            ))}
          </ul>
        </>
      )}

      <footer className="app-footer">
        <button className="link" onClick={handleChangeToken}>
          Trocar token
        </button>
      </footer>
    </main>
  );
}

function formatLastSync(ts: number | null): string {
  if (ts === null) return "nunca sincronizado";
  const fresh = Date.now() - ts < TASK_TTL_MS;
  const when = new Date(ts).toLocaleTimeString();
  return fresh ? `sincronizado ${when} (recente)` : `desatualizado — último: ${when}`;
}

export default App;
