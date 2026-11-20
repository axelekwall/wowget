# wowget service

The server side of the PowerShell client ([SPEC-POWERSHELL.md](SPEC-POWERSHELL.md)).
Public endpoints resolve releases, search, serve the registry and accept addon
suggestions. The public web catalogue uses the same search. An optional
signed-in dashboard shows the last reported inventory for each device and
queues changes for its next explicit sync. A separate private admin interface
manages the registry and suggestion queue. The reasons are in PLAN.md,
"Decisions (2026-11-20)".

## Goals

1. Public web search and the normal CLI workflow work without an account.
   Search and resolution receive only their request inputs. The public API
   does not build a per-user inventory from those requests.
2. The optional dashboard uses passkey accounts without email or phone
   collection. Only enrolled devices upload the limited data needed for
   dashboard and sync.
3. Automatic public addon discovery defaults on for enrolled devices,
   with a separate opt-out disclosed during installation and enrollment.
   Public catalogue entries show verified public addon metadata.
4. One maintainer runs the service on Cloudflare, starting on the free
   tier. Confirm the relevant quotas during the prototypes.
5. Anyone can run their own copy from this repository (`WOWGET_API_URL`).

## Platform

- Cloudflare Workers, TypeScript, in `service/` in this repository, deployed
  with Wrangler.
- **D1** (SQLite) for the registry, suggestions, search index and release
  cache. The optional dashboard also uses D1 for accounts, credentials,
  devices, last reports and pending operations. Publish and acknowledge
  changes with conditional writes and transactions.
- **Rate limits**:
  - **Short windows** (bursts per IP hash): the Workers Rate Limiting
    binding. It supports 10- and 60-second periods and counts per
    Cloudflare location, so these limits are approximate.
  - **Per day** (suggestions and discovery submissions per IP hash): a D1
    table `daily_counts (ip_hash, day, kind, count)`. The daily cron deletes
    rows older than two days.
  - Device authorization, passkey challenges and recovery have separate
    request limits and short-lived challenges where applicable. Authenticated
    sync is bounded per device as well as per IP.

- **Cloudflare Access** in front of `/admin/*`.
- **Cron Triggers and D1** schedule and track ongoing service work. Cron
  queues catalogue imports, registry and suggestion checks, and bounded
  housekeeping. Keep job status, attempts and retry times in D1. Scheduled
  runs and the admin Recheck action use the same job handlers. Workers
  claim and retry work in bounded batches. Add Cloudflare Queues or
  Workflows if the job runner needs their delivery or retry features.

Start on Workers Free. Cloudflare documents 10 ms of active CPU per HTTP or
cron invocation on Free, excluding I/O waits. Phase 0 benchmarks a full
WoWInterface catalogue import and representative ZIP checks, including
larger releases, as well as cold resolve batches. Confirm D1 quotas, FTS5
and upstream request budgets. If full imports and checks do not fit Free
with headroom, use Workers Paid (currently USD $5/month before usage
overages). Consider Cloudflare Containers only if the existing Bun checker
is more practical to run there. Host ongoing jobs on Cloudflare in either
case. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

## API

All endpoints are under `/v1`, take and return JSON (`application/json`,
UTF-8), and send `Cache-Control` where noted. Errors are
`{ "error": { "code": "<code>", "message": "<text>" } }` with a 4xx or 5xx
status. Codes: `bad_request`, `not_found`, `conflict`, `too_large`,
`rate_limited` (with `Retry-After`), `upstream` (a source failed), `internal`.

Every CLI request carries `User-Agent: wowget/<version> (<os>-<arch>)`.
Application logs omit raw IPs, user agents, cookies, credentials and
request bodies. Rate limits use a salted hash of the IP that rotates
daily. Check platform logging settings before launch and document retention
for any infrastructure logs. Public CLI requests carry no account or
device identifier.

### `GET /v1/version`

```json
{
  "app": { "version": "1.2.0", "url": "https://github.com/axelekwall/wowget/releases/download/v1.2.0/wowget-1.2.0.zip", "sha256": "…" },
  "runtime": { "version": "7.6.10", "assets": { "win-x64": { "url": "…", "sha256": "…" }, "osx-arm64": { "url": "…", "sha256": "…" } } },
  "installers": { "ps1": "…/install.ps1", "sh": "…/install.sh" }
}
```

Written by the release workflow through the admin API. `Cache-Control:
max-age=300`.

The response is informational: clients use only `app.version`. They build the
download URL from it (this repository's GitHub release), verify the release
signature with the public key they carry, and read the runtime from the
verified zip's `runtime.json` (SPEC-POWERSHELL.md, "Release signature"). A
compromised service can therefore announce a version but cannot make a client
run code the project did not sign. `runtime` and `installers` are for people
and the admin page only.

### `GET /v1/registry`

```json
{
  "version": 412,
  "updatedAt": "2026-11-20T09:00:00Z",
  "addons": [
    { "name": "Questie", "aliases": [], "source": "github:Questie/Questie",
      "flavors": ["forever", "classic"], "folders": ["Questie", "QuestieDB"],
      "description": "…", "disabled": null }
  ]
}
```

- Same fields and meaning as `registry/addons.toml` in SPEC-SEARCH.md.
  `version` increases on every change.
- `ETag` from `version`; `If-None-Match` answers 304.
- The release workflow saves this response as `registry.json` in the release
  zip, the client's offline fallback.

### `POST /v1/resolve`

Request, with a provisional cap of 20 items. Set the cap in phase 0 from
cold-cache measurements. The current resolver can page through releases
and fetch multiple candidate metadata files for a flavor. Budget for that
behavior and older pins before promising a batch size:

```json
{ "items": [
  { "source": "github:Questie/Questie", "flavor": "forever", "prerelease": false, "pin": null },
  { "source": "wowi:7032", "flavor": "classic" }
] }
```

Response, one result per item in order:

```json
{ "results": [
  { "ok": true, "releaseId": "v11.4.2", "version": "11.4.2", "filename": "Questie-v11.4.2.zip",
    "url": "https://github.com/…/Questie-v11.4.2.zip", "sha256": "…", "md5": null, "size": 4823121,
    "publishedAt": "…", "flavorVerified": true, "folders": ["Questie", "QuestieDB"] },
  { "ok": false, "error": { "code": "flavor", "message": "…lists classic, mists but not forever" } }
] }
```

- Only `github:` and `wowi:` sources. Anything else is `bad_request` for that
  item.
- The resolution rules are those of SPEC-MVP.md ("GitHub") and the
  WoWInterface source today: `release.json` and its flavor metadata, asset
  name hints, pre-release handling, pins, WoWInterface file details and MD5.
  The code moves from `src/core/sources/` to `service/src/sources/`.
- `sha256` from the GitHub asset `digest` field when present (it reads
  `sha256:<hex>`; the service returns the hex only); `md5` from
  WoWInterface. `folders` from the registry entry when the source is in the
  registry, else `null`; the client finds folders in the zip as today.
- Upstream responses are cached in D1 per (source, prerelease, pin) for 10
  minutes, and GitHub requests send the cached ETag, so most items cost one D1
  read and no subrequest. Flavor selection runs on the cached data.
- GitHub requests use the service's token (a Worker secret), 5,000 requests
  an hour instead of 60.
- An upstream failure is an `upstream` error for that item only.
- Rate limit (binding): 20 requests per IP hash per 60 seconds provisionally. Check it against
  the final batch size and a large manifest on several machines behind one
  address.

### `GET /v1/search?q=<text>&flavors=<f,f>&github=<0|1>&limit=<n>`

```json
{ "rows": [ { "name": "Questie", "source": "github:Questie/Questie", "origin": "registry",
  "flavors": { "forever": "yes", "mists": "unknown" }, "folders": ["Questie"],
  "description": "…", "downloads": null, "updatedAt": "…" } ],
  "warnings": [] }
```

- Matching, ranking, de-duplication and the flavor filter of SPEC-SEARCH.md,
  run over the registry and the WoWInterface catalogue in D1 (FTS5 when
  available, otherwise a normalised-name column and `LIKE`).
- `github=1` adds GitHub topic search through the service token, cached for
  an hour per query.
- The client marks rows that are already in its manifest; public search never receives
  the manifest.
- `limit` defaults to 20, at most 50. Rate limit (binding): 30 searches per
  IP hash per 60 seconds.

### `POST /v1/suggestions`

```json
{ "items": [ { "source": "github:owner/repo", "name": "Foo" } ], "note": "optional, ≤ 500 chars" }
```

Response `202 { "accepted": [ { "source", "status": "queued" | "listed" | "duplicate" } ] }`.

- At most 20 items. `url:` sources are refused.
- `listed`: the registry has it. `duplicate`: already in the queue; the
  queue entry's count goes up instead of adding a row.
- New items are resolved once for each flavor in the background and stored
  with the result, so the admin sees whether it installs.
- Rate limit (D1 daily counter): 3 requests per IP hash per day, plus 1 per
  60 seconds through the binding.

### `POST /v1/discovery`

An account-free intake for automatic catalogue contributions. The CLI calls
it only after an enrolled device's explicit sync, when its separate
contribution setting is enabled. The payload contains only canonical public `github:owner/repo`
and `wowi:id` identifiers. Reject direct URLs, private or inaccessible
sources, and extra fields such as versions, targets, device IDs, account IDs
or timestamps. Requests carry no account credential. Apply burst and daily
limits to bounded batches. Public search and resolution do not feed discovery.

Deduplicate by canonical source against the registry and the pending queue.
Store the unique candidate without a contributor association or a per-install
event. Reuse the registry verification workflow. Batch publication of clean,
verified candidates to reduce the chance that publication timing reveals
someone's activity. Queue ambiguous results for review. Public search
shows only the addon's public metadata and verified flavor support, without
contributor identities, install counts or discovery-activity labels.
`wowget suggest` remains available for deliberate contributions without an
account and continues to use the existing suggestion queue.

## Public web catalogue and optional dashboard

Render a lightweight public browse and search page using the same ranking,
flavor filters and registry as `/v1/search`. An account is needed only for
the device dashboard. The dashboard shows one device and target at a time,
its last report time, desired membership, reported installed versions, and
queued changes and results. Users can queue add, remove and update operations,
cancel work that has not started, and revoke or remove a device. The UI
shows when a change is pending, applied, conflicted or failed. A queued
change never changes the displayed installed version until the device
reports the outcome.

### Accounts and device approval

- Use Better Auth in the Worker with its built-in D1 support for dashboard
  sessions, the Passkey plugin for browser registration and sign-in,
  and the Device Authorization plugin for CLI approval. Prototype the
  combination on the deployed Worker before building the dashboard.
  Verify passkey-first signup with no email or phone collection,
  first-session creation, and independent device revocation. Check
  whether the account schema requires an email field. If it prevents
  the intended signup flow, evaluate SimpleWebAuthn for verification
  with wowget-managed sessions and device approval.
  [Better Auth on D1](https://better-auth.com/blog/1-5),
  [Passkey plugin](https://better-auth.com/docs/plugins/passkey),
  [Device Authorization plugin](https://better-auth.com/docs/plugins/device-authorization),
  and [SimpleWebAuthn](https://simplewebauthn.dev/docs/packages/server).
- Use discoverable WebAuthn passkeys with user verification. Choose a stable
  relying-party domain before enrollment. Validate origin, RP ID and a
  short-lived, single-use challenge. Assign a random internal account ID
  and allow an optional display name. Signup requires no username,
  password, email address or phone number.
- Browser sessions use secure, HttpOnly session cookies, expiry and
  server-side revocation. Protect state-changing browser requests against
  CSRF, scope each read and write to the signed-in account, and verify the
  passkey again for sensitive account changes.
- Use the [OAuth Device Authorization Grant](https://www.rfc-editor.org/rfc/rfc8628)
  for `wowget login`. The CLI receives a short user code and a separate
  high-entropy device code. After passkey sign-in the user matches the
  code, reviews the requested device label and explicitly approves it.
  Expire and rate-limit codes and polling. Redeem a successful approval
  once for an opaque credential bound to the enrolled device. Store the
  credential verifier rather than the raw token on the service. The
  credential can use only that device's sync endpoints and revoke itself.
  Enforce the device scope in wowget's API. Test that it cannot read or
  modify another device or act as a dashboard session. The PowerShell
  client only makes HTTP requests and opens the browser for approval.
- Allow additional passkeys and issue a high-entropy, single-use recovery
  code for offline storage. Store only its hash. Successful recovery
  enrolls a replacement passkey and lets the user revoke existing devices
  and credentials. Without a passkey or recovery code the hosted account
  is unrecoverable. The local CLI and its data remain usable.

### Device sync

Keep separate records for the device's last reported desired membership
and installed versions, and a queue of versioned intents for that device.
The dashboard overlays pending adds and removes on the last reported
desired list. An update leaves membership as it was and asks the client
to run its normal update for that addon. Devices and targets are individually
addressable. A shared cross-device profile is outside the first version.

- Fetch pending operations and submit a report and acknowledgements
  through authenticated device endpoints. Use an atomic claim so a
  cancellation applies only before execution starts. An interrupted client
  can resume its claimed operations. Include stable operation IDs and
  target and addon preconditions from the report on which the web edit
  was based. Use conditional report revisions so a stale retry cannot
  replace a newer report.
- When a device is behind, display its last report time and leave web
  changes pending. Accept acknowledgements idempotently, keep retryable
  failures visible, and mark stale edits as conflicts. The service never
  sends scripts, arbitrary download URLs or filesystem paths to execute.
  The client validates every operation and applies it only during an
  explicit `wowget sync`.
- Store only the device label, opaque target IDs, target names and flavors,
  public addon identifiers, desired membership, installed versions, opaque
  state revisions for preconditions, and bounded result codes. Keep raw logs, absolute paths, private URL sources,
  and complete manifests out of reports. The service can read the synced
  fields. Explain this before enrollment. These accounts are pseudonymous.
- Discovery contributions default on for enrolled devices only. Explain
  the setting during installation and show it during browser approval.
  Honor the preference saved at installation and let users opt out before
  approval or later from the dashboard. An enrolled device submits
  identifiers in a separate public request only after explicit sync and
  when the current setting allows it. The service does not join discovery
  candidates to account or device records. Turning contributions off
  stops future submissions.
- Allow users to revoke device credentials, remove a device and its
  hosted reports and operations, or delete the account and its associated
  device data and sessions. Set retention for authorization challenges,
  reports, completed operations and service logs before release.

## Registry and suggestions

The registry lives in D1. `registry/addons.toml` is removed from the
repository in the switch phase, after one import.

Tables (sketch):

```sql
CREATE TABLE registry_addons (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  source TEXT NOT NULL UNIQUE, aliases TEXT NOT NULL DEFAULT '[]',
  flavors TEXT NOT NULL, folders TEXT NOT NULL, description TEXT,
  disabled TEXT, rank INTEGER NOT NULL, checked_at TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE suggestions (
  id INTEGER PRIMARY KEY, source TEXT NOT NULL UNIQUE, name TEXT,
  note TEXT, count INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL,  -- queued, checked, accepted, rejected
  check_result TEXT, created_at TEXT NOT NULL, decided_at TEXT
);
CREATE TABLE registry_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); -- version, updated_at
```

- **Checks** (`flavors`, `folders`, `disabled`): cron schedules stale entries
  and queued suggestions, and the admin can enqueue a single recheck. Resolve
  upstream metadata first. Reuse verification for unchanged releases and
  inspect changed ZIPs in bounded jobs. Share inspection results across
  flavors when they use the same archive. A transient upstream or compute
  failure leaves the last verified registry entry in place and retries the
  job. New candidates wait for verification.
- **WoWInterface catalogue**: a scheduled Worker downloads and projects the
  catalogue fields listed in SPEC-SEARCH.md. Compare against the live D1
  catalogue and stage only changed rows and removed IDs. Apply the staged
  changes in one D1 transaction after the entire import succeeds. Unchanged
  entries remain in place. Failed or incomplete imports leave the last good
  catalogue available. Track in-progress imports in D1 and clean up
  abandoned staging data.
- Accepting a suggestion copies its checked `flavors` and `folders` into a new
  registry entry at the bottom of the ranking and bumps the registry version.
  Only checked suggestions can be accepted.

## Admin interface

- `/admin`, server-rendered HTML from the Worker with plain forms and no
  client-side framework, so it needs no build step and no new front-end
  dependency.
- Behind Cloudflare Access (an application on `/admin/*`, login with the
  maintainer's email one-time code). The Worker also verifies the
  `Cf-Access-Jwt-Assertion` header against the Access team's keys, so a
  misconfigured route does not open the admin area.
- Pages:
  - **Suggestions**: the queue with count, source, proposed name, note, check
    result per flavor; accept (with an editable name and description), reject,
    re-check.
  - **Registry**: list, search, edit name, aliases, description, rank;
    disable and enable; delete; re-check.
  - **Service**: registry version, last check and catalogue import times,
    request and rate-limit counters for the last 7 days. Show aggregate
    operational counters only.
- Every change writes an audit row: time, actor, action, entry. The actor is
  the Access user's email, the Cloudflare job identity for scheduled work,
  or the release service token's client ID for version publication.
- `/admin/api/version` accepts release metadata from the publication
  workflow. Scheduled jobs use Cloudflare bindings and record their
  results directly in D1.

## Repository and deployment

- One repository. `client/` for the PowerShell client, `service/` for the
  Worker and its server-rendered public catalogue, account dashboard and
  admin pages.
- Path filters: the client release workflow runs on changes under `client/`;
  a `service-deploy.yml` workflow deploys `service/` on pushes to `main` that
  change it, with a Cloudflare API token from a GitHub secret. Commit types
  stay as AGENTS.md describes; a service-only change uses `feat(service)` or
  `fix(service)` and does not cut a client release (the release workflow
  checks the paths).
- GitHub Actions handles CI, deployment, and release publication.
  Catalogue ingestion, registry and suggestion checks, retries, and
  housekeeping run on Cloudflare after deployment. GitHub and WoWInterface
  remain upstream addon sources.
- Secrets live in Cloudflare and GitHub only. Setting them up is the
  maintainer's job; the repository holds none.

  | Secret | Where | Used for |
  |---|---|---|
  | GitHub token, read-only public access | Worker | `/v1/resolve`, GitHub search |
  | IP-hash salt | Worker | rate-limit keys |
  | Access service token (client id and secret) | GitHub Actions | release publication calling `/admin/api/version` |
  | Cloudflare API token, Workers and D1 edit | GitHub Actions | deploying the service |
  | Release signing key (ECDSA P-256 private key) | GitHub Actions, release job only | signing release zips |
- Keeping the service code public adds no attack surface: the public client
  already shows every endpoint, and the defences (rate limits, size caps,
  host allowlists, Access, secrets) do not depend on the code being hidden.
- `WOWGET_API_URL` lets anyone point the client at their own deployment.

## Abuse and failure

| Risk | Mitigation |
|---|---|
| Rate limits evaded across Cloudflare locations | Short-window binding limits are approximate and per location. Use D1 counters for daily caps and add WAF limits if needed. |
| `/v1/resolve` used as a GitHub proxy | Limit supported sources, bound each batch and retain caching and rate limits. |
| Suggestion or discovery spam | Bound requests, deduplicate sources, verify candidates, and review ambiguous submissions before publishing. |
| Someone approves the wrong device | Display and match the short code, require explicit WebAuthn-authenticated approval, expire codes and allow device revocation. |
| A stale or retried operation changes the wrong local state | Bind operations to a device and target, include preconditions and stable IDs, and enforce local ownership and replay handling. |
| A compromised service sends a malicious addon download | Client host allowlist on each redirect hop and hash verification. The service still chooses the URL and expected hash, so addon provenance remains a trust boundary. |
| A compromised service pushes a client update | Clients use the advertised version only, fetch from the project's GitHub releases, and verify the project signature. |
| Service down | Local inspection and removal, direct URL sources, and the registry snapshot keep working. Public resolution, search and dashboard sync report a network failure. |
| Free-plan limits reached | Measure load and expose aggregate counters. The maintainer decides whether to change limits or move plans. |

## Phases

0. Confirm the platform limits. Deploy a skeleton with `/v1/version` and
   GitHub `/v1/resolve` behind `WOWGET_API_URL`, and measure CPU and upstream
   requests on cold batches, including older flavor-compatible builds
   and pinned releases. Benchmark the full catalogue import and ZIP checks
   on Cloudflare before choosing the production plan.
1. Ship public resolution, the registry import and endpoint, version
   metadata and the release cache.
2. Add public search, the web catalogue, catalogue imports, manual
   suggestions and the private registry admin interface. Run scheduled
   imports and verification on Cloudflare and retire the legacy registry
   and suggestion workflows at the switch. The account-free CLI can ship
   at this point.
3. Prototype Better Auth signup, sessions and device approval on
   Workers with D1. Then add the optional dashboard and sync for
   independent devices. Add discovery with a separate opt-out and batch
   publication. Test credentials and recovery, device isolation, stale
   reports and operation replay, and verify that account-free use never
   contributes automatically and that an opted-out device stays opted out.

## Not in scope

- Email or phone collection.
- Shared-manifest links or end-to-end encrypted manifest storage.
- Hosting or mirroring addon zips, or CurseForge.
- Background sync, push notifications, or unattended action execution.
