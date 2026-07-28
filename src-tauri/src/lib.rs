mod clickup;
mod secret;

use clickup::Team;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            token_status,
            save_clickup_token,
            clear_clickup_token,
            get_teams
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
