CREATE TABLE local_feeds (subscription_id TEXT PRIMARY KEY NOT NULL REFERENCES subscriptions(id), token_hash TEXT NOT NULL UNIQUE, token_ciphertext TEXT NOT NULL, xml_object_key TEXT NOT NULL, version INTEGER NOT NULL CHECK (version >= 0), mutation_id TEXT NOT NULL);
ALTER TABLE publication_outbox ADD COLUMN attempted_at INTEGER NOT NULL DEFAULT 0;
