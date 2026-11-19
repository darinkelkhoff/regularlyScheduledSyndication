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

## Deploy to your own Cloudflare account

The app runs as a **Cloudflare Worker**, with a D1 database, a private R2 bucket,
static assets, and a once-per-minute scheduled handler. You do not need the
maintainer's account, resources, or secrets. A custom domain is optional.

### 1. Prerequisites and clone

You need Git, Node.js 24 or newer, npm, and a Cloudflare account with permission
to manage Workers, D1, and R2. Enable an [R2 subscription](https://developers.cloudflare.com/r2/get-started/)
in your account before creating the bucket; Cloudflare usage charges may apply.
Wrangler is included in the project's development dependencies.

```sh
git clone https://github.com/darinkelkhoff/regularlyScheduledSyndication.git
cd regularlyScheduledSyndication
npm ci
npx wrangler login
npx wrangler whoami
```

Confirm that Wrangler is using **your** intended account. If you have access to
multiple accounts, add your account ID as `account_id` in the configuration.

The following steps create one independent installation using
`wrangler.production.jsonc`. The repository's committed configurations contain
placeholder domains and database IDs that you must replace.

### 2. Create the database and private bucket

```sh
npx wrangler d1 create regsched-production --config wrangler.production.jsonc --update-config=false
npx wrangler r2 bucket create regsched-production-feeds --config wrangler.production.jsonc
```

Copy the database ID printed by the first command into
`d1_databases[0].database_id` in `wrangler.production.jsonc`. The database name
must match `d1_databases[0].database_name`, and the bucket name must match
`r2_buckets[0].bucket_name`. Keep the binding names **`DB`**, **`FEEDS`**, and
**`ASSETS`** unchanged; the application uses them.

You can choose different resource names if these already exist in your account;
update the configuration to match. Keep the R2 bucket private: do not enable
r2.dev or attach a public bucket domain. The Worker serves custom feeds itself.

### 3. Choose the site's permanent HTTPS address

For a personal installation without a custom domain, use a `workers.dev` address.
Find or set your account's subdomain under **Workers & Pages** in the Cloudflare
dashboard. With Worker name `regsched-production` and account subdomain
`your-subdomain`, edit these fields in `wrangler.production.jsonc`:

```json
"name": "regsched-production",
"workers_dev": true,
"vars": {
  "ORIGIN": "https://regsched-production.your-subdomain.workers.dev",
  "RP_ID": "regsched-production.your-subdomain.workers.dev",
  "APP_ENV": "production"
}
```

**Remove the entire `routes` property** for the `workers.dev` option. Leave the
remaining configuration, including compatibility flags, asset build settings,
and cron trigger, in place. Cloudflare documents the address format in its
[workers.dev guide](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).

Alternatively, use a custom hostname in an active Cloudflare DNS zone that you
control. Keep `workers_dev: false`, set `ORIGIN` to `https://your-hostname` and
`RP_ID` to just `your-hostname`, and replace `routes[0].pattern` with that same
hostname. Keep `custom_domain: true`. Wrangler creates the
[Worker Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
during deployment.

`ORIGIN` must be the exact HTTPS origin, without a trailing slash or path.
`RP_ID` is the hostname only. The app rejects requests to a different origin.
Choose the address before registering accounts: passkeys are bound to the RP ID,
and changing the hostname later also changes custom feed URLs.

### 4. Generate and back up installation secrets

Generate two independent secrets into an ignored local file. This command
refuses to overwrite an existing file, so rerunning it cannot silently replace
your encryption key:

```sh
node --input-type=module <<'NODE'
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
mkdirSync('.local/self-hosting', { recursive: true, mode: 0o700 });
writeFileSync('.local/self-hosting/production-secrets.json', JSON.stringify({
  SOURCE_SECRET: randomBytes(32).toString('base64url'),
  ADMIN_SETUP_SECRET: randomBytes(32).toString('base64url'),
}, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
NODE
```

Back up this file in a secure location outside the checkout. `SOURCE_SECRET`
encrypts source URLs and saved feed snapshots; losing or replacing it makes
existing encrypted data unreadable. `ADMIN_SETUP_SECRET` authorizes registration
of the first administrator. Do not commit either value or reuse the local
development server's secrets.

### 5. Check, migrate, and deploy

```sh
npm run typecheck
npm test
npm run check:production
npx wrangler d1 migrations apply DB --config wrangler.production.jsonc --remote
npx wrangler deploy --config wrangler.production.jsonc --secrets-file .local/self-hosting/production-secrets.json
```

The check command builds without deploying. The migration command applies all
pending SQL migrations to the database bound as `DB`; review Wrangler's target
account/database before confirming. The deploy command builds the app, uploads
assets and secrets, and installs the scheduled trigger. The secrets-file option
uploads secrets with the Worker version, including on the first deployment; see
[Cloudflare's secrets documentation](https://developers.cloudflare.com/workers/configuration/secrets/).

Open your configured `ORIGIN`. For a quick health check, replace the example
hostname below with your actual address:

```sh
curl --fail https://regsched-production.your-subdomain.workers.dev/api/health
```

The response should be `{"app":"RegSched","ok":true}`. A 404 at the deployed
Worker URL usually means `ORIGIN` does not exactly match the address you opened.
If you used a custom domain, wait for its DNS/certificate to become ready.

### 6. Register the first administrator and try a feed

1. Open the site and select **Create account**.
2. Enter an account name and check **Set up the first administrator**.
3. Open your saved secrets file locally and enter its `ADMIN_SETUP_SECRET` value
   in **Administrator setup code**. Create the passkey when prompted.
4. Save the account recovery code when it is displayed.
5. In **Administration**, leave public signup closed for a personal installation,
   or open it if you want other people to create accounts.
6. Add a podcast RSS URL, choose episodes and a schedule, then subscribe to its
   custom feed URL in your podcast app. Confirm a scheduled episode appears.

Source checks and feed updates run on Cloudflare without a local server. The
cron processes bounded work each minute, and source feeds are normally checked
about hourly. Anyone with a custom feed URL can read that feed. RSS references
the original audio URLs; RegSched does not host or copy podcast audio.

### Optional: separate staging installation

Repeat the setup with `wrangler.jsonc`, using a different Worker name, D1 database,
R2 bucket, hostname, and **new secrets**. The template names are
`regsched-staging` and `regsched-staging-feeds`; keep `APP_ENV: "staging"`.
For staging commands, use `--config wrangler.jsonc` and a separate secrets file.
Never point staging at your production database or bucket. You can skip staging
entirely if you only want one personal installation.

### Updating an existing installation

Preserve your edited deployment configuration when pulling upstream changes.
Keep your encryption key unchanged and take backups before migrations.

```sh
git pull --ff-only
npm ci
npm run typecheck
npm test
npx wrangler d1 migrations apply DB --config wrangler.production.jsonc --remote
npm run deploy:production
```

Later deployments retain existing Worker secrets; do not generate new ones for
an update. If you changed the resource names, the `DB` binding-based migration
command above still selects your configured database. Keep your local
configuration changes out of upstream pull requests. Import only feeds you are
entitled to access and respect the publisher's terms.

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
