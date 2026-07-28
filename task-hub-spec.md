# Spec: Task Hub

App desktop de notas autoadesivas com integração ClickUp. Substitui a varredura manual de tarefas espalhadas em múltiplas listas por uma view única, priorizada localmente, com escrita de volta no ClickUp.

## Contexto do usuário

- Assignee ClickUp: `87383082` (Gabriel Sena Silva)
- Volume real medido: 76 tasks atribuídas, ~35 abertas, distribuídas em 9 listas
- Sistema operacional alvo: Linux Mint (primário) e Windows (secundário)

## Stack

| Camada | Escolha | Por quê |
|---|---|---|
| Shell | Tauri 2.x | Janela always-on-top sem borda, binário ~10MB, keyring nativo |
| Frontend | React 18 + TypeScript + Vite | Ecossistema conhecido pelo usuário |
| Estado local | SQLite via `tauri-plugin-sql` | Notas locais e ordem de foco precisam sobreviver a restart |
| Credenciais | `keyring` crate via command Rust | Token nunca em arquivo de config ou localStorage |
| HTTP | `reqwest` no lado Rust | Evita CORS; o frontend chama commands Tauri |

Regra dura: **nenhuma chamada HTTP direto do frontend.** Todo request externo passa por `#[tauri::command]` no Rust. Isso resolve CORS e mantém o token fora do contexto JS.

## Fase 1: hub de leitura + escrita mínima

Escopo fechado. Não implementar GitHub, Slack ou perguntas em linguagem natural nesta fase.

### 1.1 Camada ClickUp

Antes de implementar, validar os contratos abaixo contra `https://developer.clickup.com/reference` — a spec foi escrita com base em API v2 e endpoints podem ter mudado.

Autenticação: header `Authorization: <personal_token>`. Token pessoal começa com `pk_`. **Não** usar prefixo `Bearer`.

```
GET  /api/v2/team
     → descobrir team_id (workspace). Rodar uma vez, cachear em SQLite.

GET  /api/v2/team/{team_id}/task
     ?assignees[]=87383082
     &include_closed=false
     &subtasks=true
     &page=0
     → 100 tasks por página. Paginar até retornar array vazio.
     → NÃO usar GET /list/{id}/task: só cobre uma lista.

GET  /api/v2/list/{list_id}
     → retorna array `statuses`, cada um com { status, type, orderindex }
     → `type` assume: open | custom | closed | done
     → obrigatório para resolver "marcar como feito". Ver 1.3.

PUT  /api/v2/task/{task_id}
     body: { status?: string, priority?: 1|2|3|4|null, due_date?: number }
     → priority: 1=urgent, 2=high, 3=normal, 4=low
     → due_date em epoch milissegundos
```

Rate limit: assumir 100 req/min por token. Implementar:
- Um único fetch paginado no refresh, nunca um request por task
- Cache em SQLite com TTL de 5 minutos
- Backoff exponencial em HTTP 429, lendo o header `Retry-After` quando presente
- Refresh manual explícito (botão) além do automático

### 1.2 Sprint é o nome da List, não um campo

Não existe campo `sprint` na API. Sprint é derivado de `task.list.name`.

Listas reais medidas no workspace:

| List ID | Nome | Tipo derivado |
|---|---|---|
| `901114167268` | Revenue Sprint 8 (7/21 - 8/3) | sprint 8 |
| `901114167368` | Upstream 2.0 | não-sprint |
| `901113757111` | Backlog | não-sprint |
| `901112030747` | Delivery | não-sprint |
| `901114106757` | Revenue Sprint 7 (7/14 - 7/20) | sprint 7 |
| `901114071577` | Revenue Sprint 6 (7/7 - 7/13) | sprint 6 |
| `901114030579` | Revenue Sprint 5 (6/30 - 7/6) | sprint 5 |
| `901113994454` | Revenue Sprint 4 (6/23 - 6/29) | sprint 4 |
| `901113919086` | Revenue Sprint 2 (6/9 - 6/15) | sprint 2 |
| `901113896647` | Revenue Sprint 1 (6/2 - 6/8) | sprint 1 |

Parser:

```ts
const SPRINT_RE = /Sprint\s+(\d+)\s*\((\d{1,2}\/\d{1,2})\s*-\s*(\d{1,2}\/\d{1,2})\)/i;

type ListMeta =
  | { kind: "sprint"; number: number; startsAt: Date; endsAt: Date }
  | { kind: "other" };
```

Requisitos do parser:
- Match falho retorna `{ kind: "other" }`. Nunca lançar exceção nem descartar a task.
- As datas no nome não têm ano. Inferir: se a data resultante ficar mais de 6 meses no futuro em relação a hoje, subtrair um ano.
- Não hardcodar os IDs da tabela acima em lógica de negócio. A tabela é referência para teste; em runtime derivar tudo de `task.list`.

### 1.3 Resolução de status (o ponto mais frágil)

Statuses medidos em uso no workspace: `to do`, `in progress`, `testing`, `validação`, `a refinar`, `prioritized`, `backlog`, `com blocker`, `concluída`, `complete`.

São 10 variações, e cada List define seu próprio conjunto. Existem **duas** grafias distintas de concluído (`concluída` e `complete`) em listas diferentes.

Portanto, para marcar uma task como feita:

1. Ler os statuses da List da task via `GET /api/v2/list/{list_id}` (cachear por list, TTL longo, ~1h)
2. Encontrar o status com `type === "done"`; se ausente, cair para `type === "closed"`
3. Enviar exatamente a string `status` retornada pela API, preservando acento e caixa
4. Se nenhum status done/closed existir na list, não enviar o PUT. Mostrar erro acionável ao usuário nomeando a list

Proibido: hardcodar `"concluída"`, `"complete"` ou qualquer string de status literal em `PUT`.

Mapa de status para cor na UI (apenas apresentação, pode ser hardcoded):

```ts
const STATUS_ROLE: Record<string, "danger" | "accent" | "warning" | "neutral"> = {
  "com blocker": "danger",
  "in progress": "accent",
  "validação": "accent",
  "prioritized": "accent",
  "testing": "warning",
  "a refinar": "warning",
  "to do": "neutral",
  "backlog": "neutral",
};
```

Status desconhecido cai em `neutral`. Nunca quebrar a renderização por status novo.

### 1.4 Prioridade: o campo do ClickUp está vazio

Medição: 11 de 76 tasks têm `priority` preenchida. As outras 65 vêm `null`.

Consequência de design: **ordenar por `priority` do ClickUp não funciona.** A ordenação primária do hub é uma ordem manual local, persistida em SQLite, que nunca é escrita de volta no ClickUp.

Justificativa de não sincronizar a ordem: o `orderindex` do ClickUp não é settável de forma confiável pela API pública, e a ordem de foco é pessoal do usuário, não do time. Escrever isso de volta mexeria numa view compartilhada.

O que **é** escrito de volta: apenas `status`, `priority` e `due_date`, sempre por ação explícita do usuário.

### 1.5 Modelo de dados

```sql
CREATE TABLE task_cache (
  id            TEXT PRIMARY KEY,
  custom_id     TEXT,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL,
  priority      INTEGER,
  list_id       TEXT NOT NULL,
  list_name     TEXT NOT NULL,
  due_date      INTEGER,
  assignees     TEXT NOT NULL,
  raw           TEXT NOT NULL,
  fetched_at    INTEGER NOT NULL
);

CREATE TABLE list_status_cache (
  list_id     TEXT PRIMARY KEY,
  statuses    TEXT NOT NULL,
  fetched_at  INTEGER NOT NULL
);

CREATE TABLE focus (
  task_id     TEXT PRIMARY KEY,
  position    INTEGER NOT NULL,
  pinned_at   INTEGER NOT NULL
);

CREATE TABLE note (
  id          TEXT PRIMARY KEY,
  body        TEXT NOT NULL,
  done        INTEGER NOT NULL DEFAULT 0,
  position    INTEGER,
  created_at  INTEGER NOT NULL,
  promoted_to TEXT
);
```

`note` cobre o caso "responder fulano": item que não merece uma task no ClickUp. Campo `promoted_to` guarda o task_id caso o usuário promova a nota para task real, evitando duplicata.

`task_cache.raw` guarda o JSON completo da task. Permite adicionar campos derivados depois sem refetch.

### 1.6 Derivações computadas no frontend

Nunca persistir estes valores; recalcular a cada render:

```ts
isLate      = due_date !== null && due_date < startOfToday()
isBlocked   = status.toLowerCase().includes("blocker")
isStale     = list é sprint && sprint.endsAt < hoje && status não é done
```

`isStale` é o sinal mais valioso e não existe em nenhuma view nativa do ClickUp: task aberta numa sprint que já fechou. Na medição inicial havia uma task em `validação` na Sprint 2 (fechou 15/06) ainda aberta em 28/07.

### 1.7 Interface

Layout em coluna única, largura ~420px, janela always-on-top sem decoração.

Ordem vertical:

1. Barra de métricas: abertas, atrasadas, travadas, esquecidas (`isStale`)
2. Chips de filtro: tudo, sprint atual, cada não-sprint, atrasadas, travadas, esquecidas. Filtro único selecionado, não múltiplo
3. Seção "meu foco": itens fixados, ordem manual arrastável, numerados
4. Seção "fila": notas locais primeiro, depois tasks filtradas

Cada card mostra: título, pill de status, pill de prioridade quando urgent/high, pill de atraso com a data, e em texto fraco o `custom_id || id` e o nome da list.

Interações:
- Fixar/desfixar (move entre foco e fila)
- Arrastar para reordenar dentro do foco
- Marcar como feito (dispara o fluxo de 1.3, com estado otimista e rollback em falha)
- Criar nota local
- Promover nota para task ClickUp

Sem tela de configuração além de um campo de token e um seletor de workspace.

### 1.8 Critérios de aceite da Fase 1

- [ ] Refresh completo traz todas as tasks abertas paginando corretamente, sem estourar rate limit
- [ ] Uma list renomeada fora do padrão de sprint não quebra o app; a task aparece em "outros"
- [ ] Marcar como feito funciona tanto numa list que usa `concluída` quanto numa que usa `complete`, sem código específico para cada
- [ ] Ordem manual do foco sobrevive a restart do app
- [ ] Nenhuma escrita no ClickUp acontece sem ação explícita do usuário
- [ ] Token não aparece em nenhum arquivo em disco fora do keyring, nem em log
- [ ] App abre offline e mostra o cache com indicador de dado obsoleto

## Fase 2: verificação via Claude

Só começar depois da Fase 1 aceita.

Objetivo: campo de pergunta em linguagem natural por task ("essa PR já subiu?") que consulta fontes externas e propõe uma ação.

Arquitetura: **custom tools, não MCP remoto.** MCP remoto exigiria implementar OAuth completo com callback local, refresh e revogação por provedor. Com tokens estáticos e custom tools o custo cai para algumas funções de fetch.

Chamada à API Anthropic feita do lado Rust, com o token da Anthropic no keyring.

Tools a declarar:

```
clickup_get_task(task_id)        → status, assignees, due_date, comentários recentes
github_search_prs(repo, query)   → state, merged_at, review_decision
slack_search(query, channel)     → mensagens recentes que casem
```

Formato de resposta obrigatório (system prompt força JSON puro, sem markdown fence):

```json
{
  "resposta": "texto curto para o usuário",
  "acao": "marcar_feito" | "mudar_status" | "nada",
  "status_alvo": "string ou null",
  "evidencia": "o que sustenta a conclusão",
  "confianca": "alta" | "media" | "baixa"
}
```

Regras de segurança da Fase 2:

- `acao` nunca é aplicada automaticamente. Sempre renderizar como sugestão com botão de confirmar
- `confianca: "baixa"` não oferece botão de ação, só mostra a resposta
- A `evidencia` é obrigatória e sempre visível antes do usuário confirmar
- Se o modelo não retornar JSON válido, mostrar o texto cru e não oferecer ação

Ordem das integrações: GitHub primeiro (PRs têm estado binário e verificável), Slack por último (verificar "respondi o fulano?" é ambíguo e propenso a falso positivo).

## Armadilhas a evitar

1. Hardcodar strings de status em escrita. Ver 1.3
2. Ordenar por `priority` do ClickUp. Está vazio em 85% das tasks
3. Usar `GET /list/{id}/task`. Só cobre uma lista, e o usuário tem 9
4. Um request por task para resolver algo. Rate limit de 100/min
5. Escrever a ordem manual de volta no ClickUp. Mexe em view compartilhada
6. Deixar as notas locais virarem uma lista paralela às tasks. O caminho de promoção para ClickUp precisa ser óbvio, senão as duas bases dessincronizam e o app é abandonado
7. Token em arquivo de config, `.env` comitado ou localStorage
8. Aplicar ação sugerida pela IA sem confirmação

## Entregáveis por etapa

Etapa A: projeto Tauri inicializado, command de keyring funcionando, tela de token, `GET /api/v2/team` retornando workspace.

Etapa B: sync completo com paginação, SQLite populado, parser de sprint com testes unitários cobrindo nome fora do padrão e virada de ano.

Etapa C: UI de leitura com filtros e métricas, sem escrita.

Etapa D: foco com ordem manual persistida, notas locais, promoção de nota para task.

Etapa E: escrita de status com resolução dinâmica, estado otimista, rollback.

Etapa F: janela always-on-top, tray icon, build para Linux e Windows.
