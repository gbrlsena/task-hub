# Task Hub

App desktop de notas autoadesivas com integração ClickUp. Ver [`task-hub-spec.md`](task-hub-spec.md).

Stack: Tauri 2 · React 18 + TypeScript + Vite · keyring nativo · `reqwest` no lado Rust.

> Regra dura: nenhuma chamada HTTP sai do frontend. Todo request externo passa por
> um `#[tauri::command]` em Rust. O token do ClickUp vive só no cofre de credenciais
> do SO, nunca em arquivo, log ou `localStorage`.

## Status: Etapa A

Entregue nesta etapa (ver seção "Entregáveis por etapa" no spec):

- Projeto Tauri inicializado (React 18 + TS + Vite).
- Command de keyring funcionando — `src-tauri/src/secret.rs`
  (Credential Manager no Windows, Secret Service no Linux).
- Tela de token — `src/App.tsx` (valida prefixo `pk_`).
- `GET /api/v2/team` retornando os workspaces — `src-tauri/src/clickup.rs`.

Commands expostos ao frontend (`src/api.ts`):
`token_status`, `save_clickup_token`, `clear_clickup_token`, `get_teams`.

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

```bash
cd src-tauri && cargo test
```

Cobre a validação do token e o parsing da resposta de `GET /team`.
