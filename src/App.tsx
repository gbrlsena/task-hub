import { useEffect, useState } from "react";
import { clearToken, getTeams, saveToken, tokenStatus, type Team } from "./api";
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

      <footer className="app-footer">
        <button className="link" onClick={handleChangeToken}>
          Trocar token
        </button>
      </footer>
    </main>
  );
}

export default App;
