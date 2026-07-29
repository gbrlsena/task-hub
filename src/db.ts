import Database from "@tauri-apps/plugin-sql";
import { notifyChanged } from "./sync";

/** TTL do cache de tasks: 5 minutos (spec §1.1). */
export const TASK_TTL_MS = 5 * 60 * 1000;

/** Limite pra rotular o cache como "desatualizado" na UI: 12h sem sync. */
export const STALE_AFTER_MS = 12 * 60 * 60 * 1000;

export type SubjectKind = "task" | "note";

/** Task como devolvida pelo command Rust `sync_open_tasks`. */
export interface SyncedTask {
  id: string;
  custom_id: string | null;
  name: string;
  status: string;
  status_type: string;
  priority: number | null;
  list_id: string;
  list_name: string;
  due_date: number | null;
  parent: string | null;
  assignees: number[];
  description: string;
  raw: string;
}

/** Task lida do cache para exibição (sem `raw`/`assignees`). */
export interface CachedTask {
  id: string;
  custom_id: string | null;
  name: string;
  status: string;
  status_type: string;
  priority: number | null;
  list_id: string;
  list_name: string;
  due_date: number | null;
  parent: string | null;
  description: string;
}

export interface Comment {
  id: string;
  subject_id: string;
  subject_kind: SubjectKind;
  body: string;
  created_at: number;
}

export interface Reminder {
  id: string;
  subject_id: string;
  subject_kind: SubjectKind;
  body: string | null;
  remind_at: number;
  dismissed: number;
  created_at: number;
}

let dbPromise: Promise<Database> | null = null;

/** Abre (uma vez) o SQLite local. Migrações rodam no lado Rust ao carregar. */
export function getDb(): Promise<Database> {
  if (!dbPromise) dbPromise = Database.load("sqlite:taskhub.db");
  return dbPromise;
}

// --- Cache de tasks -------------------------------------------------------

/** Faz upsert das tasks no `task_cache`, carimbando `fetched_at`. */
export async function cacheTasks(tasks: SyncedTask[], fetchedAt: number): Promise<void> {
  const db = await getDb();
  for (const t of tasks) {
    await db.execute(
      `INSERT INTO task_cache
         (id, custom_id, name, status, status_type, priority, list_id, list_name, due_date, parent, assignees, description, raw, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT(id) DO UPDATE SET
         custom_id = excluded.custom_id,
         name      = excluded.name,
         status    = excluded.status,
         status_type = excluded.status_type,
         priority  = excluded.priority,
         list_id   = excluded.list_id,
         list_name = excluded.list_name,
         due_date  = excluded.due_date,
         parent    = excluded.parent,
         assignees = excluded.assignees,
         description = excluded.description,
         raw       = excluded.raw,
         fetched_at = excluded.fetched_at`,
      [
        t.id,
        t.custom_id,
        t.name,
        t.status,
        t.status_type,
        t.priority,
        t.list_id,
        t.list_name,
        t.due_date,
        t.parent,
        JSON.stringify(t.assignees),
        t.description,
        t.raw,
        fetchedAt,
      ],
    );
  }
  notifyChanged();
}

/** Remove do cache as tasks que não vieram no sync atual (`fetched_at` antigo). */
export async function pruneStale(syncedAt: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM task_cache WHERE fetched_at < $1", [syncedAt]);
}

/** Lê as tasks do cache, ordenadas por lista e depois por vencimento. */
export async function getCachedTasks(): Promise<CachedTask[]> {
  const db = await getDb();
  return db.select<CachedTask[]>(
    `SELECT id, custom_id, name, status, status_type, priority, list_id, list_name, due_date, parent, description
     FROM task_cache
     ORDER BY list_name, due_date IS NULL, due_date`,
  );
}

/** Esvazia o cache de tasks (ex.: ao trocar o board, o escopo muda). */
export async function clearTasks(): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM task_cache");
  notifyChanged();
}

/** Timestamp do sync mais recente (max fetched_at), ou null se vazio. */
export async function lastFetchedAt(): Promise<number | null> {
  const db = await getDb();
  const rows = await db.select<{ t: number | null }[]>(
    "SELECT MAX(fetched_at) AS t FROM task_cache",
  );
  return rows[0]?.t ?? null;
}

// --- Comentários (log privado) -------------------------------------------

export async function addComment(
  subjectId: string,
  subjectKind: SubjectKind,
  body: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO comment (id, subject_id, subject_kind, body, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [crypto.randomUUID(), subjectId, subjectKind, body, Date.now()],
  );
  notifyChanged();
}

export async function listComments(subjectId: string): Promise<Comment[]> {
  const db = await getDb();
  return db.select<Comment[]>(
    "SELECT * FROM comment WHERE subject_id = $1 ORDER BY created_at DESC",
    [subjectId],
  );
}

export async function deleteComment(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM comment WHERE id = $1", [id]);
  notifyChanged();
}

// --- Lembretes ------------------------------------------------------------

export async function addReminder(
  subjectId: string,
  subjectKind: SubjectKind,
  remindAt: number,
  body: string | null,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO reminder (id, subject_id, subject_kind, body, remind_at, dismissed, created_at)
     VALUES ($1, $2, $3, $4, $5, 0, $6)`,
    [crypto.randomUUID(), subjectId, subjectKind, body, remindAt, Date.now()],
  );
  notifyChanged();
}

export async function listReminders(subjectId: string): Promise<Reminder[]> {
  const db = await getDb();
  return db.select<Reminder[]>(
    "SELECT * FROM reminder WHERE subject_id = $1 ORDER BY dismissed, remind_at",
    [subjectId],
  );
}

export async function dismissReminder(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE reminder SET dismissed = 1 WHERE id = $1", [id]);
  notifyChanged();
}

export async function deleteReminder(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM reminder WHERE id = $1", [id]);
  notifyChanged();
}

/** Ids de assunto com pelo menos um lembrete vencido e não dispensado. */
export async function dueReminderSubjectIds(now: number): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db.select<{ subject_id: string }[]>(
    "SELECT DISTINCT subject_id FROM reminder WHERE dismissed = 0 AND remind_at <= $1",
    [now],
  );
  return new Set(rows.map((r) => r.subject_id));
}

// --- Statuses da list (cache 1h) ------------------------------------------

export interface StatusDef {
  status: string;
  type: string; // open | custom | closed | done
  orderindex: number;
  color?: string | null;
}

/** TTL do cache de statuses por list (spec §1.3): ~1h. */
export const LIST_STATUS_TTL_MS = 60 * 60 * 1000;

export async function getCachedListStatuses(listId: string): Promise<StatusDef[] | null> {
  const db = await getDb();
  const rows = await db.select<{ statuses: string; fetched_at: number }[]>(
    "SELECT statuses, fetched_at FROM list_status_cache WHERE list_id = $1",
    [listId],
  );
  const row = rows[0];
  if (!row || Date.now() - row.fetched_at > LIST_STATUS_TTL_MS) return null;
  try {
    return JSON.parse(row.statuses) as StatusDef[];
  } catch {
    return null;
  }
}

export async function cacheListStatuses(listId: string, statuses: StatusDef[]): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO list_status_cache (list_id, statuses, fetched_at) VALUES ($1, $2, $3)
     ON CONFLICT(list_id) DO UPDATE SET statuses = excluded.statuses, fetched_at = excluded.fetched_at`,
    [listId, JSON.stringify(statuses), Date.now()],
  );
}

/** Atualização otimista do status no cache local (antes/depois do PUT). */
export async function updateTaskStatusLocal(
  taskId: string,
  status: string,
  statusType: string,
): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE task_cache SET status = $2, status_type = $3 WHERE id = $1", [
    taskId,
    status,
    statusType,
  ]);
  notifyChanged();
}

// --- Foco (pin), spec §1.5 ------------------------------------------------

export async function getPinnedIds(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select<{ task_id: string }[]>(
    "SELECT task_id FROM focus ORDER BY position, pinned_at",
  );
  return rows.map((r) => r.task_id);
}

export async function pinTask(taskId: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO focus (task_id, position, pinned_at)
     VALUES ($1, (SELECT COALESCE(MAX(position), 0) + 1 FROM focus), $2)
     ON CONFLICT(task_id) DO NOTHING`,
    [taskId, Date.now()],
  );
  notifyChanged();
}

export async function unpinTask(taskId: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM focus WHERE task_id = $1", [taskId]);
  notifyChanged();
}

/** Persiste a ordem manual do foco (posição = índice no array). */
export async function setFocusOrder(orderedIds: string[]): Promise<void> {
  const db = await getDb();
  for (let i = 0; i < orderedIds.length; i++) {
    await db.execute("UPDATE focus SET position = $2 WHERE task_id = $1", [orderedIds[i], i]);
  }
  notifyChanged();
}
