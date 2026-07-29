# Task Hub — instruções de projeto

App desktop de notas autoadesivas com integração ClickUp (Tauri 2 + React 18 +
TypeScript). Especificação completa em [`task-hub-spec.md`](task-hub-spec.md) —
leia-a antes de qualquer trabalho significativo, ela é a fonte da verdade para
requisitos, contratos de API e critérios de aceite.

## Regras duras (do spec, não flexibilizar)

- **Nenhuma chamada HTTP direto do frontend.** Todo request externo
  (ClickUp, Anthropic, GitHub) passa por um `#[tauri::command]` em Rust.
- **Nunca hardcodar strings de status** em código de escrita (`"concluída"`,
  `"complete"`, etc.). Resolver dinamicamente via `GET /list/{id}` e o campo
  `type` (`open|custom|closed|done`) — ver `src-tauri/src/clickup.rs`.
- **Nenhuma escrita no ClickUp sem ação explícita do usuário.** Sugestões da
  IA (Fase 2) nunca se aplicam sozinhas; `confianca: baixa` não mostra botão
  de ação; a evidência é sempre visível antes de confirmar.
- **Segredos só no keyring do SO**, nunca em arquivo, `.env`, log ou
  localStorage. Ver `src-tauri/src/secret.rs` — 3 contas: `clickup_personal_token`,
  `anthropic_api_key`, `github_token`, service `task-hub`.
- Ordem manual do "foco" é local e **nunca** sincroniza de volta pro ClickUp
  (mexeria numa view compartilhada).
- Sync é sempre um único fetch paginado — nunca um request por task
  (rate limit de 100/min do ClickUp).

## Stack e onde as coisas moram

- **Rust** (`src-tauri/src/`): dono de todo HTTP (`reqwest`), keyring
  (`secret.rs`), e das migrações SQL. `clickup.rs` (API ClickUp), `github.rs`
  (busca de PRs), `ai.rs` (loop de tool-use com a Anthropic).
- **Frontend** (`src/`): React + TS + Vite. `db.ts` fala com o SQLite
  (`@tauri-apps/plugin-sql`), `api.ts` invoca os commands Tauri, `sprint.ts`/
  `task.ts` têm a lógica pura (parser de sprint, derivações como `isLate`/
  `isStale`/`isDone`), testada com vitest.
- SQLite local via `tauri-plugin-sql`; migrações em `src-tauri/migrations/`,
  numeradas e cumulativas — nunca editar uma migração já commitada, sempre
  adicionar uma nova.

## Design system

Pegada inspirada no design skill [nutlope/hallmark](https://github.com/nutlope/hallmark)
(anti "AI slop"): papel quente + tinta ardósia fria, tokens **OKLCH** em
`:root` (`src/App.css`) — nunca hex solto no meio do CSS. Fontes **embutidas
offline** via `@fontsource-variable` (Plus Jakarta Sans no corpo, JetBrains
Mono em labels/ids) — nunca CDN, o app roda offline. Um acento (pêra) usado
com parcimônia (~3% da tela: ação primária, borda de item ativo, links) —
nunca como preenchimento grande. Cores de status são **tints semânticos**,
distintos do acento da UI (in progress = ciano, blocker/atraso/urgent = coral,
testing = âmbar, lembrete = lavanda). Números sempre com `tabular-nums`. Sem
emoji como ícone, sem side-stripe colorida, sem preto/branco puros.

Antes de qualquer mudança visível de UI: mostrar um preview (mockup) e
esperar aprovação antes de mexer no código de verdade — o usuário gosta de
iterar em opções visuais primeiro.

## Fluxo de dev vs. release (importante — combinado com o usuário)

- **Dia a dia**: testar via `npm.cmd run tauri dev` (ver nota do PowerShell
  abaixo). Recarrega sozinho a cada mudança — não precisa recompilar nada.
- **Release**: só gerar o binário/instalador quando o usuário **pedir
  explicitamente** ("recompila", "fecha essa versão", "gera o release").
  Nunca fazer isso automaticamente a cada aprovação de mudança — builds de
  release demoram minutos e não compensa a cada micro-ajuste.
- Ao gerar release: **bump de versão semver** em três arquivos que precisam
  ficar em sincronia — `package.json`, `src-tauri/tauri.conf.json`,
  `src-tauri/Cargo.toml`. Patch (`0.1.0→0.1.1`) para fix pequeno, minor
  (`0.1.0→0.2.0`) para feature nova, a não ser que o usuário peça um número
  específico. Depois rodar `npm.cmd run tauri build`.
- O binário fica em `src-tauri/target/release/task-hub.exe` (também gera
  `.msi` e um instalador NSIS em `target/release/bundle/`). O usuário fixa
  esse `.exe` na barra de tarefas — cada rebuild **substitui o arquivo no
  mesmo caminho**, então o atalho fixado continua funcionando sem refixar.

## Toolchain (Windows, ambiente de dev atual)

- Node + npm, Rust stable (via `rustup`), MSVC Build Tools (VS 2022 C++,
  instalado via winget) — necessário pro linker do Tauri no Windows.
- **PowerShell bloqueia `npm` por padrão** (ExecutionPolicy Restricted barra
  o shim `npm.ps1`). Usar `npm.cmd` em vez de `npm` em qualquer comando
  PowerShell, ou rodar em Bash/Git Bash/cmd onde `npm` funciona direto.
- Linux Mint é o alvo primário de produção (spec) — nesse ambiente, `npm`
  funciona normal; prerequisito é `build-essential` + `libssl-dev`.
- A pasta local do repo ainda se chama `notas-hub` (nome antigo, só
  cosmético) — o produto e o repo GitHub se chamam **Task Hub**
  (`gbrlsena/task-hub`, público, licença MIT).

## Testes

- Rust: `cd src-tauri && cargo test` — valida token, parsing de task/`/team`,
  status_type.
- Frontend: `npm test` (vitest) — parser de sprint, agrupamento por sprint,
  derivações (`isDone`/`isStale`/`isLate`/`computeMetrics`), helpers de
  lembrete/tempo relativo.
- Rodar os dois antes de considerar uma mudança pronta. Build (`npm run
  build`) também deve passar limpo (typecheck + vite build).

## Estado atual (o que está pronto vs. não)

**Feito:**
- Etapa A (bootstrap: keyring, tela de token, `GET /team`).
- Etapa B (sync paginado escopado por folder, SQLite, parser de sprint).
- Navegação por sprint (setas), subtasks aninhadas, pills de status/
  prioridade/atraso, métricas + filtro por sprint (abertas/progresso/
  atrasadas/travadas/esquecidas), esconder concluídas por padrão.
- Anotações privadas por task (comentários datados + lembretes com chips de
  data relativa) — nunca sincronizam pro ClickUp.
- Etapa E (escrever status no ClickUp com resolução dinâmica, otimista +
  rollback).
- Foco (pin) imune ao filtro, com reordenação por arraste (framer-motion).
- Fase 2 (verificação via Claude): `ask_task` com tools `clickup_get_task` +
  `github_search_prs`, contrato JSON com evidência/confiança, aplicação só
  por confirmação explícita. **Cada chamada custa na API da Anthropic.**
- Reskin de UI na pegada hallmark (tema claro, tokens OKLCH, fontes offline).

**Não feito ainda (não assumir que existe):**
- **Fila de notas locais**: a tabela `note` existe na migração 0001, mas não
  há UI nem commands pra criar/promover notas locais pra task real. É
  trabalho futuro, não construído.
- **Modo escuro**: só existe o tema claro atual; os tokens já são variáveis
  CSS, então adicionar um dark seria barato, mas ainda não foi feito.
- **Etapa F** (empacotamento final): rodamos um `tauri build` manual (exe +
  msi + nsis), mas não há tray icon, a janela não é always-on-top nem
  sem-decoração, e não foi testado em Linux.

## Convenções de commit

Mensagens em português, no estilo do histórico existente, terminando com
`Co-Authored-By: Claude <modelo> <noreply@anthropic.com>`. Só commitar quando
o usuário pedir explicitamente — nunca commitar proativamente.
