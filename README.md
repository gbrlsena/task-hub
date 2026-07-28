# Task Hub

App desktop de notas autoadesivas com integração ClickUp. Ver [`task-hub-spec.md`](task-hub-spec.md).

Stack: Tauri 2 · React 18 + TypeScript + Vite · keyring nativo · `reqwest` no lado Rust.

> Regra dura: nenhuma chamada HTTP sai do frontend. Todo request externo passa por
> um `#[tauri::command]` em Rust. O token do ClickUp vive só no cofre de credenciais
> do SO, nunca em arquivo, log ou `localStorage`.

## Status: Etapas A e B

**Etapa A** — bootstrap:
- Projeto Tauri (React 18 + TS + Vite).
- Command de keyring — `src-tauri/src/secret.rs` (Credential Manager no Windows,
  Secret Service no Linux).
- Tela de token — `src/App.tsx` (valida prefixo `pk_`).
- `GET /api/v2/team` retornando os workspaces — `src-tauri/src/clickup.rs`.

**Etapa B** — sync + estado local:
- Sync paginado das tasks abertas (`GET /team/{id}/task`, `include_closed=false`,
  `subtasks=true`, 100/página até vir vazio) com backoff em 429 lendo `Retry-After`
  — `clickup::fetch_open_tasks`.
- Assignee derivado de `GET /api/v2/user` (não hardcodado).
- SQLite via `tauri-plugin-sql` com migração do schema de §1.5
  — `src-tauri/migrations/0001_init.sql`; cache/TTL no frontend em `src/db.ts`.
- Parser de sprint (`src/sprint.ts`) com testes cobrindo nome fora do padrão e
  virada de ano (`src/sprint.test.ts`, vitest).

**Navegação + anotações** (ver
[design](docs/superpowers/specs/2026-07-28-navegacao-sprint-subtasks-anotacoes-design.md)):
- Board = folder do ClickUp, escopável por URL/id (`get_folder`, sync por
  `list_ids[]` do folder).
- Navegação por sprint com setas ‹ ›, uma sprint por vez, default na sprint atual.
- Tasks com subtasks aninhadas expansíveis (campo `parent` no sync); pills de
  status (cor via §1.3), prioridade (urgent/high) e atraso — `src/task.ts`.
- Camada privada local (nunca vai pro ClickUp): comentários datados + lembretes
  com badge quando vencido, por task — `src/TaskCard.tsx`, tabelas `comment` e
  `reminder` (`migrations/0002_notes.sql`).
- Barra de métricas (abertas/atrasadas/travadas/esquecidas) e chips de filtro;
  tasks concluídas escondidas por padrão. "Concluída" é detectado pelo `type` do
  status (`done`/`closed`), sem hardcodar strings (§1.3) — coluna `status_type`
  (`migrations/0003_status_type.sql`), lógica em `src/task.ts`.

**Fase 2** — verificação via Claude:
- `ask_task(task_id, pergunta)` no Rust chama a Messages API da Anthropic
  (`claude-sonnet-5`, HTTP cru) num loop de tool-use com custom tools
  `clickup_get_task` e `github_search_prs` — `src-tauri/src/ai.rs`,
  `src-tauri/src/github.rs`. System prompt força o JSON do contrato; JSON
  inválido cai pra texto cru sem ação.
- Chave da Anthropic e token do GitHub no cofre (contas separadas do ClickUp)
  — `src-tauri/src/secret.rs`. UI de conexões no rodapé.
- Na task: campo "perguntar" → resposta com evidência sempre visível +
  confiança; botão "confirmar" só com `acao ≠ nada` e `confianca ≠ baixa`.

Commands expostos ao frontend (`src/api.ts`):
`token_status`, `save_clickup_token`, `clear_clickup_token`, `get_teams`,
`get_folder`, `sync_open_tasks`, `get_list_statuses`, `set_task_status`,
`anthropic_status`, `save_anthropic_key`, `github_status`, `save_github_token`,
`ask_task`.

## Pré-requisitos

- Node + npm
- Rust (stable) + toolchain MSVC no Windows / `build-essential` + `libssl-dev` no Linux
- WebView2 (já vem no Windows 11)

## Rodar

```bash
npm install
npm run tauri dev
```

No primeiro uso o app pede o token pessoal do ClickUp (Settings → Apps → API Token,
começa com `pk_`). Ele é salvo no cofre e usado para listar os workspaces.

## Testes (lógica pura, sem rede)

Rust — validação de token e parsing de tasks/`/team`:

```bash
cd src-tauri && cargo test
```

Frontend — parser de sprint (nome fora do padrão, virada de ano):

```bash
npm test
```
