import { useState } from "react";
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
} from "./db";
import { isLate, priorityLabel, showsPriority, statusRole } from "./task";

interface Props {
  task: CachedTask;
  getChildren: (id: string) => CachedTask[];
  dueIds: Set<string>;
  onRemindersChanged: () => void;
  depth?: number;
}

function fmtDayMonth(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

function TaskCard({ task, getChildren, dueIds, onRemindersChanged, depth = 0 }: Props) {
  const [showSubs, setShowSubs] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [reminders, setReminders] = useState<Reminder[] | null>(null);
  const [commentInput, setCommentInput] = useState("");
  const [remindAt, setRemindAt] = useState("");
  const [remindBody, setRemindBody] = useState("");

  const children = getChildren(task.id);
  const late = isLate(task.due_date);
  const prio = priorityLabel(task.priority);
  const hasDueReminder = dueIds.has(task.id);

  async function loadNotes() {
    setComments(await listComments(task.id));
    setReminders(await listReminders(task.id));
  }

  async function toggleNotes() {
    const next = !showNotes;
    setShowNotes(next);
    if (next && comments === null) await loadNotes();
  }

  async function submitComment(e: React.FormEvent) {
    e.preventDefault();
    const body = commentInput.trim();
    if (!body) return;
    await addComment(task.id, "task", body);
    setCommentInput("");
    setComments(await listComments(task.id));
  }

  async function removeComment(id: string) {
    await deleteComment(id);
    setComments(await listComments(task.id));
  }

  async function submitReminder(e: React.FormEvent) {
    e.preventDefault();
    const at = new Date(remindAt).getTime();
    if (Number.isNaN(at)) return;
    await addReminder(task.id, "task", at, remindBody.trim() || null);
    setRemindAt("");
    setRemindBody("");
    setReminders(await listReminders(task.id));
    onRemindersChanged();
  }

  async function onDismiss(id: string) {
    await dismissReminder(id);
    setReminders(await listReminders(task.id));
    onRemindersChanged();
  }

  async function onDeleteReminder(id: string) {
    await deleteReminder(id);
    setReminders(await listReminders(task.id));
    onRemindersChanged();
  }

  return (
    <li className="task-card" style={{ marginLeft: depth ? 16 : 0 }}>
      <div className="task-main">
        <span className="task-name">{task.name}</span>
        <span className={`status-pill role-${statusRole(task.status)}`}>
          {task.status || "—"}
        </span>
      </div>

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
          <form className="note-add" onSubmit={submitComment}>
            <input
              placeholder="Comentário pra você mesmo…"
              value={commentInput}
              onChange={(e) => setCommentInput(e.currentTarget.value)}
            />
          </form>
          <ul className="comment-list">
            {(comments ?? []).map((c) => (
              <li key={c.id} className="comment">
                <div className="comment-body">{c.body}</div>
                <div className="comment-meta muted">
                  {new Date(c.created_at).toLocaleString()}
                  <button className="link danger" onClick={() => removeComment(c.id)}>
                    apagar
                  </button>
                </div>
              </li>
            ))}
            {comments !== null && comments.length === 0 && (
              <li className="muted">Sem comentários ainda.</li>
            )}
          </ul>

          <form className="reminder-add" onSubmit={submitReminder}>
            <input
              type="datetime-local"
              value={remindAt}
              onChange={(e) => setRemindAt(e.currentTarget.value)}
            />
            <input
              placeholder="lembrete (opcional)"
              value={remindBody}
              onChange={(e) => setRemindBody(e.currentTarget.value)}
            />
            <button type="submit" disabled={remindAt === ""}>
              + lembrete
            </button>
          </form>
          <ul className="reminder-list">
            {(reminders ?? []).map((r) => {
              const due = r.dismissed === 0 && r.remind_at <= Date.now();
              return (
                <li key={r.id} className={`reminder ${due ? "due" : ""}`}>
                  <span>
                    {new Date(r.remind_at).toLocaleString()}
                    {r.body ? ` — ${r.body}` : ""}
                    {r.dismissed === 1 && " (dispensado)"}
                  </span>
                  <span className="reminder-actions">
                    {r.dismissed === 0 && (
                      <button className="link" onClick={() => onDismiss(r.id)}>
                        dispensar
                      </button>
                    )}
                    <button className="link danger" onClick={() => onDeleteReminder(r.id)}>
                      apagar
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
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
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export default TaskCard;
