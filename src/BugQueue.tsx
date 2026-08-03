import { useEffect, useMemo, useState } from "react";
import {
  bugStatusOptions,
  createTaskFromBug,
  setBugStatus,
  syncBugs,
  type BugStatusOption,
} from "./api";
import {
  cacheBugs,
  getCachedBugs,
  getPinnedIds,
  lastBugFetchedAt,
  pinTask,
  setFocusOrder,
  pruneStaleBugs,
  unpinTask,
} from "./db";
import { Reorder } from "framer-motion";
import FocoItem from "./FocoItem";
import Notes from "./Notes";
import StatusPicker from "./StatusPicker";
import {
  authorLabel,
  bugAge,
  computeBugMetrics,
  ENCERRADOS_PADRAO,
  groupByStatus,
  isEncerrado,
  priorityTint,
  shortProduct,
  statusTint,
  type Bug,
} from "./bug";
import { relTime } from "./task";
import { onChanged } from "./sync";

/**
 * Fila de bugs da Slack List, agrupada por status como o kanban que o time já
 * usa.
 *
 * Escrita: só a troca de status, por clique explícito, otimista com rollback —
 * e vai para uma List **compartilhada** com todo o `#bugs`, não para um espaço
 * privado. Exige `lists:write`; sem o escopo a gravação falha com a mensagem do
 * Slack em vez de fingir que deu certo.
 *
 * As opções do status carregam ao abrir o menu (não no sync), senão reabrir a
 * janela deixaria a pill sem opções e portanto não clicável.
 *
 * Anotações e pin são locais e nunca saem daqui.
 */

const ENCERRADOS_KEY = "taskhub.bugs.encerrados";

function loadEncerrados(): string[] {
  const bruto = localStorage.getItem(ENCERRADOS_KEY);
  if (!bruto) return ENCERRADOS_PADRAO;
  try {
    const lista = JSON.parse(bruto);
    return Array.isArray(lista) ? lista : ENCERRADOS_PADRAO;
  } catch {
    return ENCERRADOS_PADRAO;
  }
}

interface Props {
  listId: string;
  slackOn: boolean;
  onOpenSettings: () => void;
  /** Lista da sprint que o board está mostrando — destino do "criar card". */
  sprintListId: string;
  sprintName: string;
}

interface CardProps {
  bug: Bug;
  now: Date;
  listId: string;
  /** `null` = ainda não carregadas; o menu pede ao abrir. */
  statusOpcoes: BugStatusOption[] | null;
  onLoadStatus: () => void;
  pinned: boolean;
  onTogglePin: () => void;
  /** Lista da sprint que o hub mostra; vazio desabilita "criar card". */
  sprintListId: string;
  sprintName: string;
  onChanged: () => void;
}

function BugCard({
  bug,
  now,
  listId,
  statusOpcoes,
  onLoadStatus,
  pinned,
  onTogglePin,
  sprintListId,
  sprintName,
  onChanged,
}: CardProps) {
  const [aberto, setAberto] = useState(false);
  const [notasAbertas, setNotasAbertas] = useState(false);
  const [menuAberto, setMenuAberto] = useState(false);
  const [gravando, setGravando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [criado, setCriado] = useState<{ url: string } | null>(null);
  /** Status exibido de forma otimista até o Slack confirmar. */
  const [statusLocal, setStatusLocal] = useState<string | null>(null);

  const status = statusLocal ?? bug.status;
  const temDetalhe = !!(bug.description || bug.category || bug.origin || bug.team);

  async function trocarStatus(opcao: BugStatusOption) {
    if (opcao.rotulo === status) {
      setMenuAberto(false);
      return;
    }
    const anterior = status;
    setMenuAberto(false);
    setErro(null);
    setGravando(true);
    setStatusLocal(opcao.rotulo);
    try {
      await setBugStatus(listId, bug.id, opcao.id);
      onChanged();
    } catch (e) {
      // Rollback: o rótulo volta ao que o Slack ainda tem.
      setStatusLocal(anterior);
      setErro(String(e));
    } finally {
      setGravando(false);
    }
  }

  async function criarCard() {
    setErro(null);
    try {
      const corpo = [
        bug.description,
        "",
        `Bug do Slack: ${bug.permalink}`,
        bug.product ? `Produto: ${bug.product}` : "",
        bug.category ? `Categoria: ${bug.category}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      setCriado(await createTaskFromBug(sprintListId, bug.name, corpo));
    } catch (e) {
      setErro(String(e));
    }
  }

  const meta = [
    authorLabel(bug),
    bugAge(bug.created_at, now),
    bug.cases && bug.cases > 1 ? `${bug.cases} casos` : null,
    bug.attachments > 0 ? `${bug.attachments} anexo${bug.attachments > 1 ? "s" : ""}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <article className={`task-card${statusTint(status) === "danger" ? " is-blocked" : ""}`}>
      <div className="pill-row">
        {bug.priority && (
          <span className={`pill role-${priorityTint(bug.priority)}`}>{bug.priority}</span>
        )}

        {bug.product && (
          <span className="pill role-neutral" title={bug.product}>
            {shortProduct(bug.product)}
          </span>
        )}

        <StatusPicker
          current={status}
          currentRole={statusTint(status)}
          open={menuAberto}
          onToggle={() => {
            // Carrega ao abrir, como o TaskCard faz com os statuses da list.
            if (!menuAberto && statusOpcoes === null) onLoadStatus();
            setMenuAberto((v) => !v);
          }}
          options={
            statusOpcoes === null
              ? null
              : statusOpcoes.map((o) => ({
                  id: o.id,
                  label: o.rotulo,
                  role: statusTint(o.rotulo),
                }))
          }
          onPick={(o) => void trocarStatus({ id: o.id, rotulo: o.label })}
          busy={gravando}
        />
      </div>

      {temDetalhe ? (
        <button className="task-name bug-name" onClick={() => setAberto((v) => !v)}>
          {bug.name || "(sem título)"}
        </button>
      ) : (
        <p className="task-name bug-name is-plain">{bug.name || "(sem título)"}</p>
      )}

      <div className="task-meta muted">{meta}</div>

      {aberto && (
        <div className="desc-panel">
          {bug.description && <p className="bug-desc">{bug.description}</p>}
          <dl className="bug-fields">
            {bug.team && (
              <>
                <dt>time</dt>
                <dd>{bug.team}</dd>
              </>
            )}
            {bug.category && (
              <>
                <dt>categoria</dt>
                <dd>{bug.category}</dd>
              </>
            )}
            {bug.origin && (
              <>
                <dt>origem</dt>
                <dd>{bug.origin}</dd>
              </>
            )}
            {bug.product && (
              <>
                <dt>produto</dt>
                <dd>{bug.product}</dd>
              </>
            )}
          </dl>
        </div>
      )}

      {notasAbertas && (
        <Notes subjectId={bug.id} subjectKind="bug" onRemindersChanged={onChanged} />
      )}

      <div className="task-actions">
        <button className={`link${pinned ? " pinned" : ""}`} onClick={onTogglePin}>
          {pinned ? "★ no foco" : "☆ fixar"}
        </button>
        <button className="link" onClick={() => setNotasAbertas((v) => !v)}>
          {notasAbertas ? "▾" : "▸"} minhas anotações
        </button>
        {bug.permalink && (
          <a className="link" href={bug.permalink} target="_blank" rel="noreferrer">
            abrir no Slack
          </a>
        )}
        {sprintListId ? (
          <button className="link" onClick={criarCard} title={`Cria em ${sprintName}`}>
            criar card
          </button>
        ) : (
          <span className="muted" title="Abra uma sprint no board do ClickUp primeiro">
            criar card
          </span>
        )}
      </div>

      {criado && (
        <p className="hint">
          card criado em {sprintName} ·{" "}
          <a className="link" href={criado.url} target="_blank" rel="noreferrer">
            abrir no ClickUp
          </a>
        </p>
      )}
      {erro && <p className="error">{erro}</p>}
    </article>
  );
}

export default function BugQueue({
  listId,
  slackOn,
  onOpenSettings,
  sprintListId,
  sprintName,
}: Props) {
  const [bugs, setBugs] = useState<Bug[]>([]);
  const [last, setLast] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [mostrarEncerrados, setMostrarEncerrados] = useState(false);
  const [statusOpcoes, setStatusOpcoes] = useState<BugStatusOption[] | null>(null);
  const [statusErro, setStatusErro] = useState<string | null>(null);
  const [pinOrder, setPinOrder] = useState<string[]>([]);
  const encerrados = useMemo(loadEncerrados, []);

  const now = new Date();

  async function recarregar() {
    setBugs(await getCachedBugs());
    setLast(await lastBugFetchedAt());
    setPinOrder(await getPinnedIds("bug"));
  }

  /** Uma vez por sessão: as opções são as mesmas para todos os cartões. */
  async function carregarStatus() {
    if (statusOpcoes !== null) return;
    setStatusErro(null);
    try {
      setStatusOpcoes(await bugStatusOptions(listId));
    } catch (e) {
      setStatusErro(String(e));
    }
  }

  async function alternarPin(id: string) {
    if (pinOrder.includes(id)) await unpinTask(id);
    else await pinTask(id, "bug");
    await recarregar();
  }

  // Reorder devolve a nova ordem dos ids; grava só o domínio "bug".
  async function reordenarFoco(nova: string[]) {
    setPinOrder(nova);
    await setFocusOrder(nova, "bug");
  }

  useEffect(() => {
    recarregar().catch(() => {});
    let off: (() => void) | undefined;
    onChanged(() => recarregar().catch(() => {}))
      .then((fn) => {
        off = fn;
      })
      .catch(() => {});
    return () => off?.();
  }, []);

  async function sincronizar() {
    setSyncing(true);
    setErro(null);
    setAviso(null);
    try {
      const r = await syncBugs(listId);
      if (r.status_opcoes.length > 0) setStatusOpcoes(r.status_opcoes);
      const agora = Date.now();
      await cacheBugs(r.bugs, listId, agora);
      await pruneStaleBugs(agora);
      await recarregar();

      const avisos: string[] = [];
      if (r.colunas_faltando.length > 0) {
        avisos.push(`colunas não resolvidas: ${r.colunas_faltando.join(", ")}`);
      }
      if (!r.nomes_resolvidos && r.bugs.length > 0) {
        avisos.push("autor aparece como id — falta o escopo users:read");
      }
      setAviso(avisos.join(" · ") || null);
    } catch (e) {
      setErro(String(e));
    } finally {
      setSyncing(false);
    }
  }

  const pinSet = useMemo(() => new Set(pinOrder), [pinOrder]);

  /**
   * Foco: bugs fixados na ordem manual, resolvidos de TODOS os bugs — imunes ao
   * agrupamento por status e ao filtro de encerrados, igual ao foco do hub.
   */
  const focoBugs = useMemo(
    () => pinOrder.map((id) => bugs.find((b) => b.id === id)).filter((b): b is Bug => !!b),
    [pinOrder, bugs],
  );

  const visiveis = useMemo(
    () =>
      (mostrarEncerrados ? bugs : bugs.filter((b) => !isEncerrado(b.status, encerrados))).filter(
        (b) => !pinSet.has(b.id),
      ),
    [bugs, mostrarEncerrados, encerrados, pinSet],
  );
  const grupos = useMemo(() => groupByStatus(visiveis), [visiveis]);
  const metrics = useMemo(() => computeBugMetrics(bugs, encerrados), [bugs, encerrados]);

  if (!slackOn) {
    return (
      <div className="error-box">
        <p className="muted">
          A fila de bugs precisa do token do Slack (<code>xoxp-</code>, escopos{" "}
          <code>lists:read</code> e <code>files:read</code>).
        </p>
        <button onClick={onOpenSettings}>Conectar o Slack</button>
      </div>
    );
  }

  return (
    <>
      <div className="bug-head">
        <p className="muted">
          {metrics.abertos} {metrics.abertos === 1 ? "bug" : "bugs"} na sua fila
          {metrics.alta > 0 && <span className="bug-count-alta"> · {metrics.alta} alta</span>}
        </p>
        <button onClick={sincronizar} disabled={syncing}>
          {syncing ? "lendo a List…" : "sincronizar"}
        </button>
      </div>

      {last && <p className="hint">último sync {relTime(last, now)}</p>}
      {aviso && <p className="hint">{aviso}</p>}
      {erro && <p className="error">{erro}</p>}
      {statusErro && <p className="error">{statusErro}</p>}

      {focoBugs.length > 0 && (
        <section className="foco">
          <div className="eyebrow">Meu foco</div>
          <Reorder.Group
            as="div"
            axis="y"
            values={pinOrder}
            onReorder={reordenarFoco}
            className="task-list foco-list"
          >
            {focoBugs.map((b) => (
              <FocoItem key={b.id} id={b.id}>
                <BugCard
                  bug={b}
                  now={now}
                  listId={listId}
                  statusOpcoes={statusOpcoes}
                  onLoadStatus={() => void carregarStatus()}
                  pinned
                  onTogglePin={() => void alternarPin(b.id)}
                  sprintListId={sprintListId}
                  sprintName={sprintName}
                  onChanged={() => void sincronizar()}
                />
              </FocoItem>
            ))}
          </Reorder.Group>
        </section>
      )}

      {grupos.length === 0 && focoBugs.length === 0 && !syncing && (
        <p className="muted">
          {bugs.length === 0
            ? "Nada em cache ainda. Sincronize para buscar a fila."
            : "Nenhum bug aberto na sua fila."}
        </p>
      )}

      {grupos.map((g) => (
        <section key={g.status} className="bug-group">
          <p className={`eyebrow bug-group-label tint-${statusTint(g.status)}`}>
            {g.status.toLowerCase()} · {g.bugs.length}
          </p>
          {g.bugs.map((b) => (
            <BugCard
              key={b.id}
              bug={b}
              now={now}
              listId={listId}
              statusOpcoes={statusOpcoes}
              onLoadStatus={() => void carregarStatus()}
              pinned={pinSet.has(b.id)}
              onTogglePin={() => void alternarPin(b.id)}
              sprintListId={sprintListId}
              sprintName={sprintName}
              onChanged={() => void sincronizar()}
            />
          ))}
        </section>
      ))}

      {metrics.encerrados > 0 && (
        <button className="link" onClick={() => setMostrarEncerrados((v) => !v)}>
          {mostrarEncerrados ? "esconder" : "mostrar"} encerrados · {metrics.encerrados}
        </button>
      )}
    </>
  );
}
