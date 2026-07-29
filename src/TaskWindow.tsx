import { useCallback, useEffect, useState } from "react";
import {
  dueReminderSubjectIds,
  getCachedTasks,
  getPinnedIds,
  pinTask,
  unpinTask,
  updateTaskStatusLocal,
  type CachedTask,
} from "./db";
import { onChanged } from "./sync";
import { buildTaskTree } from "./task";
import TaskCard from "./TaskCard";
import "./App.css";

/** Nada é fantasma dentro da própria janela destacada. */
const NONE: Set<string> = new Set();

/**
 * A janela aberta por "destacar": o mesmo `TaskCard` do hub, sozinho, com a
 * gaveta já aberta. Lê o mesmo SQLite e se atualiza pelo ping das outras.
 */
function TaskWindow({ taskId }: { taskId: string }) {
  const [tasks, setTasks] = useState<CachedTask[] | null>(null);
  const [dueIds, setDueIds] = useState<Set<string>>(new Set());
  const [pinnedOrder, setPinnedOrder] = useState<string[]>([]);

  const reload = useCallback(async () => {
    const [rows, due, pinned] = await Promise.all([
      getCachedTasks(),
      dueReminderSubjectIds(Date.now()),
      getPinnedIds(),
    ]);
    setTasks(rows);
    setDueIds(due);
    setPinnedOrder(pinned);
  }, []);

  useEffect(() => {
    reload().catch(() => setTasks([]));
  }, [reload]);

  // Outra janela escreveu no banco: relê.
  useEffect(() => {
    const un = onChanged(() => {
      reload().catch(() => {});
    });
    return () => {
      un.then((off) => off()).catch(() => {});
    };
  }, [reload]);

  async function handleTogglePin(id: string) {
    if (pinnedOrder.includes(id)) await unpinTask(id);
    else await pinTask(id);
    setPinnedOrder(await getPinnedIds());
  }

  // Otimista: estado + cache local, igual ao hub. No rollback vem o valor antigo.
  async function handleStatusChanged(id: string, status: string, statusType: string) {
    setTasks((ts) =>
      (ts ?? []).map((t) => (t.id === id ? { ...t, status, status_type: statusType } : t)),
    );
    await updateTaskStatusLocal(id, status, statusType);
  }

  if (tasks === null) {
    return (
      <div className="app">
        <p className="muted">carregando…</p>
      </div>
    );
  }

  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    return (
      <div className="app">
        <p className="muted">
          Essa task não está mais no cache local. Sincronize na janela principal.
        </p>
      </div>
    );
  }

  const tree = buildTaskTree(tasks);

  return (
    <div className="app">
      <TaskCard
        task={task}
        getChildren={(id) => tree.childrenByParent.get(id) ?? []}
        dueIds={dueIds}
        onRemindersChanged={() => {
          reload().catch(() => {});
        }}
        pinnedIds={new Set(pinnedOrder)}
        detachedIds={NONE}
        onTogglePin={handleTogglePin}
        onStatusChanged={handleStatusChanged}
        standalone
      />
    </div>
  );
}

export default TaskWindow;
