/**
 * Lógica pura da fila de bugs (Slack List "Solicitações — Bugs").
 *
 * Os rótulos de status e prioridade chegam **do schema da List**, resolvidos em
 * runtime no lado Rust — nada aqui os inventa. O que este módulo faz com
 * strings é só ordenar e colorir para exibição; nenhuma escrita depende disso
 * (o escopo `lists:read` é somente leitura, o app não muda status no Slack).
 */

import type { Role } from "./task";

/** Bug como devolvido pelo command `sync_bugs` e guardado no `bug_cache`. */
export interface Bug {
  id: string;
  name: string;
  description: string;
  status: string;
  priority: string;
  product: string;
  team: string;
  category: string;
  origin: string;
  author: string;
  author_name: string;
  assignee: string;
  created_at: number | null;
  finished_at: number | null;
  cases: number | null;
  attachments: number;
  permalink: string;
}

/** Compara rótulo ignorando caixa, acento e espaço — o usuário pode renomear. */
export function normalize(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/**
 * Statuses que somem da fila por padrão: os três terminais.
 *
 * Fica aqui como **default**, não como regra fixa — é ajustável e persiste
 * local. `IMPEDIDO` e `EM VALIDAÇÃO` continuam visíveis de propósito: ainda
 * dependem de alguém.
 */
export const ENCERRADOS_PADRAO = ["SOLUCIONADO", "NÃO É BUG", "DUPLICADO"];

export function isEncerrado(status: string, encerrados: string[]): boolean {
  const s = normalize(status);
  return encerrados.some((e) => normalize(e) === s);
}

/**
 * Ordem de exibição dos grupos, seguindo o fluxo da List. `IMPEDIDO` vem
 * primeiro porque é o que trava; os terminais no fim.
 *
 * Status que não estiver nesta lista **não desaparece**: vai para o fim, em
 * ordem alfabética. Assim uma coluna nova na List aparece na fila sem exigir
 * mudança de código.
 */
const ORDEM = [
  "IMPEDIDO",
  "PENDENTE DE ANÁLISE",
  "EM ANÁLISE",
  "CORRIGINDO",
  "EM VALIDAÇÃO",
  "SOLUCIONADO",
  "NÃO É BUG",
  "DUPLICADO",
];

export function statusRank(status: string): number {
  const i = ORDEM.findIndex((s) => normalize(s) === normalize(status));
  return i === -1 ? ORDEM.length : i;
}

/** Papel de cor do status, reusando os tints semânticos do app. */
export function statusTint(status: string): Role {
  const s = normalize(status);
  if (s === "impedido") return "danger";
  if (s === "em analise" || s === "corrigindo") return "accent";
  if (s === "em validacao") return "warning";
  return "neutral";
}

/** Alta → Média → Baixa. Prioridade vazia ou desconhecida vai por último. */
export function priorityRank(priority: string): number {
  const p = normalize(priority);
  if (p === "alta") return 0;
  if (p === "media") return 1;
  if (p === "baixa") return 2;
  return 3;
}

export function priorityTint(priority: string): Role {
  const p = normalize(priority);
  if (p === "alta") return "danger";
  if (p === "media") return "warning";
  return "neutral";
}

export interface BugGroup {
  status: string;
  bugs: Bug[];
}

/**
 * Agrupa por status na ordem do fluxo; dentro do grupo, prioridade primeiro e
 * mais antigo antes em caso de empate.
 */
export function groupByStatus(bugs: Bug[]): BugGroup[] {
  const grupos = new Map<string, Bug[]>();
  for (const b of bugs) {
    const chave = b.status || "(sem status)";
    const atual = grupos.get(chave);
    if (atual) atual.push(b);
    else grupos.set(chave, [b]);
  }

  return [...grupos.entries()]
    .map(([status, lista]) => ({
      status,
      bugs: [...lista].sort(
        (a, b) =>
          priorityRank(a.priority) - priorityRank(b.priority) ||
          (a.created_at ?? 0) - (b.created_at ?? 0),
      ),
    }))
    .sort(
      (a, b) =>
        statusRank(a.status) - statusRank(b.status) || a.status.localeCompare(b.status),
    );
}

export interface BugMetrics {
  total: number;
  abertos: number;
  encerrados: number;
  alta: number;
  impedidos: number;
}

export function computeBugMetrics(bugs: Bug[], encerrados: string[]): BugMetrics {
  const fechados = bugs.filter((b) => isEncerrado(b.status, encerrados));
  return {
    total: bugs.length,
    abertos: bugs.length - fechados.length,
    encerrados: fechados.length,
    alta: bugs.filter(
      (b) => priorityRank(b.priority) === 0 && !isEncerrado(b.status, encerrados),
    ).length,
    impedidos: bugs.filter((b) => statusTint(b.status) === "danger").length,
  };
}

/** Autor para exibição: nome quando `users:read` resolveu, senão o id cru. */
export function authorLabel(b: Bug): string {
  return b.author_name || b.author || "—";
}

/**
 * Idade do bug em forma curta. O `relTime` do app cai em `toLocaleString()`
 * acima de 24 h (`27/07/2026, 13:41:15`), que numa janela de 380px empurra a
 * linha de meta inteira. Aqui a escala continua em dias e semanas.
 *
 * `created_at` da List vem em **segundos**, não milissegundos.
 */
export function bugAge(createdAtSec: number | null, now: Date = new Date()): string {
  if (!createdAtSec) return "";
  const min = Math.round((now.getTime() - createdAtSec * 1000) / 60000);
  if (min < 1) return "agora";
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d} ${d === 1 ? "dia" : "dias"}`;
  const sem = Math.round(d / 7);
  if (sem < 9) return `${sem} sem`;
  const meses = Math.round(d / 30);
  return `${meses} ${meses === 1 ? "mês" : "meses"}`;
}

/**
 * Encurta o nome do produto para caber na janela estreita. A regra do projeto é
 * encurtar em vez de deixar quebrar linha — `Konsigleads - Cadastro, busca e
 * detalhes do acompanhamento` não cabe em 380px.
 */
export function shortProduct(product: string, max = 28): string {
  const p = product.trim();
  if (p.length <= max) return p;
  return `${p.slice(0, max - 1).trimEnd()}…`;
}
