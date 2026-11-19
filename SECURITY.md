# Security

Please report security issues privately to the repository owner rather than
including credentials, feed URLs, or account data in public issues.

Source URLs and feed snapshots are encrypted at rest with an installation key.
A custom feed URL is a bearer credential: anyone with that URL can read its
contents. Treat source URLs, custom feed URLs, recovery codes, database exports,
and the SOURCE_SECRET encryption key as sensitive.

Account recovery invalidates sessions and replaces the recovery code. Existing
passkeys remain registered; review and remove any lost or untrusted passkeys
after recovering your account.

Keep R2 buckets private. Use independent databases and buckets for each
environment. Never commit local databases, .local, .wrangler, .dev.vars, keys,
or backup files. Keep the encryption key in a secret store and retain a secure
backup; losing it makes encrypted data unreadable.
