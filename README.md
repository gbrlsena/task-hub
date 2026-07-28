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

Commands expostos ao frontend (`src/api.ts`):
`token_status`, `save_clickup_token`, `clear_clickup_token`, `get_teams`,
`sync_open_tasks`.

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
