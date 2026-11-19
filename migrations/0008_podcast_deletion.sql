CREATE TABLE podcast_deletions (subscription_id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, source_id TEXT NOT NULL, mutation_id TEXT NOT NULL, xml_object_key TEXT, requested_at INTEGER NOT NULL, cleanup_attempted_at INTEGER NOT NULL DEFAULT 0);
DROP TRIGGER releases_no_delete;
CREATE TRIGGER releases_no_delete BEFORE DELETE ON releases WHEN NOT EXISTS (SELECT 1 FROM podcast_deletions WHERE subscription_id = OLD.subscription_id) BEGIN SELECT RAISE(ABORT, 'Delivery history is immutable'); END;
