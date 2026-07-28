import { describe, expect, it } from "vitest";
import { groupBySprint, parseListMeta, pickCurrentGroupIndex } from "./sprint";

// Datas de referência fixas para tornar a inferência de ano determinística.
const JUL_28_2026 = new Date(2026, 6, 28);
const JAN_10_2026 = new Date(2026, 0, 10);

describe("parseListMeta", () => {
  it("parseia um nome de sprint real dentro do ano corrente", () => {
    const meta = parseListMeta("Revenue Sprint 8 (7/21 - 8/3)", JUL_28_2026);
    expect(meta.kind).toBe("sprint");
    if (meta.kind !== "sprint") return;
    expect(meta.number).toBe(8);
    expect(meta.startsAt).toEqual(new Date(2026, 6, 21));
    expect(meta.endsAt).toEqual(new Date(2026, 7, 3));
  });

  it("é case-insensitive", () => {
    const meta = parseListMeta("revenue sprint 2 (6/9 - 6/15)", JUL_28_2026);
    expect(meta.kind).toBe("sprint");
    if (meta.kind !== "sprint") return;
    expect(meta.number).toBe(2);
  });

  it("retorna 'other' para nomes fora do padrão, sem lançar", () => {
    for (const name of ["Backlog", "Upstream 2.0", "Delivery", "", "Sprint sem datas"]) {
      expect(parseListMeta(name, JUL_28_2026)).toEqual({ kind: "other" });
    }
  });

  it("não lança em entrada maluca", () => {
    expect(() => parseListMeta("(((  ))) Sprint ??? ()", JUL_28_2026)).not.toThrow();
    expect(parseListMeta("(((  ))) Sprint ??? ()", JUL_28_2026).kind).toBe("other");
  });

  it("virada de ano: sprint que cruza dezembro→janeiro visto em janeiro", () => {
    // Em 10/jan/2026, "12/29 - 1/4" começou em dezembro do ANO ANTERIOR.
    const meta = parseListMeta("Revenue Sprint 9 (12/29 - 1/4)", JAN_10_2026);
    expect(meta.kind).toBe("sprint");
    if (meta.kind !== "sprint") return;
    expect(meta.startsAt).toEqual(new Date(2025, 11, 29));
    expect(meta.endsAt).toEqual(new Date(2026, 0, 4));
  });

  it("data mais de 6 meses no futuro é jogada para o ano anterior", () => {
    // Em 10/jan/2026, "9/1" no ano corrente ficaria ~8 meses à frente → 2025.
    const meta = parseListMeta("Sprint 3 (9/1 - 9/7)", JAN_10_2026);
    expect(meta.kind).toBe("sprint");
    if (meta.kind !== "sprint") return;
    expect(meta.startsAt).toEqual(new Date(2025, 8, 1));
    expect(meta.endsAt).toEqual(new Date(2025, 8, 7));
  });
});

describe("groupBySprint", () => {
  const t = (list_name: string, id: string) => ({ list_name, id });

  it("agrupa por sprint, mais recente primeiro, e joga não-sprint pro fim", () => {
    const items = [
      t("Revenue Sprint 4 (6/23 - 6/29)", "a"),
      t("Backlog", "b"),
      t("Revenue Sprint 8 (7/21 - 8/3)", "c"),
      t("Revenue Sprint 4 (6/23 - 6/29)", "d"),
    ];
    const groups = groupBySprint(items, JUL_28_2026);

    expect(groups.map((g) => g.title)).toEqual(["Sprint 8", "Sprint 4", "Backlog"]);
    // Sprint 4 acumulou as duas tasks da mesma lista.
    expect(groups[1].tasks.map((x) => x.id)).toEqual(["a", "d"]);
  });
});

describe("pickCurrentGroupIndex", () => {
  const t = (list_name: string, id: string) => ({ list_name, id });
  const items = [
    t("Revenue Sprint 8 (7/21 - 8/3)", "a"),
    t("Revenue Sprint 7 (7/14 - 7/20)", "b"),
  ];
  const groups = groupBySprint(items, JUL_28_2026); // [Sprint 8, Sprint 7]

  it("escolhe a sprint cujo range engloba hoje", () => {
    expect(pickCurrentGroupIndex(groups, new Date(2026, 6, 28))).toBe(0); // dentro da 8
    expect(pickCurrentGroupIndex(groups, new Date(2026, 6, 16))).toBe(1); // dentro da 7
  });

  it("cai no primeiro (mais recente) quando nenhuma engloba hoje", () => {
    expect(pickCurrentGroupIndex(groups, new Date(2026, 0, 1))).toBe(0);
  });
});
