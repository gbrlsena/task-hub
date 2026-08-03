//! Leitura da Slack List de bugs ("Solicitações — Bugs").
//!
//! O canal #bugs é só um feed do bot: a mensagem não carrega título, status
//! nem responsável — isso vive no registro da List. Então a fonte é a List:
//! `slackLists.items.list` traz os itens (`lists:read`) e `files.info` traz o
//! schema (`files:read`), porque uma List é um arquivo no Slack.
//!
//! Nada aqui hardcoda nome nem id de coluna. O `items.list` devolve valores de
//! `select` como ids opacos (`OptYYB79DT0`) e o `key` de cada campo varia por
//! workspace; quem traduz é o `list_metadata.schema`, resolvido em runtime —
//! mesma disciplina do `status_type` no ClickUp.

const API: &str = "https://slack.com/api";

/// A Web API do Slack responde HTTP 200 mesmo em erro, sinalizando no `ok`.
/// Sem isso, um `invalid_auth` viraria "lista vazia" silenciosa.
fn check_ok(v: serde_json::Value, metodo: &str) -> Result<serde_json::Value, String> {
    if v["ok"].as_bool() == Some(true) {
        return Ok(v);
    }
    let erro = v["error"].as_str().unwrap_or("erro desconhecido");
    let dica = match erro {
        "invalid_auth" | "not_authed" | "token_revoked" => {
            " — o token foi revogado ou está errado; gere outro em api.slack.com/apps"
        }
        "missing_scope" => {
            " — falta escopo para esse metodo (lists:read para os itens, files:read \
             para o schema, lists:write para gravar status); adicione e reinstale o app"
        }
        "not_allowed_token_type" => " — use o User OAuth Token (xoxp-), não o de bot",
        "list_not_found" | "file_not_found" => {
            " — id da List errado, ou sua conta não tem acesso a ela"
        }
        "feature_not_enabled" => " — Lists não está habilitado neste workspace (exige plano pago)",
        "ratelimited" => " — rate limit do Slack (tier 2, 20+/min); tente de novo em instantes",
        _ => "",
    };
    Err(format!("Slack recusou {metodo}: {erro}{dica}"))
}

async fn get(
    token: &str,
    metodo: &str,
    params: &[(&str, &str)],
) -> Result<serde_json::Value, String> {
    let resp = reqwest::Client::new()
        .get(format!("{API}/{metodo}"))
        .query(params)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| format!("Falha de rede ao falar com o Slack: {e}"))?;

    if !resp.status().is_success() {
        let code = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Slack respondeu HTTP {code}: {body}"));
    }

    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Resposta inesperada do Slack: {e}"))?;

    check_ok(v, metodo)
}

/// Encurta strings e arrays longos: a descrição de um bug pode ser enorme, e o
/// diagnóstico só precisa da forma do valor, não do conteúdo inteiro.
///
/// Cuidado: não usar em payload que precisa vir completo — cortar o array do
/// schema em 3 já escondeu 11 das 14 colunas uma vez.
fn truncar(v: &serde_json::Value) -> serde_json::Value {
    match v {
        serde_json::Value::String(s) if s.chars().count() > 160 => {
            let corte: String = s.chars().take(160).collect();
            serde_json::Value::String(format!("{corte}…"))
        }
        serde_json::Value::Array(a) => {
            serde_json::Value::Array(a.iter().take(3).map(truncar).collect())
        }
        serde_json::Value::Object(o) => {
            serde_json::Value::Object(o.iter().map(|(k, v)| (k.clone(), truncar(v))).collect())
        }
        outro => outro.clone(),
    }
}

/// Quem é o dono do token. `auth.test` não exige escopo — serve de ping, dá o
/// `user_id` que filtra a fila por "sou o responsável" e a `url` do workspace,
/// que é o que permite montar o link do registro sem chutar o domínio.
pub async fn auth_test(token: &str) -> Result<serde_json::Value, String> {
    let v = get(token, "auth.test", &[]).await?;
    Ok(serde_json::json!({
        "user_id": v["user_id"],
        "user": v["user"],
        "team": v["team"],
        "team_id": v["team_id"],
        "url": v["url"],
    }))
}

/// Uma página de itens da List. `cursor` vazio busca a primeira.
pub async fn items_page(
    token: &str,
    list_id: &str,
    cursor: Option<&str>,
    limit: u16,
) -> Result<serde_json::Value, String> {
    let limit = limit.to_string();
    let mut params = vec![("list_id", list_id), ("limit", limit.as_str())];
    if let Some(c) = cursor.filter(|c| !c.is_empty()) {
        params.push(("cursor", c));
    }
    get(token, "slackLists.items.list", &params).await
}

// --- Schema da List --------------------------------------------------------

/// Extrai `Opt… → rótulo` de um objeto `options` de coluna select.
///
/// Tolerante de propósito: procura o primeiro array de objetos e aceita
/// `value`/`id`/`option_id`/`key` como id e `label`/`name`/`text` como rótulo.
/// A forma exata não está documentada, então o cru também é devolvido junto —
/// se a extração falhar, o dado está lá para conferir em vez de sumir.
fn extrair_opcoes(options: &serde_json::Value) -> std::collections::HashMap<String, String> {
    const IDS: [&str; 4] = ["value", "id", "option_id", "key"];
    const ROTULOS: [&str; 3] = ["label", "name", "text"];

    let mut mapa = std::collections::HashMap::new();

    let Some(obj) = options.as_object() else {
        return mapa;
    };

    for valor in obj.values() {
        let Some(arr) = valor.as_array() else { continue };
        for entrada in arr {
            let Some(e) = entrada.as_object() else { continue };
            let id = IDS.iter().find_map(|k| e.get(*k)?.as_str());
            let rotulo = ROTULOS.iter().find_map(|k| e.get(*k)?.as_str());
            if let (Some(id), Some(rotulo)) = (id, rotulo) {
                mapa.insert(id.to_string(), rotulo.to_string());
            }
        }
        if !mapa.is_empty() {
            break;
        }
    }

    mapa
}

/// Traduz uma entrada do `list_metadata.schema` numa coluna nomeada.
fn coluna_do_schema(entrada: &serde_json::Value) -> serde_json::Value {
    let opcoes = extrair_opcoes(&entrada["options"]);
    serde_json::json!({
        "key": entrada["key"].as_str().unwrap_or(""),
        "id": entrada["id"].as_str().unwrap_or(""),
        "nome": entrada["name"].as_str().unwrap_or(""),
        "tipo": entrada["type"].as_str().unwrap_or(""),
        "primaria": entrada["is_primary_column"].as_bool().unwrap_or(false),
        "opcoes": opcoes,
        // Cru pra conferência: a forma de `options` não é documentada.
        "options_bruto": entrada["options"].clone(),
    })
}

/// Schema da List: nomes, tipos e rótulos dos select. Vem do `files.info`,
/// porque uma List é um arquivo — o `items.list` só dá ids opacos.
///
/// Também devolve a dica de qual coluna é o status: a view padrão da List é um
/// kanban agrupado por ela, então o `group_by` entrega o que seria chute.
pub async fn schema(token: &str, list_id: &str) -> Result<serde_json::Value, String> {
    let v = get(token, "files.info", &[("file", list_id)]).await?;
    let meta = &v["file"]["list_metadata"];

    let vazio = Vec::new();
    let entradas = meta["schema"].as_array().unwrap_or(&vazio);
    if entradas.is_empty() {
        return Err("O files.info nao trouxe list_metadata.schema — sem isso nao ha \
                    como traduzir as colunas."
            .into());
    }

    let colunas: Vec<serde_json::Value> = entradas.iter().map(coluna_do_schema).collect();

    // A view padrão é o kanban "By status kanban": o agrupamento dela aponta a
    // coluna de status sem eu precisar inferir pelo nome.
    let padrao = meta["default_view"].as_str().unwrap_or("");
    let agrupada_por = meta["views"]
        .as_array()
        .and_then(|vs| vs.iter().find(|view| view["id"].as_str() == Some(padrao)))
        .and_then(|view| view["grouping"]["group_by"].as_str())
        .unwrap_or("");

    Ok(serde_json::json!({
        "colunas": colunas,
        "coluna_de_status": agrupada_por,
        "linhas": v["file"]["list_limits"]["row_count"],
        "arquivadas": v["file"]["list_limits"]["archived_row_count"],
    }))
}

// --- Mapeamento das colunas -------------------------------------------------

/// Um bug da List, já com rótulos resolvidos, pronto pro SQLite.
#[derive(serde::Serialize, Default, Debug, PartialEq)]
pub struct BugDto {
    pub id: String,
    pub name: String,
    pub description: String,
    pub status: String,
    pub priority: String,
    pub product: String,
    pub team: String,
    pub category: String,
    pub origin: String,
    /// Ids do Slack. O nome depende de `users:read`; sem o escopo fica o id.
    pub author: String,
    pub author_name: String,
    pub assignee: String,
    pub created_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub cases: Option<i64>,
    pub attachments: i64,
    pub permalink: String,
    pub raw: String,
}

/// Minúsculas e sem acento, pra casar nome de coluna sem depender de grafia.
fn normalizar(s: &str) -> String {
    s.trim()
        .chars()
        .map(|c| match c {
            'á' | 'à' | 'â' | 'ã' | 'ä' | 'Á' | 'À' | 'Â' | 'Ã' => 'a',
            'é' | 'ê' | 'è' | 'ë' | 'É' | 'Ê' => 'e',
            'í' | 'ì' | 'î' | 'ï' | 'Í' => 'i',
            'ó' | 'ô' | 'õ' | 'ò' | 'ö' | 'Ó' | 'Ô' | 'Õ' => 'o',
            'ú' | 'ù' | 'û' | 'ü' | 'Ú' => 'u',
            'ç' | 'Ç' => 'c',
            outro => outro.to_ascii_lowercase(),
        })
        .collect()
}

/// Que coluna é o quê. Os campos tipados saem do `type` do schema, que é
/// inequívoco (`user` é Responsável, `created_by` é Autor). Os `select` só se
/// distinguem pelo nome — menos o Status, que vem do agrupamento da view.
///
/// Nada é obrigatório: coluna que não resolve simplesmente não aparece no
/// cartão, em vez de derrubar o sync.
#[derive(Default, Debug)]
pub struct Mapa {
    primaria: String,
    descricao: String,
    status: String,
    /// `column_id` do status — o `items.update` pede o id, não o `key`.
    status_id: String,
    /// Opções do status na ordem do schema, pra montar o menu.
    status_opcoes: Vec<(String, String)>,
    prioridade: String,
    produto: String,
    time: String,
    categoria: String,
    origem: String,
    responsavel: String,
    autor: String,
    criado: String,
    finalizado: String,
    casos: String,
    anexos: String,
    /// `key` da coluna → (`Opt…` → rótulo).
    rotulos: std::collections::HashMap<String, std::collections::HashMap<String, String>>,
}

impl Mapa {
    /// Monta o mapa a partir do retorno de [`schema`].
    pub fn novo(schema: &serde_json::Value) -> Self {
        let mut m = Mapa::default();
        m.status = schema["coluna_de_status"].as_str().unwrap_or("").to_string();

        let vazio = Vec::new();
        for c in schema["colunas"].as_array().unwrap_or(&vazio) {
            let key = c["key"].as_str().unwrap_or("").to_string();
            let tipo = c["tipo"].as_str().unwrap_or("");
            let nome = normalizar(c["nome"].as_str().unwrap_or(""));
            let primaria = c["primaria"].as_bool().unwrap_or(false);

            if let Some(op) = c["opcoes"].as_object() {
                if !op.is_empty() {
                    m.rotulos.insert(
                        key.clone(),
                        op.iter()
                            .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                            .collect(),
                    );
                }
            }

            if key == m.status {
                m.status_id = c["id"].as_str().unwrap_or("").to_string();
                // A ordem do schema é a ordem que o Slack mostra no menu.
                if let Some(op) = c["opcoes"].as_object() {
                    m.status_opcoes = op
                        .iter()
                        .filter_map(|(id, r)| r.as_str().map(|s| (id.clone(), s.to_string())))
                        .collect();
                }
            }

            match tipo {
                "user" => m.responsavel = key,
                "created_by" => m.autor = key,
                "created_time" => m.criado = key,
                "date" => m.finalizado = key,
                "number" => m.casos = key,
                "attachment" => m.anexos = key,
                "text" if primaria => m.primaria = key,
                "text" => m.descricao = key,
                "select" if key == m.status => {}
                "select" => match nome.as_str() {
                    "prioridade" => m.prioridade = key,
                    "produto" => m.produto = key,
                    "time" => m.time = key,
                    "categoria" => m.categoria = key,
                    "origem" => m.origem = key,
                    _ => {}
                },
                _ => {}
            }
        }

        m
    }

    /// Colunas que o mapa não conseguiu resolver — a UI mostra isso em vez de
    /// deixar o campo sumir sem explicação.
    pub fn faltando(&self) -> Vec<&'static str> {
        [
            (self.primaria.is_empty(), "titulo"),
            (self.status.is_empty(), "status"),
            (self.prioridade.is_empty(), "prioridade"),
            (self.responsavel.is_empty(), "responsavel"),
        ]
        .iter()
        .filter(|(vazio, _)| *vazio)
        .map(|(_, nome)| *nome)
        .collect()
    }
}

/// Acha o campo do item pela `key` da coluna.
fn campo<'a>(item: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
    if key.is_empty() {
        return None;
    }
    item["fields"]
        .as_array()?
        .iter()
        .find(|c| c["key"].as_str() == Some(key))
}

fn texto(item: &serde_json::Value, key: &str) -> String {
    campo(item, key)
        .and_then(|c| c["text"].as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

/// Primeiro id de um campo de lista, tentando várias props.
///
/// A prop do item **não** é o `type` da coluna: uma coluna `created_by` entrega
/// o valor em `user`. Por isso a busca é tolerante e cai em `value` no fim, em
/// vez de assumir que o nome da prop espelha o tipo declarado.
fn primeiro(item: &serde_json::Value, key: &str, props: &[&str]) -> String {
    let Some(c) = campo(item, key) else {
        return String::new();
    };
    for prop in props {
        if let Some(s) = c[*prop].as_array().and_then(|a| a.first()?.as_str()) {
            return s.to_string();
        }
    }
    // `value` costuma repetir o mesmo dado como escalar.
    c["value"].as_str().unwrap_or("").to_string()
}

fn numero(item: &serde_json::Value, key: &str, prop: &str) -> Option<i64> {
    let c = campo(item, key)?;
    c[prop]
        .as_array()
        .and_then(|a| a.first()?.as_i64())
        .or_else(|| c[prop].as_i64())
        .or_else(|| c["value"].as_array().and_then(|a| a.first()?.as_i64()))
        .or_else(|| c["value"].as_i64())
}

/// Traduz o `Opt…` de um select no rótulo. Se não achar, devolve o id cru —
/// visível na tela é melhor que silenciosamente vazio.
fn rotulo(m: &Mapa, item: &serde_json::Value, key: &str) -> String {
    let id = primeiro(item, key, &["select"]);
    if id.is_empty() {
        return String::new();
    }
    m.rotulos
        .get(key)
        .and_then(|r| r.get(&id))
        .cloned()
        .unwrap_or(id)
}

/// Converte um item cru da List num [`BugDto`].
pub fn mapear_item(m: &Mapa, item: &serde_json::Value, base_url: &str, list_id: &str) -> BugDto {
    let id = item["id"].as_str().unwrap_or("").to_string();
    let anexos = campo(item, &m.anexos)
        .and_then(|c| c["attachment"].as_array().map(|a| a.len() as i64))
        .unwrap_or(0);

    BugDto {
        permalink: if base_url.is_empty() || id.is_empty() {
            String::new()
        } else {
            format!(
                "{}/lists/{}?record_id={}",
                base_url.trim_end_matches('/'),
                list_id,
                id
            )
        },
        name: texto(item, &m.primaria),
        description: texto(item, &m.descricao),
        status: rotulo(m, item, &m.status),
        priority: rotulo(m, item, &m.prioridade),
        product: rotulo(m, item, &m.produto),
        team: rotulo(m, item, &m.time),
        category: rotulo(m, item, &m.categoria),
        origin: rotulo(m, item, &m.origem),
        // Coluna `created_by` entrega o valor na prop `user` — não em
        // `created_by`. Foi o que deixou o autor como "—" na primeira versão.
        author: primeiro(item, &m.autor, &["user", "created_by"]),
        author_name: String::new(),
        assignee: primeiro(item, &m.responsavel, &["user"]),
        created_at: numero(item, &m.criado, "timestamp"),
        finished_at: numero(item, &m.finalizado, "date"),
        cases: numero(item, &m.casos, "number"),
        attachments: anexos,
        raw: item.to_string(),
        id,
    }
}

// --- Sync -------------------------------------------------------------------

/// Nome de exibição de cada autor, via `users.info`. Exige `users:read`; sem o
/// escopo devolve mapa vazio e o cartão mostra o id — degradar é melhor que
/// derrubar o sync por um campo cosmético.
async fn nomes_dos_autores(
    token: &str,
    ids: &[String],
) -> std::collections::HashMap<String, String> {
    let mut nomes = std::collections::HashMap::new();
    for id in ids {
        match get(token, "users.info", &[("user", id)]).await {
            Ok(v) => {
                let u = &v["user"];
                let nome = u["profile"]["display_name"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .or_else(|| u["profile"]["real_name"].as_str())
                    .or_else(|| u["real_name"].as_str())
                    .or_else(|| u["name"].as_str())
                    .unwrap_or("");
                if !nome.is_empty() {
                    nomes.insert(id.clone(), nome.to_string());
                }
            }
            // Falta de escopo ou usuário inacessível: segue sem o nome.
            Err(_) => return nomes,
        }
    }
    nomes
}

/// Fila de bugs onde o dono do token é o Responsável.
///
/// Um único fetch paginado da List inteira (a mesma regra do sync do ClickUp:
/// nunca um request por item), filtrando localmente pela coluna Responsável —
/// a API não filtra por campo.
pub async fn sync_bugs(token: &str, list_id: &str) -> Result<serde_json::Value, String> {
    let auth = auth_test(token).await?;
    let eu = auth["user_id"].as_str().unwrap_or("").to_string();
    if eu.is_empty() {
        return Err("Nao consegui identificar seu usuario no Slack.".into());
    }
    let base_url = auth["url"].as_str().unwrap_or("").to_string();

    let esquema = schema(token, list_id).await?;
    let mapa = Mapa::novo(&esquema);
    if mapa.responsavel.is_empty() {
        return Err("A List nao tem coluna de Responsavel (tipo `user`) — sem ela nao \
                    da pra montar a sua fila."
            .into());
    }

    let mut bugs: Vec<BugDto> = Vec::new();
    let mut cursor: Option<String> = None;
    let mut paginas = 0;

    // Teto de páginas: a List tem ~340 linhas ativas; 20 páginas de 100 é
    // folga larga e evita loop infinito se o cursor vier repetido.
    loop {
        let pagina = items_page(token, list_id, cursor.as_deref(), 100).await?;
        paginas += 1;

        let vazio = Vec::new();
        for item in pagina["items"].as_array().unwrap_or(&vazio) {
            let bug = mapear_item(&mapa, item, &base_url, list_id);
            if bug.assignee == eu {
                bugs.push(bug);
            }
        }

        let proximo = pagina["response_metadata"]["next_cursor"]
            .as_str()
            .unwrap_or("")
            .to_string();
        if proximo.is_empty() || paginas >= 20 {
            break;
        }
        cursor = Some(proximo);
    }

    // Nome dos autores: só os distintos, e só dos bugs que sobraram no filtro.
    let mut autores: Vec<String> = bugs.iter().map(|b| b.author.clone()).collect();
    autores.retain(|a| !a.is_empty());
    autores.sort();
    autores.dedup();
    let nomes = nomes_dos_autores(token, &autores).await;
    for bug in &mut bugs {
        bug.author_name = nomes.get(&bug.author).cloned().unwrap_or_default();
    }

    Ok(serde_json::json!({
        "eu": eu,
        "bugs": bugs,
        "paginas": paginas,
        "colunas_faltando": mapa.faltando(),
        "nomes_resolvidos": !nomes.is_empty(),
        "status_opcoes": mapa
            .status_opcoes
            .iter()
            .map(|(id, rotulo)| serde_json::json!({ "id": id, "rotulo": rotulo }))
            .collect::<Vec<_>>(),
    }))
}

/// Opções da coluna de status, para o menu de troca.
///
/// Existe separado do `sync_bugs` porque o menu carrega sob demanda ao abrir —
/// mesmo padrão do `loadListStatuses` do ClickUp. Sem isso, reabrir a janela
/// deixava a pill sem opções e portanto não clicável.
pub async fn status_options(token: &str, list_id: &str) -> Result<serde_json::Value, String> {
    let esquema = schema(token, list_id).await?;
    let mapa = Mapa::novo(&esquema);
    if mapa.status_opcoes.is_empty() {
        return Err("A coluna de status da List nao tem opcoes legiveis.".into());
    }
    Ok(serde_json::json!(mapa
        .status_opcoes
        .iter()
        .map(|(id, rotulo)| serde_json::json!({ "id": id, "rotulo": rotulo }))
        .collect::<Vec<_>>()))
}

/// Grava o status de um bug na List (`lists:write`).
///
/// A coluna e o id da opção são resolvidos do schema **na hora da escrita**, em
/// vez de confiar num id que o frontend carregou no último sync: se alguém
/// renomear ou remover a opção no Slack, isso falha em vez de gravar errado.
/// Mesma disciplina do `set_task_status` do ClickUp.
pub async fn set_bug_status(
    token: &str,
    list_id: &str,
    row_id: &str,
    option_id: &str,
) -> Result<(), String> {
    let esquema = schema(token, list_id).await?;
    let mapa = Mapa::novo(&esquema);

    if mapa.status_id.is_empty() {
        return Err("Nao achei a coluna de status na List.".into());
    }
    if !mapa.status_opcoes.iter().any(|(id, _)| id == option_id) {
        return Err(format!(
            "A opcao {option_id} nao existe mais na coluna de status — \
             sincronize a fila antes de tentar de novo."
        ));
    }

    let corpo = serde_json::json!({
        "list_id": list_id,
        "cells": [{
            "row_id": row_id,
            "column_id": mapa.status_id,
            "select": [option_id],
        }],
    });

    let resp = reqwest::Client::new()
        .post(format!("{API}/slackLists.items.update"))
        .header("Authorization", format!("Bearer {token}"))
        .json(&corpo)
        .send()
        .await
        .map_err(|e| format!("Falha de rede ao gravar o status no Slack: {e}"))?;

    if !resp.status().is_success() {
        let code = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Slack respondeu HTTP {code}: {body}"));
    }

    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Resposta inesperada do Slack: {e}"))?;
    check_ok(v, "slackLists.items.update").map(|_| ())
}

// --- Diagnóstico ------------------------------------------------------------

/// Resumo de um campo: o `key`, o `column_id`, que tipos de valor apareceram e
/// os valores de fato. `key` e `column_id` são identificadores, não valores:
/// ficam fora de `valores`.
fn resumir_campo(campo: &serde_json::Value) -> (String, String, Vec<String>, serde_json::Value) {
    let key = campo["key"].as_str().unwrap_or("(sem key)").to_string();
    let column_id = campo["column_id"].as_str().unwrap_or("").to_string();
    let mut tipos = Vec::new();
    let mut valores = serde_json::Map::new();

    if let Some(obj) = campo.as_object() {
        for (k, v) in obj {
            if k == "key" || k == "column_id" || v.is_null() {
                continue;
            }
            // Array vazio é campo em branco, não um tipo de valor.
            if v.as_array().is_some_and(|a| a.is_empty()) {
                continue;
            }
            if k != "value" {
                tipos.push(k.clone());
            }
            valores.insert(k.clone(), truncar(v));
        }
    }

    (key, column_id, tipos, serde_json::Value::Object(valores))
}

/// Diagnóstico: primeira página da List, com o inventário dos campos e uma
/// amostra crua. Andaime — sai quando a fila estiver desenhada.
pub async fn diagnose(token: &str, list_id: &str) -> Result<serde_json::Value, String> {
    let auth = auth_test(token).await?;
    let pagina = items_page(token, list_id, None, 5).await?;

    let vazio = Vec::new();
    let itens = pagina["items"].as_array().unwrap_or(&vazio);

    // Um campo por `key`, na ordem em que aparecem. Um mesmo campo pode vir
    // vazio num item e preenchido no próximo — a primeira ocorrência com valor
    // ganha da que veio em branco.
    let mut campos: Vec<serde_json::Value> = Vec::new();

    for item in itens {
        let sem_campos = Vec::new();
        for campo in item["fields"].as_array().unwrap_or(&sem_campos) {
            let (key, column_id, tipos, valores) = resumir_campo(campo);
            let tem_valor = !tipos.is_empty();
            let novo = serde_json::json!({
                "key": key,
                "column_id": column_id,
                "tipos": tipos,
                "valores": valores,
            });

            match campos.iter().position(|c| c["key"] == novo["key"]) {
                Some(i) => {
                    let vazio = campos[i]["tipos"].as_array().is_some_and(|a| a.is_empty());
                    if vazio && tem_valor {
                        campos[i] = novo;
                    }
                }
                None => campos.push(novo),
            }
        }
    }

    Ok(serde_json::json!({
        "auth": auth,
        "itens_na_pagina": itens.len(),
        "tem_proxima_pagina": pagina["response_metadata"]["next_cursor"]
            .as_str()
            .is_some_and(|c| !c.is_empty()),
        "campos": campos,
        "amostra_crua": itens.iter().take(2).map(truncar).collect::<Vec<_>>(),
    }))
}

// --- Entrada do usuário -----------------------------------------------------

/// Valida o formato do User OAuth Token do Slack. Bot token (`xoxb-`) não
/// serve aqui: a List é compartilhada com pessoas, não com o app.
pub fn validate_token(token: &str) -> Result<&str, String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("Informe o User OAuth Token do Slack.".into());
    }
    if token.starts_with("xoxb-") {
        return Err("Esse é um Bot Token. Use o User OAuth Token (xoxp-).".into());
    }
    if !token.starts_with("xoxp-") {
        return Err("Token de usuário do Slack deve comecar com 'xoxp-'.".into());
    }
    Ok(token)
}

/// Aceita a URL da List ou o id cru (`F08NTEW4H3R`).
pub fn parse_list_id(input: &str) -> Option<String> {
    let input = input.trim();
    if input.is_empty() {
        return None;
    }
    // .../lists/T08JX0WVDND/F08NTEW4H3R?record_id=... → pega o segmento F...
    let candidato = input
        .split(['?', '#'])
        .next()
        .unwrap_or(input)
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(input);

    let ok = candidato.starts_with('F')
        && candidato.len() >= 9
        && candidato[1..].chars().all(|c| c.is_ascii_alphanumeric());

    ok.then(|| candidato.to_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::{
        check_ok, coluna_do_schema, extrair_opcoes, parse_list_id, resumir_campo, truncar,
        validate_token,
    };

    /// Schema reduzido da List real "Solicitações — Bugs".
    fn esquema_real() -> serde_json::Value {
        serde_json::json!({
            "coluna_de_status": "Col07QP7FEP4M",
            "colunas": [
                { "key": "name", "nome": "Name", "tipo": "text", "primaria": true, "opcoes": {} },
                { "key": "Col07QP76TBQD", "nome": "Descrição", "tipo": "text", "primaria": false, "opcoes": {} },
                { "key": "Col07QP7C0V45", "nome": "Responsável", "tipo": "user", "primaria": false, "opcoes": {} },
                { "key": "Col07QKEDLLAJ", "nome": "Data de criação", "tipo": "created_time", "primaria": false, "opcoes": {} },
                { "key": "Col07QKE8AVP0", "nome": "Prioridade", "tipo": "select", "primaria": false,
                  "opcoes": { "OptT6D4G0LP": "Alta", "OptYYB79DT0": "Média", "Opt1U1H8FRP": "Baixa" } },
                { "key": "Col07QP7FEP4M", "id": "Col08NTEW692B", "nome": "Status", "tipo": "select", "primaria": false,
                  "opcoes": { "OptLKAALRN6": "PENDENTE DE ANÁLISE", "OptBIXZNMOQ": "IMPEDIDO" } },
                { "key": "Col07R4P97PPB", "nome": "Autor", "tipo": "created_by", "primaria": false, "opcoes": {} },
                { "key": "Col08PRRKCP1P", "nome": "Anexos", "tipo": "attachment", "primaria": false, "opcoes": {} },
                { "key": "Col08QLHYBDK6", "nome": "Produto", "tipo": "select", "primaria": false,
                  "opcoes": { "OptLV9M9ONA": "Dados" } },
                { "key": "Col08S75NBA6P", "nome": "Time", "tipo": "select", "primaria": false,
                  "opcoes": { "OptC9YBDYRT": "@canais-revenue @Iago Mota" } },
                { "key": "Col09P0UHMZ6G", "nome": "Quantidade de Casos", "tipo": "number", "primaria": false, "opcoes": {} },
                { "key": "Col0AF8UWGBSL", "nome": "Data de Finalização", "tipo": "date", "primaria": false, "opcoes": {} },
                { "key": "Col0AR6JMSP6C", "nome": "Origem", "tipo": "select", "primaria": false,
                  "opcoes": { "OptU45P27VH": "Interno" } },
                { "key": "Col0AQCB34HNW", "nome": "Categoria", "tipo": "select", "primaria": false,
                  "opcoes": { "OptFRBBJWXD": "Erro de scraping / seletor CSS" } },
            ]
        })
    }

    /// O item real que amostramos da List (Brito → Iglan).
    fn item_real() -> serde_json::Value {
        serde_json::json!({
            "id": "Rec0BLMJQG55G",
            "fields": [
                { "key": "name", "text": "Acompanhamento zangão sem docs" },
                { "key": "Col07QP76TBQD", "text": "Esse acompanhamento foi criado sem RG ou CNH, apenas com contracheque." },
                { "key": "Col07QKE8AVP0", "select": ["OptYYB79DT0"] },
                { "key": "Col07QP7FEP4M", "select": ["OptLKAALRN6"] },
                { "key": "Col08S75NBA6P", "select": ["OptC9YBDYRT"] },
                { "key": "Col08QLHYBDK6", "select": ["OptLV9M9ONA"] },
                { "key": "Col07QKEDLLAJ", "timestamp": [1785334988] },
                // A coluna é `created_by` no schema, mas o item traz `user`.
                { "key": "Col07R4P97PPB", "user": ["U08NTN41WM8"], "value": "U08NTN41WM8" },
                { "key": "Col07QP7C0V45", "user": ["U08NQPUA5N3"] },
                { "key": "Col08PRRKCP1P", "attachment": ["F0BLK3YPPQE", "F0BLP1JMRB3"] },
                { "key": "Col0AR6JMSP6C" },
            ]
        })
    }

    #[test]
    fn mapa_resolve_as_colunas_pelo_tipo_e_pelo_nome() {
        let m = super::Mapa::novo(&esquema_real());
        // `user` é Responsável e `created_by` é Autor: o tipo desempata sem
        // depender do nome da coluna.
        assert_eq!(m.responsavel, "Col07QP7C0V45");
        assert_eq!(m.autor, "Col07R4P97PPB");
        assert_eq!(m.primaria, "name");
        assert_eq!(m.descricao, "Col07QP76TBQD");
        assert_eq!(m.status, "Col07QP7FEP4M");
        assert_eq!(m.prioridade, "Col07QKE8AVP0");
        assert_eq!(m.produto, "Col08QLHYBDK6");
        assert_eq!(m.time, "Col08S75NBA6P");
        assert_eq!(m.categoria, "Col0AQCB34HNW");
        assert_eq!(m.origem, "Col0AR6JMSP6C");
        assert_eq!(m.casos, "Col09P0UHMZ6G");
        assert_eq!(m.finalizado, "Col0AF8UWGBSL");
        assert!(m.faltando().is_empty(), "nada essencial deve faltar: {:?}", m.faltando());
    }

    #[test]
    fn mapeia_o_item_real_com_rotulos_traduzidos() {
        let m = super::Mapa::novo(&esquema_real());
        let bug = super::mapear_item(
            &m,
            &item_real(),
            "https://konsi-workspace.slack.com/",
            "F08NTEW4H3R",
        );

        assert_eq!(bug.name, "Acompanhamento zangão sem docs");
        assert_eq!(bug.priority, "Média");
        assert_eq!(bug.status, "PENDENTE DE ANÁLISE");
        assert_eq!(bug.product, "Dados");
        assert_eq!(bug.team, "@canais-revenue @Iago Mota");
        assert_eq!(bug.author, "U08NTN41WM8");
        assert_eq!(bug.assignee, "U08NQPUA5N3");
        assert_eq!(bug.created_at, Some(1785334988));
        assert_eq!(bug.attachments, 2);
        assert_eq!(bug.cases, None, "coluna ausente no item nao inventa valor");
        assert_eq!(bug.origin, "", "campo em branco fica vazio");
        assert_eq!(
            bug.permalink,
            "https://konsi-workspace.slack.com/lists/F08NTEW4H3R?record_id=Rec0BLMJQG55G"
        );
    }

    #[test]
    fn guarda_o_column_id_do_status_separado_do_key() {
        // O items.update pede `column_id`; o item traz `key`. São diferentes:
        // gravar usando o key escreveria na coluna errada (ou em nenhuma).
        let m = super::Mapa::novo(&esquema_real());
        assert_eq!(m.status, "Col07QP7FEP4M", "key, usado pra ler o item");
        assert_eq!(m.status_id, "Col08NTEW692B", "column_id, usado pra escrever");
        assert_ne!(m.status, m.status_id);
    }

    #[test]
    fn expoe_as_opcoes_de_status_para_o_menu() {
        let m = super::Mapa::novo(&esquema_real());
        let ids: Vec<&str> = m.status_opcoes.iter().map(|(id, _)| id.as_str()).collect();
        assert!(ids.contains(&"OptLKAALRN6"));
        assert!(ids.contains(&"OptBIXZNMOQ"));
        let rotulos: Vec<&str> = m.status_opcoes.iter().map(|(_, r)| r.as_str()).collect();
        assert!(rotulos.contains(&"IMPEDIDO"));
    }

    #[test]
    fn autor_vem_da_prop_user_apesar_do_tipo_created_by() {
        // Regressão: eu buscava a prop "created_by" e o autor saía vazio ("—").
        let m = super::Mapa::novo(&esquema_real());
        let bug = super::mapear_item(&m, &item_real(), "", "F1");
        assert_eq!(bug.author, "U08NTN41WM8");
        assert_ne!(bug.author, bug.assignee, "autor e responsavel sao colunas distintas");
    }

    #[test]
    fn cai_em_value_quando_a_prop_esperada_nao_existe() {
        let m = super::Mapa::novo(&esquema_real());
        let item = serde_json::json!({
            "id": "Rec9",
            "fields": [{ "key": "Col07QP7C0V45", "value": "U0SOZINHO" }]
        });
        let bug = super::mapear_item(&m, &item, "", "F1");
        assert_eq!(bug.assignee, "U0SOZINHO");
    }

    #[test]
    fn opt_sem_rotulo_mostra_o_id_em_vez_de_sumir() {
        let m = super::Mapa::novo(&esquema_real());
        let item = serde_json::json!({
            "id": "Rec1",
            "fields": [{ "key": "Col07QP7FEP4M", "select": ["OptDESCONHECIDO"] }]
        });
        let bug = super::mapear_item(&m, &item, "", "F1");
        assert_eq!(bug.status, "OptDESCONHECIDO");
    }

    #[test]
    fn mapa_sem_coluna_de_responsavel_e_reportado() {
        let esquema = serde_json::json!({
            "coluna_de_status": "",
            "colunas": [{ "key": "name", "nome": "Name", "tipo": "text", "primaria": true, "opcoes": {} }]
        });
        let m = super::Mapa::novo(&esquema);
        let faltando = m.faltando();
        assert!(faltando.contains(&"responsavel"));
        assert!(faltando.contains(&"status"));
        assert!(faltando.contains(&"prioridade"));
    }

    #[test]
    fn normalizar_ignora_acento_e_caixa() {
        assert_eq!(super::normalizar("Descrição"), "descricao");
        assert_eq!(super::normalizar(" Responsável "), "responsavel");
        assert_eq!(super::normalizar("CATEGORIA"), "categoria");
    }

    #[test]
    fn aceita_user_token() {
        assert_eq!(validate_token("  xoxp-123  "), Ok("xoxp-123"));
    }

    #[test]
    fn rejeita_bot_token_com_dica() {
        let erro = validate_token("xoxb-123").unwrap_err();
        assert!(erro.contains("xoxp-"), "erro deve apontar o token certo: {erro}");
    }

    #[test]
    fn rejeita_token_vazio_ou_sem_prefixo() {
        assert!(validate_token("   ").is_err());
        assert!(validate_token("abc123").is_err());
    }

    #[test]
    fn extrai_list_id_da_url() {
        let url = "https://konsi-workspace.slack.com/lists/T08JX0WVDND/F08NTEW4H3R?record_id=Rec0BL";
        assert_eq!(parse_list_id(url), Some("F08NTEW4H3R".into()));
    }

    #[test]
    fn aceita_list_id_cru() {
        assert_eq!(parse_list_id("F08NTEW4H3R"), Some("F08NTEW4H3R".into()));
        assert_eq!(parse_list_id("f08ntew4h3r"), None, "id deve comecar com F");
    }

    #[test]
    fn rejeita_entrada_que_nao_e_list() {
        assert_eq!(parse_list_id(""), None);
        assert_eq!(parse_list_id("C08PL8NQBQR"), None, "canal nao e List");
    }

    #[test]
    fn ok_falso_vira_erro_acionavel() {
        let v = serde_json::json!({ "ok": false, "error": "missing_scope" });
        let erro = check_ok(v, "files.info").unwrap_err();
        assert!(erro.contains("files:read"), "erro deve dizer o escopo: {erro}");
    }

    #[test]
    fn ok_verdadeiro_passa_direto() {
        let v = serde_json::json!({ "ok": true, "items": [] });
        assert!(check_ok(v, "slackLists.items.list").is_ok());
    }

    #[test]
    fn exemplo_nao_pode_ser_o_column_id() {
        // Regressão: o resumo mostrava "Col08…" como valor de todo campo,
        // porque column_id vem antes do valor real na ordem do JSON.
        let campo = serde_json::json!({
            "key": "Col07R4P97PPB",
            "column_id": "Col08NTEW6C3H",
            "value": ["U08NBFPRD6U"],
            "user": ["U08NBFPRD6U"],
        });
        let (key, column_id, tipos, valores) = resumir_campo(&campo);
        assert_eq!(key, "Col07R4P97PPB");
        assert_eq!(column_id, "Col08NTEW6C3H");
        assert_eq!(tipos, vec!["user"], "`value` nao e um tipo, e o valor cru");
        assert!(valores.get("column_id").is_none(), "id nao e valor");
        assert_eq!(valores["user"], serde_json::json!(["U08NBFPRD6U"]));
    }

    #[test]
    fn campo_em_branco_nao_declara_tipo() {
        let campo = serde_json::json!({ "key": "Col0AR6JMSP6C", "column_id": "Col0AQ8TVV50D" });
        let (_, _, tipos, valores) = resumir_campo(&campo);
        assert!(tipos.is_empty());
        assert_eq!(valores, serde_json::json!({}));
    }

    #[test]
    fn trunca_texto_longo_mantendo_a_forma() {
        let longo = "a".repeat(400);
        let v = truncar(&serde_json::json!({ "text": longo }));
        let texto = v["text"].as_str().unwrap();
        assert!(texto.chars().count() <= 161, "cortou: {}", texto.chars().count());
        assert!(texto.ends_with('…'));
    }

    #[test]
    fn trunca_sem_quebrar_caractere_multibyte() {
        let longo = "ç".repeat(400);
        let v = truncar(&serde_json::json!(longo));
        assert!(v.as_str().unwrap().starts_with('ç'));
    }

    #[test]
    fn extrai_rotulos_de_select_no_formato_choices() {
        let options = serde_json::json!({
            "choices": [
                { "value": "OptYYB79DT0", "label": "Alta", "color": "red" },
                { "value": "OptLKAALRN6", "label": "Média" },
            ]
        });
        let mapa = extrair_opcoes(&options);
        assert_eq!(mapa.get("OptYYB79DT0").map(String::as_str), Some("Alta"));
        assert_eq!(mapa.get("OptLKAALRN6").map(String::as_str), Some("Média"));
    }

    #[test]
    fn extrai_rotulos_com_id_e_name_em_vez_de_value_e_label() {
        // A forma exata de `options` não é documentada — a extração tolera
        // as variações plausíveis em vez de exigir uma só.
        let options = serde_json::json!({
            "options": [{ "id": "OptXZ1OS4M8", "name": "Concluído" }]
        });
        let mapa = extrair_opcoes(&options);
        assert_eq!(mapa.get("OptXZ1OS4M8").map(String::as_str), Some("Concluído"));
    }

    #[test]
    fn options_sem_array_de_objetos_nao_inventa_nada() {
        // Coluna de texto: `options` é só `{"format":"text"}`.
        assert!(extrair_opcoes(&serde_json::json!({ "format": "text" })).is_empty());
        assert!(extrair_opcoes(&serde_json::json!(null)).is_empty());
    }

    #[test]
    fn coluna_do_schema_preserva_o_cru_para_conferencia() {
        let entrada = serde_json::json!({
            "id": "Col08NTEW5JQ7",
            "key": "Col07QP7C0V45",
            "name": "Responsável",
            "type": "user",
            "is_primary_column": false,
            "options": { "format": "single_entity", "show_member_name": true },
        });
        let c = coluna_do_schema(&entrada);
        assert_eq!(c["nome"], "Responsável");
        assert_eq!(c["tipo"], "user");
        assert_eq!(c["key"], "Col07QP7C0V45");
        assert_eq!(c["primaria"], false);
        assert_eq!(c["options_bruto"]["format"], "single_entity");
    }
}
