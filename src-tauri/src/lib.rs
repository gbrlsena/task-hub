mod ai;
mod clickup;
mod github;
mod secret;

use ai::AskResult;
use clickup::{FolderRef, StatusDef, TaskDto, Team};
use tauri_plugin_sql::{Migration, MigrationKind};

/// Lê o token do ClickUp do cofre ou erro acionável.
fn clickup_token() -> Result<String, String> {
    secret::read(secret::CLICKUP)?.ok_or_else(|| "Nenhum token do ClickUp salvo.".to_string())
}

// --- ClickUp -------------------------------------------------------------

#[tauri::command]
fn token_status() -> Result<bool, String> {
    Ok(secret::read(secret::CLICKUP)?.is_some())
}

/// Valida o formato do token pessoal do ClickUp (§1.1): prefixo `pk_`.
fn validate_token(token: &str) -> Result<&str, String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("Informe o token pessoal do ClickUp.".into());
    }
    if !token.starts_with("pk_") {
        return Err("Token pessoal do ClickUp deve comecar com 'pk_'.".into());
    }
    Ok(token)
}

#[tauri::command]
fn save_clickup_token(token: String) -> Result<(), String> {
    let token = validate_token(&token)?;
    secret::store(secret::CLICKUP, token)
}

#[tauri::command]
fn clear_clickup_token() -> Result<(), String> {
    secret::clear(secret::CLICKUP)
}

#[tauri::command]
async fn get_teams() -> Result<Vec<Team>, String> {
    clickup::get_teams(&clickup_token()?).await
}

#[tauri::command]
async fn get_folder(folder_id: String) -> Result<FolderRef, String> {
    clickup::get_folder(&clickup_token()?, &folder_id).await
}

#[tauri::command]
async fn sync_open_tasks(folder_id: String) -> Result<Vec<TaskDto>, String> {
    let token = clickup_token()?;
    let teams = clickup::get_teams(&token).await?;
    let team = teams
        .first()
        .ok_or_else(|| "Nenhum workspace disponivel para este token.".to_string())?;
    let assignee_id = clickup::get_authorized_user_id(&token).await?;
    clickup::fetch_open_tasks(&token, &team.id, assignee_id, &folder_id).await
}

#[tauri::command]
async fn get_list_statuses(list_id: String) -> Result<Vec<StatusDef>, String> {
    clickup::get_list_statuses(&clickup_token()?, &list_id).await
}

#[tauri::command]
async fn set_task_status(task_id: String, status: String) -> Result<(), String> {
    clickup::set_task_status(&clickup_token()?, &task_id, &status).await
}

// --- Fase 2: credenciais + verificação -----------------------------------

#[tauri::command]
fn anthropic_status() -> Result<bool, String> {
    Ok(secret::read(secret::ANTHROPIC)?.is_some())
}

#[tauri::command]
fn save_anthropic_key(key: String) -> Result<(), String> {
    let key = key.trim();
    if !key.starts_with("sk-ant-") {
        return Err("A chave da API Anthropic deve comecar com 'sk-ant-'.".into());
    }
    secret::store(secret::ANTHROPIC, key)
}

#[tauri::command]
fn clear_anthropic_key() -> Result<(), String> {
    secret::clear(secret::ANTHROPIC)
}

#[tauri::command]
fn github_status() -> Result<bool, String> {
    Ok(secret::read(secret::GITHUB)?.is_some())
}

#[tauri::command]
fn save_github_token(token: String) -> Result<(), String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("Informe o token do GitHub.".into());
    }
    secret::store(secret::GITHUB, token)
}

#[tauri::command]
fn clear_github_token() -> Result<(), String> {
    secret::clear(secret::GITHUB)
}

/// Verificação via Claude (Fase 2). Lê as credenciais do cofre.
#[tauri::command]
async fn ask_task(task_id: String, question: String) -> Result<AskResult, String> {
    let anthropic = secret::read(secret::ANTHROPIC)?
        .ok_or_else(|| "Conecte a API da Anthropic primeiro (chave sk-ant-).".to_string())?;
    let clickup = clickup_token()?;
    let github = secret::read(secret::GITHUB)?;
    ai::ask_task(&anthropic, &clickup, github.as_deref(), &task_id, &question).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "create initial schema",
            sql: include_str!("../migrations/0001_init.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "subtask parent column, comment and reminder tables",
            sql: include_str!("../migrations/0002_notes.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "status_type column for done detection",
            sql: include_str!("../migrations/0003_status_type.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "task description column",
            sql: include_str!("../migrations/0004_description.sql"),
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:taskhub.db", migrations)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            token_status,
            save_clickup_token,
            clear_clickup_token,
            get_teams,
            get_folder,
            sync_open_tasks,
            get_list_statuses,
            set_task_status,
            anthropic_status,
            save_anthropic_key,
            clear_anthropic_key,
            github_status,
            save_github_token,
            clear_github_token,
            ask_task
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::validate_token;

    #[test]
    fn aceita_token_valido() {
        assert_eq!(validate_token("pk_123abc"), Ok("pk_123abc"));
    }

    #[test]
    fn apara_espacos_antes_de_validar() {
        assert_eq!(validate_token("  pk_123abc  "), Ok("pk_123abc"));
    }

    #[test]
    fn rejeita_token_sem_prefixo() {
        assert!(validate_token("123abc").is_err());
        assert!(validate_token("Bearer pk_123").is_err());
    }

    #[test]
    fn rejeita_token_vazio() {
        assert!(validate_token("").is_err());
        assert!(validate_token("    ").is_err());
    }
}
