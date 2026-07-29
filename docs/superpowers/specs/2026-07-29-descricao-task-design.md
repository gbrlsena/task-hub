# Design: descrição da task — gaveta no cartão + janela destacada

Data: 2026-07-29. Estende a UI de leitura (Etapa C/D) com a descrição da task
vinda do ClickUp: uma gaveta dentro do cartão e, para quem quiser ler com
calma, uma segunda janela com a task inteira. Enquanto a janela está aberta, o
cartão no hub encolhe para o estado **destacado**.

## Princípio

Nenhum request novo. A descrição **já vem** no payload do sync paginado
(`GET /team/{id}/task`) e hoje é descartada — fica enterrada na coluna `raw`.
Todo o trabalho é promover esse campo a cidadão de primeira classe e desenhar a
leitura. A regra do §1.1 (um único fetch paginado, nunca um request por task)
continua intacta.

## A. Dados: a descrição vira coluna

- Migração `0004_description.sql` (nova e cumulativa; as três já commitadas não
  são tocadas):

```sql
ALTER TABLE task_cache ADD COLUMN description TEXT NOT NULL DEFAULT '';
```

- `lib.rs`: registrar `Migration { version: 4, description: "task description
  column", … }`.
- `clickup.rs`: `TaskDto` ganha `description: String`; `parse_task` lê
  `t["description"]` com fallback para `t["text_content"]` e `trim()`. Campo
  ausente vira `""` — mantém a tolerância que a função já tem (nunca descarta a
  task por dado inesperado).
- `db.ts`: `description` entra em `SyncedTask`, no upsert de `cacheTasks`, no
  `SELECT` de `getCachedTasks` e em `CachedTask`.
- Efeito colateral aceito: tasks já em cache só mostram descrição **depois do
  próximo sync** — que roda ao abrir o app. Nada de migração de dados.

### Por que não markdown

O endpoint devolve texto puro: as descrições reais do board usam "Contexto",
"Passo a passo", "Objetivo" como linhas soltas, sem `#`, `-` ou `**`, e
`markdown_description` não vem nessa resposta. Renderizar com um parser seria
enfeite para sintaxe que não existe no dado. `white-space: pre-wrap` e pronto.

## B. A gaveta

- O **nome da task** é o gatilho. Vira `<button className="task-name">` quando
  `description` não é vazia; continua `<span>` inerte quando é — task sem
  descrição não ganha afordância nem gaveta vazia.
- Estado local `showDesc` no `TaskCard` (não persiste, como os outros painéis).
- Painel `.desc-panel`: eyebrow mono "descrição", corpo `pre-wrap`,
  `max-height: 40vh` com rolagem própria só quando estoura. Sem clamp e sem
  "ler tudo" — um estado a menos; descrição gigante se resolve destacando.
  A rolagem encadeia normal ao chegar no fim, então a lista não trava.
- Borda esquerda no acento (pêra), sem raio nos cantos (regra: raio só com
  borda nos quatro lados).
- `aria-expanded` + `aria-controls` no botão do nome.

### Por que não o duplo clique, nem folha sobreposta

- **Duplo clique** colidiria com o clique simples (gaveta abre e fecha antes da
  janela aparecer), exigiria segurar o clique simples ~250 ms — deixando lerdo o
  caso de 95% —, selecionaria a palavra do título no webview, e não se anuncia
  na tela. Destino bom, atalho errado: o gatilho vira botão explícito.
- **Folha sobreposta** cobriria a lista e exigiria a escala de `z-index` que o
  `CLAUDE.md` ainda lista como não implementada. A janela destacada resolve o
  mesmo problema (descrição longa numa janela de 420 px) sem cobrir nada.

## C. A janela destacada

- Criada no Rust, coerente com o resto (`api.ts` só invoca commands) e sem
  precisar abrir permissão de criar webview para o frontend:

```rust
#[tauri::command]
async fn open_task_window(app: AppHandle, task_id: String, title: String) -> Result<(), String>
```

- Label `task-<id>`; `WebviewUrl::App("index.html?task=<id>")`; 460×720. Se a
  janela já existir, `set_focus()` em vez de abrir uma segunda — o mesmo command
  serve para abrir e para trazer para a frente. O `title` vem do frontend
  (`custom_id` ou nome) porque o Rust não lê o SQLite, que é do lado JS.
- **`capabilities/default.json` passa a listar `["main", "task-*"]`.** Hoje está
  travado em `["main"]`: uma janela com outro label herdaria zero permissões e o
  `plugin-sql` dela falharia calado.
- Roteamento: `main.tsx` lê `?task=` e escolhe entre `<App/>` e `<TaskWindow
  taskId>`. Helper puro `parseTaskParam(search)` para poder testar.
- `TaskWindow.tsx` carrega o cache com os mesmos helpers do `App`
  (`getCachedTasks`, `buildTaskTree`, `getPinnedIds`, `dueReminderSubjectIds`) e
  renderiza **o `TaskCard` inteiro** — status editável, subtasks, anotações,
  perguntar — com a gaveta aberta por padrão. Nenhum componente de detalhe novo:
  é o mesmo cartão, sozinho numa janela.
- Se o id não estiver mais no cache (sync podou a task), a janela mostra um
  aviso pedindo sync na principal, em vez de tela branca.

## D. O estado "destacado"

Enquanto a janela está aberta, o cartão no hub encolhe para **uma linha: o nome
e o rótulo mono `destacado`**. Sem pills, sem meta, sem ações, sem gaveta. Fundo
transparente e borda tracejada, sem sombra — o cartão vira o vazio que a nota
deixou. Clicar nele chama o mesmo `open_task_window`, que foca a janela aberta.

**"Destacado" não é um dado, é uma consequência.** A verdade é o conjunto de
janelas `task-*` abertas, que o Tauri já conhece:

- `#[tauri::command] detached_task_ids() -> Vec<String>` — deriva de
  `app.webview_windows()`, filtrando o prefixo do label. A janela principal
  chama isso ao montar.
- `taskhub:detached` com a lista atualizada é emitido nos dois momentos em que
  ela muda: no fim de `open_task_window` (abriu uma) e no `on_window_event` de
  `Destroyed` de uma janela `task-*` (fechou uma). O `App` escuta e guarda em
  estado.

Nada gravado em disco, nada para dessincronizar, e um crash não deixa fantasma
preso na lista. O `TaskCard` recebe `detachedIds: Set<string>` junto com
`pinnedIds`, no mesmo padrão que já existe.

Consequências que caem de graça:

- Fechar a janela devolve o cartão inteiro.
- A task destacada continua contando nas métricas e nos filtros — só o desenho
  encolhe, o número não mente.
- No "Meu foco" a alça de arraste vive no `FocoItem`, **fora** do `TaskCard`:
  a linha encolhe e continua arrastável.

Efeito colateral aceito: some da lista a pill de atraso e o chip de lembrete
dessa task. Enquanto a janela está na tela ela mostra isso melhor que a pill;
se incomodar (destacar três e minimizar as três deixa o hub quieto sobre elas),
manter só a pill de atraso no fantasma é mudança de uma linha.

## E. Sincronia entre as janelas

O SQLite já é a fonte da verdade de tudo que muda: status grava com
`updateTaskStatusLocal`, pin e anotações também gravam. Então não trafega
payload entre janelas — só um ping:

- Depois de cada escrita (status, rollback de status, pin/unpin, comentário,
  lembrete): `emit("taskhub:changed")`.
- Cada janela escuta e relê do banco o que lhe interessa: a principal recarrega
  tasks, pins e lembretes vencidos; a destacada recarrega a sua task e as notas.
- Handlers de refresh **nunca** emitem — sem loop.
- `core:default` já cobre os eventos; nenhuma permissão nova além do `task-*`.

Risco residual declarado: duas conexões no mesmo arquivo SQLite podem esbarrar
em `database is locked`. As escritas aqui são minúsculas e raras, então na
prática não deve aparecer; se aparecer, o conserto é um retry curto — não vamos
antecipar complexidade por isso.

## Erros e bordas

| Caso | Comportamento |
| --- | --- |
| Task sem descrição | Nome não clicável, nenhuma gaveta |
| Janela já aberta para a task | Foca a existente, não abre outra |
| Task destacada some no sync | Janela avisa; fantasma some da lista sozinho |
| Janela principal fechada com destacadas abertas | App segue vivo nas destacadas (padrão do Tauri) |
| `open_task_window` falha | Erro no cartão, como os outros erros do `TaskCard` |

## Testes

- Rust (`cargo test`): `parse_task` extraindo `description`; caindo para
  `text_content` quando `description` vem vazia; virando `""` quando não vem
  nenhum dos dois. Helper puro do label (`window_label(id)`) e o inverso usado
  por `detached_task_ids`.
- Vitest: `parseTaskParam(search)` (com `?task=`, sem, e com valor vazio) e a
  normalização da descrição (trim, colapsar linhas em branco em excesso).
- `npm run build` limpo (typecheck + vite build) antes de considerar pronto.

## Fora do escopo

- Renderizar markdown (ver §A).
- Editar a descrição — a escrita no ClickUp continua limitada a status.
- Transformar URLs do texto em links clicáveis (dá para fazer depois com o
  `opener`, que já está no projeto).
- Duplo clique como acelerador — fica disponível se o botão não bastar.
- Modo escuro, tray icon, always-on-top: seguem não construídos.

## Critérios de aceite

1. Depois de um sync, clicar no nome de uma task com descrição abre a gaveta
   com o texto; clicar de novo fecha.
2. Task sem descrição não tem nome clicável.
3. "Destacar" abre uma janela com a task inteira e a descrição aberta; o cartão
   no hub vira uma linha com o nome e `destacado`.
4. Clicar no cartão destacado traz a janela para a frente; nunca abre a segunda.
5. Mudar o status na janela destacada aparece no hub sem sync manual, e
   vice-versa.
6. Fechar a janela devolve o cartão completo ao hub.
7. `cargo test`, `npm test` e `npm run build` passam.
