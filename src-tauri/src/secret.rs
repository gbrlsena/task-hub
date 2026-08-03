//! Armazenamento de segredos no cofre de credenciais do SO.
//!
//! Regra do spec: segredos nunca vivem em arquivo de config, `.env`,
//! localStorage ou log. Só no keyring nativo (Credential Manager no Windows,
//! Secret Service no Linux) e no lado Rust. Nunca devolvidos para o JS.

use keyring::{Entry, Error as KeyringError};

const SERVICE: &str = "task-hub";

// Contas (uma por segredo).
pub const CLICKUP: &str = "clickup_personal_token";
pub const ANTHROPIC: &str = "anthropic_api_key";
pub const GITHUB: &str = "github_token";
pub const SLACK: &str = "slack_token";

fn entry(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, account).map_err(|e| format!("Falha ao abrir o cofre: {e}"))
}

/// Grava (ou sobrescreve) um segredo.
pub fn store(account: &str, token: &str) -> Result<(), String> {
    entry(account)?
        .set_password(token)
        .map_err(|e| format!("Falha ao salvar no cofre: {e}"))
}

/// Lê um segredo. `Ok(None)` quando ainda não há valor salvo.
pub fn read(account: &str) -> Result<Option<String>, String> {
    match entry(account)?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(format!("Falha ao ler do cofre: {e}")),
    }
}

/// Remove um segredo. Idempotente.
pub fn clear(account: &str) -> Result<(), String> {
    match entry(account)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(format!("Falha ao remover do cofre: {e}")),
    }
}
