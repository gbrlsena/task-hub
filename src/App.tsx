import { useEffect, useMemo, useState } from "react";
import { Reorder } from "framer-motion";
import {
  anthropicStatus,
  clearToken,
  detachedTaskIds,
  getFolder,
  githubStatus,
  saveAnthropicKey,
  saveGithubToken,
  saveSlackToken,
  saveToken,
  slackDiagnose,
  slackSchema,
  slackStatus,
  syncOpenTasks,
  tokenStatus,
  type FolderRef,
  type SlackDiagnosis,
  type SlackSchema,
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
import { onChanged, onDetached } from "./sync";
import {
  buildTaskTree,
  computeMetrics,
  isDone,
  matchesFilter,
  type FilterKind,
} from "./task";
import TaskCard from "./TaskCard";
import BugQueue from "./BugQueue";
import FocoItem from "./FocoItem";
import "./App.css";

type Screen = { kind: "loading" } | { kind: "token" } | { kind: "board" };

const DEFAULT_FOLDER_ID = "90118026854";
/** Slack List "Solicitações — Bugs" do canal #bugs. */
const BUGS_LIST_ID = "F08NTEW4H3R";
const FOLDER_KEY = "taskhub.folderId";
const SOURCE_KEY = "taskhub.source";

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
  const [detachedIds, setDetachedIds] = useState<Set<string>>(new Set());

  // Fase 2: conexões (Anthropic + GitHub)
  const [connOpen, setConnOpen] = useState(false);
  const [anthropicOn, setAnthropicOn] = useState(false);
  const [githubOn, setGithubOn] = useState(false);
  const [ckInput, setCkInput] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [ghInput, setGhInput] = useState("");
  const [connError, setConnError] = useState<string | null>(null);

  // Slack: fila de bugs. O diagnóstico é andaime da fase de mapeamento das
  // colunas da List — sai daqui quando o cartão da fila existir.
  const [slackOn, setSlackOn] = useState(false);
  const [slackInput, setSlackInput] = useState("");
  const [listInput, setListInput] = useState(BUGS_LIST_ID);
  const [diagnosis, setDiagnosis] = useState<SlackDiagnosis | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [schema, setSchema] = useState<SlackSchema | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);

  // Fonte ativa do hub: board do ClickUp ou fila de bugs do Slack. Local, o
  // usuário alterna; nada do ClickUp é perdido ao trocar.
  const [source, setSource] = useState<"clickup" | "bugs">(
    () => (localStorage.getItem(SOURCE_KEY) === "bugs" ? "bugs" : "clickup"),
  );

  useEffect(() => {
    localStorage.setItem(SOURCE_KEY, source);
  }, [source]);

  /**
   * Troca o token do ClickUp sem sair da tela. O cache de tasks é esvaziado:
   * outro token pode ser outra conta, e mostrar tasks do escopo anterior seria
   * mentira até o próximo sync.
   */
  async function saveClickup() {
    setConnError(null);
    try {
      await saveToken(ckInput);
      setCkInput("");
      await clearTasks();
      setTasks([]);
      setLastSync(null);
      setSyncError(null);
    } catch (e) {
      setConnError(String(e));
    }
  }

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

  async function saveSlack() {
    setConnError(null);
    try {
      await saveSlackToken(slackInput);
      setSlackInput("");
      setSlackOn(true);
    } catch (e) {
      setConnError(String(e));
    }
  }

  async function runSchema() {
    setConnError(null);
    setSchemaLoading(true);
    try {
      setSchema(await slackSchema(listInput));
    } catch (e) {
      setSchema(null);
      setConnError(String(e));
    } finally {
      setSchemaLoading(false);
    }
  }

  async function runDiagnose() {
    setConnError(null);
    setDiagnosing(true);
    try {
      setDiagnosis(await slackDiagnose(listInput));
    } catch (e) {
      setDiagnosis(null);
      setConnError(String(e));
    } finally {
      setDiagnosing(false);
    }
  }

  // Navegação / filtros
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKind>("tudo");
  const [showDone, setShowDone] = useState(false);

  // Foco (pin) + reordenação por arraste
  const [pinnedOrder, setPinnedOrder] = useState<string[]>([]);
  const pinnedSet = useMemo(() => new Set(pinnedOrder), [pinnedOrder]);
  // Reorder do framer-motion devolve a nova ordem dos values (ids).
  async function handleReorder(newOrder: string[]) {
    setPinnedOrder(newOrder);
    await setFocusOrder(newOrder);
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
    slackStatus().then((v) => alive && setSlackOn(v)).catch(() => {});

    return () => {
      alive = false;
    };
  }, [screen.kind, folderId]);

  async function reloadCache() {
    setTasks(await getCachedTasks());
    setLastSync(await lastFetchedAt());
    setPinnedOrder(await getPinnedIds());
    await reloadDue();
  }

  // Janelas destacadas + ping de escrita das outras janelas.
  useEffect(() => {
    detachedTaskIds()
      .then((ids) => setDetachedIds(new Set(ids)))
      .catch(() => {});

    const offs = [
      onDetached((ids) => setDetachedIds(new Set(ids))),
      onChanged(() => {
        reloadCache().catch(() => {});
      }),
    ];

    return () => {
      for (const off of offs) off.then((f) => f()).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        <div className="source-switch" role="tablist" aria-label="Fonte">
          <button
            role="tab"
            aria-selected={source === "clickup"}
            className={source === "clickup" ? "is-on" : ""}
            onClick={() => setSource("clickup")}
          >
            ClickUp
          </button>
          <button
            role="tab"
            aria-selected={source === "bugs"}
            className={source === "bugs" ? "is-on" : ""}
            onClick={() => setSource("bugs")}
          >
            Bugs
          </button>
        </div>
      </header>

      {source === "bugs" ? (
        <BugQueue
          listId={listInput}
          slackOn={slackOn}
          onOpenSettings={() => setConnOpen(true)}
          sprintListId={current?.tasks[0]?.list_id ?? ""}
          sprintName={current?.tasks[0]?.list_name ?? "a sprint atual"}
        />
      ) : (
        <>
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
          <Reorder.Group
            as="div"
            axis="y"
            values={pinnedOrder}
            onReorder={handleReorder}
            className="task-list foco-list"
          >
            {focoTasks.map((t) => (
              <FocoItem key={t.id} id={t.id}>
                <TaskCard
                  task={t}
                  getChildren={noChildren}
                  dueIds={dueIds}
                  onRemindersChanged={reloadDue}
                  pinnedIds={pinnedSet}
                  detachedIds={detachedIds}
                  onTogglePin={handleTogglePin}
                  onStatusChanged={handleStatusChanged}
                />
              </FocoItem>
            ))}
          </Reorder.Group>
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
            <div className="task-list">
              {tree.roots.map((t) => (
                <TaskCard
                  key={t.id}
                  task={t}
                  getChildren={getChildren}
                  dueIds={dueIds}
                  onRemindersChanged={reloadDue}
                  pinnedIds={pinnedSet}
                  detachedIds={detachedIds}
                  onTogglePin={handleTogglePin}
                  onStatusChanged={handleStatusChanged}
                />
              ))}
            </div>
          ) : (
            <div className="task-list">
              {filtered.map((t) => (
                <TaskCard
                  key={t.id}
                  task={t}
                  getChildren={noChildren}
                  dueIds={dueIds}
                  onRemindersChanged={reloadDue}
                  pinnedIds={pinnedSet}
                  detachedIds={detachedIds}
                  onTogglePin={handleTogglePin}
                  onStatusChanged={handleStatusChanged}
                />
              ))}
              {filtered.length === 0 && (
                <div className="muted">Nada em “{filter}” nesta sprint.</div>
              )}
            </div>
          )}
        </>
      )}

        </>
      )}

      <footer className="app-footer">
        <div className="footer-row">
          <button className="link" onClick={() => setConnOpen((v) => !v)}>
            conexões {anthropicOn ? "· Claude ✓" : ""}
            {githubOn ? " · GitHub ✓" : ""}
            {slackOn ? " · Slack ✓" : ""}
          </button>
        </div>

        {connOpen && (
          <div className="conn-panel">
            {/* ClickUp primeiro: é a credencial que o app exige pra funcionar. */}
            <label className="eyebrow">Token do ClickUp</label>
            <div className="composer">
              <input
                type="password"
                autoComplete="off"
                placeholder="conectado — cole para trocar"
                value={ckInput}
                onChange={(e) => setCkInput(e.currentTarget.value)}
              />
              <button
                className="composer-icon"
                onClick={saveClickup}
                disabled={ckInput.trim() === ""}
              >
                salvar
              </button>
            </div>
            <div className="conn-row-aux">
              <button className="link danger" onClick={handleChangeToken}>
                desconectar
              </button>
            </div>

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

            <label className="eyebrow">Token do Slack (fila de bugs)</label>
            <div className="composer">
              <input
                type="password"
                autoComplete="off"
                placeholder={slackOn ? "conectado — cole para trocar" : "xoxp-…"}
                value={slackInput}
                onChange={(e) => setSlackInput(e.currentTarget.value)}
              />
              <button
                className="composer-icon"
                onClick={saveSlack}
                disabled={slackInput.trim() === ""}
              >
                salvar
              </button>
            </div>

            <label className="eyebrow">List de bugs</label>
            <div className="composer">
              <input
                className="mono"
                type="text"
                autoComplete="off"
                placeholder="F… ou a URL da List"
                value={listInput}
                onChange={(e) => setListInput(e.currentTarget.value)}
              />
              <button
                className="composer-icon"
                onClick={runDiagnose}
                disabled={!slackOn || diagnosing || listInput.trim() === ""}
              >
                {diagnosing ? "lendo…" : "diagnosticar"}
              </button>
              <button
                className="composer-icon"
                onClick={runSchema}
                disabled={!slackOn || schemaLoading || listInput.trim() === ""}
              >
                {schemaLoading ? "exportando…" : "schema"}
              </button>
            </div>

            {schema && (
              <div className="diag">
                <p className="diag-row">
                  <span className="muted">linhas · arquivadas</span>
                  <span className="mono">
                    {schema.linhas ?? "—"} · {schema.arquivadas ?? "—"}
                  </span>
                </p>
                <p className="diag-row">
                  <span className="muted">coluna de status</span>
                  <span className="mono">{schema.coluna_de_status || "—"}</span>
                </p>
                <label className="eyebrow">colunas ({schema.colunas.length})</label>
                <pre className="diag-dump">
                  {schema.colunas
                    .map((c) => {
                      const rotulos = Object.entries(c.opcoes);
                      const lista = rotulos.length
                        ? `\n  ${rotulos.map(([id, label]) => `${id} → ${label}`).join("\n  ")}`
                        : "";
                      const marca = c.key === schema.coluna_de_status ? " ← status" : "";
                      return `${c.nome || "(sem nome)"} · ${c.tipo} · ${c.key}${marca}${lista}`;
                    })
                    .join("\n")}
                </pre>
              </div>
            )}

            {diagnosis && (
              <div className="diag">
                <p className="diag-row">
                  <span className="muted">você</span>
                  <span className="mono">{diagnosis.auth.user_id}</span>
                </p>
                <p className="diag-row">
                  <span className="muted">itens na página</span>
                  <span className="mono">{diagnosis.itens_na_pagina}</span>
                </p>
                <p className="diag-row">
                  <span className="muted">próxima página</span>
                  <span className="mono">{diagnosis.tem_proxima_pagina ? "sim" : "não"}</span>
                </p>
                <label className="eyebrow">campos encontrados</label>
                {diagnosis.campos.length === 0 ? (
                  <p className="hint">
                    Nenhum campo veio preenchido — provavelmente falta o escopo `files:read`.
                  </p>
                ) : (
                  <pre className="diag-dump">
                    {diagnosis.campos
                      .map(
                        (c) =>
                          `${c.key} · ${c.tipos.join(", ") || "vazio na amostra"}\n  ${JSON.stringify(
                            c.valores,
                          )}`,
                      )
                      .join("\n")}
                  </pre>
                )}
              </div>
            )}

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
