-- type do status (open | custom | closed | done) para detectar "concluída"
-- sem hardcodar strings (§1.3). Populado no proximo sync.
ALTER TABLE task_cache ADD COLUMN status_type TEXT NOT NULL DEFAULT '';
