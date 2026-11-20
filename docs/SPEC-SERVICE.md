# wowget service

The server side of the PowerShell client ([SPEC-POWERSHELL.md](SPEC-POWERSHELL.md)).
It resolves releases, searches, serves the registry, takes registry
suggestions, stores shared manifests and has a private admin interface. It
replaces the registry file in the repository and the GitHub issue flow of
SPEC-REGISTRY-SUGGEST.md. The reasons are in PLAN.md, "Decisions
(2026-11-20)".

## Goals

1. The client asks one service for everything that needs the internet except
   downloads, so it stays small and makes one request per command.
2. No accounts for users. No personal data stored.
3. Shared manifests are end-to-end encrypted: the service cannot read or
   change them.
4. One maintainer runs it on Cloudflare's free tier, with an admin interface
   for the registry and the suggestion queue.
5. Anyone can run their own copy from this repository (`WOWGET_API_URL`).

## Platform

- Cloudflare Workers, TypeScript, in `service/` in this repository, deployed
  with Wrangler.
- **D1** (SQLite) for the registry, suggestions, search index, release cache
  and an index of links (id, size, created, last write, last read day), which
  the idle-link cron and the admin counters need because Durable Objects
  cannot be listed.
- **Durable Objects** with SQLite storage, one per shared link, for atomic
  compare-and-swap.
- **Workers Rate Limiting binding** for every rate limit, so counting
  requests costs no D1 writes.
- **Cloudflare Access** in front of `/admin/*`.
- **Cron triggers** for small periodic work. Heavy work (downloading and
  inspecting zips, parsing the 6 MB WoWInterface catalogue) runs in GitHub
  Actions and pushes its results to the service through the admin API,
  because the free plan limits CPU time per request.

Free-plan limits to confirm in phase 0 and record here: CPU time per request
(believed 10 ms), subrequests per request (believed 50), D1 reads and writes
per day (believed 5 million and 100,000), Durable Object requests per day,
and FTS5 in D1 (believed supported). The API is shaped so that every client
request needs at most one D1 query per item and stays under the subrequest
limit even with a cold cache (see `/v1/resolve`).

## API

All endpoints are under `/v1`, take and return JSON (`application/json`,
UTF-8), and send `Cache-Control` where noted. Errors are
`{ "error": { "code": "<code>", "message": "<text>" } }` with a 4xx or 5xx
status. Codes: `bad_request`, `not_found`, `conflict`, `too_large`,
`rate_limited` (with `Retry-After`), `upstream` (a source failed), `internal`.

Every request from the client carries `User-Agent: wowget/<version>
(<os>-<arch>)`. The service logs no IP addresses or user agents; rate limits
use a salted hash of the IP that rotates daily.

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

Request, at most 20 items (fixed in phase 0 so that a batch with a cold cache,
up to two upstream requests per item, stays within the subrequest limit):

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
- Rate limit: 30 requests per IP hash per 10 minutes. Counting requests rather
  than items keeps a large manifest (50 addons on 3 flavors is 150 items, or 8
  requests after the client removes duplicates) well inside it, and leaves
  room for several machines behind one address.

### `POST /v1/identify`

For `reconcile`: which sources may own unmanaged folders.

```json
{ "folders": ["Bagnon", "Bagnon_Config"], "flavor": "classic" }
```

Response: `{ "matches": [ { "folders": ["Bagnon", "Bagnon_Config"], "candidates": [ { "source": "wowi:…", "name": "…", "origin": "registry" | "wowi" } ] } ] }`,
from the registry's `folders` and the WoWInterface catalogue's `UIDir`, as
`catalogSuggestions` matches today. At most 200 folders per request; 10
requests per IP hash per 10 minutes.

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
- The client marks rows that are already in its manifest; the service never
  sees the manifest.
- `limit` defaults to 20, at most 50. Rate limit: 30 searches per IP hash per
  minute.

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
- Rate limit: 3 requests per IP hash per day.

### Links (shared manifests)

#### Tokens and keys

- `secret`: 32 random bytes from the client.
- `HKDF-SHA256(ikm = secret, salt = "", info = …, length = 32)` derives:
  - `linkId` with info `wowget link id v1`, sent as base64url without padding;
  - `encKey` with info `wowget link enc v1`, for AES-256-GCM, never sent;
  - `writeKey` with info `wowget link write v1`, sent on writes.
- Write token: `wg1-rw-` + base32 (RFC 4648, no padding, lower case) of
  `secret`.
- Read-only token: `wg1-ro-` + base32 of `linkId bytes || encKey`. It cannot
  produce `writeKey`.
- The service stores `SHA-256(writeKey)` and compares in constant time.

#### Envelope

The stored blob is

```json
{ "v": 1, "nonce": "<base64url 12 bytes>", "ct": "<base64url ciphertext and 16-byte tag>" }
```

- The plaintext is `{ "v": 1, "seq": <remote version>, "manifest": { … } }`
  as UTF-8 JSON.
- AES-256-GCM with `encKey`, a random 12-byte nonce per write, a 16-byte tag.
- The associated data is the `linkId` string (base64url, as sent in URLs) as
  ASCII bytes, so a blob cannot be moved to another link.
- HKDF uses a zero-length salt.
- `seq` inside the ciphertext must equal the version the service returns with
  the blob. A writer sets `seq` to the version it sends in `If-Match` plus
  one (`1` on create). A reader refuses a blob whose `seq` differs from the
  returned version or is lower than the last version it saw, which catches a
  service that serves an older blob.
- `test-vectors/links.json` holds secrets, derived ids and keys, a fixed nonce,
  plaintext and ciphertext, so the client and service tests agree byte for
  byte.

#### Endpoints

| Request | Rule | Response |
|---|---|---|
| `PUT /v1/links/:id` with `{ writeKeyHash, blob }` and `If-None-Match: *` | creates | `201`, `ETag: "1"`; `409` if it exists |
| `GET /v1/links/:id` | | `200 { version, blob, updatedAt }`, `ETag: "<version>"`; `404` |
| `PUT /v1/links/:id` with `{ blob }`, `X-Wowget-Write-Key`, `If-Match: "<version>"` | write key must match; the version must equal the stored one | `200 { version }` with the new `ETag`; `412` with the current version on a mismatch; `403` on a wrong key; `404` |
| `DELETE /v1/links/:id` with `X-Wowget-Write-Key` | | `204`; `403`; `404` |

- `If-Match` and `ETag` carry the version as a quoted string, as HTTP
  requires: `"7"`.
- Blob at most 64 KB as sent. Larger is `413 too_large`. The client keeps the
  plaintext manifest under 40 KB, which leaves room for JSON and base64url.
- One Durable Object per `linkId` serialises writes, so compare-and-swap is
  atomic.
- The D1 link index is written on create, on every write, on delete, and on a
  read only when the stored read day is not today, so reads cost at most one D1
  write per link per day.
- A link without reads or writes for 12 months is deleted by a daily cron that
  reads the D1 index.
- Rate limits: 10 link creations per IP hash per day; per link, 600 reads and
  120 writes per hour, and per IP hash 120 link requests per 10 minutes, so
  one token holder cannot use up a link's limits for the others quickly.

#### Security properties

The service cannot read or forge manifests, and cannot move a blob between
links. A guessed link id gives nothing without `encKey`. A read-only token
cannot write. What it does not protect: a leaked write token gives full
access until `link rotate`; the service can delete or withhold a blob; the
`seq` check catches a replayed older blob only after the client has seen a
newer one; anything that can read the user's files can read `link.json`.

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

- **Checks** (`flavors`, `folders`, `disabled`) need the zips, so they run in
  GitHub Actions with the existing check logic: a daily scheduled workflow
  reads `/v1/registry` and the queued suggestions, checks them, and posts
  results to `POST /admin/api/checks`. The workflow authenticates with a
  Cloudflare Access service token (GitHub secret). The admin interface can
  start the workflow for one entry through `workflow_dispatch`.
- **WoWInterface catalogue**: the same daily workflow downloads it, projects
  the fields SPEC-SEARCH.md lists, and compares it with the previous day's
  projection (kept as a workflow artifact). It posts only added, changed and
  removed entries to `POST /admin/api/catalog` in chunks, all tagged with one
  import id, then calls `POST /admin/api/catalog/commit` with that id. D1 has
  no transaction across requests, so rows carry the import id and searches read
  the id named in `registry_meta`; the commit switches it in one statement and
  deletes the replaced rows. Sending only the difference keeps the daily D1
  writes, FTS index updates included, to the entries that changed.
- Accepting a suggestion copies its checked `flavors` and `folders` into a new
  registry entry at the bottom of the ranking and bumps the registry version.
  Accepting an unchecked suggestion is not possible.

## Admin interface

- `/admin`, server-rendered HTML from the Worker with plain forms and no
  client-side framework, so it needs no build step and no new front-end
  dependency.
- Behind Cloudflare Access (an application on `/admin/*`, login with the
  maintainer's email one-time code or GitHub). The Worker also verifies the
  `Cf-Access-Jwt-Assertion` header against the Access team's keys, so a
  misconfigured route does not open the admin area.
- Pages:
  - **Suggestions**: the queue with count, source, proposed name, note, check
    result per flavor; accept (with an editable name and description), reject,
    re-check.
  - **Registry**: list, search, edit name, aliases, description, rank;
    disable and enable; delete; re-check.
  - **Service**: registry version, last check and catalogue import times,
    link count and total size, request and rate-limit counters for the last
    7 days. No per-link or per-user detail.
- Every change writes an audit row: time, actor, action, entry. The actor is
  the Access user's email, or the service token's client id and name for the
  GitHub Actions workflows.
- `/admin/api/*` takes JSON for the GitHub Actions workflow and the release
  workflow (`/admin/api/version`).

## Repository and deployment

- One repository. `client/` for the PowerShell client, `service/` for the
  Worker, shared test vectors for the link crypto in `test-vectors/`.
- Path filters: the client release workflow runs on changes under `client/`;
  a `service-deploy.yml` workflow deploys `service/` on pushes to `main` that
  change it, with a Cloudflare API token from a GitHub secret. Commit types
  stay as AGENTS.md describes; a service-only change uses `feat(service)` or
  `fix(service)` and does not cut a client release (the release workflow
  checks the paths).
- Secrets live in Cloudflare and GitHub only. Setting them up is the
  maintainer's job; the repository holds none.

  | Secret | Where | Used for |
  |---|---|---|
  | GitHub token, read-only public access | Worker | `/v1/resolve`, GitHub search |
  | GitHub fine-grained token, `actions: write` on this repository only | Worker | starting the check workflow from the admin interface |
  | IP-hash salt | Worker | rate-limit keys |
  | Access service token (client id and secret) | GitHub Actions | the check, catalogue and release workflows calling `/admin/api/*` |
  | Cloudflare API token, Workers and D1 edit | GitHub Actions | deploying the service |
  | Release signing key (ECDSA P-256 private key) | GitHub Actions, release job only | signing release zips |
- Keeping the service code public adds no attack surface: the public client
  already shows every endpoint, and the defences (rate limits, size caps,
  host allowlists, Access, secrets) do not depend on the code being hidden.
- `WOWGET_API_URL` lets anyone point the client at their own deployment.

## Abuse and failure

| Risk | Mitigation |
|---|---|
| Anonymous blob storage used as free storage | 64 KB cap, 10 creations per IP hash a day, deletion after 12 months idle |
| `/v1/resolve` used as a GitHub proxy | Only `github:`/`wowi:` sources, 20 items a request, rate limits, cached results |
| Suggestion spam | 3 requests per IP hash a day, de-duplication by source, nothing published without the admin |
| A compromised service sends a malicious addon download | Client host allowlist on every redirect hop and hash check. The service chooses the URL and hash, so the worst case is a malicious addon: Lua inside WoW's sandbox, with access to the game account's UI and saved variables, not to the system |
| A compromised service pushes a client update | Not possible without the release signing key: clients take only a version number from the service and verify the signed zip from GitHub (SPEC-POWERSHELL.md, "Release signature") |
| Service down | `list`, `remove`, `doctor`, `url:` sources and the registry snapshot keep working; resolution and search fail with a `network` error |
| Free-plan limits reached | Cloudflare returns errors for the rest of the day; the admin page shows the counters; the paid plan is the maintainer's decision |

## Phases

0. Confirm the platform limits above. Deploy a skeleton with `/v1/version`
   and `/v1/resolve` for `github:` behind `WOWGET_API_URL`, and measure CPU
   time per resolve item.
1. `/v1/resolve` (GitHub and WoWInterface), `/v1/registry`, `/v1/version`,
   the registry import from `registry/addons.toml`, the release cache.
   Needed by client phase 1.
2. Search with the catalogue import workflow; suggestions; the admin
   interface with Access.
3. Links. Needed by client phase 4.
4. Switch: the registry workflows and `registry/addons.toml` removed, the
   suggestion issue form and workflow removed.

## Not in scope

- User accounts, sign-in for users, or anything stored per user.
- Hosting or mirroring addon zips.
- CurseForge.
- Push notifications or background sync.
