import { useEffect, useState } from "react";
import {
  clearToken,
  getTeams,
  saveToken,
  syncOpenTasks,
  tokenStatus,
  type Team,
} from "./api";
import {
  cacheTasks,
  countCachedTasks,
  lastFetchedAt,
  pruneStale,
  TASK_TTL_MS,
} from "./db";
import "./App.css";

type Screen =
  | { kind: "loading" }
  | { kind: "token" }
  | { kind: "workspaces" };

function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });

  // Estado da tela de token
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);

  // Estado da tela de workspaces
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamsError, setTeamsError] = useState<string | null>(null);
  const [loadingTeams, setLoadingTeams] = useState(false);

  // Estado do sync / cache local
  const [taskCount, setTaskCount] = useState<number | null>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  // Ao abrir: existe token salvo? decide a tela inicial.
  useEffect(() => {
    tokenStatus()
      .then((has) => setScreen(has ? { kind: "workspaces" } : { kind: "token" }))
      .catch(() => setScreen({ kind: "token" }));
  }, []);

  // Sempre que cair na tela de workspaces, busca os teams.
  useEffect(() => {
    if (screen.kind !== "workspaces") return;
    let alive = true;
    setLoadingTeams(true);
    setTeamsError(null);
    getTeams()
      .then((t) => {
        if (alive) setTeams(t);
      })
      .catch((e: unknown) => {
        if (alive) setTeamsError(String(e));
      })
      .finally(() => {
        if (alive) setLoadingTeams(false);
      });
    return () => {
      alive = false;
    };
  }, [screen.kind]);

  // Ao entrar na tela de workspaces, carrega o estado do cache local.
  useEffect(() => {
    if (screen.kind !== "workspaces") return;
    let alive = true;
    Promise.all([countCachedTasks(), lastFetchedAt()])
      .then(([count, last]) => {
        if (!alive) return;
        setTaskCount(count);
        setLastSync(last);
      })
      .catch(() => {
        /* cache vazio/erro de leitura: ignorável, o sync recupera */
      });
    return () => {
      alive = false;
    };
  }, [screen.kind]);

  async function handleSync() {
    setSyncing(true);
    setSyncError(null);
    try {
      const tasks = await syncOpenTasks();
      const now = Date.now();
      await cacheTasks(tasks, now);
      await pruneStale(now);
      setTaskCount(await countCachedTasks());
      setLastSync(await lastFetchedAt());
    } catch (err) {
      setSyncError(String(err));
    } finally {
      setSyncing(false);
    }
  }

  async function handleSaveToken(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setTokenError(null);
    try {
      await saveToken(token);
      setToken("");
      setScreen({ kind: "workspaces" });
    } catch (err) {
      setTokenError(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleChangeToken() {
    await clearToken();
    setTeams([]);
    setTaskCount(null);
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

  // screen.kind === "workspaces"
  return (
    <main className="app">
      <header className="app-header">
        <h1>Task Hub</h1>
        <p className="muted">Workspaces disponíveis para este token.</p>
      </header>

      {loadingTeams && <p className="muted">Buscando workspaces…</p>}

      {teamsError && (
        <div className="error-box">
          <p className="error">{teamsError}</p>
          <button onClick={() => setScreen({ kind: "workspaces" })}>
            Tentar de novo
          </button>
        </div>
      )}

      {!loadingTeams && !teamsError && (
        <ul className="team-list">
          {teams.map((t) => (
            <li key={t.id} className="team">
              <span
                className="team-dot"
                style={{ background: t.color ?? "#8b8b8b" }}
              />
              <span className="team-name">{t.name}</span>
              <span className="team-id muted">{t.id}</span>
            </li>
          ))}
          {teams.length === 0 && (
            <li className="muted">Nenhum workspace retornado.</li>
          )}
        </ul>
      )}

      <section className="sync-panel">
        <div className="sync-stats">
          <span className="sync-count">
            {taskCount === null ? "—" : taskCount} tasks em cache
          </span>
          <span className="muted">{formatLastSync(lastSync)}</span>
        </div>
        {syncError && <p className="error">{syncError}</p>}
        <button onClick={handleSync} disabled={syncing}>
          {syncing ? "Sincronizando…" : "Sincronizar tarefas"}
        </button>
      </section>

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
  const ageMs = Date.now() - ts;
  const fresh = ageMs < TASK_TTL_MS;
  const when = new Date(ts).toLocaleTimeString();
  return fresh ? `sincronizado ${when} (recente)` : `desatualizado — último: ${when}`;
}

export default App;
