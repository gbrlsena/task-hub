import { useEffect, useState } from "react";
import {
  addComment,
  addReminder,
  deleteComment,
  deleteReminder,
  dismissReminder,
  listComments,
  listReminders,
  type Comment,
  type Reminder,
  type SubjectKind,
} from "./db";
import { quickReminderAt, relTime, type QuickReminder } from "./task";

/**
 * Painel de anotações privadas de um assunto (task, bug ou nota local).
 *
 * Nunca sincroniza para fora: nem ClickUp, nem Slack. É o registro da análise,
 * que é justamente o que se perde quando o histórico só existe na cabeça.
 *
 * Usado pelo cartão de task e pelo de bug — as duas telas compartilham este
 * componente justamente para não divergirem. Mudança de comportamento aqui vale
 * nos dois lugares.
 */

const QUICK_CHIPS: { kind: QuickReminder; label: string }[] = [
  { kind: "today18", label: "hoje 18h" },
  { kind: "tomorrow9", label: "amanhã 9h" },
  { kind: "mon9", label: "seg 9h" },
];

interface Props {
  subjectId: string;
  subjectKind: SubjectKind;
  /**
   * Chamado quando um lembrete muda. O hub usa isso pra recalcular os badges
   * de "lembrete vencido" — sem esse aviso o cartão salva e a lista não reage.
   */
  onRemindersChanged?: () => void;
}

export default function Notes({ subjectId, subjectKind, onRemindersChanged }: Props) {
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [reminders, setReminders] = useState<Reminder[] | null>(null);
  const [text, setText] = useState("");
  const [showChips, setShowChips] = useState(false);
  const [pickAt, setPickAt] = useState("");

  async function reload() {
    const [c, r] = await Promise.all([listComments(subjectId), listReminders(subjectId)]);
    setComments(c);
    setReminders(r);
  }

  useEffect(() => {
    reload().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subjectId]);

  async function saveComment() {
    const body = text.trim();
    if (!body) return;
    await addComment(subjectId, subjectKind, body);
    setText("");
    await reload();
  }

  async function saveReminder(at: number) {
    if (!Number.isFinite(at)) return;
    await addReminder(subjectId, subjectKind, at, text.trim() || null);
    setText("");
    setShowChips(false);
    setPickAt("");
    await reload();
    onRemindersChanged?.();
  }

  const timeline = [
    ...(comments ?? []).map((c) => ({ at: c.created_at, kind: "comment" as const, c })),
    ...(reminders ?? []).map((r) => ({ at: r.created_at, kind: "reminder" as const, r })),
  ].sort((a, b) => b.at - a.at);

  return (
    <div className="notes-panel">
      <ul className="timeline">
        {timeline.map((e) =>
          e.kind === "comment" ? (
            <li key={e.c.id} className="entry entry-comment">
              <div className="entry-body">{e.c.body}</div>
              <div className="entry-meta muted">
                <span>{relTime(e.c.created_at)}</span>
                <button
                  className="link danger"
                  onClick={async () => {
                    await deleteComment(e.c.id);
                    await reload();
                  }}
                >
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
                    <button
                      className="link"
                      onClick={async () => {
                        await dismissReminder(e.r.id);
                        await reload();
                        onRemindersChanged?.();
                      }}
                    >
                      dispensar
                    </button>
                  )}
                  <button
                    className="link danger"
                    onClick={async () => {
                      await deleteReminder(e.r.id);
                      await reload();
                      onRemindersChanged?.();
                    }}
                  >
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
  );
}
