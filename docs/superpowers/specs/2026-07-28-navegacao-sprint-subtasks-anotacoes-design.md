# Design: navegação por sprint, subtasks e anotações privadas

Data: 2026-07-28. Estende o `task-hub-spec.md` (Fase 1) com a UI de leitura
(Etapa C/D) remodelada pela direção do usuário, mais uma camada local nova
(comentários + lembretes) que não existia no spec original.

## Princípio

Nada aqui sincroniza pro ClickUp. Board/sprint são navegação; comentários e
lembretes são uma camada **privada e local** (SQLite) por cima das tasks.

## A. Navegação: board → sprint

- Board (folder) já existe e é trocável (URL/id, persistido).
- Navegador de sprint com setas **‹ Sprint N (dd/m–dd/m) ›**: mostra **uma**
  sprint por vez.
- Ordem: sprints por número; ‹ anterior, › próxima. Listas não-sprint do folder
  entram como posições extras no fim ("Outros"), pra nada ficar inacessível.
- Default: a sprint cujo range engloba hoje; se nenhuma, a de maior número.
- A tela mostra só as tasks da sprint/posição selecionada.

## B. Tasks + subtasks

- Lista só as **tasks de topo** (as que não têm `parent`, ou cujo `parent` não
  está no conjunto visível → fallback pra topo, pra nunca sumir).
- Card mostra pills: status (cor via `STATUS_ROLE` do §1.3), prioridade quando
  urgent/high, atraso com data quando `isLate`. Texto fraco: `custom_id || id`
  e nome da lista.
- Subtasks: controle "▸ N subtasks" expande e mostra as subtasks aninhadas
  (recuadas), cada uma com suas pills. Expansão é estado de UI local (não
  persiste).
- Enabler: capturar `parent` (id da task pai) no sync → coluna `parent` em
  `task_cache`. Árvore montada no frontend.

## C. Anotações privadas (por task e subtask)

- Área expansível "minhas anotações" no card.
- **Comentários**: histórico datado, imutável, mais novo no topo, adicionar com
  Enter, apagar. Tabela `comment`.
- **Lembretes**: `remind_at` (data/hora) + texto opcional. "Vencido" =
  `remind_at <= agora && !dismissed`, recalculado a cada render (como `isLate`).
  Badge "lembrete" no card quando vencido; dispensável. Tabela `reminder`.
- Ambos referenciam um assunto genérico: `subject_id` + `subject_kind`
  (`task` | `note`), porque valem tanto pra task do ClickUp quanto pra nota
  local da fila (Etapa D). O caminho `note` fica plugável; ativa com a fila.

## Dados

- `task_cache`: + coluna `parent TEXT` (migração `0002`, `ALTER TABLE`).
- Migração `0002` cria:

```sql
CREATE TABLE comment (
  id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, subject_kind TEXT NOT NULL,
  body TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE reminder (
  id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, subject_kind TEXT NOT NULL,
  body TEXT, remind_at INTEGER NOT NULL, dismissed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
```

## Derivações computadas (nunca persistir; recalcular por render — §1.6)

- `isLate = due_date != null && due_date < startOfToday()`
- `isBlocked = status.toLowerCase().includes("blocker")`
- `priorityLabel`: 1=urgent, 2=high (só mostra pill em urgent/high)
- reminder vencido: ver C.

## Fora de escopo desta fatia

- Pin/foco com ordem manual (Etapa D) e notas locais da fila — as anotações já
  preveem `subject_kind=note`, mas a fila em si vem depois.
- Escrita de status/priority/due_date de volta no ClickUp (Etapa E).
- Notificação nativa de lembrete (o usuário escolheu destaque no app).

## Testes

- Rust: `parse_task` extrai `parent`.
- vitest: montagem da árvore (topo + filhos, órfão vira topo); seleção da sprint
  atual (range engloba hoje; fallback maior número); derivações (`isLate`,
  `statusRole`, label de prioridade).
