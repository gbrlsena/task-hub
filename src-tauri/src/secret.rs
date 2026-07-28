//! Armazenamento do token pessoal do ClickUp no cofre de credenciais do SO.
//!
//! Regra do spec: o token nunca vive em arquivo de config, `.env`, localStorage
//! ou log. Ele so existe no keyring nativo (Credential Manager no Windows,
//! Secret Service no Linux) e no lado Rust. Nunca e devolvido para o JS.

use keyring::{Entry, Error as KeyringError};

const SERVICE: &str = "task-hub";
const ACCOUNT: &str = "clickup_personal_token";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("Falha ao abrir o cofre de credenciais: {e}"))
}

/// Grava (ou sobrescreve) o token no cofre.
pub fn store(token: &str) -> Result<(), String> {
    entry()?
        .set_password(token)
        .map_err(|e| format!("Falha ao salvar o token no cofre: {e}"))
}

/// Le o token. `Ok(None)` quando ainda nao ha token salvo.
pub fn read() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(format!("Falha ao ler o token do cofre: {e}")),
    }
}

/// Remove o token. Idempotente: apagar algo inexistente nao e erro.
pub fn clear() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(format!("Falha ao remover o token do cofre: {e}")),
    }
}
