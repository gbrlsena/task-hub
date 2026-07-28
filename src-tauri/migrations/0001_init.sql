-- Schema inicial (spec §1.5). Estado local que precisa sobreviver a restart.

CREATE TABLE IF NOT EXISTS task_cache (
  id            TEXT PRIMARY KEY,
  custom_id     TEXT,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL,
  priority      INTEGER,
  list_id       TEXT NOT NULL,
  list_name     TEXT NOT NULL,
  due_date      INTEGER,
  assignees     TEXT NOT NULL,
  raw           TEXT NOT NULL,
  fetched_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS list_status_cache (
  list_id     TEXT PRIMARY KEY,
  statuses    TEXT NOT NULL,
  fetched_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS focus (
  task_id     TEXT PRIMARY KEY,
  position    INTEGER NOT NULL,
  pinned_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS note (
  id          TEXT PRIMARY KEY,
  body        TEXT NOT NULL,
  done        INTEGER NOT NULL DEFAULT 0,
  position    INTEGER,
  created_at  INTEGER NOT NULL,
  promoted_to TEXT
);
