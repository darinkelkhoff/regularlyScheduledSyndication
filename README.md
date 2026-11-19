# RegSched

Regularly Scheduled Syndication releases episodes from a podcast feed on your
schedule. Work through a back catalog, plan a slow binge, or revisit selected
episodes in your existing podcast app.

- Import a podcast RSS URL and choose the episodes you want.
- Schedule daily, weekly, or interval releases in your time zone.
- Subscribe to your custom RSS feed in your podcast app.
- Pause, resume, change the schedule, or remove a podcast.
- Sign in using passkeys, with a recovery code for account recovery.
- Administrators can manage signup and accounts, and view account/feed counts.

## Local development

Requires Node.js 24 or newer and npm.

```sh
npm ci
npm run dev
```

Open http://localhost:8787. Local databases, encryption keys, and the initial
administrator setup secret are created under `.local/`; the setup secret is
in `.local/dev-config.json`. Keep this directory private. The development
server binds to loopback. No Cloudflare account is needed for local testing.

The first administrator uses the setup secret during registration. Save the
account recovery code when it is displayed. Public signup closes after the
initial administrator is registered and can be opened in Administration.

```sh
npm run typecheck
npm run build
npm test
npx playwright install chromium
npm run test:browser
```

Integration tests use disposable Miniflare D1 databases and require local
loopback sockets. Browser tests use a separate local server on port 8788.
Tests use synthetic feeds and software authenticators; manual testing with
real passkeys and podcast apps is also useful.

## Cloudflare deployment

The Worker uses D1, a private R2 bucket, static assets, and a once-per-minute
scheduled handler. The included Wrangler configurations are templates; replace
example hostnames and database IDs before deployment. Use independent databases
and buckets for staging and production.

1. Authenticate Wrangler and create a D1 database and private R2 bucket for each
   environment. Put their names/IDs in the matching configuration.
2. Set `ORIGIN` to the exact HTTPS site origin and `RP_ID` to its hostname. Update
   production custom-domain routes. Passkeys are bound to the configured RP ID.
3. Generate a cryptographically random 32-byte base64url `SOURCE_SECRET` and a
   separate random `ADMIN_SETUP_SECRET`. Store them with `wrangler secret put`
   (add `--config wrangler.production.jsonc` for production). Do not put secrets
   in configuration files. Keep a secure backup of `SOURCE_SECRET`.
4. Apply all migrations before deploying code: `npm run migrate:staging`, then
   `npm run deploy:staging`. Verify staging before running the corresponding
   production commands.
5. Register the first administrator using the setup secret, save the recovery
   code, and review public signup settings.

Keep R2 public access and r2.dev disabled. Custom RSS URLs are bearer credentials:
anyone with the URL can read the feed. RSS references original audio URLs; this
app does not host or copy podcast audio. Import only feeds you are entitled to
access and respect the publisher's terms.

## Security and architecture

See [SECURITY.md](SECURITY.md) for sensitive data handling and reporting.
React provides the web UI, Hono serves the API, and SimpleWebAuthn handles
passkeys. Source URLs and saved RSS snapshots use owner-bound AES-GCM encryption.
D1 holds schedules and immutable release history; version checks fence competing
publication attempts. The encryption key must persist across deployments.

The importer limits feed size, XML complexity, episode count (2,000), redirects,
and network destinations. Hosted fetching requires Cloudflare's
`global_fetch_strictly_public` compatibility flag; do not add private-network
bindings without re-evaluating the importer's network policy.

Recovery invalidates existing sessions but retains registered passkeys. Review
and remove lost passkeys after recovering an account. Old accounts may have
unrecorded creation/sign-in dates; activity tracking does not invent history.

## License

[MIT](LICENSE). Third-party dependencies retain their respective licenses.
