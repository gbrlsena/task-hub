import { describe, expect, it } from "vitest";
import {
  authorLabel,
  bugAge,
  computeBugMetrics,
  ENCERRADOS_PADRAO,
  groupByStatus,
  isEncerrado,
  normalize,
  priorityRank,
  priorityTint,
  shortProduct,
  statusRank,
  statusTint,
  type Bug,
} from "./bug";

function bug(over: Partial<Bug> = {}): Bug {
  return {
    id: "Rec1",
    name: "Bug",
    description: "",
    status: "PENDENTE DE ANÁLISE",
    priority: "Média",
    product: "",
    team: "",
    category: "",
    origin: "",
    author: "U1",
    author_name: "",
    assignee: "UEU",
    created_at: 1000,
    finished_at: null,
    cases: null,
    attachments: 0,
    permalink: "",
    ...over,
  };
}

describe("normalize", () => {
  it("ignora caixa, acento e espaço", () => {
    expect(normalize(" NÃO É BUG ")).toBe("nao e bug");
    expect(normalize("Em Validação")).toBe("em validacao");
  });
});

describe("isEncerrado", () => {
  it("reconhece os três terminais do padrão", () => {
    for (const s of ["SOLUCIONADO", "NÃO É BUG", "DUPLICADO"]) {
      expect(isEncerrado(s, ENCERRADOS_PADRAO)).toBe(true);
    }
  });

  it("mantém impedido e em validação na fila", () => {
    expect(isEncerrado("IMPEDIDO", ENCERRADOS_PADRAO)).toBe(false);
    expect(isEncerrado("EM VALIDAÇÃO", ENCERRADOS_PADRAO)).toBe(false);
  });

  it("casa mesmo com grafia diferente", () => {
    expect(isEncerrado("solucionado", ENCERRADOS_PADRAO)).toBe(true);
    expect(isEncerrado("Não é bug", ENCERRADOS_PADRAO)).toBe(true);
  });

  it("respeita uma lista customizada", () => {
    expect(isEncerrado("NÃO É BUG", ["SOLUCIONADO"])).toBe(false);
  });
});

describe("statusRank", () => {
  it("põe impedido antes de tudo e terminais no fim", () => {
    expect(statusRank("IMPEDIDO")).toBeLessThan(statusRank("PENDENTE DE ANÁLISE"));
    expect(statusRank("CORRIGINDO")).toBeLessThan(statusRank("SOLUCIONADO"));
  });

  it("status desconhecido vai pro fim em vez de sumir", () => {
    expect(statusRank("STATUS NOVO QUE NAO EXISTIA")).toBeGreaterThanOrEqual(
      statusRank("DUPLICADO"),
    );
  });
});

describe("tints", () => {
  it("mapeia status para os papéis semânticos do app", () => {
    expect(statusTint("IMPEDIDO")).toBe("danger");
    expect(statusTint("EM ANÁLISE")).toBe("accent");
    expect(statusTint("CORRIGINDO")).toBe("accent");
    expect(statusTint("EM VALIDAÇÃO")).toBe("warning");
    expect(statusTint("PENDENTE DE ANÁLISE")).toBe("neutral");
  });

  it("prioridade alta é coral e baixa é neutra", () => {
    expect(priorityTint("Alta")).toBe("danger");
    expect(priorityTint("Média")).toBe("warning");
    expect(priorityTint("Baixa")).toBe("neutral");
  });
});

describe("priorityRank", () => {
  it("ordena alta, média, baixa e desconhecida", () => {
    expect(priorityRank("Alta")).toBeLessThan(priorityRank("Média"));
    expect(priorityRank("Média")).toBeLessThan(priorityRank("Baixa"));
    expect(priorityRank("")).toBeGreaterThan(priorityRank("Baixa"));
  });
});

describe("groupByStatus", () => {
  it("agrupa e ordena os grupos pelo fluxo", () => {
    const grupos = groupByStatus([
      bug({ id: "a", status: "SOLUCIONADO" }),
      bug({ id: "b", status: "IMPEDIDO" }),
      bug({ id: "c", status: "PENDENTE DE ANÁLISE" }),
    ]);
    expect(grupos.map((g) => g.status)).toEqual([
      "IMPEDIDO",
      "PENDENTE DE ANÁLISE",
      "SOLUCIONADO",
    ]);
  });

  it("dentro do grupo, prioridade primeiro e mais antigo no empate", () => {
    const grupos = groupByStatus([
      bug({ id: "media", priority: "Média", created_at: 1 }),
      bug({ id: "alta", priority: "Alta", created_at: 500 }),
      bug({ id: "media-velha", priority: "Média", created_at: 0 }),
    ]);
    expect(grupos[0].bugs.map((b) => b.id)).toEqual(["alta", "media-velha", "media"]);
  });

  it("bug sem status ganha um grupo próprio em vez de desaparecer", () => {
    const grupos = groupByStatus([bug({ status: "" })]);
    expect(grupos).toHaveLength(1);
    expect(grupos[0].status).toBe("(sem status)");
  });

  it("não muta o array de entrada", () => {
    const entrada = [bug({ id: "x", priority: "Baixa" }), bug({ id: "y", priority: "Alta" })];
    groupByStatus(entrada);
    expect(entrada.map((b) => b.id)).toEqual(["x", "y"]);
  });
});

describe("computeBugMetrics", () => {
  it("separa abertos de encerrados e conta alta e impedidos", () => {
    const m = computeBugMetrics(
      [
        bug({ status: "IMPEDIDO", priority: "Alta" }),
        bug({ status: "PENDENTE DE ANÁLISE", priority: "Alta" }),
        bug({ status: "SOLUCIONADO", priority: "Alta" }),
        bug({ status: "DUPLICADO", priority: "Baixa" }),
      ],
      ENCERRADOS_PADRAO,
    );
    expect(m.total).toBe(4);
    expect(m.encerrados).toBe(2);
    expect(m.abertos).toBe(2);
    // A "Alta" já SOLUCIONADA não entra na contagem.
    expect(m.alta).toBe(2);
    expect(m.impedidos).toBe(1);
  });
});

describe("authorLabel", () => {
  it("usa o nome quando resolvido e cai no id sem users:read", () => {
    expect(authorLabel(bug({ author_name: "Brito", author: "U08NTN41WM8" }))).toBe("Brito");
    expect(authorLabel(bug({ author_name: "", author: "U08NTN41WM8" }))).toBe("U08NTN41WM8");
    expect(authorLabel(bug({ author_name: "", author: "" }))).toBe("—");
  });
});

describe("bugAge", () => {
  const agora = new Date("2026-07-29T12:00:00Z");
  const seg = (d: string) => Math.floor(new Date(d).getTime() / 1000);

  it("usa segundos, não milissegundos", () => {
    expect(bugAge(seg("2026-07-29T10:00:00Z"), agora)).toBe("2 h");
  });

  it("escala em dias, semanas e meses em vez de data completa", () => {
    expect(bugAge(seg("2026-07-27T12:00:00Z"), agora)).toBe("2 dias");
    expect(bugAge(seg("2026-07-28T12:00:00Z"), agora)).toBe("1 dia");
    expect(bugAge(seg("2026-06-29T12:00:00Z"), agora)).toBe("4 sem");
    expect(bugAge(seg("2026-01-29T12:00:00Z"), agora)).toBe("6 meses");
  });

  it("nunca devolve string longa com hora e segundos", () => {
    const antigo = bugAge(seg("2026-07-27T13:41:15Z"), agora);
    expect(antigo).not.toMatch(/:/);
    expect(antigo.length).toBeLessThanOrEqual(8);
  });

  it("sem data não inventa nada", () => {
    expect(bugAge(null, agora)).toBe("");
  });
});

describe("shortProduct", () => {
  it("encurta nome longo em vez de deixar quebrar linha", () => {
    const longo = "Konsigleads - Cadastro, busca e detalhes do acompanhamento";
    const curto = shortProduct(longo);
    expect(curto.length).toBeLessThanOrEqual(28);
    expect(curto.endsWith("…")).toBe(true);
  });

  it("deixa nome curto intacto", () => {
    expect(shortProduct("Dados")).toBe("Dados");
    expect(shortProduct("Auto-digitação")).toBe("Auto-digitação");
  });
});
