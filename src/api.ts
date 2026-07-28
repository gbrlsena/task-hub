import { invoke } from "@tauri-apps/api/core";
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

/** Pergunta em linguagem natural sobre uma task (roda o loop de tools no Rust). */
export const askTask = (taskId: string, question: string) =>
  invoke<AskResult>("ask_task", { taskId, question });
