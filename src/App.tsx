import { useEffect, useMemo, useState } from "react";
import {
  anthropicStatus,
  clearToken,
  getFolder,
  githubStatus,
  saveAnthropicKey,
  saveGithubToken,
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
  getPinnedIds,
  lastFetchedAt,
  pinTask,
  pruneStale,
  setFocusOrder,
  STALE_AFTER_MS,
  unpinTask,
  updateTaskStatusLocal,
  type CachedTask,
} from "./db";
import { groupBySprint, pickCurrentGroupIndex } from "./sprint";
import {
  buildTaskTree,
  computeMetrics,
  isDone,
  matchesFilter,
  type FilterKind,
} from "./task";
import TaskCard from "./TaskCard";
import "./App.css";

type Screen = { kind: "loading" } | { kind: "token" } | { kind: "board" };

const DEFAULT_FOLDER_ID = "90118026854";
const FOLDER_KEY = "taskhub.folderId";

function loadFolderId(): string {
  return localStorage.getItem(FOLDER_KEY) ?? DEFAULT_FOLDER_ID;
}

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

const noChildren = () => [];

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

  // Fase 2: conexões (Anthropic + GitHub)
  const [connOpen, setConnOpen] = useState(false);
  const [anthropicOn, setAnthropicOn] = useState(false);
  const [githubOn, setGithubOn] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [ghInput, setGhInput] = useState("");
  const [connError, setConnError] = useState<string | null>(null);

  async function saveKey() {
    setConnError(null);
    try {
      await saveAnthropicKey(keyInput);
      setKeyInput("");
      setAnthropicOn(true);
    } catch (e) {
      setConnError(String(e));
    }
  }

  async function saveGh() {
    setConnError(null);
    try {
      await saveGithubToken(ghInput);
      setGhInput("");
      setGithubOn(true);
    } catch (e) {
      setConnError(String(e));
    }
  }

  // Navegação / filtros
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKind>("tudo");
  const [showDone, setShowDone] = useState(false);

  // Foco (pin) + reordenação por arraste
  const [pinnedOrder, setPinnedOrder] = useState<string[]>([]);
  const pinnedSet = useMemo(() => new Set(pinnedOrder), [pinnedOrder]);
  const [dragId, setDragId] = useState<string | null>(null);

  async function handleDropOn(targetId: string) {
    if (!dragId || dragId === targetId) {
      setDragId(null);
      return;
    }
    const order = [...pinnedOrder];
    const from = order.indexOf(dragId);
    const to = order.indexOf(targetId);
    if (from < 0 || to < 0) {
      setDragId(null);
      return;
    }
    order.splice(from, 1);
    order.splice(to, 0, dragId);
    setPinnedOrder(order);
    setDragId(null);
    await setFocusOrder(order);
  }

  // Foco: tasks fixadas, resolvidas de TODAS as tasks (imunes ao filtro/sprint).
  const focoTasks = useMemo(
    () => pinnedOrder.map((id) => tasks.find((t) => t.id === id)).filter((t): t is CachedTask => !!t),
    [pinnedOrder, tasks],
  );

  // Base = tasks visíveis na sprint (concluídas escondidas por padrão, sem as fixadas).
  const baseTasks = useMemo(
    () =>
      tasks.filter(
        (t) => (showDone || !isDone(t.status_type)) && !pinnedSet.has(t.id),
      ),
    [tasks, showDone, pinnedSet],
  );

  const groups = useMemo(() => groupBySprint(baseTasks), [baseTasks]);

  const currentIndex = useMemo(() => {
    if (groups.length === 0) return -1;
    const i = selectedKey ? groups.findIndex((g) => g.key === selectedKey) : -1;
    return i >= 0 ? i : pickCurrentGroupIndex(groups);
  }, [groups, selectedKey]);

  const current = currentIndex >= 0 ? groups[currentIndex] : null;

  // Métricas e filtro são SEMPRE da sprint selecionada.
  const metrics = useMemo(() => computeMetrics(current ? current.tasks : []), [current]);
  const tree = useMemo(() => buildTaskTree(current ? current.tasks : []), [current]);
  const filtered = useMemo(
    () => (current ? current.tasks : []).filter((t) => matchesFilter(t, filter)),
    [current, filter],
  );
  const getChildren = (id: string) => tree.childrenByParent.get(id) ?? [];

  async function reloadDue() {
    setDueIds(await dueReminderSubjectIds(Date.now()));
  }

  useEffect(() => {
    tokenStatus()
      .then((has) => setScreen(has ? { kind: "board" } : { kind: "token" }))
      .catch(() => setScreen({ kind: "token" }));
  }, []);

  useEffect(() => {
    if (screen.kind !== "board") return;
    let alive = true;

    getFolder(folderId)
      .then((f) => alive && setFolder(f))
      .catch(() => alive && setFolder(null));

    Promise.all([
      getCachedTasks(),
      lastFetchedAt(),
      dueReminderSubjectIds(Date.now()),
      getPinnedIds(),
    ])
      .then(([rows, last, due, pinned]) => {
        if (!alive) return;
        setTasks(rows);
        setLastSync(last);
        setDueIds(due);
        setPinnedOrder(pinned);
      })
      .catch(() => {});

    anthropicStatus().then((v) => alive && setAnthropicOn(v)).catch(() => {});
    githubStatus().then((v) => alive && setGithubOn(v)).catch(() => {});

    return () => {
      alive = false;
    };
  }, [screen.kind, folderId]);

  async function reloadCache() {
    setTasks(await getCachedTasks());
    setLastSync(await lastFetchedAt());
    await reloadDue();
  }

  async function handleTogglePin(id: string) {
    if (pinnedSet.has(id)) await unpinTask(id);
    else await pinTask(id);
    setPinnedOrder(await getPinnedIds());
  }

  // Otimista: atualiza estado + cache local. No rollback, é chamado com o valor antigo.
  async function handleStatusChanged(id: string, status: string, statusType: string) {
    setTasks((ts) =>
      ts.map((t) => (t.id === id ? { ...t, status, status_type: statusType } : t)),
    );
    await updateTaskStatusLocal(id, status, statusType);
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
  const metricTiles = [
    { label: "abertas", value: metrics.abertas, filter: "tudo" as const, role: "" },
    { label: "progresso", value: metrics.progresso, filter: "progresso" as const, role: "accent" },
    { label: "atrasadas", value: metrics.atrasadas, filter: "atrasadas" as const, role: "danger" },
    { label: "travadas", value: metrics.travadas, filter: "travadas" as const, role: "danger" },
    { label: "esquecidas", value: metrics.esquecidas, filter: "esquecidas" as const, role: "warning" },
  ];

  return (
    <main className="app">
      <header className="app-header">
        <h1>Task Hub</h1>
      </header>

      <section className="board-bar">
        <div className="board-id">
          <span className="eyebrow">Board</span>
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

      <section className="sync-bar">
        <span className="sync-info muted">
          {tasks.length} tasks · {formatLastSync(lastSync)}
        </span>
        <button className="sync-btn" onClick={handleSync} disabled={syncing}>
          {syncing ? "…" : "↻ Sincronizar"}
        </button>
      </section>
      {syncError && <p className="error">{syncError}</p>}

      {tasks.length === 0 && !syncing && (
        <p className="muted">Nenhuma task em cache. Clique em “Sincronizar”.</p>
      )}

      {focoTasks.length > 0 && (
        <section className="foco">
          <div className="eyebrow">Meu foco</div>
          <ol className="task-list foco-list">
            {focoTasks.map((t) => (
              <TaskCard
                key={t.id}
                task={t}
                getChildren={noChildren}
                dueIds={dueIds}
                onRemindersChanged={reloadDue}
                pinnedIds={pinnedSet}
                onTogglePin={handleTogglePin}
                onStatusChanged={handleStatusChanged}
                draggable
                onDragStart={(e) => {
                  setDragId(t.id);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", t.id);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  handleDropOn(t.id);
                }}
              />
            ))}
          </ol>
        </section>
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
                {currentIndex + 1}/{groups.length}
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

          {/* Métricas da sprint = o filtro. Um controle só. */}
          <section className="metrics">
            {metricTiles.map((m) => (
              <button
                key={m.label}
                className={`metric${filter === m.filter ? " active" : ""}`}
                onClick={() => setFilter(m.filter)}
              >
                <span className={`metric-value ${m.role}`}>{m.value}</span>
                <span className="metric-label muted">{m.label}</span>
              </button>
            ))}
          </section>

          <div className="metrics-aux">
            <button className="link" onClick={() => setShowDone((v) => !v)}>
              {showDone ? "ocultar concluídas" : "mostrar concluídas"}
            </button>
          </div>

          {filter === "tudo" ? (
            <ul className="task-list">
              {tree.roots.map((t) => (
                <TaskCard
                  key={t.id}
                  task={t}
                  getChildren={getChildren}
                  dueIds={dueIds}
                  onRemindersChanged={reloadDue}
                  pinnedIds={pinnedSet}
                  onTogglePin={handleTogglePin}
                  onStatusChanged={handleStatusChanged}
                />
              ))}
            </ul>
          ) : (
            <ul className="task-list">
              {filtered.map((t) => (
                <TaskCard
                  key={t.id}
                  task={t}
                  getChildren={noChildren}
                  dueIds={dueIds}
                  onRemindersChanged={reloadDue}
                  pinnedIds={pinnedSet}
                  onTogglePin={handleTogglePin}
                  onStatusChanged={handleStatusChanged}
                />
              ))}
              {filtered.length === 0 && (
                <li className="muted">Nada em “{filter}” nesta sprint.</li>
              )}
            </ul>
          )}
        </>
      )}

      <footer className="app-footer">
        <div className="footer-row">
          <button className="link" onClick={handleChangeToken}>
            Trocar token
          </button>
          <button className="link" onClick={() => setConnOpen((v) => !v)}>
            conexões {anthropicOn ? "· Claude ✓" : ""}
            {githubOn ? " · GitHub ✓" : ""}
          </button>
        </div>

        {connOpen && (
          <div className="conn-panel">
            <label className="eyebrow">Chave da API Anthropic</label>
            <div className="composer">
              <input
                type="password"
                autoComplete="off"
                placeholder={anthropicOn ? "conectada — cole para trocar" : "sk-ant-…"}
                value={keyInput}
                onChange={(e) => setKeyInput(e.currentTarget.value)}
              />
              <button className="composer-icon" onClick={saveKey} disabled={keyInput.trim() === ""}>
                salvar
              </button>
            </div>

            <label className="eyebrow">Token do GitHub (opcional, para PRs)</label>
            <div className="composer">
              <input
                type="password"
                autoComplete="off"
                placeholder={githubOn ? "conectado — cole para trocar" : "ghp_… / github_pat_…"}
                value={ghInput}
                onChange={(e) => setGhInput(e.currentTarget.value)}
              />
              <button className="composer-icon" onClick={saveGh} disabled={ghInput.trim() === ""}>
                salvar
              </button>
            </div>

            {connError && <p className="error">{connError}</p>}
            <p className="hint">
              Guardadas no cofre do SO, nunca em arquivo ou log. A verificação chama a API da
              Anthropic (custa por uso).
            </p>
          </div>
        )}
      </footer>
    </main>
  );
}

function formatLastSync(ts: number | null): string {
  if (ts === null) return "nunca sincronizado";
  const fresh = Date.now() - ts < STALE_AFTER_MS;
  const when = new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return fresh ? `atualizado ${when}` : `desatualizado · ${when}`;
}

export default App;
