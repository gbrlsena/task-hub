-- Foco (pin) passa a valer para bug tambem, nao so para task do ClickUp.
--
-- A tabela `focus` tinha uma linha por task_id. Bug e task nunca colidiriam por
-- id (Rec... vs numerico), mas sem `kind` a lista de fixados do hub e a da fila
-- de bugs se misturariam nas consultas. A coluna separa os dois dominios e a
-- ordem manual de cada um fica independente.
--
-- Default 'task' preserva o que ja estava fixado.

ALTER TABLE focus ADD COLUMN kind TEXT NOT NULL DEFAULT 'task';

CREATE INDEX IF NOT EXISTS idx_focus_kind ON focus (kind, position);
