mod clickup;
mod secret;

use clickup::{FolderRef, TaskDto, Team};
use tauri_plugin_sql::{Migration, MigrationKind};

/// Ha um token do ClickUp salvo no cofre?
#[tauri::command]
fn token_status() -> Result<bool, String> {
    Ok(secret::read()?.is_some())
}

/// Valida o formato do token pessoal do ClickUp (contrato do spec, secao 1.1):
/// nao vazio e prefixo `pk_`. Retorna o token ja com espacos aparados.
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

/// Salva o token pessoal do ClickUp no cofre nativo.
#[tauri::command]
fn save_clickup_token(token: String) -> Result<(), String> {
    let token = validate_token(&token)?;
    secret::store(token)
}

/// Remove o token salvo (para trocar de conta/workspace).
#[tauri::command]
fn clear_clickup_token() -> Result<(), String> {
    secret::clear()
}

/// Descobre os workspaces do usuario via `GET /api/v2/team`.
/// Le o token do cofre; ele nunca transita pelo frontend.
#[tauri::command]
async fn get_teams() -> Result<Vec<Team>, String> {
    let token = secret::read()?
        .ok_or_else(|| "Nenhum token do ClickUp salvo.".to_string())?;
    clickup::get_teams(&token).await
}

/// Resolve o folder escolhido (id -> nome) para exibir o board na UI.
#[tauri::command]
async fn get_folder(folder_id: String) -> Result<FolderRef, String> {
    let token = secret::read()?
        .ok_or_else(|| "Nenhum token do ClickUp salvo.".to_string())?;
    clickup::get_folder(&token, &folder_id).await
}

/// Sync das tasks abertas do usuario dentro do folder escolhido (paginado,
/// um unico fetch). Usa o primeiro workspace; o SQLite fica a cargo do frontend.
#[tauri::command]
async fn sync_open_tasks(folder_id: String) -> Result<Vec<TaskDto>, String> {
    let token = secret::read()?
        .ok_or_else(|| "Nenhum token do ClickUp salvo.".to_string())?;

    let teams = clickup::get_teams(&token).await?;
    let team = teams
        .first()
        .ok_or_else(|| "Nenhum workspace disponivel para este token.".to_string())?;

    let assignee_id = clickup::get_authorized_user_id(&token).await?;
    clickup::fetch_open_tasks(&token, &team.id, assignee_id, &folder_id).await
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
            sync_open_tasks
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
        // Nao aceitar Bearer/OAuth aqui: o spec exige token pessoal pk_.
        assert!(validate_token("Bearer pk_123").is_err());
    }

    #[test]
    fn rejeita_token_vazio() {
        assert!(validate_token("").is_err());
        assert!(validate_token("    ").is_err());
    }
}
