// Sprint é derivado do NOME da List (§1.2). Não existe campo `sprint` na API.
// Em runtime, sempre derivar de `task.list.name` — os IDs da tabela do spec são
// só referência de teste, nunca lógica de negócio.

export const SPRINT_RE =
  /Sprint\s+(\d+)\s*\((\d{1,2}\/\d{1,2})\s*-\s*(\d{1,2}\/\d{1,2})\)/i;

export type ListMeta =
  | { kind: "sprint"; number: number; startsAt: Date; endsAt: Date }
  | { kind: "other" };

// ~6 meses. As datas no nome não têm ano; se a data resultante ficar mais de
// 6 meses no futuro em relação a `now`, ela pertence ao ano anterior.
const SIX_MONTHS_MS = 183 * 24 * 60 * 60 * 1000;

function parseDayMonth(dm: string, now: Date): Date {
  const [month, day] = dm.split("/").map((n) => parseInt(n, 10));
  const date = new Date(now.getFullYear(), month - 1, day);
  if (date.getTime() - now.getTime() > SIX_MONTHS_MS) {
    date.setFullYear(date.getFullYear() - 1);
  }
  return date;
}

/**
 * Deriva metadados de uma List a partir do nome.
 * Nunca lança e nunca descarta: nome fora do padrão vira `{ kind: "other" }`.
 */
export function parseListMeta(listName: string, now: Date = new Date()): ListMeta {
  const match = SPRINT_RE.exec(listName);
  if (!match) return { kind: "other" };

  return {
    kind: "sprint",
    number: parseInt(match[1], 10),
    startsAt: parseDayMonth(match[2], now),
    endsAt: parseDayMonth(match[3], now),
  };
}
