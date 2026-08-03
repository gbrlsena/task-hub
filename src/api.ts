import { invoke } from "@tauri-apps/api/core";
import type { Bug } from "./bug";
import {
  cacheListStatuses,
  getCachedListStatuses,
  type StatusDef,
  type SyncedTask,
} from "./db";

/** Workspace do ClickUp (a API chama de "team"). */
export interface Team {
  id: string;
  name: string;
  color?: string | null;
  avatar?: string | null;
}

/** Folder do ClickUp — o "board" de onde vêm as tasks. */
export interface FolderRef {
  id: string;
  name: string;
  space_name?: string | null;
}

/** Ha um token salvo no cofre nativo? */
export const tokenStatus = () => invoke<boolean>("token_status");

/** Salva o token pessoal (`pk_...`) no cofre. Valida o prefixo no lado Rust. */
export const saveToken = (token: string) =>
  invoke<void>("save_clickup_token", { token });

/** Remove o token salvo. */
export const clearToken = () => invoke<void>("clear_clickup_token");

/** GET /api/v2/team usando o token do cofre. */
export const getTeams = () => invoke<Team[]>("get_teams");

/** Resolve o folder escolhido (id → nome) para exibir o board. */
export const getFolder = (folderId: string) =>
  invoke<FolderRef>("get_folder", { folderId });

/** Sync paginado das tasks abertas do usuário dentro do folder (lado Rust). */
export const syncOpenTasks = (folderId: string) =>
  invoke<SyncedTask[]>("sync_open_tasks", { folderId });

/** Grava o status da task no ClickUp (ação explícita). */
export const setTaskStatus = (taskId: string, status: string) =>
  invoke<void>("set_task_status", { taskId, status });

/** Statuses da list, servidos do cache local (TTL 1h) ou buscados no ClickUp. */
export async function loadListStatuses(listId: string): Promise<StatusDef[]> {
  const cached = await getCachedListStatuses(listId);
  if (cached) return cached;
  const fresh = await invoke<StatusDef[]>("get_list_statuses", { listId });
  await cacheListStatuses(listId, fresh);
  return fresh;
}

// --- Fase 2: verificação via Claude --------------------------------------

export interface AskResult {
  valid: boolean;
  resposta: string;
  acao: "marcar_feito" | "mudar_status" | "nada" | string;
  status_alvo: string | null;
  evidencia: string;
  confianca: "alta" | "media" | "baixa" | string;
  raw: string;
}

export const anthropicStatus = () => invoke<boolean>("anthropic_status");
export const saveAnthropicKey = (key: string) => invoke<void>("save_anthropic_key", { key });
export const clearAnthropicKey = () => invoke<void>("clear_anthropic_key");

export const githubStatus = () => invoke<boolean>("github_status");
export const saveGithubToken = (token: string) => invoke<void>("save_github_token", { token });
export const clearGithubToken = () => invoke<void>("clear_github_token");

// --- Slack: fila de bugs --------------------------------------------------

/**
 * Resumo de um campo da List. `key` e `column_id` são identificadores opacos
 * (`Col0…`) e diferentes entre si; `tipos` e `valores` são o que revela qual
 * coluna é responsável, status ou prioridade.
 */
export interface SlackFieldProbe {
  key: string;
  column_id: string;
  tipos: string[];
  valores: Record<string, unknown>;
}

export interface SlackDiagnosis {
  auth: { user_id: string; user: string; team: string };
  itens_na_pagina: number;
  tem_proxima_pagina: boolean;
  campos: SlackFieldProbe[];
  amostra_crua: unknown[];
}

export const slackStatus = () => invoke<boolean>("slack_status");
export const saveSlackToken = (token: string) => invoke<void>("save_slack_token", { token });
export const clearSlackToken = () => invoke<void>("clear_slack_token");

/**
 * Sonda a List de bugs: quem é o dono do token e quais campos os registros
 * trazem. Andaime da fase de mapeamento — sai quando o cartão existir.
 */
export const slackDiagnose = (list: string) =>
  invoke<SlackDiagnosis>("slack_diagnose", { list });

/** Uma coluna da List, nomeada pelo `list_metadata.schema`. */
export interface SlackColumn {
  key: string;
  id: string;
  nome: string;
  /** `text`, `select`, `user`, `date`, `attachment`… */
  tipo: string;
  primaria: boolean;
  /** `Opt…` → rótulo. Vazio em colunas que não são select. */
  opcoes: Record<string, string>;
  /** Cru, porque a forma de `options` não é documentada. */
  options_bruto: unknown;
}

export interface SlackSchema {
  colunas: SlackColumn[];
  /** `key` da coluna de status, lida do agrupamento da view padrão. */
  coluna_de_status: string;
  linhas: number | null;
  arquivadas: number | null;
}

/** Nomes das colunas e rótulos dos select, via `files.info`. */
export const slackSchema = (list: string) => invoke<SlackSchema>("slack_schema", { list });

/** Uma opção da coluna de status, para montar o menu. */
export interface BugStatusOption {
  id: string;
  rotulo: string;
}

export interface BugSync {
  /** Seu `user_id` no Slack — quem o filtro de Responsável usou. */
  eu: string;
  bugs: Bug[];
  paginas: number;
  /** Colunas essenciais que o schema não resolveu (a UI avisa em vez de calar). */
  colunas_faltando: string[];
  /** `false` quando falta `users:read` e o autor fica como id. */
  nomes_resolvidos: boolean;
  /** Opções da coluna de status, na ordem do schema — o menu vem daqui. */
  status_opcoes: BugStatusOption[];
}

/** Fila de bugs da List onde você é o Responsável (fetch paginado + filtro). */
export const syncBugs = (list: string) => invoke<BugSync>("sync_bugs", { list });

/**
 * Opções da coluna de status, carregadas ao abrir o menu (mesmo padrão do
 * `loadListStatuses` do ClickUp). Vem do schema da List, resolvido em runtime.
 */
export const bugStatusOptions = (list: string) =>
  invoke<BugStatusOption[]>("bug_status_options", { list });

/**
 * Grava o status do bug na Slack List. Escrita numa lista compartilhada —
 * só por ação explícita do usuário, nunca por sync ou sugestão de IA.
 */
export const setBugStatus = (list: string, bugId: string, optionId: string) =>
  invoke<void>("set_bug_status", { list, bugId, optionId });

export interface CreatedTask {
  id: string;
  url: string;
}

/** Cria uma task no ClickUp a partir de um bug, na lista informada. */
export const createTaskFromBug = (listId: string, name: string, description: string) =>
  invoke<CreatedTask>("create_task_from_bug", { listId, name, description });

/** Pergunta em linguagem natural sobre uma task (roda o loop de tools no Rust). */
export const askTask = (taskId: string, question: string) =>
  invoke<AskResult>("ask_task", { taskId, question });

// --- Janela destacada -----------------------------------------------------

/** Abre a janela da task; se já estiver aberta, traz pra frente. */
export const openTaskWindow = (taskId: string, title: string) =>
  invoke<void>("open_task_window", { taskId, title });

/** Ids das tasks que estão com janela destacada aberta agora. */
export const detachedTaskIds = () => invoke<string[]>("detached_task_ids");
