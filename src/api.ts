import { invoke } from "@tauri-apps/api/core";
import type { SyncedTask } from "./db";

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
