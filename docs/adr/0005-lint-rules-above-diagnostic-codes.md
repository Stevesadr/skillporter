# ADR-0005: Lint rules sit above diagnostic codes, and severity comes from the profile

**Status:** accepted (Phase 1b)

## Context

`lint` has to explain *why* a skill will not work on a target, and the same fact has to be
readable by two different audiences: a human scanning a terminal, and the conversion report
in Phase 1c. Phase 1a already had a stable diagnostic vocabulary (`SHELL_INJECTION`,
`UNKNOWN_CAPABILITY`, `LIMIT_EXCEEDED`, …), but it is too coarse to report on:

1. **One code covers several meanings.** `LIMIT_EXCEEDED` describes a name that is too long,
   a description that will be shortened in a catalog, a discovery depth that is never
   scanned, and skillporter's own file-size limit. Four different problems, four different
   fixes, one code.
2. **The same fact has a different severity per agent.** A missing `name` is fatal for
   `dsh` and harmless for Claude Code, which falls back to the directory name. A flat `.md`
   file is invisible to Codex and perfectly fine for `dsh`.
3. **Severity has to follow the research, not the author's nerves.** The project rule is
   that a limit the agent enforces by rejecting is an `error`, and a limit that only
   truncates a display string is a `warning`. That distinction exists in the profiles
   (`enforcement`, `fields[].status`, `truncation`) and must not be re-litigated in code.

## Decision

1. **A separate, stable rule catalogue** (`SP001`…`SP024`) in `packages/core/src/rules.ts`.
   Rule ids are never reused and never renumbered, so a report can be diffed across releases.
   Each rule declares: id, slug, title, area, diagnostic code, the profile field(s) it reads,
   its severity policy, its fix, and its description.
2. **`code` says what kind of fact was observed; `ruleId` says what it means here.** One code
   may back several rules, and one rule may emit a second code when the underlying fact is
   `unknown`. The mapping is generated into `docs/lint-rules.md` from the catalogue, so the
   document cannot drift from the code.
3. **Severity is a function of the profile.** `severityForEnforcement` maps `reject` and
   `silent-skip` to `error`, `truncate` to `warning`, and `none` to `info`. `silent-skip`
   counts as an error because the outcome for the user is identical to rejection — the skill
   never appears — and the only feedback is a log line.
4. **Two derivations, labelled.** Twenty rules are `derivation: profile` and read only
   capability-profile data; four are `derivation: tool` and report skillporter's own
   observations (a symlink it would not follow, a limit it hit, a case collision). Tool
   findings are never presented as agent limits.
5. **Every finding carries a source URL.** Profiles declare `covers` on each source, so a
   rule cites the document that substantiates its area. The profile validator fails if a
   profile cannot cover `paths`, `discovery`, `identity`, `name`, `description` and `fields`.
6. **`lint` never refuses on ambiguity.** Where `inspect` requires `--from`, `lint` assumes a
   source only to read the file, reports the assumption, and states that the target rules are
   unaffected. Source-relative parse diagnostics are filtered out, so the assumption cannot
   change a finding.
7. **Exit codes:** `0` clean, `1` at least one error, `2` warnings only. `--ignore-unknown`
   suppresses `UNKNOWN_CAPABILITY` only: it can turn a `2` into a `0`, never a `1` into a `0`.

## Consequences

- A new agent profile brings its rules with it. The test suite proves this by writing a
  synthetic profile to a temporary directory and asserting that a dozen rules fire for an
  agent the codebase has never heard of. That test is the guard against the catalogue quietly
  becoming per-agent code.
- `docs/lint-rules.md` is generated and CI-checked, so adding a rule without regenerating the
  document fails the build.
- The `SP…` namespace is a public surface. Removing a rule is a breaking change; correcting
  one is not.
- `schema/lint-report.schema.json` is versioned with the same discipline as the IR schema, so
  Phase 1c can reuse the finding shape in the conversion report without a translation layer.

## Alternatives rejected

- **Report diagnostic codes directly.** Cheap, but a user cannot tell a name-length error from
  a file-size warning, and the conversion report would have to re-derive meaning from prose.
- **One rule per agent per fact** (`CODEX_NAME`, `DSH_NAME`, …). Turns the catalogue into the
  per-agent code the project exists to avoid, and makes every new profile a code change.
- **Severity hardcoded per rule.** Fails the requirement that severity match the research: the
  same rule must be an error where the agent rejects and a warning where it truncates.
- **A single numeric score instead of severities.** Cannot express "this will not load" versus
  "this will look different", which is the only distinction a user acts on.
