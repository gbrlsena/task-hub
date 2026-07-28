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
  getCachedTasks,
  lastFetchedAt,
  pruneStale,
  TASK_TTL_MS,
  type CachedTask,
} from "./db";
import { groupBySprint } from "./sprint";
import "./App.css";

type Screen = { kind: "loading" } | { kind: "token" } | { kind: "board" };

// Board inicial (folder "Revenue Sprints"); trocável e persistido em localStorage.
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

  const groups = useMemo(() => groupBySprint(tasks), [tasks]);

  // Tela inicial: existe token salvo?
  useEffect(() => {
    tokenStatus()
      .then((has) => setScreen(has ? { kind: "board" } : { kind: "token" }))
      .catch(() => setScreen({ kind: "token" }));
  }, []);

  // Ao entrar no board (ou trocar de folder): resolve o nome e carrega o cache.
  useEffect(() => {
    if (screen.kind !== "board") return;
    let alive = true;

    getFolder(folderId)
      .then((f) => alive && setFolder(f))
      .catch(() => alive && setFolder(null));

    Promise.all([getCachedTasks(), lastFetchedAt()])
      .then(([rows, last]) => {
        if (!alive) return;
        setTasks(rows);
        setLastSync(last);
      })
      .catch(() => {});

    return () => {
      alive = false;
    };
  }, [screen.kind, folderId]);

  async function reloadCache() {
    setTasks(await getCachedTasks());
    setLastSync(await lastFetchedAt());
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
    // Escopo mudou: limpa o cache do board anterior.
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

      {groups.map((g) => (
        <section key={g.key} className="sprint-group">
          <header className="sprint-header">
            <span className="sprint-title">{g.title}</span>
            {g.meta.kind === "sprint" && (
              <span className="muted">
                {fmtDM(g.meta.startsAt)}–{fmtDM(g.meta.endsAt)}
              </span>
            )}
            <span className="sprint-count muted">{g.tasks.length}</span>
          </header>
          <ul className="task-list">
            {g.tasks.map((t) => (
              <li key={t.id} className="task-card">
                <div className="task-main">
                  <span className="task-name">{t.name}</span>
                  <span className="status-pill">{t.status || "—"}</span>
                </div>
                <div className="task-meta muted">
                  {t.custom_id ?? t.id} · {t.list_name}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}

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
