# Releasing

How a version of skillporter gets from `main` to npm. **Nothing publishes automatically.**
There is no release workflow, no tag-triggered CI job and no bot. Every step below is run by a
human, in order, and each one is checkable before the next one starts.

Every statement about npm behaviour in this file is quoted or paraphrased from the official npm
documentation, and the source is listed in [Claims and sources](#claims-and-sources) at the end.
Anything I could not verify is listed in [What is unverified](#what-is-unverified) instead of
being asserted.

## What gets published

Two packages, from one repository:

| Package | Directory | Contents | Why it is separate |
| --- | --- | --- | --- |
| `@skillporter/core` | `packages/core` | the parsers, IR, linter, emitters, plus `agents/` and `schema/` | usable as a library without the CLI |
| `skillporter` | `packages/cli` | `dist/` only, a thin `commander` front end | the command users install |

`skillporter` depends on `@skillporter/core`. That single fact drives the publish order and most
of the rollback advice below.

## One-time setup

Do these once, before the first release. Nothing here is needed again afterwards.

### 1. Own the names

Two different names have to be yours:

- **`skillporter`** (unscoped) — needs an npm **user account** called `skillporter`, or an
  account that has been granted the name.
- **`@skillporter`** (scope) — needs a **user or organisation** named `skillporter`. npm grants
  a scope that matches your user or organisation name: *"When you sign up for an npm user
  account or create an organization, you are granted a scope that matches your user or
  organization name."* To publish under an organisation scope, *"you must create an npm user
  account, then create an npm organization."*

Both were unclaimed as of 2026-11-15 (`npm view skillporter` and `npm view @skillporter/core`
both return 404). Claiming them is a browser task on npmjs.com — there is no CLI command that
reserves a name without publishing to it.

### 2. Enable 2FA

Publishing is not possible without it. npm's wording: *"Publishing to npm requires either:
Two-factor authentication (2FA) enabled on your account, OR A granular access token with bypass
2FA enabled."*

Enable 2FA in **authorization and writes** mode, not authorization-only — publish is a write
action, and authorization-only mode does not cover it. `npm profile enable-2fa auth-and-writes`
is the CLI path.

If you would rather use a token than an interactive prompt, it must be a granular access token
with *bypass 2FA* enabled. Note that since August 2026 a bypass-2FA token cannot be used for
account-identity or account-governance actions, so it is a publishing credential only.

### 3. Confirm the toolchain

- Node **22.20.0** or newer (both packages declare `engines.node: >=22.20.0`).
- npm **9.5.0** or newer — the floor for provenance support, should you add it later.
- `npm whoami` must return the account that owns both names.

## Release procedure

### Step 1 — Start from a green, clean tree

```bash
git switch main
git pull --ff-only
git status --porcelain        # must print nothing
```

The last CI run on `main` must be green on Linux, macOS **and** Windows. A release is not the
place to discover a Windows-only failure.

### Step 2 — Bump both versions

Edit `version` in `packages/core/package.json` and `packages/cli/package.json` to the same
number, then resynchronise the lockfile:

```bash
npm install                   # rewrites package-lock.json with the new workspace versions
git diff --stat               # expect exactly three files: two manifests and the lockfile
```

Both packages version together. `@skillporter/core` is a real dependency of the CLI, so letting
them drift means publishing a CLI that resolves a core you did not test it against.

If the new version leaves the `@skillporter/core` range in `packages/cli/package.json` no longer
satisfied — for example when going from `0.1.x` to `0.2.0`, because `^0.1.0` does not admit
`0.2.0` — update that range in the same commit.

### Step 3 — Update the changelog

Move everything under `## [Unreleased]` in `CHANGELOG.md` into a new `## [x.y.z] - YYYY-MM-DD`
section, and leave a fresh empty `## [Unreleased]` above it. The entry is written for someone
deciding whether to upgrade, so it has to say what changed for them, not what files changed.

### Step 4 — Run the full gate

```bash
npm run typecheck
npm run validate:profiles
npm run agents:docs:check
npm run rules:check
npm run build
npm test
```

All six must pass. `agents:docs:check` and `rules:check` fail when a generated document has
drifted from the data it is generated from — if either fails, run `npm run agents:docs` or
`npm run rules` and commit the result rather than editing the generated file.

### Step 5 — Inspect both tarballs

```bash
npm pack --dry-run --workspace @skillporter/core
npm pack --dry-run --workspace skillporter
```

Check, every time, without assuming last release's result carries over:

- `@skillporter/core` contains `dist/`, **`agents/*.yaml`** and **`schema/*.json`**. Without the
  profiles an installed CLI cannot load a single agent.
- `skillporter` contains `dist/` only.
- Neither contains `tests/`, `fixtures/`, `.workbuddy-ai/`, source maps pointing at absolute
  paths, or anything with a personal email in it.
- `packages/cli/dist/index.js` still starts with `#!/usr/bin/env node`.

`packages/core` runs `prepack` while packing, which copies the repository's `agents/` and
`schema/` into the package directory, and `postpack` afterwards, which deletes those copies
again. Seeing them appear and vanish is normal. A copy left behind after a failed pack is a
stale directory that would shadow the real one — delete it before retrying.

### Step 6 — Commit and tag

```bash
git add -A
git commit -m "release: v0.1.0"
git push origin main
```

Wait for CI to go green on that commit. Only then tag:

```bash
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
```

The git tag is a marker for humans. It is **not** an npm dist-tag and does not publish anything
— see [Tagging](#tagging).

### Step 7 — Publish `@skillporter/core` first

```bash
cd packages/core
npm publish --access public --dry-run    # last look at the file list
npm publish --access public
```

`--access public` is already in `publishConfig`, so the flag is belt and braces. It matters
because *"By default, scoped packages are published with private visibility"* — without it, a
scoped package goes up private and nobody can install it. (The unscoped CLI package cannot be
restricted at all: *"Unscoped packages are always public"* and *"Unscoped packages cannot be set
to `restricted`"*.)

npm will prompt for a one-time password. `--otp <code>` supplies it non-interactively.

### Step 8 — Verify core before publishing the CLI

```bash
npm view @skillporter/core version
npm view @skillporter/core dist.tarball
npm pack @skillporter/core@0.1.0 --dry-run     # in an empty directory
```

This pause is the point of the ordering. Once `skillporter` is published with
`@skillporter/core` in its `dependencies`, the registry sees core as a package that another
package depends on, and that removes the fast route to unpublishing core (see
[Rolling back](#rolling-back)). Confirm core is right while it is still cheap to be wrong.

### Step 9 — Publish the CLI

```bash
cd packages/cli
npm publish --access public --dry-run
npm publish --access public
```

If you skip straight to this step, `npm install -g skillporter` fails to resolve its dependency
for however long core is missing — a broken window that is entirely avoidable.

### Step 10 — Check the published result

```bash
npm view skillporter version
npm view skillporter dependencies      # @skillporter/core must resolve to a published version
npx --yes skillporter@0.1.0 --version
npx --yes skillporter@0.1.0 agents
```

The last command should list six agents. If it prints an empty list or throws, the profiles did
not make it into the tarball and the release needs a new version — see
[Rolling back](#rolling-back).

## Provenance

**A release made by the steps above has no provenance attestation, and cannot have one.**
npm's documentation is explicit: *"To publish a package with provenance, you must build your
package with a supported cloud CI/CD provider using a cloud-hosted runner. Today this includes
GitHub Actions and GitLab CI/CD."* A publish from a laptop has no OIDC identity to sign with.

This is a deliberate trade for the first release: a manual publish is auditable by a human
watching it happen, and it needs no stored credential. Provenance is worth adding once there is
a release cadence worth automating, and it is the better end state.

When you do add it, the requirements are:

- a GitHub-hosted runner — *"Run on a GitHub-hosted runner"*;
- `permissions: id-token: write` on the job — *"Give permission to mint an ID-token"*;
- `--provenance` on the publish command, plus `--access public` on a first publish;
- a public `repository` in `package.json` that matches, case-sensitively, the repository you are
  publishing from. Ours is `git+https://github.com/Stevesadr/skillporter.git`, which matches the
  GitHub remote.

Do **not** add `"provenance": true` to `publishConfig` while releases are manual. The setting
applies to every publish from that directory, including a local one, and there is no supported
local flow behind it.

Users can check any package's attestations with `npm audit signatures`.

## Tagging

Two unrelated kinds of tag exist, and confusing them causes real mistakes:

- **Git tags** (`git tag v0.1.0`) mark a commit. They are what this repository uses, and they
  publish nothing by themselves.
- **npm dist-tags** (`latest`, `next`) are pointers to a version *inside the registry*. `latest`
  is what `npm install skillporter` resolves to.

A publish sets `latest` to the version just published, unless you pass `--tag`. So a prerelease
must say so:

```bash
npm publish --access public --tag next     # 0.2.0-rc.1 becomes `next`, not `latest`
```

Tags that look like semver ranges are rejected — *"Tags that can be interpreted as valid semver
ranges will be rejected"* — so `v1.4` is not a valid tag name while `next` and `rc` are.

Moving `latest` back to an earlier version, without publishing anything:

```bash
npm dist-tag add skillporter@0.1.0 latest
npm dist-tag ls skillporter
```

## Rolling back

Use the least destructive option that solves the actual problem. In order:

### 1. Fix forward

For anything short of a security problem, publish a new patch version. `package@version` can
never be reused — *"Once `package@version` has been used, you can never use it again. You must
publish a new version even if you unpublished the old one."* — so a rollback is always a new
number, never a re-upload.

### 2. Move the `latest` dist-tag

Only works when a previous good version exists. On a **first** release there is none, so this
option is unavailable until 0.1.1 exists. `npm dist-tag add` requires an OTP when 2FA is on
auth-and-writes.

### 3. Deprecate

The right tool when the version should stay installable but should not be chosen:

```bash
npm deprecate skillporter@0.1.0 "0.1.0 loses the body of any skill with CRLF line endings; use 0.1.1"
npm deprecate "@skillporter/core@0.1.0" "broken; use 0.1.1"
```

It takes a version range as well as a version, and *"SemVer ranges passed to this command are
interpreted such that they **do** include prerelease versions"*. You must be an owner.
Deprecation prints your message on install and on the package page, and does not remove the
tarball. Undo it by passing an empty message: `npm deprecate skillporter@0.1.0 ""`.

Deprecating an entire package — rather than one version — *"will be dropped from our search
results"*, so prefer the version-scoped form.

### 4. Unpublish

Last resort, and time-limited. *"For newly created packages, as long as no other packages in
the npm Public Registry depend on your package, you can unpublish anytime within the first 72
hours after publishing."*

After 72 hours, unpublishing requires **all** of: no dependents in the registry, fewer than 300
downloads in the last week, and a single owner.

```bash
npm unpublish skillporter@0.1.0
npm unpublish skillporter --force          # every version, needs --force
```

Three consequences to plan around:

- **Unpublishing cannot be undone** — *"Once you have unpublished a package, you will not be
  able to undo the unpublish."*
- **The number is burnt** — the same name and version can never be published again.
- **A 24-hour lockout follows** — *"If you entirely unpublish all versions of a package, you may
  not publish any new versions of that package until 24 hours have passed."*

And the trap specific to this repository: **publishing the CLI removes core's escape hatch.**
Once `skillporter@0.1.0` exists with `@skillporter/core` in its dependencies, core has a
dependent in the registry, and neither the 72-hour rule nor the post-72-hour rule applies to it
any more. That is why [step 8](#step-8--verify-core-before-publishing-the-cli) verifies core
before the CLI goes up. If core is broken and already has a dependent, deprecate it and ship a
patch.

## What is unverified

- **Whether `publishConfig.provenance: true` makes a local publish fail outright**, or publishes
  without an attestation. The documentation states the requirement (a supported cloud CI/CD
  provider on a cloud-hosted runner) but not the local failure mode. The advice above avoids the
  question by not setting it.
- **How npm normalises `git+…​.git` against the GitHub slug** when checking the repository for
  provenance. The field is correct in shape; whether the `git+` prefix and `.git` suffix are
  stripped for the comparison is not documented on the page cited.
- **Whether `npm publish --workspace <name>` runs `prepack` with the workspace as its working
  directory.** The `--workspace` form is documented, and `prepack` here uses a path relative to
  the package, so it should behave identically — but the `cd` form in step 7 is the one that has
  actually been run.
- **The exact behaviour of `npm version` inside this workspace layout.** The bump in step 2 is
  done by editing the two manifests and running `npm install`, which is what was done for 0.1.0
  and is observable end to end.

## Claims and sources

All retrieved 2026-11-15.

| Claim | Source |
| --- | --- |
| Publishing requires 2FA or a bypass-2FA granular token; auth-and-writes vs authorization-only; bypass tokens restricted since August 2026 | <https://docs.npmjs.com/about-two-factor-authentication> |
| `npm publish` flags `--access`, `--tag`, `--dry-run`, `--otp`, `--provenance`; access default for new packages; unscoped cannot be restricted; `dry-run` not honoured by `dist-tags`/`owner` | <https://docs.npmjs.com/cli/v11/commands/npm-publish> |
| A scope is granted to match a user or organisation name; scoped packages are private by default | <https://docs.npmjs.com/about-scopes> |
| Org-scoped publishing requires creating an organisation; `npm publish --access public` for scoped public packages; staged publishing | <https://docs.npmjs.com/creating-and-publishing-scoped-public-packages> |
| Provenance requires a supported cloud CI/CD provider on a cloud-hosted runner (GitHub Actions, GitLab CI/CD); `id-token: write`; `--provenance --access public`; matching public `repository`; `npm audit signatures` | <https://docs.npmjs.com/generating-provenance-statements> |
| Unpublish windows: 72 hours for new packages, then no dependents + under 300 weekly downloads + single owner; `--force`; not undoable; name and version never reusable; 24-hour lockout | <https://docs.npmjs.com/policies/unpublish> and <https://docs.npmjs.com/cli/v11/commands/npm-unpublish> |
| Deprecate syntax, version ranges including prereleases, ownership requirement, empty string to undo, whole-package deprecation drops search results | <https://docs.npmjs.com/cli/v11/commands/npm-deprecate> |
| dist-tag `add`/`rm`/`ls`; publish sets `latest` unless `--tag`; semver-looking tags rejected | <https://docs.npmjs.com/cli/v11/commands/npm-dist-tag> |

## See also

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to change a profile or the code before it is released.
- [`CHANGELOG.md`](CHANGELOG.md) — what each version changed.
- [`docs/agents.md`](docs/agents.md) — generated; the supported-agent matrix as of this commit.
