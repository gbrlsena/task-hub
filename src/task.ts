import type { CachedTask } from "./db";
import { parseListMeta } from "./sprint";

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

/** "Concluída" pelo type da API, sem hardcodar strings de status (§1.3). */
export function isDone(statusType: string): boolean {
  return statusType === "done" || statusType === "closed";
}

/**
 * Esquecida (§1.6): task aberta numa sprint que já fechou. O sinal mais
 * valioso e que não existe em view nativa do ClickUp.
 */
export function isStale(listName: string, statusType: string, now: Date = new Date()): boolean {
  if (isDone(statusType)) return false;
  const meta = parseListMeta(listName, now);
  return meta.kind === "sprint" && meta.endsAt.getTime() < startOfToday(now);
}

export type FilterKind = "tudo" | "progresso" | "atrasadas" | "travadas" | "esquecidas";

export interface Metrics {
  abertas: number;
  progresso: number;
  atrasadas: number;
  travadas: number;
  esquecidas: number;
}

/** "Em progresso" = status de papel `accent` (in progress, validação, prioritized). */
export function isInProgress(status: string): boolean {
  return statusRole(status) === "accent";
}

/** Métricas do board, contadas só sobre tasks não concluídas. */
export function computeMetrics(tasks: CachedTask[], now: Date = new Date()): Metrics {
  const m: Metrics = { abertas: 0, progresso: 0, atrasadas: 0, travadas: 0, esquecidas: 0 };
  for (const t of tasks) {
    if (isDone(t.status_type)) continue;
    m.abertas++;
    if (isInProgress(t.status)) m.progresso++;
    if (isLate(t.due_date, now)) m.atrasadas++;
    if (isBlocked(t.status)) m.travadas++;
    if (isStale(t.list_name, t.status_type, now)) m.esquecidas++;
  }
  return m;
}

/** A task casa com o filtro de atributo selecionado? ("tudo" sempre casa.) */
export function matchesFilter(t: CachedTask, filter: FilterKind, now: Date = new Date()): boolean {
  switch (filter) {
    case "progresso":
      return isInProgress(t.status);
    case "atrasadas":
      return isLate(t.due_date, now);
    case "travadas":
      return isBlocked(t.status);
    case "esquecidas":
      return isStale(t.list_name, t.status_type, now);
    default:
      return true;
  }
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

// Lembretes rápidos (chips): data relativa em vez do date picker cru.
export type QuickReminder = "today18" | "tomorrow9" | "mon9";

/** Converte um chip de lembrete em epoch ms, relativo a `now`. */
export function quickReminderAt(kind: QuickReminder, now: Date = new Date()): number {
  const d = new Date(now);
  d.setSeconds(0, 0);
  if (kind === "today18") {
    d.setHours(18, 0, 0, 0);
    return d.getTime();
  }
  if (kind === "tomorrow9") {
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.getTime();
  }
  // mon9: próxima segunda-feira às 9h (nunca hoje).
  d.setHours(9, 0, 0, 0);
  const day = d.getDay(); // 0 dom .. 6 sáb
  let add = (1 - day + 7) % 7;
  if (add === 0) add = 7;
  d.setDate(d.getDate() + add);
  return d.getTime();
}

/** Tempo relativo curto: "agora", "há 5 min", "há 2 h"; senão data/hora. */
export function relTime(ms: number, now: Date = new Date()): string {
  const min = Math.round((now.getTime() - ms) / 60000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  return new Date(ms).toLocaleString();
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
