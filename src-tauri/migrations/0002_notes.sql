-- Subtasks: id da task pai (null no topo).
ALTER TABLE task_cache ADD COLUMN parent TEXT;

-- Camada privada local (nunca vai pro ClickUp).
-- Comentario: historico datado, imutavel.
CREATE TABLE IF NOT EXISTS comment (
  id           TEXT PRIMARY KEY,
  subject_id   TEXT NOT NULL,
  subject_kind TEXT NOT NULL,   -- 'task' | 'note'
  body         TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reminder (
  id           TEXT PRIMARY KEY,
  subject_id   TEXT NOT NULL,
  subject_kind TEXT NOT NULL,   -- 'task' | 'note'
  body         TEXT,
  remind_at    INTEGER NOT NULL,
  dismissed    INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comment_subject ON comment (subject_id);
CREATE INDEX IF NOT EXISTS idx_reminder_subject ON reminder (subject_id);
