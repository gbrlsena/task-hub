import Database from "@tauri-apps/plugin-sql";

/** TTL do cache de tasks: 5 minutos (spec §1.1). */
export const TASK_TTL_MS = 5 * 60 * 1000;

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
  assignees: number[];
  raw: string;
}

let dbPromise: Promise<Database> | null = null;

/** Abre (uma vez) o SQLite local. Migrações rodam no lado Rust ao carregar. */
export function getDb(): Promise<Database> {
  if (!dbPromise) dbPromise = Database.load("sqlite:taskhub.db");
  return dbPromise;
}

/** Faz upsert das tasks no `task_cache`, carimbando `fetched_at`. */
export async function cacheTasks(tasks: SyncedTask[], fetchedAt: number): Promise<void> {
  const db = await getDb();
  for (const t of tasks) {
    await db.execute(
      `INSERT INTO task_cache
         (id, custom_id, name, status, priority, list_id, list_name, due_date, assignees, raw, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT(id) DO UPDATE SET
         custom_id = excluded.custom_id,
         name      = excluded.name,
         status    = excluded.status,
         priority  = excluded.priority,
         list_id   = excluded.list_id,
         list_name = excluded.list_name,
         due_date  = excluded.due_date,
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
        JSON.stringify(t.assignees),
        t.raw,
        fetchedAt,
      ],
    );
  }
}

/**
 * Remove do cache as tasks que não vieram no sync atual (fecharam ou saíram do
 * assignee). Como todas as tasks do sync foram carimbadas com `syncedAt`,
 * qualquer `fetched_at` anterior é resíduo.
 */
export async function pruneStale(syncedAt: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM task_cache WHERE fetched_at < $1", [syncedAt]);
}

export async function countCachedTasks(): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ n: number }[]>("SELECT COUNT(*) AS n FROM task_cache");
  return rows[0]?.n ?? 0;
}

/** Timestamp do sync mais recente (max fetched_at), ou null se vazio. */
export async function lastFetchedAt(): Promise<number | null> {
  const db = await getDb();
  const rows = await db.select<{ t: number | null }[]>(
    "SELECT MAX(fetched_at) AS t FROM task_cache",
  );
  return rows[0]?.t ?? null;
}
