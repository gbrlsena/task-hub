mod ai;
mod clickup;
mod detach;
mod github;
mod secret;
mod slack;

use ai::AskResult;
use clickup::{CreatedTask, FolderRef, StatusDef, TaskDto, Team};
use tauri::Manager;
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

// --- Slack: fila de bugs ---------------------------------------------------

#[tauri::command]
fn slack_status() -> Result<bool, String> {
    Ok(secret::read(secret::SLACK)?.is_some())
}

#[tauri::command]
fn save_slack_token(token: String) -> Result<(), String> {
    let token = slack::validate_token(&token)?;
    secret::store(secret::SLACK, token)
}

#[tauri::command]
fn clear_slack_token() -> Result<(), String> {
    secret::clear(secret::SLACK)
}

/// Diagnóstico da List de bugs: quem é o dono do token e quais campos os
/// registros trazem. Passo zero — sem isso não há como mapear as colunas
/// (responsável, status, prioridade) sem chutar.
#[tauri::command]
async fn slack_diagnose(list: String) -> Result<serde_json::Value, String> {
    let token = secret::read(secret::SLACK)?
        .ok_or_else(|| "Nenhum token do Slack salvo (xoxp-).".to_string())?;
    let list_id = slack::parse_list_id(&list)
        .ok_or_else(|| "Nao reconheci um id ou URL de List do Slack.".to_string())?;
    slack::diagnose(&token, &list_id).await
}

/// Nomes das colunas e rótulos dos select da List. Vem do `files.info`
/// (`files:read`), único lugar que traduz os ids opacos `Opt…`.
#[tauri::command]
async fn slack_schema(list: String) -> Result<serde_json::Value, String> {
    let token = secret::read(secret::SLACK)?
        .ok_or_else(|| "Nenhum token do Slack salvo (xoxp-).".to_string())?;
    let list_id = slack::parse_list_id(&list)
        .ok_or_else(|| "Nao reconheci um id ou URL de List do Slack.".to_string())?;
    slack::schema(&token, &list_id).await
}

/// Fila de bugs da Slack List onde você é o Responsável. Um fetch paginado da
/// List inteira + filtro local (a API não filtra por campo).
#[tauri::command]
async fn sync_bugs(list: String) -> Result<serde_json::Value, String> {
    let token = secret::read(secret::SLACK)?
        .ok_or_else(|| "Nenhum token do Slack salvo (xoxp-).".to_string())?;
    let list_id = slack::parse_list_id(&list)
        .ok_or_else(|| "Nao reconheci um id ou URL de List do Slack.".to_string())?;
    slack::sync_bugs(&token, &list_id).await
}

/// Opções da coluna de status da List, carregadas ao abrir o menu.
#[tauri::command]
async fn bug_status_options(list: String) -> Result<serde_json::Value, String> {
    let token = secret::read(secret::SLACK)?
        .ok_or_else(|| "Nenhum token do Slack salvo (xoxp-).".to_string())?;
    let list_id = slack::parse_list_id(&list)
        .ok_or_else(|| "Nao reconheci um id ou URL de List do Slack.".to_string())?;
    slack::status_options(&token, &list_id).await
}

/// Grava o status do bug na Slack List. Exige `lists:write`. Ação explícita:
/// nunca chamado por sync nem por sugestão de IA.
#[tauri::command]
async fn set_bug_status(list: String, bug_id: String, option_id: String) -> Result<(), String> {
    let token = secret::read(secret::SLACK)?
        .ok_or_else(|| "Nenhum token do Slack salvo (xoxp-).".to_string())?;
    let list_id = slack::parse_list_id(&list)
        .ok_or_else(|| "Nao reconheci um id ou URL de List do Slack.".to_string())?;
    slack::set_bug_status(&token, &list_id, &bug_id, &option_id).await
}

/// Cria uma task no ClickUp a partir de um bug. O `list_id` é a sprint que o hub
/// está mostrando — quem decide é a UI, não este command.
#[tauri::command]
async fn create_task_from_bug(
    list_id: String,
    name: String,
    description: String,
) -> Result<CreatedTask, String> {
    clickup::create_task(&clickup_token()?, &list_id, &name, &description).await
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
        Migration {
            version: 5,
            description: "bug cache from slack list",
            sql: include_str!("../migrations/0005_bugs.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "focus kind so bugs can be pinned too",
            sql: include_str!("../migrations/0006_focus_kind.sql"),
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
        .on_window_event(|window, event| {
            // Fechou uma janela de task: a lista de destacadas mudou.
            if matches!(event, tauri::WindowEvent::Destroyed)
                && detach::task_id_from_label(window.label()).is_some()
            {
                detach::emit_detached(window.app_handle(), Some(window.label()));
            }
        })
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
            slack_status,
            save_slack_token,
            clear_slack_token,
            slack_diagnose,
            slack_schema,
            sync_bugs,
            bug_status_options,
            set_bug_status,
            create_task_from_bug,
            ask_task,
            open_task_window,
            detached_task_ids
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
