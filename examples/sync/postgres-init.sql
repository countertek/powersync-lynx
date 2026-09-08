CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

ALTER TABLE todos REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'powersync') THEN
    CREATE PUBLICATION powersync FOR TABLE todos;
  END IF;
END
$$;
