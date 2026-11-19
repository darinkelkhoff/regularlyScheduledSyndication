# Public source preparation review — 2026-11-19

## Scope

Reviewed authentication, session/recovery flows, administrator authorization,
CSRF and client output handling, owner-scoped database access, RSS import,
publication races, deployment configuration, dependency advisories, and source
publication contents. This is a focused code and configuration review, not a
penetration test or a guarantee that no vulnerabilities remain.

## Findings and remediation

1. **Sensitive private repository history — publication blocker.** The original
   private repository contains local credentials and databases. It must remain
   private. The public repository starts with a new source-only history; it does
   not reuse commits or objects from the private repository. Restored ignore
   rules exclude local state and generated files. Publication uses an explicit
   source-file allowlist, template deployment configuration, and a rewritten
   public README. The export was checked against known private configuration
   values with no matches. No public exposure was observed.
2. **Source credentials inherited by relative media URLs — high severity.** The
   parser now removes source URL userinfo before resolving relative artwork,
   links, and enclosures, and rejects explicit credentials in media URLs.
   Regression tests cover these fields. Counts-only inspection found no affected
   media URLs in current staging or production stored metadata.
3. **Concurrent publication storage growth — moderate severity.** Publishing an
   unchanged version now skips rendering/upload. A strictly newer-version and
   observed-object compare-and-swap prevents competing writers from replacing
   the same version; losing writes delete their new objects. The manual publish
   endpoint has a per-owner durable rate limit. Regression tests exercise
   competing publishers and stale publication after deletion/reset.
4. **Dependency advisories — moderate severity.** Updated Hono and the local
   Node adapter to patched versions. The resulting locked dependency installation
   reports zero known npm advisories as of this review.

No confirmed authentication bypass, CSRF, SQL injection, client-output XSS,
or cross-account read was identified within the reviewed scope. Recovery
intentionally retains existing passkeys while revoking sessions; this policy is
explained in SECURITY.md.

## Validation

- Type checking and build pass.
- 125 integration/unit tests pass, including new security regression tests.
- All three browser tests pass, including the admin table and signup badge.
- The clean export receives a separate dependency install, build, type check,
  and test run before publication.

## Limits and follow-up

Keep the original repository private until its eventual deletion. Adding ignore
rules does not remove its existing sensitive history. Retain encryption keys
and backups securely. Existing-source metadata inspection is not an upstream
credential rotation or a historical exposure investigation.

Network destination checking in the Worker depends on public-fetch routing and
`global_fetch_strictly_public`; reassess it before adding private-network
bindings. Distributed storage failures can still leave retained immutable
objects when a database outcome is uncertain; operational object reconciliation
is separate from the fixed normal concurrent-publication race.
