ALTER TABLE sources ADD COLUMN draft_expires_at INTEGER;
UPDATE sources SET draft_expires_at = 0 WHERE NOT EXISTS (SELECT 1 FROM subscriptions WHERE source_id = sources.id);
CREATE INDEX sources_draft_expiry ON sources(user_id, draft_expires_at);
