# Registry suggestions

Extends SPEC-SEARCH.md. Scope: a way for users to propose the addons they use
for the registry without a GitHub token, git or a fork.

## Goals

1. `wowget suggest` lists the manifest addons that are not in the registry and
   opens a prefilled GitHub issue that proposes them.
2. A workflow checks each proposed source the way `registry:check` does and
   opens a pull request with the entries that pass. A person reviews and
   merges it.
3. Contributors need a GitHub account and nothing else. The binary handles no
   credentials.

## Why an issue

Opening the pull request from the CLI needs a token that can fork and open
pull requests (a classic token with `public_repo`, or an OAuth app). Few
players have one. An issue form needs only a signed-in browser, and the
registry check already derives `flavors` and `folders` from the source, so a
suggestion only has to carry a source string and a name.

## `wowget suggest`

```
wowget suggest [name...] [--print]
```

- Reads the manifest and the registry (the same loading as `search`, with
  the built-in copy as fallback).
- Considers every manifest addon, or only the named ones; an unknown name is
  a usage error. Targets play no part.
- Per addon, one status:
  - `listed`: a registry entry has the same source, compared as
    `github:<owner>/<repo>` case-insensitively and `wowi:<id>`.
  - `url`: a `url:` source, which the registry does not accept.
  - `suggested`: anything else.
- When at least one addon is `suggested`, builds the URL of a new issue on
  `axelekwall/wowget` from the `registry-addon.yml` form, with the
  `addons` field prefilled, one line per addon: `<source> <name>`.
- Opens the URL in the default browser (`open` on macOS,
  `rundll32 url.dll,FileProtocolHandler` on Windows, `xdg-open` elsewhere)
  and always prints it. `--print` and `--json` only print it. A browser that
  fails to open is a warning, not an error.
- A URL longer than 8,000 characters is a usage error that asks for names,
  since GitHub rejects longer ones.
- `--json` prints `{ "addons": [{ "name", "source", "status", "registryName"? }], "url": string | null }`.

## Issue form

`.github/ISSUE_TEMPLATE/registry-addon.yml`, labelled `registry`, with a
required `addons` textarea and an optional `notes` textarea.

Line format, shared by the CLI and the workflow (`src/core/suggest.ts`):

- `<source>` or `<source> <name>`; the name is the rest of the line.
- Blank lines, lines starting with `#` and GitHub's `_No response_` are
  ignored.
- Without a name, the entry takes the name the source suggests: the repo name
  for GitHub, the WoWInterface file or display name otherwise.

## Workflow

`.github/workflows/registry-suggest.yml`, on `issues` (`opened`, `edited`,
and `labeled` with `registry`) for open issues labelled `registry`, and on
`workflow_dispatch` with an issue number.

Two jobs, so the job that downloads and extracts arbitrary zips holds no
write token:

1. **check** (`contents: read`, `issues: read`): reads the issue body with
   `gh` into a file (never into a shell command), runs
   `scripts/suggest-registry.ts`, and uploads the resulting
   `registry/addons.toml` and a Markdown report as an artifact.
2. **publish** (`contents: write`, `pull-requests: write`, `issues: write`):
   refuses an artifact that does not start with the current registry file
   byte for byte (only appends are allowed). When the file changed, commits
   it to `registry/suggest-<issue>`, force-pushes, and opens or updates a
   pull request that closes the issue. Comments the report on the issue,
   editing its previous comment when there is one.

Editing the issue reruns both jobs from the current `main`, so a suggestion
whose branch conflicts with a merged one is fixed by editing the issue.

### `scripts/suggest-registry.ts`

```
bun scripts/suggest-registry.ts --body <file> [--file registry/addons.toml] [--report <file>]
```

1. Takes the `### Addons` section of the body (the whole body when there is
   no such heading) and strips code fences.
2. Parses each line. At most 25 suggestions per issue; the rest are reported
   as skipped.
3. Rejects `url:` sources, sources already in the registry, and duplicates in
   the issue.
4. Runs `checkEntry` from the check script on each remaining source. An entry
   that installs on no flavor is rejected with the reason per flavor.
5. Appends an `[[addon]]` block with `name`, `source`, `flavors` and
   `folders` for each passing source, in issue order, and re-parses the file
   in strict mode. A suggestion that makes it invalid (a name or alias clash,
   a bad name) is rejected with the problem.
6. Writes the file and the report. Exits 1 on a usage error or a GitHub rate
   limit, 0 otherwise; rejected suggestions are reported, not failures.

A pull request opened with the workflow token starts no workflows, so the
pull request shows no Registry check; the workflow already ran it.

## Not in scope

- Opening pull requests from the CLI, and any token handling in the binary.
- Suggesting unmanaged addons found by `reconcile`; adopt them first.
- Aliases and descriptions; the reviewer adds them on the pull request.
- Anonymous submissions without a GitHub account.

## Setup

The `registry` label must exist in the repository, and Actions must be
allowed to create pull requests (the scheduled registry update already needs
this).
