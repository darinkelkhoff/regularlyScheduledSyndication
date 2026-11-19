ALTER TABLE sources ADD COLUMN background_checked_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN background_processed_at INTEGER NOT NULL DEFAULT 0;
CREATE TABLE background_job (id INTEGER PRIMARY KEY CHECK (id = 1), claim TEXT, lease_until INTEGER NOT NULL DEFAULT 0);
INSERT INTO background_job (id) VALUES (1);
CREATE INDEX sources_background ON sources(next_check_at, background_checked_at);
