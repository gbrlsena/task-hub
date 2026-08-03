# Task Hub — instruções de projeto

App desktop de notas autoadesivas com integração ClickUp (Tauri 2 + React 18 +
TypeScript). Especificação completa em [`task-hub-spec.md`](task-hub-spec.md) —
leia-a antes de qualquer trabalho significativo, ela é a fonte da verdade para
requisitos, contratos de API e critérios de aceite.

## Regras duras (do spec, não flexibilizar)

- **Nenhuma chamada HTTP direto do frontend.** Todo request externo
  (ClickUp, Anthropic, GitHub, Slack) passa por um `#[tauri::command]` em Rust.
- **Nunca hardcodar strings de status** em código de escrita (`"concluída"`,
  `"complete"`, etc.). Resolver dinamicamente: no ClickUp via `GET /list/{id}` e
  o campo `type` (`open|custom|closed|done`); na Slack List via
  `list_metadata.schema` do `files.info` — ver `clickup.rs` e `slack.rs`.
- **Nenhuma escrita sem ação explícita do usuário**, em nenhuma das fontes.
  Sugestões da IA (Fase 2) nunca se aplicam sozinhas; `confianca: baixa` não
  mostra botão de ação; a evidência é sempre visível antes de confirmar.
- **A Slack List de bugs é compartilhada com toda a empresa.** Diferente do
  board do ClickUp, escrever ali afeta o fluxo do `#bugs` inteiro. Só a troca de
  status escreve, por clique, e a coluna e a opção são revalidadas **no momento
  da escrita** — se alguém renomear no Slack, falha em vez de gravar errado.
- **Segredos só no keyring do SO**, nunca em arquivo, `.env`, log ou
  localStorage. Ver `src-tauri/src/secret.rs` — 4 contas:
  `clickup_personal_token`, `anthropic_api_key`, `github_token`, `slack_token`,
  service `task-hub`. Todos entram pela tela de conexões (rodapé → "conexões").
- Ordem manual do "foco" é local e **nunca** sincroniza de volta pro ClickUp
  (mexeria numa view compartilhada).
- Sync é sempre um único fetch paginado — nunca um request por task
  (rate limit de 100/min do ClickUp; tier 2, 20+/min no Slack).
- **Não duplicar UI entre as telas.** Status, anotações e foco são componentes
  compartilhados (`StatusPicker`, `Notes`, `FocoItem`). Cópias parecidas
  divergem na prática — já aconteceu e custou um refactor.

## Stack e onde as coisas moram

- **Rust** (`src-tauri/src/`): dono de todo HTTP (`reqwest`), keyring
  (`secret.rs`), das migrações SQL e das janelas. `clickup.rs` (API ClickUp),
  `slack.rs` (Slack List de bugs), `github.rs` (busca de PRs), `ai.rs` (loop de
  tool-use com a Anthropic), `detach.rs` (janela destacada: label, inventário
  das abertas, criar/focar).
- **Frontend** (`src/`): React + TS + Vite. `db.ts` fala com o SQLite
  (`@tauri-apps/plugin-sql`), `api.ts` invoca os commands Tauri, `sprint.ts`/
  `task.ts`/`bug.ts` têm a lógica pura (parser de sprint, derivações como
  `isLate`/`isStale`/`isDone`, agrupamento e tints dos bugs), testada com
  vitest. `TaskWindow.tsx` é a tela da janela destacada, `sync.ts` o ping entre
  janelas, `sticker.ts` o ajuste de altura, `route.ts` a leitura do `?task=`.
- **Componentes compartilhados pelas duas fontes**: `StatusPicker.tsx` (pill +
  dropdown de status), `Notes.tsx` (anotações e lembretes por `subject_kind`),
  `FocoItem.tsx` (item arrastável do "Meu foco"). `TaskCard.tsx` é o cartão do
  ClickUp e `BugQueue.tsx` a fila de bugs; os dois consomem os três acima.
- SQLite local via `tauri-plugin-sql`; migrações em `src-tauri/migrations/`,
  numeradas e cumulativas — nunca editar uma migração já commitada, sempre
  adicionar uma nova. Editar uma já aplicada quebra o app: ver as armadilhas
  na seção de dev vs. release.
- **Capabilities**: `src-tauri/capabilities/default.json` lista
  `["main", "task-*"]`. Janela cujo label não casa com esses padrões nasce sem
  permissão nenhuma e o `plugin-sql` dela falha calado.

## Slack: a fila de bugs (segunda fonte do hub)

O canal `#bugs` **não** é a fonte. Cada post lá é do bot "Formulário de
submissão de bugs" e carrega só quem abriu, prioridade, time e um link — sem
título, status nem responsável. O conteúdo real mora na Slack List
**"Solicitações — Bugs"** (`F08NTEW4H3R`), e é dela que o app lê.

- **Escopos** no User OAuth Token (`xoxp-`, nunca bot `xoxb-`): `lists:read`
  (itens), `files:read` (schema e export), `lists:write` (gravar status).
  `users:read` é opcional — sem ele o autor aparece como id (`U08NTN41WM8`) em
  vez de nome, e o sync avisa. Lists exige workspace em plano pago.
- **Uma List é um arquivo.** O schema (nomes de coluna, tipos e rótulos dos
  `select`) vem do `files.info` → `list_metadata.schema`. O `items.list` **não**
  traz schema: devolve `select` como id opaco (`OptYYB79DT0`).
- **Qual coluna é o quê**: os tipados saem do `type` do schema e são
  inequívocos (`user` = Responsável, `created_by` = Autor, `created_time`,
  `date`, `number`, `attachment`, `text` primário = título). Só os `select`
  casam por nome — menos o **Status**, que sai do `grouping.group_by` da view
  padrão da List, em vez de ser adivinhado.
- A fila filtra por Responsável **localmente**: a API não filtra por campo,
  então é um fetch paginado da List inteira e o filtro no lado Rust.

### Três armadilhas do payload (todas com teste de regressão)

Não são hipotéticas — cada uma custou uma iteração:

- **`key` ≠ `column_id`.** O item traz `key`; o `items.update` exige
  `column_id`. Gravar usando o `key` escreve na coluna errada (ou em nenhuma).
- **A prop do valor não espelha o `type` da coluna.** Uma coluna
  `created_by` entrega o valor em **`user`**. Por isso a leitura tenta várias
  props e cai em `value` no fim, em vez de confiar no tipo declarado.
- **`column_id` vem antes do valor na ordem do JSON.** Um resumo que pega "o
  primeiro campo não nulo" mostra o id como se fosse o valor.

A lição que vale para o próximo campo novo: **sondar e despejar o cru antes de
escrever o parser.** Os botões `diagnosticar` e `schema` no painel de conexões
existem pra isso e são andaime dev-facing, não feature.

### O que não funciona (já testado, não repetir)

- **Baixar o export CSV** (`slackLists.download.*` ou o `list_csv_download_url`)
  para descobrir rótulos: a URL responde HTML do app web em vez de CSV. O
  `reqwest` também descarta o `Authorization` ao seguir redirect entre hosts.
  Não vale a pena — o `files.info` já dá o schema direto.

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

**Espaçamento** (não implementado, documentando o alvo): o hallmark recomenda
uma escala 4pt nomeada (`--space-3xs` … `--space-4xl`) em vez de px cru. Hoje o
`App.css` usa px direto em `padding`/`gap`. Adotar se a UI crescer.

**Camadas** (parcialmente implementado): a escala de z-index nomeada existe
desde que apareceu a primeira camada sobreposta de verdade — o dropdown de
status, que precisa sair do fluxo. Declarados: `--z-base: 0`, `--z-raised: 5`
(casa com o `whileDrag` do arraste do foco) e `--z-dropdown: 50`. Se surgirem
modal, toast ou tooltip, continuar a escala em vez de inventar número solto.
**Nunca `z-index: 9999`.**

Nota do porquê o dropdown sai do fluxo: quando o menu de status ficava no fluxo
dentro da linha `.task-main`, ele disputava largura com o `.task-name` (que é
`flex: 1`) e esmagava o título em uma palavra por linha.

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
- **Fechar o app antes de compilar**: o Windows tranca o `.exe` em execução e
  o build morre com `failed to remove file … Acesso negado (os error 5)`.

### Migrações: duas armadilhas que já quebraram o app

Dev e release compartilham o mesmo banco (`%APPDATA%\com.gbrlsena.task-hub\
taskhub.db`), e o sqlx valida as migrações aplicadas na abertura. Duas
consequências que **não são hipotéticas** — as duas aconteceram na `0.2.0`:

- **Rodar o `tauri dev` com uma migração nova invalida o release instalado**
  até a próxima recompilação. O binário velho vê um schema mais novo do que
  conhece e se recusa a abrir: *migration N was previously applied but is
  missing in the resolved migrations*. Não é corrupção, é proteção — o
  conserto é recompilar, nunca apagar o banco (as anotações e lembretes são
  locais e não existem no ClickUp).
- **Nunca deixar o conteúdo de um `.sql` já aplicado mudar um único byte.** O
  sqlx guarda um sha384 do arquivo; qualquer diferença vira *migration N was
  previously applied but has been modified*. No Windows isso acontece **sem
  ninguém editar nada**: com `core.autocrlf=true`, um `git checkout` reescreve
  em CRLF o arquivo que mudou naquele intervalo. Foi assim que a `0004`
  quebrou depois do merge. O `.gitattributes` fixa `*.sql text eol=lf` — não
  remover. Pra diagnosticar, comparar o checksum guardado com o do arquivo:

```bash
python -c "import sqlite3,hashlib,io,os; db=os.path.join(os.environ['APPDATA'],'com.gbrlsena.task-hub','taskhub.db'); print(sqlite3.connect(f'file:{db}?mode=ro',uri=True).execute('SELECT version,hex(checksum) FROM _sqlx_migrations').fetchall()); print(hashlib.sha384(io.open('src-tauri/migrations/0004_description.sql','rb').read()).hexdigest())"
```

## Toolchain (Windows, ambiente de dev atual)

- Node + npm, Rust stable (via `rustup`), MSVC Build Tools (VS 2022 C++,
  instalado via winget) — necessário pro linker do Tauri no Windows.
- **PowerShell bloqueia `npm` por padrão** (ExecutionPolicy Restricted barra
  o shim `npm.ps1`). Usar `npm.cmd` em vez de `npm` em qualquer comando
  PowerShell, ou rodar em Bash/Git Bash/cmd onde `npm` funciona direto.
- **`cargo` não está no PATH** dos shells que o Claude Code abre nesta máquina
  (nem Bash nem PowerShell) — chamar `~/.cargo/bin/cargo.exe` direto, ou
  prefixar `PATH="$HOME/.cargo/bin:$PATH"` no comando. No terminal do usuário
  funciona normal; é só nos shells da ferramenta.
- Linux Mint é o alvo primário de produção (spec) — nesse ambiente, `npm`
  funciona normal; prerequisito é `build-essential` + `libssl-dev`.
- A pasta local do repo ainda se chama `notas-hub` (nome antigo, só
  cosmético) — o produto e o repo GitHub se chamam **Task Hub**
  (`gbrlsena/task-hub`, público, licença MIT).

## Testes

- Rust: `cd src-tauri && cargo test` (39 testes) — valida token, parsing de
  task/`/team`, status_type, extração da descrição (com fallback pro
  `text_content`), o label da janela destacada e, do lado Slack, validação do
  token/List id, tradução do `ok: false` em erro acionável, mapeamento das
  colunas pelo schema e as três armadilhas do payload.
- Frontend: `npm test` (vitest, 59 testes) — parser de sprint, agrupamento por
  sprint, derivações (`isDone`/`isStale`/`isLate`/`computeMetrics`), helpers de
  lembrete/tempo relativo, `cleanDescription`, `parseTaskParam`,
  `stickerHeight` e a lógica de bug (`groupByStatus`, `isEncerrado`,
  `statusRank`/tints, `bugAge`, `shortProduct`).
- O que **não** tem teste automatizado: escrita no SQLite (não há harness pro
  plugin), componentes React e o comportamento entre janelas. Isso se verifica
  no `tauri dev`, na mão.
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
- **Fila de bugs do Slack** (migrações `0005`/`0006`): segunda fonte do hub,
  alternada por um seletor no cabeçalho. Mostra só os bugs onde você é o
  Responsável, agrupados por status, com anotações locais, foco (pin) e "criar
  card no ClickUp" na lista da sprint aberta. Troca de status grava na List.
  Ver a seção "Slack: a fila de bugs" acima — inclusive o que já foi testado e
  **não** funciona.
- Descrição da task (migração `0004`): já vinha no payload do sync e era
  descartada dentro de `raw`, agora é coluna própria. Clicar no **nome** abre
  a gaveta (`.desc-panel`); nome sem descrição não vira botão. Texto puro com
  `pre-wrap` — o endpoint não devolve markdown, não existe parser e não deve
  existir.
- Janela destacada: `open_task_window` (Rust, `src-tauri/src/detach.rs`) abre
  `index.html?task=<id>` com label `task-<id>`, renderizando o **mesmo**
  `TaskCard` (`TaskWindow.tsx`), não um componente de detalhe paralelo. Se a
  janela já existe, foca em vez de abrir outra. A altura cola no conteúdo
  (`sticker.ts`, `ResizeObserver`); a largura é do usuário.
- Estado "destacado": o cartão no hub encolhe pra nome + rótulo enquanto a
  janela existe. **Não é persistido** — deriva de `app.webview_windows()`, então
  crash não deixa fantasma preso na lista.
- Sincronia entre janelas por ping (`taskhub:changed` em `sync.ts`), sem
  payload: o SQLite é a fonte da verdade, cada janela relê. O ping carrega o
  label de quem escreveu pra janela ignorar o próprio eco. Toda escrita do
  `db.ts` dispara — é o único lugar onde isso mora, não espalhar pelos
  componentes.

**Não feito ainda (não assumir que existe):**
- **Fila de notas locais**: a tabela `note` existe na migração 0001, mas não
  há UI nem commands pra criar/promover notas locais pra task real. É
  trabalho futuro, não construído.
- **Modo escuro**: só existe o tema claro atual; os tokens já são variáveis
  CSS, então adicionar um dark seria barato, mas ainda não foi feito.
- **Etapa F** (empacotamento final): rodamos `tauri build` manual (exe + msi +
  nsis, hoje na `0.3.0`), mas não há tray icon, as janelas não são
  always-on-top nem sem-decoração, e não foi testado em Linux. A janela
  destacada seria o candidato natural a virar sticker sem decoração — implica
  desenhar botão de fechar e área de arraste próprios.
- **Largura da janela destacada** não acompanha o texto (só a altura cola no
  conteúdo). Decisão consciente: largura variável deixa cada sticker com uma
  medida diferente.
- **Na fila de bugs**: não há janela destacada, nem "perguntar" (o `ask_task` é
  específico do ClickUp e precisaria de uma tool que leia a List), nem arraste
  nos cartões dentro dos grupos (só no bloco "Meu foco"). A lista de status que
  conta como "encerrado" (`SOLUCIONADO`, `NÃO É BUG`, `DUPLICADO`) é ajuste
  local em `localStorage`, sem UI pra editar.

## Convenções de commit

Mensagens em português, no estilo do histórico existente, terminando com
`Co-Authored-By: Claude <modelo> <noreply@anthropic.com>`. Só commitar quando
o usuário pedir explicitamente — nunca commitar proativamente.
