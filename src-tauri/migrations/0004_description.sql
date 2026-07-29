-- Descricao da task (texto puro do ClickUp). Ja vinha no payload do sync e
-- era descartada dentro de `raw`. Populado no proximo sync.
ALTER TABLE task_cache ADD COLUMN description TEXT NOT NULL DEFAULT '';
