import type { CachedTask } from "./db";

// Mapa de status -> papel de cor na UI (§1.3). Só apresentação.
export type Role = "danger" | "accent" | "warning" | "neutral";

const STATUS_ROLE: Record<string, Role> = {
  "com blocker": "danger",
  "in progress": "accent",
  "validação": "accent",
  prioritized: "accent",
  testing: "warning",
  "a refinar": "warning",
  "to do": "neutral",
  backlog: "neutral",
};

/** Papel de cor do status. Status desconhecido cai em neutral (§1.3). */
export function statusRole(status: string): Role {
  return STATUS_ROLE[status.toLowerCase()] ?? "neutral";
}

function startOfToday(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** due_date != null && due_date < começo de hoje (§1.6). */
export function isLate(dueDate: number | null, now: Date = new Date()): boolean {
  return dueDate !== null && dueDate < startOfToday(now);
}

/** status contém "blocker" (§1.6). */
export function isBlocked(status: string): boolean {
  return status.toLowerCase().includes("blocker");
}

const PRIORITY_LABELS: Record<number, string> = {
  1: "urgent",
  2: "high",
  3: "normal",
  4: "low",
};

export function priorityLabel(priority: number | null): string | null {
  return priority === null ? null : PRIORITY_LABELS[priority] ?? null;
}

/** Só mostra pill de prioridade quando urgent (1) ou high (2) — §1.7. */
export function showsPriority(priority: number | null): boolean {
  return priority === 1 || priority === 2;
}

export interface TaskTree {
  roots: CachedTask[];
  childrenByParent: Map<string, CachedTask[]>;
}

/**
 * Monta a árvore de tasks. Raiz = sem `parent` OU cujo `parent` não está no
 * conjunto visível (subtask órfã sobe pro topo, pra nunca sumir).
 */
export function buildTaskTree(tasks: CachedTask[]): TaskTree {
  const ids = new Set(tasks.map((t) => t.id));
  const childrenByParent = new Map<string, CachedTask[]>();
  const roots: CachedTask[] = [];

  for (const t of tasks) {
    if (t.parent && ids.has(t.parent)) {
      const bucket = childrenByParent.get(t.parent);
      if (bucket) bucket.push(t);
      else childrenByParent.set(t.parent, [t]);
    } else {
      roots.push(t);
    }
  }

  return { roots, childrenByParent };
}
