//! Camada de acesso a API do ClickUp (v2).
//!
//! Contratos validados contra https://developer.clickup.com/reference:
//! - Auth: header `Authorization: <personal_token>` SEM prefixo `Bearer`.
//!   (Bearer e so para tokens OAuth; o token pessoal `pk_` vai cru no header.)
//! - `GET /api/v2/team` retorna `{ "teams": [ { id, name, ... } ] }`.
//! - `GET /api/v2/team/{team_id}/task` (Get Filtered Team Tasks): filtra por
//!   `assignees[]`, `include_closed`, `subtasks`, `page` (100/pagina, page 0-based).
//! - `GET /api/v2/user` retorna o usuario autorizado (para nao hardcodar o assignee).

use serde::{Deserialize, Serialize};
use std::time::Duration;

const API_BASE: &str = "https://api.clickup.com/api/v2";
const MAX_PAGES: u32 = 100; // trava de seguranca contra loop infinito de paginacao
const MAX_429_RETRIES: u32 = 5;

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

/// `GET /api/v2/user` — id do usuario autorizado. Evita hardcodar o assignee.
pub async fn get_authorized_user_id(token: &str) -> Result<i64, String> {
    let resp = reqwest::Client::new()
        .get(format!("{API_BASE}/user"))
        .header("Authorization", token)
        .send()
        .await
        .map_err(|e| format!("Falha de rede ao ler /user: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("ClickUp respondeu HTTP {} em /user", resp.status()));
    }

    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Resposta inesperada em /user: {e}"))?;

    v["user"]["id"]
        .as_i64()
        .ok_or_else(|| "Nao foi possivel ler o id do usuario em /user.".to_string())
}

/// Task achatada para caching (spec §1.5). `raw` guarda o JSON completo.
#[derive(Debug, Clone, Serialize)]
pub struct TaskDto {
    pub id: String,
    pub custom_id: Option<String>,
    pub name: String,
    pub status: String,
    /// type do status na API: open | custom | closed | done (§1.3).
    pub status_type: String,
    pub priority: Option<i64>,
    pub list_id: String,
    pub list_name: String,
    pub due_date: Option<i64>,
    /// Id da task pai quando esta e uma subtask; None no topo.
    pub parent: Option<String>,
    pub assignees: Vec<i64>,
    /// Descricao da task. Texto puro: o endpoint nao devolve markdown.
    pub description: String,
    pub raw: String,
}

/// Extrai os campos da task com tolerancia: a API mistura tipos (due_date vem
/// como string de ms, priority como objeto, etc). Campo ausente vira default,
/// nunca descarta a task (spec: nunca lançar/descartar por dado inesperado).
fn parse_task(t: &serde_json::Value) -> Option<TaskDto> {
    let id = t["id"].as_str()?.to_string();

    // due_date e priority.id chegam como string numerica ("1690000000000").
    let str_to_i64 = |v: &serde_json::Value| -> Option<i64> {
        v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok()))
    };

    let assignees = t["assignees"]
        .as_array()
        .map(|arr| arr.iter().filter_map(|a| a["id"].as_i64()).collect())
        .unwrap_or_default();

    // `description` e `text_content` sao dois recortes do mesmo texto puro;
    // o primeiro nao-vazio vale. Ausente vira "" (nunca descarta a task).
    let description = ["description", "text_content"]
        .iter()
        .filter_map(|k| t[*k].as_str())
        .map(str::trim)
        .find(|s| !s.is_empty())
        .unwrap_or("")
        .to_string();

    Some(TaskDto {
        id,
        custom_id: t["custom_id"].as_str().map(str::to_string),
        name: t["name"].as_str().unwrap_or("(sem título)").to_string(),
        status: t["status"]["status"].as_str().unwrap_or("").to_string(),
        status_type: t["status"]["type"].as_str().unwrap_or("").to_string(),
        priority: str_to_i64(&t["priority"]["id"]),
        list_id: t["list"]["id"].as_str().unwrap_or("").to_string(),
        list_name: t["list"]["name"].as_str().unwrap_or("").to_string(),
        due_date: str_to_i64(&t["due_date"]),
        parent: t["parent"].as_str().map(str::to_string),
        assignees,
        description,
        raw: t.to_string(),
    })
}

/// Folder (o "board" que o usuario escolhe). `space` opcional so para exibir.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderRef {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub space_name: Option<String>,
}

/// `GET /api/v2/folder/{folder_id}` — resolve id -> nome (para exibir o board).
pub async fn get_folder(token: &str, folder_id: &str) -> Result<FolderRef, String> {
    let resp = reqwest::Client::new()
        .get(format!("{API_BASE}/folder/{folder_id}"))
        .header("Authorization", token)
        .send()
        .await
        .map_err(|e| format!("Falha de rede ao ler o folder: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Nao foi possivel abrir o folder {folder_id} (HTTP {}).",
            resp.status()
        ));
    }

    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Resposta inesperada ao ler o folder: {e}"))?;

    Ok(FolderRef {
        id: v["id"].as_str().unwrap_or(folder_id).to_string(),
        name: v["name"].as_str().unwrap_or("(folder)").to_string(),
        space_name: v["space"]["name"].as_str().map(str::to_string),
    })
}

/// `GET /api/v2/folder/{folder_id}/list` — ids das listas (sprints) do folder.
async fn get_folder_list_ids(token: &str, folder_id: &str) -> Result<Vec<String>, String> {
    let resp = reqwest::Client::new()
        .get(format!("{API_BASE}/folder/{folder_id}/list"))
        .header("Authorization", token)
        .send()
        .await
        .map_err(|e| format!("Falha de rede ao listar as listas do folder: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Nao foi possivel listar as listas do folder {folder_id} (HTTP {}).",
            resp.status()
        ));
    }

    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Resposta inesperada ao listar as listas do folder: {e}"))?;

    Ok(v["lists"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|l| l["id"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default())
}

/// Sync das tasks abertas do usuario DENTRO de um folder (o board escolhido),
/// paginado ate vir vazio. Escopa por `list_ids[]` das listas do folder — um
/// unico fetch paginado, nunca um request por task. Backoff em 429 (§1.1).
pub async fn fetch_open_tasks(
    token: &str,
    team_id: &str,
    assignee_id: i64,
    folder_id: &str,
) -> Result<Vec<TaskDto>, String> {
    let list_ids = get_folder_list_ids(token, folder_id).await?;
    if list_ids.is_empty() {
        return Err(format!(
            "O folder {folder_id} nao tem listas visiveis para este token."
        ));
    }

    let client = reqwest::Client::new();
    let mut out = Vec::new();

    for page in 0..MAX_PAGES {
        let value = get_task_page(&client, token, team_id, assignee_id, &list_ids, page).await?;
        let tasks = value["tasks"].as_array().cloned().unwrap_or_default();
        if tasks.is_empty() {
            break;
        }
        out.extend(tasks.iter().filter_map(parse_task));
    }

    Ok(out)
}

/// Busca uma pagina, com retry/backoff exponencial em HTTP 429.
async fn get_task_page(
    client: &reqwest::Client,
    token: &str,
    team_id: &str,
    assignee_id: i64,
    list_ids: &[String],
    page: u32,
) -> Result<serde_json::Value, String> {
    let url = format!("{API_BASE}/team/{team_id}/task");

    // list_ids[] repetido, um por lista do folder.
    let mut params: Vec<(String, String)> = vec![
        ("assignees[]".to_string(), assignee_id.to_string()),
        ("include_closed".to_string(), "false".to_string()),
        ("subtasks".to_string(), "true".to_string()),
        ("page".to_string(), page.to_string()),
    ];
    for id in list_ids {
        params.push(("list_ids[]".to_string(), id.clone()));
    }

    for attempt in 0..=MAX_429_RETRIES {
        let resp = client
            .get(&url)
            .header("Authorization", token)
            .query(&params)
            .send()
            .await
            .map_err(|e| format!("Falha de rede ao paginar tasks: {e}"))?;

        if resp.status().as_u16() == 429 {
            if attempt == MAX_429_RETRIES {
                return Err("Rate limit do ClickUp (429) persistente ao paginar tasks.".into());
            }
            // Retry-After em segundos quando presente; senao backoff exponencial.
            let wait = resp
                .headers()
                .get("Retry-After")
                .and_then(|h| h.to_str().ok())
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(1u64 << attempt);
            tokio::time::sleep(Duration::from_secs(wait)).await;
            continue;
        }

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("ClickUp respondeu HTTP {status} ao paginar tasks: {body}"));
        }

        return resp
            .json::<serde_json::Value>()
            .await
            .map_err(|e| format!("Resposta inesperada ao paginar tasks: {e}"));
    }

    unreachable!("loop de retry sempre retorna")
}

/// Um status possível de uma List (§1.3). `type` ∈ open | custom | closed | done.
#[derive(Debug, Clone, Serialize)]
pub struct StatusDef {
    pub status: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub orderindex: i64,
    pub color: Option<String>,
}

/// `GET /api/v2/list/{list_id}` — statuses da list, para resolver "marcar feito"
/// e trocar status sem hardcodar strings (§1.3).
pub async fn get_list_statuses(token: &str, list_id: &str) -> Result<Vec<StatusDef>, String> {
    let resp = reqwest::Client::new()
        .get(format!("{API_BASE}/list/{list_id}"))
        .header("Authorization", token)
        .send()
        .await
        .map_err(|e| format!("Falha de rede ao ler a list: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Nao foi possivel ler os statuses da list {list_id} (HTTP {}).",
            resp.status()
        ));
    }

    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Resposta inesperada ao ler a list: {e}"))?;

    let order = |x: &serde_json::Value| -> i64 {
        x.as_i64()
            .or_else(|| x.as_f64().map(|f| f as i64))
            .or_else(|| x.as_str().and_then(|s| s.parse().ok()))
            .unwrap_or(0)
    };

    Ok(v["statuses"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|s| {
                    Some(StatusDef {
                        status: s["status"].as_str()?.to_string(),
                        kind: s["type"].as_str().unwrap_or("custom").to_string(),
                        orderindex: order(&s["orderindex"]),
                        color: s["color"].as_str().map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

/// `PUT /api/v2/task/{task_id}` — grava o status. Envia a string exatamente
/// como veio da API (acento e caixa preservados). Escrita só por ação explícita.
pub async fn set_task_status(token: &str, task_id: &str, status: &str) -> Result<(), String> {
    let resp = reqwest::Client::new()
        .put(format!("{API_BASE}/task/{task_id}"))
        .header("Authorization", token)
        .json(&serde_json::json!({ "status": status }))
        .send()
        .await
        .map_err(|e| format!("Falha de rede ao gravar o status: {e}"))?;

    if resp.status().is_success() {
        return Ok(());
    }

    let code = resp.status();
    let body = resp.text().await.unwrap_or_default();
    Err(match code.as_u16() {
        401 => "Token do ClickUp invalido ou sem permissao (HTTP 401).".to_string(),
        _ => format!("ClickUp recusou a mudanca de status (HTTP {code}): {body}"),
    })
}

/// Resumo de uma task para a Fase 2: status, assignees, due_date e comentários
/// recentes. Retorna JSON compacto pronto pra virar tool_result.
pub async fn get_task_summary(token: &str, task_id: &str) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();

    let task: serde_json::Value = client
        .get(format!("{API_BASE}/task/{task_id}"))
        .header("Authorization", token)
        .send()
        .await
        .map_err(|e| format!("Falha de rede ao ler a task: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Resposta inesperada ao ler a task: {e}"))?;

    // Comentários (melhor esforço; se falhar, segue sem eles).
    let comments = client
        .get(format!("{API_BASE}/task/{task_id}/comment"))
        .header("Authorization", token)
        .send()
        .await
        .ok();
    let recent: Vec<String> = match comments {
        Some(resp) if resp.status().is_success() => resp
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v["comments"].as_array().cloned())
            .unwrap_or_default()
            .iter()
            .rev()
            .take(5)
            .filter_map(|c| c["comment_text"].as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    };

    Ok(serde_json::json!({
        "id": task["id"],
        "name": task["name"],
        "status": task["status"]["status"],
        "status_type": task["status"]["type"],
        "due_date": task["due_date"],
        "assignees": task["assignees"].as_array().map(|a| {
            a.iter().filter_map(|x| x["username"].as_str()).collect::<Vec<_>>()
        }),
        "url": task["url"],
        "recent_comments": recent,
    }))
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

    #[test]
    fn parse_task_extrai_campos_com_tipos_mistos() {
        // Formato real de uma task: due_date string de ms, priority objeto,
        // status aninhado, list aninhada, assignees como array de objetos.
        let t: serde_json::Value = serde_json::from_str(
            r#"{
              "id": "abc123",
              "custom_id": "REV-42",
              "name": "Ajustar automação",
              "status": { "status": "in progress", "type": "custom" },
              "priority": { "id": "2", "priority": "high" },
              "due_date": "1690000000000",
              "list": { "id": "901114167268", "name": "Revenue Sprint 8 (7/21 - 8/3)" },
              "parent": "parent999",
              "assignees": [ { "id": 87383082 }, { "id": 99 } ]
            }"#,
        )
        .unwrap();

        let dto = super::parse_task(&t).expect("task válida deve parsear");
        assert_eq!(dto.id, "abc123");
        assert_eq!(dto.custom_id.as_deref(), Some("REV-42"));
        assert_eq!(dto.status, "in progress");
        assert_eq!(dto.status_type, "custom");
        assert_eq!(dto.priority, Some(2));
        assert_eq!(dto.due_date, Some(1690000000000));
        assert_eq!(dto.list_id, "901114167268");
        assert_eq!(dto.parent.as_deref(), Some("parent999"));
        assert_eq!(dto.assignees, vec![87383082, 99]);
    }

    #[test]
    fn parse_task_tolera_priority_e_due_date_nulos() {
        // 65 de 76 tasks vêm com priority null (spec §1.4).
        let t: serde_json::Value = serde_json::from_str(
            r#"{
              "id": "x",
              "name": "Sem prioridade",
              "status": { "status": "to do" },
              "priority": null,
              "due_date": null,
              "list": { "id": "1", "name": "Backlog" }
            }"#,
        )
        .unwrap();

        let dto = super::parse_task(&t).expect("deve parsear");
        assert_eq!(dto.priority, None);
        assert_eq!(dto.due_date, None);
        assert_eq!(dto.parent, None);
        assert!(dto.assignees.is_empty());
    }

    #[test]
    fn parse_task_extrai_a_descricao() {
        let t: serde_json::Value = serde_json::from_str(
            r#"{
              "id": "abc123",
              "name": "Com descrição",
              "status": { "status": "to do", "type": "open" },
              "description": "  Contexto\n\nTestar o fluxo.  ",
              "text_content": "Contexto\n\nTestar o fluxo.",
              "list": { "id": "1", "name": "Backlog" }
            }"#,
        )
        .unwrap();

        let dto = super::parse_task(&t).expect("deve parsear");
        assert_eq!(dto.description, "Contexto\n\nTestar o fluxo.");
    }

    #[test]
    fn parse_task_cai_no_text_content_quando_description_vem_vazia() {
        let t: serde_json::Value = serde_json::from_str(
            r#"{
              "id": "x",
              "name": "Só text_content",
              "status": { "status": "to do" },
              "description": "",
              "text_content": "Objetivo\nTirar o hardcode.",
              "list": { "id": "1", "name": "Backlog" }
            }"#,
        )
        .unwrap();

        let dto = super::parse_task(&t).expect("deve parsear");
        assert_eq!(dto.description, "Objetivo\nTirar o hardcode.");
    }

    #[test]
    fn parse_task_sem_descricao_nenhuma_vira_string_vazia() {
        let t: serde_json::Value = serde_json::from_str(
            r#"{
              "id": "y",
              "name": "Sem nada",
              "status": { "status": "to do" },
              "list": { "id": "1", "name": "Backlog" }
            }"#,
        )
        .unwrap();

        let dto = super::parse_task(&t).expect("deve parsear");
        assert_eq!(dto.description, "");
    }
}
