import { describe, expect, it } from "vitest";
import type { CachedTask } from "./db";
import { buildTaskTree, isLate, priorityLabel, showsPriority, statusRole } from "./task";

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
