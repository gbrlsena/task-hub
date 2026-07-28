import Database from "@tauri-apps/plugin-sql";

/** TTL do cache de tasks: 5 minutos (spec §1.1). */
export const TASK_TTL_MS = 5 * 60 * 1000;

export type SubjectKind = "task" | "note";

/** Task como devolvida pelo command Rust `sync_open_tasks`. */
export interface SyncedTask {
  id: string;
  custom_id: string | null;
  name: string;
  status: string;
  priority: number | null;
  list_id: string;
  list_name: string;
  due_date: number | null;
  parent: string | null;
  assignees: number[];
  raw: string;
}

/** Task lida do cache para exibição (sem `raw`/`assignees`). */
export interface CachedTask {
  id: string;
  custom_id: string | null;
  name: string;
  status: string;
  priority: number | null;
  list_id: string;
  list_name: string;
  due_date: number | null;
  parent: string | null;
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
         (id, custom_id, name, status, priority, list_id, list_name, due_date, parent, assignees, raw, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT(id) DO UPDATE SET
         custom_id = excluded.custom_id,
         name      = excluded.name,
         status    = excluded.status,
         priority  = excluded.priority,
         list_id   = excluded.list_id,
         list_name = excluded.list_name,
         due_date  = excluded.due_date,
         parent    = excluded.parent,
         assignees = excluded.assignees,
         raw       = excluded.raw,
         fetched_at = excluded.fetched_at`,
      [
        t.id,
        t.custom_id,
        t.name,
        t.status,
        t.priority,
        t.list_id,
        t.list_name,
        t.due_date,
        t.parent,
        JSON.stringify(t.assignees),
        t.raw,
        fetchedAt,
      ],
    );
  }
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
    `SELECT id, custom_id, name, status, priority, list_id, list_name, due_date, parent
     FROM task_cache
     ORDER BY list_name, due_date IS NULL, due_date`,
  );
}

/** Esvazia o cache de tasks (ex.: ao trocar o board, o escopo muda). */
export async function clearTasks(): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM task_cache");
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
}

export async function deleteReminder(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM reminder WHERE id = $1", [id]);
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
