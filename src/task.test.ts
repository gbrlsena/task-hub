import { describe, expect, it } from "vitest";
import type { CachedTask } from "./db";
import {
  buildTaskTree,
  isLate,
  priorityLabel,
  quickReminderAt,
  relTime,
  showsPriority,
  statusRole,
} from "./task";

function task(partial: Partial<CachedTask> & { id: string }): CachedTask {
  return {
    custom_id: null,
    name: partial.id,
    status: "to do",
    priority: null,
    list_id: "1",
    list_name: "Backlog",
    due_date: null,
    parent: null,
    ...partial,
  };
}

const NOW = new Date(2026, 6, 28, 15, 0); // 28/jul/2026 15:00

describe("statusRole", () => {
  it("mapeia status conhecidos e é case-insensitive", () => {
    expect(statusRole("com blocker")).toBe("danger");
    expect(statusRole("In Progress")).toBe("accent");
    expect(statusRole("testing")).toBe("warning");
    expect(statusRole("to do")).toBe("neutral");
  });

  it("status desconhecido cai em neutral", () => {
    expect(statusRole("qualquer coisa nova")).toBe("neutral");
  });
});

describe("isLate", () => {
  it("ontem é atrasado, hoje e futuro não, null não", () => {
    expect(isLate(new Date(2026, 6, 27).getTime(), NOW)).toBe(true);
    expect(isLate(new Date(2026, 6, 28, 10).getTime(), NOW)).toBe(false);
    expect(isLate(new Date(2026, 6, 30).getTime(), NOW)).toBe(false);
    expect(isLate(null, NOW)).toBe(false);
  });
});

describe("prioridade", () => {
  it("rotula e só mostra urgent/high", () => {
    expect(priorityLabel(1)).toBe("urgent");
    expect(priorityLabel(4)).toBe("low");
    expect(priorityLabel(null)).toBeNull();
    expect(showsPriority(1)).toBe(true);
    expect(showsPriority(2)).toBe(true);
    expect(showsPriority(3)).toBe(false);
    expect(showsPriority(null)).toBe(false);
  });
});

describe("quickReminderAt", () => {
  const wed = new Date(2026, 6, 29, 11, 30); // quarta 29/jul/2026 11:30

  it("hoje 18h no mesmo dia", () => {
    expect(new Date(quickReminderAt("today18", wed))).toEqual(new Date(2026, 6, 29, 18, 0));
  });

  it("amanhã 9h no dia seguinte", () => {
    expect(new Date(quickReminderAt("tomorrow9", wed))).toEqual(new Date(2026, 6, 30, 9, 0));
  });

  it("seg 9h pula pra próxima segunda", () => {
    // 29/jul/2026 é quarta → segunda seguinte é 3/ago.
    expect(new Date(quickReminderAt("mon9", wed))).toEqual(new Date(2026, 7, 3, 9, 0));
  });

  it("seg 9h nunca cai no mesmo dia se hoje é segunda", () => {
    const mon = new Date(2026, 7, 3, 8, 0); // segunda 3/ago
    expect(new Date(quickReminderAt("mon9", mon))).toEqual(new Date(2026, 7, 10, 9, 0));
  });
});

describe("relTime", () => {
  const now = new Date(2026, 6, 29, 12, 0);
  it("formata minutos e horas recentes", () => {
    expect(relTime(now.getTime(), now)).toBe("agora");
    expect(relTime(now.getTime() - 5 * 60000, now)).toBe("há 5 min");
    expect(relTime(now.getTime() - 3 * 3600000, now)).toBe("há 3 h");
  });
});

describe("buildTaskTree", () => {
  it("aninha filhos e sobe subtask órfã pro topo", () => {
    const { roots, childrenByParent } = buildTaskTree([
      task({ id: "p" }),
      task({ id: "c1", parent: "p" }),
      task({ id: "c2", parent: "p" }),
      task({ id: "orfa", parent: "sumiu" }),
    ]);

    expect(roots.map((r) => r.id).sort()).toEqual(["orfa", "p"]);
    expect(childrenByParent.get("p")?.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(childrenByParent.has("sumiu")).toBe(false);
  });
});
