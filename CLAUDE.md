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
(anti "AI slop"). O skill inteiro é pra sites de marketing (heroes, navs,
macrostructures) e não foi vendorizado no repo — só os princípios abaixo,
que são os que se aplicam a um app utilitário de janela estreita (380–420px).

**Cor** (implementado): papel quente + tinta ardósia fria, tokens **OKLCH**
em `:root` (`src/App.css`) — nunca hex solto no meio do CSS. Um acento (pêra)
usado com parcimônia (~3% da tela: ação primária, borda de item ativo,
links) — nunca como preenchimento grande. Cores de status são **tints
semânticos**, distintos do acento da UI (in progress = ciano, blocker/atraso/
urgent = coral, testing = âmbar, lembrete = lavanda). Sem preto/branco puros.

**Tipografia** (implementado): regra "2+1" do hallmark — no máximo 3 famílias
por página (display + corpo + um "outlier" opcional, usado em ≤2 lugares).
Aqui: Plus Jakarta Sans faz corpo *e* display (wordmark/headings em peso
maior), JetBrains Mono é o outlier só pra ids/labels/eyebrows — embutidas
offline via `@fontsource-variable`, nunca CDN, o app roda offline. Números
com `tabular-nums`; pontuação tipográfica correta (aspas curvas, `—`, `…`,
nunca `"`/`--`/`...`). **Lacuna conhecida**: os `font-size` do `App.css` são
valores ad hoc (10px, 12px, 16px, 20px, 23px...), não uma escala em razão
fixa (o hallmark recomenda 1.25/1.333/1.5/1.618). Não é urgente pra hierarquia
simples que o app tem hoje, mas se a UI crescer, migrar pra uma escala nomeada
em vez de continuar hardcodando px.

**Motion** (parcialmente implementado): tokens de easing do hallmark —
`--ease-out: cubic-bezier(0.16,1,0.3,1)` pra elementos entrando, `--ease-in:
cubic-bezier(0.7,0,0.84,0)` pra saindo — e durações em 3 baldes (micro
100-150ms, curta 200-300ms, longa 300-500ms). Animar só `transform`/`opacity`
(GPU, não engatilha layout). Nunca bounce/elastic em UI comum — a **exceção**
explícita do hallmark é interação de arraste físico, que é exatamente o caso
do nosso "Meu foco": a mola do `framer-motion` (`Reorder`, spring
stiffness/damping) ali é deliberada, não um erro. **Lacunas conhecidas**: o
`App.css` ainda não declara os tokens de easing/duração acima (transições de
hover são instantâneas, sem token), e não há suporte a
`@media (prefers-reduced-motion: reduce)` em lugar nenhum — vale adicionar
quando a UI ganhar mais microinterações.

**Espaçamento e camadas** (não implementado, documentando o alvo): o
hallmark recomenda uma escala 4pt nomeada (`--space-3xs` … `--space-4xl`) em
vez de px cru, e um z-index de 6 níveis nomeados (`--z-base`, `--z-raised`,
`--z-dropdown`, `--z-sticky`, `--z-modal`, `--z-toast`, `--z-tooltip`) em vez
de valores ad hoc tipo `z-index: 9999`. Hoje o `App.css` usa px direto em
`padding`/`gap` e não tem nenhum `z-index` declarado (não há camadas
sobrepostas ainda — status-menu e chips de lembrete são os candidatos mais
próximos de precisar disso). Adotar a escala se/quando isso mudar.

**Responsivo**: a maior parte de `responsive.md` (breakpoints 320-1920px,
`srcset`, i18n) não se aplica — a janela é fixa/estreita, não uma página
web. A regra que **é** relevante aqui: **texto clicável nunca quebra linha**
(`white-space: nowrap` em botões/labels, encurtar o texto em vez de deixar
quebrar). Já aplicado nas pills de status (`.status-pill`/`.pill`). Ficar de
olho em rótulos dinâmicos mais longos — ex. o botão "confirmar · `<status>`"
da Fase 2 pode crescer com o nome do status e quebrar numa janela de 380px;
se isso acontecer, encurtar o texto do botão antes de tentar outra coisa.

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
