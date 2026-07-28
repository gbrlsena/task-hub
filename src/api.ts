import { invoke } from "@tauri-apps/api/core";
import type { SyncedTask } from "./db";

/** Workspace do ClickUp (a API chama de "team"). */
export interface Team {
  id: string;
  name: string;
  color?: string | null;
  avatar?: string | null;
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

/** Sync paginado das tasks abertas do usuário (lado Rust). */
export const syncOpenTasks = () => invoke<SyncedTask[]>("sync_open_tasks");
