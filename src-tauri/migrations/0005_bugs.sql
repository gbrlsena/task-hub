-- Fila de bugs da Slack List "Solicitacoes - Bugs" (canal #bugs).
--
-- Cache local do que a List devolve, ja com os rotulos resolvidos: o
-- items.list do Slack entrega select como id opaco (`Opt...`) e a traducao vem
-- do schema, resolvida em runtime. Aqui guardamos o rotulo legivel.
--
-- Escopo `lists:read` e so leitura: o app nunca escreve na List. Anotacoes e
-- lembretes de bug reusam as tabelas `comment`/`reminder` com
-- subject_kind = 'bug' (a coluna e TEXT livre, sem CHECK).

CREATE TABLE IF NOT EXISTS bug_cache (
  id           TEXT PRIMARY KEY,   -- record_id da List (Rec...)
  list_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT '',
  priority     TEXT NOT NULL DEFAULT '',
  product      TEXT NOT NULL DEFAULT '',
  team         TEXT NOT NULL DEFAULT '',
  category     TEXT NOT NULL DEFAULT '',
  origin       TEXT NOT NULL DEFAULT '',
  author       TEXT NOT NULL DEFAULT '',
  author_name  TEXT NOT NULL DEFAULT '',
  assignee     TEXT NOT NULL DEFAULT '',
  created_at   INTEGER,
  finished_at  INTEGER,
  cases        INTEGER,
  attachments  INTEGER NOT NULL DEFAULT 0,
  permalink    TEXT NOT NULL DEFAULT '',
  raw          TEXT NOT NULL,
  fetched_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bug_status ON bug_cache (status);
