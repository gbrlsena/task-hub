import { useState } from "react";
import {
  askTask,
  loadListStatuses,
  openTaskWindow,
  setTaskStatus,
  type AskResult,
} from "./api";
import { type CachedTask, type StatusDef } from "./db";
import StatusPicker from "./StatusPicker";
import Notes from "./Notes";
import {
  cleanDescription,
  isLate,
  priorityLabel,
  showsPriority,
  statusRole,
} from "./task";

interface Props {
  task: CachedTask;
  getChildren: (id: string) => CachedTask[];
  dueIds: Set<string>;
  onRemindersChanged: () => void;
  pinnedIds: Set<string>;
  /** Tasks com janela destacada aberta: o cartão delas encolhe. */
  detachedIds: Set<string>;
  onTogglePin: (id: string) => void;
  onStatusChanged: (id: string, status: string, statusType: string) => void;
  /** A janela destacada renderiza o cartão sozinho: gaveta já aberta. */
  standalone?: boolean;
  depth?: number;
}

function fmtDayMonth(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

function TaskCard({
  task,
  getChildren,
  dueIds,
  onRemindersChanged,
  pinnedIds,
  detachedIds,
  onTogglePin,
  onStatusChanged,
  standalone = false,
  depth = 0,
}: Props) {
  const pinned = pinnedIds.has(task.id);
  const hasDesc = task.description.trim() !== "";
  const [showDesc, setShowDesc] = useState(standalone);
  const descId = `desc-${task.id}`;
  const [showSubs, setShowSubs] = useState(false);
  const [showNotes, setShowNotes] = useState(false);

  // Troca de status
  const [statusMenu, setStatusMenu] = useState(false);
  const [statuses, setStatuses] = useState<StatusDef[] | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  async function toggleStatusMenu() {
    const next = !statusMenu;
    setStatusMenu(next);
    if (next && statuses === null) {
      try {
        setStatuses(await loadListStatuses(task.list_id));
      } catch (e) {
        setStatusError(String(e));
      }
    }
  }

  async function pickStatus(s: StatusDef) {
    setStatusMenu(false);
    if (s.status === task.status) return;
    const prevStatus = task.status;
    const prevType = task.status_type;
    setStatusError(null);
    onStatusChanged(task.id, s.status, s.type); // otimista
    try {
      await setTaskStatus(task.id, s.status);
    } catch (e) {
      onStatusChanged(task.id, prevStatus, prevType); // rollback
      setStatusError(String(e));
    }
  }

  // Fase 2: perguntar sobre a task
  const [showAsk, setShowAsk] = useState(false);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [ask, setAsk] = useState<AskResult | null>(null);
  const [askError, setAskError] = useState<string | null>(null);

  async function runAsk() {
    const q = question.trim();
    if (!q) return;
    setAsking(true);
    setAskError(null);
    setAsk(null);
    try {
      setAsk(await askTask(task.id, q));
    } catch (e) {
      setAskError(String(e));
    } finally {
      setAsking(false);
    }
  }

  // Aplica a sugestão da IA (só por clique explícito do usuário).
  async function applySuggestion(r: AskResult) {
    let target: string | null = null;
    let newType = task.status_type;
    try {
      const statuses = await loadListStatuses(task.list_id);
      if (r.acao === "marcar_feito") {
        const done =
          statuses.find((s) => s.type === "done") ?? statuses.find((s) => s.type === "closed");
        if (done) {
          target = done.status;
          newType = done.type;
        }
      } else if (r.acao === "mudar_status" && r.status_alvo) {
        const match = statuses.find(
          (s) => s.status.toLowerCase() === r.status_alvo!.toLowerCase(),
        );
        target = match?.status ?? r.status_alvo;
        newType = match?.type ?? task.status_type;
      }
    } catch (e) {
      setAskError(String(e));
      return;
    }
    if (!target) {
      setAskError("Não consegui resolver o status alvo nessa lista.");
      return;
    }
    const prevStatus = task.status;
    const prevType = task.status_type;
    onStatusChanged(task.id, target, newType); // otimista
    try {
      await setTaskStatus(task.id, target);
      setAsk(null);
    } catch (e) {
      onStatusChanged(task.id, prevStatus, prevType); // rollback
      setAskError(String(e));
    }
  }

  // Abre a janela destacada — ou traz pra frente a que já está aberta.
  async function detach() {
    try {
      await openTaskWindow(task.id, `${task.custom_id ?? task.id} · ${task.name}`);
    } catch (e) {
      setStatusError(String(e));
    }
  }

  const children = getChildren(task.id);
  const late = isLate(task.due_date);
  const prio = priorityLabel(task.priority);
  const hasDueReminder = dueIds.has(task.id);

  async function toggleNotes() {
    setShowNotes((v) => !v);
  }

  // Destacada: o cartão vira o vazio que a nota deixou. Clicar traz a janela.
  if (detachedIds.has(task.id) && !standalone) {
    return (
      <div className="task-card task-ghost" style={{ marginLeft: depth ? 16 : 0 }}>
        <button className="ghost-name" onClick={detach} title="Trazer a janela pra frente">
          {task.name}
        </button>
        <span className="eyebrow">destacado</span>
      </div>
    );
  }

  return (
    <div className="task-card" style={{ marginLeft: depth ? 16 : 0 }}>
      <div className="task-main">
        {hasDesc ? (
          <button
            className="task-name"
            onClick={() => setShowDesc((v) => !v)}
            aria-expanded={showDesc}
            aria-controls={descId}
            title="Ver descrição"
          >
            {task.name}
          </button>
        ) : (
          <span className="task-name">{task.name}</span>
        )}
        <StatusPicker
          current={task.status}
          currentRole={statusRole(task.status)}
          open={statusMenu}
          onToggle={toggleStatusMenu}
          options={
            statuses === null
              ? null
              : statuses.map((s) => ({
                  id: s.status,
                  label: s.status,
                  role: statusRole(s.status),
                }))
          }
          onPick={(o) => {
            // Volta pro StatusDef original: o `type` é o que decide "concluída",
            // e não dá pra derivar do rótulo.
            const def = statuses?.find((s) => s.status === o.id);
            if (def) void pickStatus(def);
          }}
        />
      </div>
      {statusError && <p className="error">{statusError}</p>}

      <div className="pill-row">
        {showsPriority(task.priority) && prio && (
          <span className={`pill prio-${prio}`}>{prio}</span>
        )}
        {late && task.due_date !== null && (
          <span className="pill pill-late">venceu {fmtDayMonth(task.due_date)}</span>
        )}
        {hasDueReminder && <span className="pill pill-reminder">lembrete</span>}
      </div>

      <div className="task-meta muted">
        {task.custom_id ?? task.id} · {task.list_name}
      </div>

      {showDesc && hasDesc && (
        <div className="desc-panel" id={descId}>
          <div className="desc-head">
            <span className="eyebrow">descrição</span>
            {!standalone && (
              <button className="link desc-detach" onClick={detach}>
                destacar
              </button>
            )}
          </div>
          <div className="desc-body">{cleanDescription(task.description)}</div>
        </div>
      )}

      <div className="task-actions">
        <button
          className={`link${pinned ? " pinned" : ""}`}
          onClick={() => onTogglePin(task.id)}
        >
          {pinned ? "★ no foco" : "☆ fixar"}
        </button>
        {children.length > 0 && (
          <button className="link" onClick={() => setShowSubs((v) => !v)}>
            {showSubs ? "▾" : "▸"} {children.length} subtask{children.length > 1 ? "s" : ""}
          </button>
        )}
        <button className="link" onClick={toggleNotes}>
          {showNotes ? "▾" : "▸"} minhas anotações
        </button>
        <button className="link" onClick={() => setShowAsk((v) => !v)}>
          {showAsk ? "▾" : "▸"} perguntar
        </button>
      </div>

      {showAsk && (
        <div className="ask-panel">
          <div className="composer">
            <input
              placeholder="perguntar sobre essa task…"
              value={question}
              onChange={(e) => setQuestion(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") runAsk();
              }}
            />
            <button className="composer-icon" onClick={runAsk} disabled={asking}>
              {asking ? "…" : "perguntar"}
            </button>
          </div>

          {askError && <p className="error">{askError}</p>}

          {ask && !ask.valid && (
            <div className="ask-result">
              <p className="ask-resposta">{ask.raw}</p>
              <p className="muted">Não interpretei como ação estruturada — sem sugestão.</p>
            </div>
          )}

          {ask && ask.valid && (
            <div className="ask-result">
              <p className="ask-resposta">{ask.resposta}</p>
              <p className="ask-evidencia">
                <span className="eyebrow">evidência</span> {ask.evidencia || "—"}
              </p>
              <div className="ask-foot">
                <span className={`pill conf-${ask.confianca}`}>confiança {ask.confianca}</span>
                {ask.acao !== "nada" && ask.confianca !== "baixa" && (
                  <button className="ask-confirm" onClick={() => applySuggestion(ask)}>
                    {ask.acao === "marcar_feito"
                      ? "confirmar · marcar feito"
                      : `confirmar · ${ask.status_alvo ?? "mudar status"}`}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {showNotes && (
        <Notes
          subjectId={task.id}
          subjectKind="task"
          onRemindersChanged={onRemindersChanged}
        />
      )}

      {showSubs && children.length > 0 && (
        <div className="task-list subtask-list">
          {children.map((child) => (
            <TaskCard
              key={child.id}
              task={child}
              getChildren={getChildren}
              dueIds={dueIds}
              onRemindersChanged={onRemindersChanged}
              pinnedIds={pinnedIds}
              detachedIds={detachedIds}
              onTogglePin={onTogglePin}
              onStatusChanged={onStatusChanged}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default TaskCard;
