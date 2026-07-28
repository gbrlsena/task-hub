//! Fase 2 — verificação via Claude. Chama a Messages API da Anthropic (HTTP
//! cru; não há SDK oficial em Rust) num loop de tool-use com custom tools.
//! O system prompt força JSON puro no contrato do spec; JSON inválido cai para
//! texto cru sem oferecer ação.

use crate::{clickup, github};
use serde::Serialize;

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const MODEL: &str = "claude-sonnet-5";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const MAX_ITERS: u32 = 6;

/// Resultado da verificação. `valid=false` => JSON não parseou; use `raw`.
#[derive(Debug, Default, Serialize)]
pub struct AskResult {
    pub valid: bool,
    pub resposta: String,
    pub acao: String, // marcar_feito | mudar_status | nada
    pub status_alvo: Option<String>,
    pub evidencia: String,
    pub confianca: String, // alta | media | baixa
    pub raw: String,
}

fn system_prompt(task_id: &str) -> String {
    format!(
        "Você é um verificador de tarefas. Dada uma pergunta sobre uma task do ClickUp, \
investigue com as ferramentas e responda.\n\n\
Regras:\n\
- Responda SEMPRE com JSON puro. Sem markdown, sem cercas ```.\n\
- Formato exato: {{\"resposta\": string, \"acao\": \"marcar_feito\"|\"mudar_status\"|\"nada\", \
\"status_alvo\": string|null, \"evidencia\": string, \"confianca\": \"alta\"|\"media\"|\"baixa\"}}\n\
- `evidencia` é obrigatória: cite o que sustenta a conclusão (ex.: PR merged em X, comentário Y).\n\
- A ação é apenas sugestão; nunca é aplicada automaticamente.\n\
- Para verificar PRs, prefira github_search_prs (estado binário e verificável).\n\
- Sem certeza suficiente: use confianca \"baixa\" e acao \"nada\".\n\
- A task em questão tem id \"{task_id}\". Use clickup_get_task com esse id para o estado atual."
    )
}

fn tools() -> serde_json::Value {
    serde_json::json!([
        {
            "name": "clickup_get_task",
            "description": "Estado atual de uma task no ClickUp: status, assignees, due_date, comentários recentes.",
            "input_schema": {
                "type": "object",
                "properties": { "task_id": { "type": "string" } },
                "required": ["task_id"]
            }
        },
        {
            "name": "github_search_prs",
            "description": "Busca pull requests num repositório do GitHub. Use para saber se uma PR subiu/mergeou.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "repo": { "type": "string", "description": "owner/nome do repositório" },
                    "query": { "type": "string", "description": "termos de busca (título, branch, etc.)" }
                },
                "required": ["repo", "query"]
            }
        }
    ])
}

/// Executa uma custom tool e devolve (texto_resultado, is_error).
async fn run_tool(
    name: &str,
    input: &serde_json::Value,
    clickup_token: &str,
    github_token: Option<&str>,
) -> (String, bool) {
    match name {
        "clickup_get_task" => {
            let id = input["task_id"].as_str().unwrap_or_default();
            match clickup::get_task_summary(clickup_token, id).await {
                Ok(v) => (v.to_string(), false),
                Err(e) => (e, true),
            }
        }
        "github_search_prs" => {
            let Some(gh) = github_token else {
                return ("Nenhum token do GitHub configurado no app.".to_string(), true);
            };
            let repo = input["repo"].as_str().unwrap_or_default();
            let query = input["query"].as_str().unwrap_or_default();
            match github::search_prs(gh, repo, query).await {
                Ok(v) => (v.to_string(), false),
                Err(e) => (e, true),
            }
        }
        other => (format!("Ferramenta desconhecida: {other}"), true),
    }
}

/// Extrai o JSON do contrato do texto final (tolerando cercas por precaução).
fn parse_result(text: &str) -> AskResult {
    let trimmed = text.trim();
    let stripped = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .map(|s| s.trim_end_matches("```").trim())
        .unwrap_or(trimmed);

    match serde_json::from_str::<serde_json::Value>(stripped) {
        Ok(v) if v.is_object() => AskResult {
            valid: true,
            resposta: v["resposta"].as_str().unwrap_or("").to_string(),
            acao: v["acao"].as_str().unwrap_or("nada").to_string(),
            status_alvo: v["status_alvo"].as_str().map(str::to_string),
            evidencia: v["evidencia"].as_str().unwrap_or("").to_string(),
            confianca: v["confianca"].as_str().unwrap_or("baixa").to_string(),
            raw: text.to_string(),
        },
        _ => AskResult {
            valid: false,
            raw: text.to_string(),
            ..Default::default()
        },
    }
}

/// Pergunta sobre uma task; roda o loop de tools e devolve o resultado.
pub async fn ask_task(
    anthropic_key: &str,
    clickup_token: &str,
    github_token: Option<&str>,
    task_id: &str,
    question: &str,
) -> Result<AskResult, String> {
    let client = reqwest::Client::new();
    let system = system_prompt(task_id);
    let tool_defs = tools();

    let mut messages: Vec<serde_json::Value> = vec![serde_json::json!({
        "role": "user",
        "content": question,
    })];

    for _ in 0..MAX_ITERS {
        let body = serde_json::json!({
            "model": MODEL,
            "max_tokens": 2048,
            "system": system,
            "tools": tool_defs,
            "output_config": { "effort": "medium" },
            "messages": messages,
        });

        let resp = client
            .post(API_URL)
            .header("x-api-key", anthropic_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Falha de rede ao chamar a Anthropic: {e}"))?;

        if !resp.status().is_success() {
            let code = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(match code.as_u16() {
                401 => "Chave da API Anthropic inválida (HTTP 401).".to_string(),
                429 => "Rate limit da Anthropic (HTTP 429). Tente de novo em instantes.".to_string(),
                _ => format!("Anthropic respondeu HTTP {code}: {text}"),
            });
        }

        let msg: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Resposta inesperada da Anthropic: {e}"))?;

        let content = msg["content"].as_array().cloned().unwrap_or_default();

        if msg["stop_reason"].as_str() == Some("tool_use") {
            // Preserva o content do assistant (inclui thinking, se houver) inalterado.
            messages.push(serde_json::json!({ "role": "assistant", "content": content }));

            let mut results = Vec::new();
            for block in &content {
                if block["type"].as_str() == Some("tool_use") {
                    let name = block["name"].as_str().unwrap_or_default();
                    let (text, is_error) =
                        run_tool(name, &block["input"], clickup_token, github_token).await;
                    results.push(serde_json::json!({
                        "type": "tool_result",
                        "tool_use_id": block["id"],
                        "content": text,
                        "is_error": is_error,
                    }));
                }
            }
            messages.push(serde_json::json!({ "role": "user", "content": results }));
            continue;
        }

        // Turno final: junta os blocos de texto e parseia o contrato.
        let text: String = content
            .iter()
            .filter(|b| b["type"].as_str() == Some("text"))
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join("");
        return Ok(parse_result(&text));
    }

    Err("O verificador não concluiu (muitas rodadas de ferramentas).".to_string())
}
