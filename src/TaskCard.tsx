import { useState } from "react";
import { loadListStatuses, setTaskStatus } from "./api";
import {
  addComment,
  addReminder,
  deleteComment,
  deleteReminder,
  dismissReminder,
  listComments,
  listReminders,
  type CachedTask,
  type Comment,
  type Reminder,
  type StatusDef,
} from "./db";
import {
  isLate,
  priorityLabel,
  quickReminderAt,
  relTime,
  showsPriority,
  statusRole,
  type QuickReminder,
} from "./task";

interface Props {
  task: CachedTask;
  getChildren: (id: string) => CachedTask[];
  dueIds: Set<string>;
  onRemindersChanged: () => void;
  pinnedIds: Set<string>;
  onTogglePin: (id: string) => void;
  onStatusChanged: (id: string, status: string, statusType: string) => void;
  depth?: number;
  /** Reordenação por arraste (só na seção "Meu foco"). */
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
}

function fmtDayMonth(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

const QUICK_CHIPS: { kind: QuickReminder; label: string }[] = [
  { kind: "today18", label: "hoje 18h" },
  { kind: "tomorrow9", label: "amanhã 9h" },
  { kind: "mon9", label: "seg 9h" },
];

function TaskCard({
  task,
  getChildren,
  dueIds,
  onRemindersChanged,
  pinnedIds,
  onTogglePin,
  onStatusChanged,
  depth = 0,
  draggable,
  onDragStart,
  onDragOver,
  onDrop,
}: Props) {
  const pinned = pinnedIds.has(task.id);
  const [showSubs, setShowSubs] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [reminders, setReminders] = useState<Reminder[] | null>(null);
  const [text, setText] = useState("");
  const [showChips, setShowChips] = useState(false);
  const [pickAt, setPickAt] = useState("");

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

  const children = getChildren(task.id);
  const late = isLate(task.due_date);
  const prio = priorityLabel(task.priority);
  const hasDueReminder = dueIds.has(task.id);

  async function reload() {
    setComments(await listComments(task.id));
    setReminders(await listReminders(task.id));
  }

  async function toggleNotes() {
    const next = !showNotes;
    setShowNotes(next);
    if (next && comments === null) await reload();
  }

  async function saveComment() {
    const body = text.trim();
    if (!body) return;
    await addComment(task.id, "task", body);
    setText("");
    await reload();
  }

  async function saveReminder(at: number) {
    if (Number.isNaN(at)) return;
    await addReminder(task.id, "task", at, text.trim() || null);
    setText("");
    setShowChips(false);
    setPickAt("");
    await reload();
    onRemindersChanged();
  }

  async function onDismiss(id: string) {
    await dismissReminder(id);
    await reload();
    onRemindersChanged();
  }

  async function removeComment(id: string) {
    await deleteComment(id);
    await reload();
  }

  async function removeReminder(id: string) {
    await deleteReminder(id);
    await reload();
    onRemindersChanged();
  }

  // Timeline unificada: comentários + lembretes, mais novo no topo.
  const timeline = [
    ...(comments ?? []).map((c) => ({ at: c.created_at, kind: "comment" as const, c })),
    ...(reminders ?? []).map((r) => ({ at: r.created_at, kind: "reminder" as const, r })),
  ].sort((a, b) => b.at - a.at);

  return (
    <li
      className={`task-card${draggable ? " draggable" : ""}`}
      style={{ marginLeft: depth ? 16 : 0 }}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="task-main">
        <span className="task-name">{task.name}</span>
        <button
          className={`status-pill role-${statusRole(task.status)}`}
          onClick={toggleStatusMenu}
          title="Mudar status"
        >
          {task.status || "—"} <span className="caret">▾</span>
        </button>
      </div>

      {statusMenu && (
        <div className="status-menu">
          {statuses === null && !statusError && <span className="muted">carregando…</span>}
          {statuses?.map((s) => (
            <button
              key={s.status}
              className={`status-opt role-${statusRole(s.status)}${
                s.status === task.status ? " current" : ""
              }`}
              onClick={() => pickStatus(s)}
            >
              {s.status}
            </button>
          ))}
        </div>
      )}
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
      </div>

      {showNotes && (
        <div className="notes-panel">
          <ul className="timeline">
            {timeline.map((e) =>
              e.kind === "comment" ? (
                <li key={e.c.id} className="entry entry-comment">
                  <div className="entry-body">{e.c.body}</div>
                  <div className="entry-meta muted">
                    <span>{relTime(e.c.created_at)}</span>
                    <button className="link danger" onClick={() => removeComment(e.c.id)}>
                      apagar
                    </button>
                  </div>
                </li>
              ) : (
                <li
                  key={e.r.id}
                  className={`entry entry-reminder${
                    e.r.dismissed === 0 && e.r.remind_at <= Date.now() ? " due" : ""
                  }`}
                >
                  <div className="entry-body">
                    <span className="bell" aria-hidden="true" /> {e.r.body ?? "lembrete"}
                  </div>
                  <div className="entry-meta muted">
                    <span>
                      {e.r.dismissed === 1
                        ? "dispensado"
                        : e.r.remind_at <= Date.now()
                          ? `venceu ${new Date(e.r.remind_at).toLocaleString()}`
                          : `lembrar ${new Date(e.r.remind_at).toLocaleString()}`}
                    </span>
                    <span className="entry-meta-actions">
                      {e.r.dismissed === 0 && (
                        <button className="link" onClick={() => onDismiss(e.r.id)}>
                          dispensar
                        </button>
                      )}
                      <button className="link danger" onClick={() => removeReminder(e.r.id)}>
                        apagar
                      </button>
                    </span>
                  </div>
                </li>
              ),
            )}
            {comments !== null && timeline.length === 0 && (
              <li className="muted entry-empty">Sem anotações ainda.</li>
            )}
          </ul>

          <div className="composer">
            <input
              placeholder="Anota aí…"
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveComment();
              }}
            />
            <button
              className="composer-icon"
              aria-label="Adicionar lembrete"
              onClick={() => setShowChips((v) => !v)}
            >
              lembrete
            </button>
          </div>

          {showChips && (
            <div className="reminder-chips">
              {QUICK_CHIPS.map((chip) => (
                <button
                  key={chip.kind}
                  className="chip"
                  onClick={() => saveReminder(quickReminderAt(chip.kind))}
                >
                  {chip.label}
                </button>
              ))}
              <input
                type="datetime-local"
                className="chip-picker"
                value={pickAt}
                onChange={(e) => setPickAt(e.currentTarget.value)}
              />
              {pickAt !== "" && (
                <button className="chip" onClick={() => saveReminder(new Date(pickAt).getTime())}>
                  ok
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {showSubs && children.length > 0 && (
        <ul className="task-list subtask-list">
          {children.map((child) => (
            <TaskCard
              key={child.id}
              task={child}
              getChildren={getChildren}
              dueIds={dueIds}
              onRemindersChanged={onRemindersChanged}
              pinnedIds={pinnedIds}
              onTogglePin={onTogglePin}
              onStatusChanged={onStatusChanged}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export default TaskCard;
