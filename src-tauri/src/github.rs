//! Busca de PRs no GitHub para a Fase 2 (tool `github_search_prs`).
//! PRs têm estado binário e verificável — por isso entram antes do Slack.

/// `GET /search/issues` filtrando por PRs do repo. Retorna JSON compacto com
/// state, merged, título, url e data — o suficiente pra "essa PR já subiu?".
pub async fn search_prs(
    token: &str,
    repo: &str,
    query: &str,
) -> Result<serde_json::Value, String> {
    let q = format!("{query} type:pr repo:{repo}");
    let resp = reqwest::Client::new()
        .get("https://api.github.com/search/issues")
        .query(&[("q", q.as_str()), ("per_page", "5")])
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "task-hub")
        .send()
        .await
        .map_err(|e| format!("Falha de rede ao buscar PRs no GitHub: {e}"))?;

    if !resp.status().is_success() {
        let code = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("GitHub respondeu HTTP {code}: {body}"));
    }

    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Resposta inesperada do GitHub: {e}"))?;

    let items: Vec<serde_json::Value> = v["items"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|it| {
                    serde_json::json!({
                        "title": it["title"],
                        "state": it["state"],
                        "merged_at": it["pull_request"]["merged_at"],
                        "url": it["html_url"],
                        "updated_at": it["updated_at"],
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(serde_json::json!({ "total": v["total_count"], "results": items }))
}
