# Descrição da task — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicar no nome de uma task abre uma gaveta com a descrição dela; um botão "destacar" abre a task inteira numa segunda janela e o cartão no hub encolhe para o estado destacado.

**Architecture:** A descrição já vem no sync paginado e é descartada dentro de `raw` — vira coluna própria (migração `0004`). A gaveta é estado local do `TaskCard`. A janela é criada no Rust (`open_task_window`), roteada por `?task=<id>` no `main.tsx`, e renderiza o mesmo `TaskCard`. "Destacado" não é persistido: deriva das janelas `task-*` abertas, empurradas pelo Rust via evento. As janelas se sincronizam por um ping (`taskhub:changed`) + releitura do SQLite, que já é a fonte da verdade.

**Tech Stack:** Tauri 2 (Rust, `WebviewWindowBuilder`, eventos), React 18 + TypeScript, `@tauri-apps/plugin-sql` (SQLite), vitest, cargo test.

Spec: [`../specs/2026-07-29-descricao-task-design.md`](../specs/2026-07-29-descricao-task-design.md)

---

## Contexto que o plano assume

- Branch de trabalho: `descricao-task` (já criado, PR #1 aberto em draft com o spec).
- **PowerShell bloqueia `npm`** — usar `npm.cmd` nos comandos. Em Bash/Git Bash, `npm` funciona.
- Testes: `cd src-tauri && cargo test` (Rust) e `npm.cmd test` (vitest, arquivos `src/*.test.ts` colocados ao lado do fonte).
- **Não rodar `tauri build`.** Release só quando o usuário pedir. Verificação manual é `npm.cmd run tauri dev`.
- Commits em português, terminando com `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## Estrutura de arquivos

| Arquivo | Responsabilidade | Ação |
| --- | --- | --- |
| `src-tauri/migrations/0004_description.sql` | Coluna `description` no cache | Criar |
| `src-tauri/src/clickup.rs` | `TaskDto.description` + extração no `parse_task` | Modificar |
| `src-tauri/src/detach.rs` | Tudo sobre janela destacada: label, lista de abertas, criar/focar, emitir evento | Criar |
| `src-tauri/src/lib.rs` | Migração v4, commands novos, `on_window_event` | Modificar |
| `src-tauri/capabilities/default.json` | Permissões para as janelas `task-*` | Modificar |
| `src/route.ts` | Ler `?task=` da URL (puro, testável) | Criar |
| `src/route.test.ts` | Testes do roteamento | Criar |
| `src/sync.ts` | Ping entre janelas: emitir/escutar, ignorar o próprio | Criar |
| `src/task.ts` | `cleanDescription` (puro) | Modificar |
| `src/task.test.ts` | Testes de `cleanDescription` | Modificar |
| `src/db.ts` | `description` nos tipos/upsert/select + ping após escrita | Modificar |
| `src/api.ts` | Wrappers `openTaskWindow` / `detachedTaskIds` | Modificar |
| `src/TaskCard.tsx` | Gaveta, botão destacar, estado fantasma | Modificar |
| `src/TaskWindow.tsx` | A tela da janela destacada | Criar |
| `src/main.tsx` | Escolhe `<App/>` ou `<TaskWindow/>` | Modificar |
| `src/App.tsx` | Estado `detachedIds`, listeners, repasse da prop | Modificar |
| `src/App.css` | Estilos da gaveta e do fantasma | Modificar |

---

### Task 1: a descrição chega do ClickUp

**Files:**
- Modify: `src-tauri/src/clickup.rs` (struct `TaskDto` em ~83-100, `parse_task` em ~105-132, testes no fim do arquivo)

- [ ] **Step 1: Escrever os testes que falham**

No `mod tests` no fim de `src-tauri/src/clickup.rs`, adicionar:

```rust
    #[test]
    fn parse_task_extrai_a_descricao() {
        let t: serde_json::Value = serde_json::from_str(
            r#"{
              "id": "abc123",
              "name": "Com descrição",
              "status": { "status": "to do", "type": "open" },
              "description": "  Contexto\n\nTestar o fluxo.  ",
              "text_content": "Contexto\n\nTestar o fluxo.",
              "list": { "id": "1", "name": "Backlog" }
            }"#,
        )
        .unwrap();

        let dto = super::parse_task(&t).expect("deve parsear");
        assert_eq!(dto.description, "Contexto\n\nTestar o fluxo.");
    }

    #[test]
    fn parse_task_cai_no_text_content_quando_description_vem_vazia() {
        let t: serde_json::Value = serde_json::from_str(
            r#"{
              "id": "x",
              "name": "Só text_content",
              "status": { "status": "to do" },
              "description": "",
              "text_content": "Objetivo\nTirar o hardcode.",
              "list": { "id": "1", "name": "Backlog" }
            }"#,
        )
        .unwrap();

        let dto = super::parse_task(&t).expect("deve parsear");
        assert_eq!(dto.description, "Objetivo\nTirar o hardcode.");
    }

    #[test]
    fn parse_task_sem_descricao_nenhuma_vira_string_vazia() {
        let t: serde_json::Value = serde_json::from_str(
            r#"{
              "id": "y",
              "name": "Sem nada",
              "status": { "status": "to do" },
              "list": { "id": "1", "name": "Backlog" }
            }"#,
        )
        .unwrap();

        let dto = super::parse_task(&t).expect("deve parsear");
        assert_eq!(dto.description, "");
    }
```

- [ ] **Step 2: Rodar os testes e ver falhar**

```bash
cd src-tauri && cargo test descricao
```

Esperado: erro de compilação — `no field 'description' on type 'TaskDto'`.

- [ ] **Step 3: Adicionar o campo na struct**

Em `TaskDto` (depois de `pub assignees: Vec<i64>,`, antes de `pub raw: String,`):

```rust
    /// Descrição da task. Texto puro: o endpoint nao devolve markdown.
    pub description: String,
```

- [ ] **Step 4: Extrair no `parse_task`**

Dentro de `parse_task`, antes do `Some(TaskDto {`:

```rust
    // `description` e `text_content` sao dois recortes do mesmo texto puro;
    // o primeiro nao-vazio vale. Ausente vira "" (nunca descarta a task).
    let description = ["description", "text_content"]
        .iter()
        .filter_map(|k| t[*k].as_str())
        .map(str::trim)
        .find(|s| !s.is_empty())
        .unwrap_or("")
        .to_string();
```

E no corpo do `Some(TaskDto { … })`, junto dos outros campos:

```rust
        description,
```

- [ ] **Step 5: Rodar os testes e ver passar**

```bash
cd src-tauri && cargo test
```

Esperado: todos passam, incluindo os 3 novos e os 4 que já existiam.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/clickup.rs
git commit -m "Capturar a descrição da task no parse do sync

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: a descrição sobrevive no SQLite

**Files:**
- Create: `src-tauri/migrations/0004_description.sql`
- Modify: `src-tauri/src/lib.rs:128-147` (lista de migrações)
- Modify: `src/db.ts` (`SyncedTask` ~12-25, `CachedTask` ~28-39, `cacheTasks` ~70-107, `getCachedTasks` ~116-121)

Sem teste automatizado: escrita em SQLite não tem harness no projeto (vitest não sobe o plugin). A verificação é `npm.cmd run build` limpo + o roteiro manual da Task 10.

- [ ] **Step 1: Criar a migração**

`src-tauri/migrations/0004_description.sql`:

```sql
-- Descrição da task (texto puro do ClickUp). Ja vinha no payload do sync e
-- era descartada dentro de `raw`. Populado no proximo sync.
ALTER TABLE task_cache ADD COLUMN description TEXT NOT NULL DEFAULT '';
```

- [ ] **Step 2: Registrar a migração**

Em `src-tauri/src/lib.rs`, no fim do `vec![]` de migrações (depois da `version: 3`):

```rust
        Migration {
            version: 4,
            description: "task description column",
            sql: include_str!("../migrations/0004_description.sql"),
            kind: MigrationKind::Up,
        },
```

- [ ] **Step 3: Levar o campo até a UI no `db.ts`**

Em `SyncedTask`, depois de `assignees: number[];`:

```ts
  description: string;
```

Em `CachedTask`, depois de `parent: string | null;`:

```ts
  description: string;
```

Em `cacheTasks`, trocar a lista de colunas, os placeholders, o bloco `DO UPDATE SET` e os valores:

```ts
      `INSERT INTO task_cache
         (id, custom_id, name, status, status_type, priority, list_id, list_name, due_date, parent, assignees, description, raw, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT(id) DO UPDATE SET
         custom_id = excluded.custom_id,
         name      = excluded.name,
         status    = excluded.status,
         status_type = excluded.status_type,
         priority  = excluded.priority,
         list_id   = excluded.list_id,
         list_name = excluded.list_name,
         due_date  = excluded.due_date,
         parent    = excluded.parent,
         assignees = excluded.assignees,
         description = excluded.description,
         raw       = excluded.raw,
         fetched_at = excluded.fetched_at`,
      [
        t.id,
        t.custom_id,
        t.name,
        t.status,
        t.status_type,
        t.priority,
        t.list_id,
        t.list_name,
        t.due_date,
        t.parent,
        JSON.stringify(t.assignees),
        t.description,
        t.raw,
        fetchedAt,
      ],
```

Em `getCachedTasks`, incluir a coluna no `SELECT`:

```ts
    `SELECT id, custom_id, name, status, status_type, priority, list_id, list_name, due_date, parent, description
     FROM task_cache
```

(o resto do `SELECT` — `ORDER BY` etc. — fica como está)

- [ ] **Step 4: Verificar que compila**

```bash
npm.cmd run build
```

Esperado: typecheck e build sem erro.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/migrations/0004_description.sql src-tauri/src/lib.rs src/db.ts
git commit -m "Migração 0004: descrição como coluna do task_cache

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: helpers puros (descrição e rota)

**Files:**
- Modify: `src/task.ts` (fim do arquivo), `src/task.test.ts` (fim do arquivo)
- Create: `src/route.ts`, `src/route.test.ts`

- [ ] **Step 1: Escrever os testes que falham**

No fim de `src/task.test.ts` (o arquivo já usa `import { describe, expect, it } from "vitest"` — conferir e reaproveitar o import existente, adicionando `cleanDescription` à lista importada de `./task`):

```ts
describe("cleanDescription", () => {
  it("tira espaço em branco das pontas", () => {
    expect(cleanDescription("  Contexto  \n")).toBe("Contexto");
  });

  it("preserva parágrafo (uma linha em branco)", () => {
    expect(cleanDescription("Contexto\n\nPasso a passo")).toBe("Contexto\n\nPasso a passo");
  });

  it("colapsa buracos de 3+ linhas em um parágrafo", () => {
    expect(cleanDescription("Contexto\n\n\n\nPasso")).toBe("Contexto\n\nPasso");
  });

  it("normaliza quebra do Windows", () => {
    expect(cleanDescription("a\r\nb")).toBe("a\nb");
  });

  it("string vazia continua vazia", () => {
    expect(cleanDescription("   ")).toBe("");
  });
});
```

`src/route.test.ts` (arquivo novo):

```ts
import { describe, expect, it } from "vitest";
import { parseTaskParam } from "./route";

describe("parseTaskParam", () => {
  it("lê o id quando a janela foi aberta com ?task=", () => {
    expect(parseTaskParam("?task=86abc123")).toBe("86abc123");
  });

  it("devolve null na janela principal (sem query)", () => {
    expect(parseTaskParam("")).toBeNull();
  });

  it("devolve null quando o parâmetro vem vazio", () => {
    expect(parseTaskParam("?task=")).toBeNull();
  });

  it("devolve null quando o parâmetro é só espaço", () => {
    expect(parseTaskParam("?task=%20")).toBeNull();
  });

  it("ignora outros parâmetros", () => {
    expect(parseTaskParam("?foo=1")).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar os testes e ver falhar**

```bash
npm.cmd test
```

Esperado: `route.test.ts` falha em resolver `./route`; `task.test.ts` falha em `cleanDescription is not a function`.

- [ ] **Step 3: Implementar**

No fim de `src/task.ts`:

```ts
/**
 * Descrição pronta pra render: o ClickUp devolve texto puro, então só
 * normaliza quebras do Windows, colapsa buracos de 3+ linhas e tira as pontas.
 */
export function cleanDescription(raw: string): string {
  return raw.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
```

`src/route.ts` (arquivo novo):

```ts
/**
 * Id da task quando a janela foi aberta como `index.html?task=<id>`
 * (janela destacada). `null` na janela principal.
 */
export function parseTaskParam(search: string): string | null {
  const raw = new URLSearchParams(search).get("task");
  const id = raw?.trim() ?? "";
  return id === "" ? null : id;
}
```

- [ ] **Step 4: Rodar os testes e ver passar**

```bash
npm.cmd test
```

Esperado: todos passam (os de sprint/task que já existiam + os 10 novos).

- [ ] **Step 5: Commit**

```bash
git add src/task.ts src/task.test.ts src/route.ts src/route.test.ts
git commit -m "Helpers puros: normalizar descrição e ler ?task= da URL

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: a gaveta no cartão

**Files:**
- Modify: `src/TaskCard.tsx` (imports, `Props`, `.task-main` em ~220-229, JSX depois de `.task-meta` em ~259-261)
- Modify: `src/App.css` (depois do bloco `.task-actions`, ~504-508)

Sem botão "destacar" ainda — ele entra na Task 6, quando a janela existe. Não faz sentido commitar botão que não faz nada.

- [ ] **Step 1: Estado e import no `TaskCard`**

No import de `./task`, adicionar `cleanDescription` à lista.

Em `Props`, adicionar:

```ts
  /** A janela destacada renderiza o cartão sozinho: gaveta já aberta. */
  standalone?: boolean;
```

Na assinatura do componente, adicionar `standalone = false,` junto dos outros parâmetros (antes de `depth = 0,`).

Junto dos outros `useState` do topo:

```tsx
  const hasDesc = task.description.trim() !== "";
  const [showDesc, setShowDesc] = useState(standalone);
  const descId = `desc-${task.id}`;
```

- [ ] **Step 2: O nome vira botão quando há descrição**

Trocar o `<span className="task-name">{task.name}</span>` em `.task-main` por:

```tsx
        {hasDesc ? (
          <button
            className="task-name"
            onClick={() => setShowDesc((v) => !v)}
            aria-expanded={showDesc}
            aria-controls={descId}
            title="Ver descrição"
          >
            {task.name}
          </button>
        ) : (
          <span className="task-name">{task.name}</span>
        )}
```

- [ ] **Step 3: A gaveta**

Logo depois do `<div className="task-meta muted">…</div>` e antes de `<div className="task-actions">`:

```tsx
      {showDesc && hasDesc && (
        <div className="desc-panel" id={descId}>
          <div className="desc-head">
            <span className="eyebrow">descrição</span>
          </div>
          <div className="desc-body">{cleanDescription(task.description)}</div>
        </div>
      )}
```

- [ ] **Step 4: Estilos**

Em `src/App.css`, depois do bloco `.task-actions`:

```css
/* Nome clicável: sublinhado segue o texto, não a caixa do botão */
button.task-name {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  font-weight: 500;
  text-align: left;
  color: inherit;
  cursor: pointer;
  text-decoration: underline dotted var(--accent-deep);
  text-underline-offset: 3px;
}

button.task-name:hover {
  text-decoration-color: var(--ink);
}

/* Gaveta da descrição */
.desc-panel {
  margin-top: 4px;
  padding: 4px 0 4px 10px;
  border-left: 2px solid var(--accent);
  background: var(--paper-2);
}

.desc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.desc-body {
  margin-top: 4px;
  white-space: pre-wrap;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ink-2);
  max-height: 40vh;
  overflow-y: auto;
}
```

- [ ] **Step 5: Verificar**

```bash
npm.cmd run build
```

Esperado: build limpo. (A verificação visual é a Task 10 — `tauri dev` só depois de um sync novo, senão as descrições estão vazias no cache.)

- [ ] **Step 6: Commit**

```bash
git add src/TaskCard.tsx src/App.css
git commit -m "Gaveta da descrição: clicar no nome abre o texto no cartão

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: o lado Rust da janela destacada

**Files:**
- Create: `src-tauri/src/detach.rs`
- Modify: `src-tauri/src/lib.rs` (declaração do módulo, commands, `invoke_handler`, `on_window_event`)
- Modify: `src-tauri/capabilities/default.json`

- [ ] **Step 1: Escrever os testes que falham**

`src-tauri/src/detach.rs` (arquivo novo, só com os testes por enquanto — o `mod tests` no fim):

```rust
#[cfg(test)]
mod tests {
    use super::{task_id_from_label, window_label};

    #[test]
    fn monta_o_label_a_partir_do_id() {
        assert_eq!(window_label("86abc123"), "task-86abc123");
    }

    #[test]
    fn le_o_id_de_volta_do_label() {
        assert_eq!(task_id_from_label("task-86abc123"), Some("86abc123"));
    }

    #[test]
    fn ignora_labels_que_nao_sao_de_task() {
        assert_eq!(task_id_from_label("main"), None);
        assert_eq!(task_id_from_label("task-"), None);
    }
}
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
cd src-tauri && cargo test detach
```

Esperado: erro — módulo `detach` não declarado / funções inexistentes.

- [ ] **Step 3: Implementar o módulo**

No topo de `src-tauri/src/detach.rs`, antes do `mod tests`:

```rust
//! Janela destacada de uma task: label, inventario das abertas e criacao.
//!
//! "Destacado" nao e um dado persistido — e o conjunto de janelas `task-*`
//! abertas, que o Tauri ja conhece. Um crash nao deixa fantasma na lista.

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const PREFIX: &str = "task-";

/// Label da janela destacada de uma task.
pub fn window_label(task_id: &str) -> String {
    format!("{PREFIX}{task_id}")
}

/// Id da task quando o label e de uma janela destacada; None para as outras.
pub fn task_id_from_label(label: &str) -> Option<&str> {
    label.strip_prefix(PREFIX).filter(|id| !id.is_empty())
}

/// Ids das tasks com janela aberta agora. `skip` tira um label do resultado —
/// o evento `Destroyed` pode disparar antes de a janela sair do mapa.
pub fn detached_ids(app: &AppHandle, skip: Option<&str>) -> Vec<String> {
    let mut ids: Vec<String> = app
        .webview_windows()
        .keys()
        .filter(|label| Some(label.as_str()) != skip)
        .filter_map(|label| task_id_from_label(label).map(str::to_string))
        .collect();
    ids.sort();
    ids
}

/// Empurra a lista atualizada pra todas as janelas.
pub fn emit_detached(app: &AppHandle, skip: Option<&str>) {
    let _ = app.emit("taskhub:detached", detached_ids(app, skip));
}

/// Abre a janela da task; se ja existir, so foca (nunca duas pra mesma task).
pub async fn open(app: AppHandle, task_id: String, title: String) -> Result<(), String> {
    let label = window_label(&task_id);

    if let Some(existing) = app.get_webview_window(&label) {
        return existing
            .set_focus()
            .map_err(|e| format!("Nao consegui focar a janela da task: {e}"));
    }

    let url = format!("index.html?task={task_id}");
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(460.0, 720.0)
        .min_inner_size(380.0, 400.0)
        .build()
        .map_err(|e| format!("Nao consegui abrir a janela da task: {e}"))?;

    emit_detached(&app, None);
    Ok(())
}
```

- [ ] **Step 4: Ligar no `lib.rs`**

Junto das outras declarações de módulo no topo:

```rust
mod detach;
```

Junto dos outros commands (depois de `ask_task`):

```rust
// --- Janela destacada ------------------------------------------------------

#[tauri::command]
async fn open_task_window(
    app: tauri::AppHandle,
    task_id: String,
    title: String,
) -> Result<(), String> {
    detach::open(app, task_id, title).await
}

#[tauri::command]
fn detached_task_ids(app: tauri::AppHandle) -> Vec<String> {
    detach::detached_ids(&app, None)
}
```

No `invoke_handler![…]`, adicionar depois de `ask_task`:

```rust
            ask_task,
            open_task_window,
            detached_task_ids
```

E no builder, entre `.plugin(tauri_plugin_opener::init())` e `.invoke_handler(…)`:

```rust
        .on_window_event(|window, event| {
            // Fechou uma janela de task: a lista de destacadas mudou.
            if matches!(event, tauri::WindowEvent::Destroyed)
                && detach::task_id_from_label(window.label()).is_some()
            {
                detach::emit_detached(window.app_handle(), Some(window.label()));
            }
        })
```

- [ ] **Step 5: Abrir a capability para as janelas novas**

`src-tauri/capabilities/default.json` — trocar a linha `"windows": ["main"],` por:

```json
  "windows": ["main", "task-*"],
```

Sem isso a janela destacada nasce sem permissão nenhuma e o `plugin-sql` dela falha calado.

- [ ] **Step 6: Rodar os testes e ver passar**

```bash
cd src-tauri && cargo test
```

Esperado: todos passam, incluindo os 3 de `detach`.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/detach.rs src-tauri/src/lib.rs src-tauri/capabilities/default.json
git commit -m "Command para abrir (ou focar) a janela destacada de uma task

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: a janela destacada no frontend

**Files:**
- Modify: `src/api.ts` (fim do arquivo)
- Create: `src/TaskWindow.tsx`
- Modify: `src/main.tsx`
- Modify: `src/TaskCard.tsx` (botão "destacar" na `.desc-head`)

- [ ] **Step 1: Wrappers no `api.ts`**

No fim de `src/api.ts`:

```ts
// --- Janela destacada -----------------------------------------------------

/** Abre a janela da task; se já estiver aberta, traz pra frente. */
export const openTaskWindow = (taskId: string, title: string) =>
  invoke<void>("open_task_window", { taskId, title });

/** Ids das tasks que estão com janela destacada aberta agora. */
export const detachedTaskIds = () => invoke<string[]>("detached_task_ids");
```

- [ ] **Step 2: Botão "destacar" na gaveta**

Em `src/TaskCard.tsx`, adicionar `openTaskWindow` ao import de `./api`.

Junto das outras funções do componente:

```tsx
  // Título da janela destacada: o que aparece na barra de tarefas.
  async function detach() {
    try {
      await openTaskWindow(task.id, `${task.custom_id ?? task.id} · ${task.name}`);
    } catch (e) {
      setStatusError(String(e));
    }
  }
```

E dentro da `.desc-head`, depois do `<span className="eyebrow">descrição</span>`:

```tsx
            {!standalone && (
              <button className="link desc-detach" onClick={detach}>
                destacar
              </button>
            )}
```

Em `src/App.css`, junto dos estilos da gaveta:

```css
/* Texto clicável nunca quebra linha (responsive.md) */
.desc-detach {
  white-space: nowrap;
}
```

- [ ] **Step 3: A tela da janela**

`src/TaskWindow.tsx` (arquivo novo):

```tsx
import { useCallback, useEffect, useState } from "react";
import {
  dueReminderSubjectIds,
  getCachedTasks,
  getPinnedIds,
  pinTask,
  unpinTask,
  updateTaskStatusLocal,
  type CachedTask,
} from "./db";
import { onChanged } from "./sync";
import { buildTaskTree } from "./task";
import TaskCard from "./TaskCard";
import "./App.css";

/** Nada é fantasma dentro da própria janela destacada. */
const NONE: Set<string> = new Set();

/**
 * A janela aberta por "destacar": o mesmo `TaskCard` do hub, sozinho, com a
 * gaveta já aberta. Lê o mesmo SQLite e se atualiza pelo ping das outras.
 */
function TaskWindow({ taskId }: { taskId: string }) {
  const [tasks, setTasks] = useState<CachedTask[] | null>(null);
  const [dueIds, setDueIds] = useState<Set<string>>(new Set());
  const [pinnedOrder, setPinnedOrder] = useState<string[]>([]);

  const reload = useCallback(async () => {
    const [rows, due, pinned] = await Promise.all([
      getCachedTasks(),
      dueReminderSubjectIds(Date.now()),
      getPinnedIds(),
    ]);
    setTasks(rows);
    setDueIds(due);
    setPinnedOrder(pinned);
  }, []);

  useEffect(() => {
    reload().catch(() => setTasks([]));
  }, [reload]);

  // Outra janela escreveu no banco: relê.
  useEffect(() => {
    const un = onChanged(() => {
      reload().catch(() => {});
    });
    return () => {
      un.then((off) => off()).catch(() => {});
    };
  }, [reload]);

  async function handleTogglePin(id: string) {
    if (pinnedOrder.includes(id)) await unpinTask(id);
    else await pinTask(id);
    setPinnedOrder(await getPinnedIds());
  }

  // Otimista: estado + cache local, igual ao hub. No rollback vem o valor antigo.
  async function handleStatusChanged(id: string, status: string, statusType: string) {
    setTasks((ts) =>
      (ts ?? []).map((t) => (t.id === id ? { ...t, status, status_type: statusType } : t)),
    );
    await updateTaskStatusLocal(id, status, statusType);
  }

  if (tasks === null) {
    return (
      <div className="app">
        <p className="muted">carregando…</p>
      </div>
    );
  }

  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    return (
      <div className="app">
        <p className="muted">
          Essa task não está mais no cache local. Sincronize na janela principal.
        </p>
      </div>
    );
  }

  const tree = buildTaskTree(tasks);

  return (
    <div className="app">
      <TaskCard
        task={task}
        getChildren={(id) => tree.childrenByParent.get(id) ?? []}
        dueIds={dueIds}
        onRemindersChanged={() => {
          reload().catch(() => {});
        }}
        pinnedIds={new Set(pinnedOrder)}
        onTogglePin={handleTogglePin}
        onStatusChanged={handleStatusChanged}
        detachedIds={NONE}
        standalone
      />
    </div>
  );
}

export default TaskWindow;
```

- [ ] **Step 4: Rotear no `main.tsx`**

Substituir o conteúdo de `src/main.tsx` por:

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/plus-jakarta-sans";
import "@fontsource-variable/jetbrains-mono";
import App from "./App";
import TaskWindow from "./TaskWindow";
import { parseTaskParam } from "./route";

// `index.html?task=<id>` = janela destacada; sem isso, o hub.
const taskId = parseTaskParam(window.location.search);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {taskId ? <TaskWindow taskId={taskId} /> : <App />}
  </React.StrictMode>,
);
```

- [ ] **Step 5: Verificar**

```bash
npm.cmd run build
```

Esperado: **falha** de typecheck em `detachedIds` (prop ainda não existe no `TaskCard`) e em `./sync` (módulo ainda não existe). Isso é esperado — a Task 7 fecha os dois. Se quiser um commit verde aqui, faça a Task 7 antes de commitar.

- [ ] **Step 6: Commit (junto com a Task 7)**

Este passo não commita sozinho: `TaskWindow.tsx` depende de `src/sync.ts` e da prop `detachedIds`, ambos na Task 7. Siga direto.

---

### Task 7: sincronia entre janelas e o estado fantasma

**Files:**
- Create: `src/sync.ts`
- Modify: `src/db.ts` (ping nas funções de escrita)
- Modify: `src/TaskCard.tsx` (`Props.detachedIds` + render do fantasma + repasse na recursão)
- Modify: `src/App.tsx` (estado, listeners, repasse nos 3 pontos que renderizam `TaskCard`)
- Modify: `src/App.css` (estilos do fantasma)

- [ ] **Step 1: O módulo de ping**

`src/sync.ts` (arquivo novo):

```ts
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

const CHANGED = "taskhub:changed";
const DETACHED = "taskhub:detached";

function selfLabel(): string {
  return getCurrentWindow().label;
}

/**
 * Avisa as outras janelas que o SQLite local mudou. Sem payload de dados: o
 * banco é a fonte da verdade, cada janela relê o que lhe interessa.
 * Fire-and-forget — nenhuma escrita espera o ping.
 */
export function notifyChanged(): void {
  emit(CHANGED, { from: selfLabel() }).catch(() => {});
}

/** Roda `handler` quando OUTRA janela escreve no banco (ignora o próprio ping). */
export function onChanged(handler: () => void): Promise<UnlistenFn> {
  const self = selfLabel();
  return listen<{ from: string }>(CHANGED, (e) => {
    if (e.payload?.from !== self) handler();
  });
}

/** Lista de tasks com janela destacada aberta, empurrada pelo Rust. */
export function onDetached(handler: (ids: string[]) => void): Promise<UnlistenFn> {
  return listen<string[]>(DETACHED, (e) => handler(e.payload ?? []));
}
```

- [ ] **Step 2: Pingar depois de cada escrita**

Em `src/db.ts`, adicionar ao topo:

```ts
import { notifyChanged } from "./sync";
```

E chamar `notifyChanged();` como **última linha** destas funções: `cacheTasks`, `clearTasks`, `updateTaskStatusLocal`, `pinTask`, `unpinTask`, `setFocusOrder`, `addComment`, `deleteComment`, `addReminder`, `deleteReminder`, `dismissReminder`.

Exemplo (`updateTaskStatusLocal`):

```ts
export async function updateTaskStatusLocal(
  taskId: string,
  status: string,
  statusType: string,
): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE task_cache SET status = $2, status_type = $3 WHERE id = $1", [
    taskId,
    status,
    statusType,
  ]);
  notifyChanged();
}
```

Não pingar em `pruneStale` (sempre roda colada em `cacheTasks`, que já pinga) nem em `cacheListStatuses` (cache de statuses não muda nada visível).

- [ ] **Step 3: Fantasma no `TaskCard`**

Em `Props`, adicionar:

```ts
  /** Tasks com janela destacada aberta: o cartão delas encolhe. */
  detachedIds: Set<string>;
```

Na assinatura do componente, adicionar `detachedIds,` junto das outras props.

Logo **antes** do `return (` principal (depois de todos os hooks e do `const children = getChildren(task.id);`, para nunca chamar hook condicionalmente):

```tsx
  // Destacada: o cartão vira o vazio que a nota deixou. Clicar traz a janela.
  if (detachedIds.has(task.id) && !standalone) {
    return (
      <div className="task-card task-ghost" style={{ marginLeft: depth ? 16 : 0 }}>
        <button className="ghost-name" onClick={detach} title="Trazer a janela pra frente">
          {task.name}
        </button>
        <span className="eyebrow">destacado</span>
      </div>
    );
  }
```

E na chamada recursiva das subtasks, repassar a prop (junto de `pinnedIds`):

```tsx
              detachedIds={detachedIds}
```

- [ ] **Step 4: Estilos do fantasma**

Em `src/App.css`, depois dos estilos da gaveta:

```css
/* Task destacada: sem relevo, é o buraco que a nota deixou */
.task-ghost {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 13px;
  background: transparent;
  border: 1px dashed var(--rule-2);
  box-shadow: none;
}

.ghost-name {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: var(--ink-2);
  text-align: left;
  cursor: pointer;
  min-width: 0;
}

.ghost-name:hover {
  background: none;
  color: var(--ink);
}
```

- [ ] **Step 5: Ligar no `App.tsx`**

No import de `./api`, adicionar `detachedTaskIds`. Adicionar o import novo:

```tsx
import { onChanged, onDetached } from "./sync";
```

Junto dos outros estados (perto de `dueIds`):

```tsx
  const [detachedIds, setDetachedIds] = useState<Set<string>>(new Set());
```

Em `reloadCache`, adicionar a linha das fixadas no fim (para o ping de pin de outra janela também chegar):

```tsx
    setPinnedOrder(await getPinnedIds());
```

Um `useEffect` novo, depois do que carrega o cache:

```tsx
  // Janelas destacadas + ping de escrita das outras janelas.
  useEffect(() => {
    detachedTaskIds()
      .then((ids) => setDetachedIds(new Set(ids)))
      .catch(() => {});

    const offs = [
      onDetached((ids) => setDetachedIds(new Set(ids))),
      onChanged(() => {
        reloadCache().catch(() => {});
      }),
    ];

    return () => {
      for (const off of offs) off.then((f) => f()).catch(() => {});
    };
  }, []);
```

E passar `detachedIds={detachedIds}` nos **três** pontos que renderizam `<TaskCard>` (foco, lista `tudo`, lista filtrada).

- [ ] **Step 6: Verificar**

```bash
npm.cmd run build && npm.cmd test
```

Esperado: build limpo e todos os testes passando.

- [ ] **Step 7: Commit**

```bash
git add src/sync.ts src/db.ts src/api.ts src/TaskCard.tsx src/TaskWindow.tsx src/main.tsx src/App.tsx src/App.css
git commit -m "Janela destacada: TaskCard sozinho, estado fantasma e ping entre janelas

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: verificação de ponta a ponta

**Files:** nenhum (só se algum passo reprovar)

- [ ] **Step 1: Suíte completa**

```bash
cd src-tauri && cargo test
```

Esperado: verde, 10 testes (7 antigos + 3 de `detach`).

```bash
npm.cmd test && npm.cmd run build
```

Esperado: verde, e build sem erro de typecheck.

- [ ] **Step 2: Roteiro manual no app**

```bash
npm.cmd run tauri dev
```

Conferir, nesta ordem (o primeiro passo é obrigatório: sem sync novo as descrições estão vazias no cache):

1. Clicar em "↻ Sincronizar". As tasks recarregam sem erro.
2. Uma task com descrição tem o nome sublinhado pontilhado; clicar abre a gaveta com o texto; clicar de novo fecha.
3. Uma task sem descrição **não** tem nome clicável.
4. Numa descrição longa, a gaveta para de crescer e ganha rolagem própria; a lista continua rolando quando a gaveta chega ao fim.
5. "destacar" abre a janela nova com a task inteira e a gaveta aberta.
6. O cartão no hub virou uma linha: nome + `destacado`, tracejado e sem sombra.
7. Clicar no cartão fantasma traz a janela pra frente — não abre uma segunda.
8. Mudar o status na janela destacada: o hub reflete sem sync manual (o cartão está fantasma, então confirme fechando a janela).
9. Fechar a janela: o cartão volta inteiro, com pills e ações.
10. Fixar a task no foco e destacar: a linha fantasma continua arrastável pela alça.
11. Anotar um comentário na janela destacada e abrir "minhas anotações" no hub: o comentário está lá.

- [ ] **Step 3: Empurrar pro PR**

```bash
git push
```

Esperado: os commits aparecem no PR #1.

- [ ] **Step 4: Relatar**

Reportar ao usuário o que passou e o que não passou no roteiro manual, com o output real. Só então perguntar se ele quer tirar o PR de draft.

---

## Fora deste plano

Do spec, continuam fora: renderizar markdown, editar a descrição, links clicáveis no texto, duplo clique como acelerador, modo escuro, tray icon e `tauri build` (release só quando o usuário pedir).
