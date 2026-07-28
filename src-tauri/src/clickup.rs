//! Camada de acesso a API do ClickUp (v2).
//!
//! Contratos validados contra https://developer.clickup.com/reference:
//! - Auth: header `Authorization: <personal_token>` SEM prefixo `Bearer`.
//!   (Bearer e so para tokens OAuth; o token pessoal `pk_` vai cru no header.)
//! - `GET /api/v2/team` retorna `{ "teams": [ { id, name, ... } ] }`.
//!
//! Nesta Etapa A so o /team esta implementado (descoberta de workspace).

use serde::{Deserialize, Serialize};

const API_BASE: &str = "https://api.clickup.com/api/v2";

/// Workspace do ClickUp (a API chama de "team").
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Team {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub avatar: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TeamsResponse {
    teams: Vec<Team>,
}

/// `GET /api/v2/team` — lista os workspaces visiveis para o token.
pub async fn get_teams(token: &str) -> Result<Vec<Team>, String> {
    let resp = reqwest::Client::new()
        .get(format!("{API_BASE}/team"))
        // NAO usar `Bearer`: token pessoal do ClickUp vai cru no header.
        .header("Authorization", token)
        .send()
        .await
        .map_err(|e| format!("Falha de rede ao contatar o ClickUp: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(match status.as_u16() {
            401 => "Token do ClickUp invalido ou nao autorizado (HTTP 401). Verifique se copiou o token pessoal inteiro.".to_string(),
            429 => "Rate limit do ClickUp atingido (HTTP 429). Aguarde alguns segundos e tente de novo.".to_string(),
            code => format!("ClickUp respondeu HTTP {code}: {body}"),
        });
    }

    resp.json::<TeamsResponse>()
        .await
        .map(|r| r.teams)
        .map_err(|e| format!("Resposta inesperada do ClickUp ao ler /team: {e}"))
}

#[cfg(test)]
mod tests {
    use super::TeamsResponse;

    #[test]
    fn parseia_resposta_do_team() {
        // Formato real de GET /api/v2/team: { "teams": [ { id, name, ... } ] }.
        // Campos extras (members) devem ser ignorados sem quebrar.
        let json = r##"{
          "teams": [
            {
              "id": "9007",
              "name": "Konsi",
              "color": "#40BC86",
              "avatar": null,
              "members": [{ "user": { "id": 87383082 } }]
            }
          ]
        }"##;

        let parsed: TeamsResponse = serde_json::from_str(json).expect("deve parsear");
        assert_eq!(parsed.teams.len(), 1);
        assert_eq!(parsed.teams[0].id, "9007");
        assert_eq!(parsed.teams[0].name, "Konsi");
        assert_eq!(parsed.teams[0].color.as_deref(), Some("#40BC86"));
    }

    #[test]
    fn tolera_campos_opcionais_ausentes() {
        let json = r#"{ "teams": [ { "id": "1", "name": "Solo" } ] }"#;
        let parsed: TeamsResponse = serde_json::from_str(json).expect("deve parsear");
        assert_eq!(parsed.teams[0].color, None);
        assert_eq!(parsed.teams[0].avatar, None);
    }
}
