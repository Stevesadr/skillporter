# skillporter

Convert AI agent skills between agent formats — and get an honest report of what changed.

> **v0.1.0 public alpha. Experimental, pre-1.0.** The IR, the parsers, `inspect`, `agents`, `lint`
> and `convert` work and are tested on Linux, macOS and Windows, but nothing here is frozen:
> the command surface, the report format and the lint rule ids may all change before 1.0,
> and a change to a capability profile can make a conversion report differently without any
> code changing. Do not build a pipeline that depends on exit code 2 without pinning a
> version. See [Honest limitations](#honest-limitations)
> for what is not known, and [Roadmap](#roadmap) for what is planned.

## Quick start

Requires Node.js 22.20.0 or newer. Install the version used by these examples:

```bash
npm install --global @skillporter/cli@0.1.0
skillporter --version
skillporter agents
```

Preview a Claude Code skill conversion to Codex CLI:

```bash
skillporter convert ./.claude/skills/my-skill --from claude-code --to codex-cli --dry-run
```

Review the fidelity report, then install from the Codex project directory:

```bash
skillporter convert ./.claude/skills/my-skill --from claude-code --to codex-cli --install --project
```

Codex discovers the converted skill under `.agents/skills/my-skill`. Open Codex
in the project and invoke it as `$my-skill`. Exit code `2` means the conversion
has losses. Add `--strict` to reject those losses before writing.

## Live demo with Caveman on Codex

Start in a fresh directory. This demo uses the published CLI and a pinned copy
of the upstream [Caveman skill](https://github.com/JuliusBrussee/caveman/tree/a192894723a8f47e7f504c7b5041967ff1f18e55/skills/caveman).

```bash
npm install --global @skillporter/cli@0.1.0
git init caveman-source
git -C caveman-source fetch --depth 1 https://github.com/JuliusBrussee/caveman.git a192894723a8f47e7f504c7b5041967ff1f18e55
git -C caveman-source checkout --detach FETCH_HEAD
git init codex-demo
cd codex-demo
skillporter convert ../caveman-source/skills/caveman --from claude-code --to codex-cli --install --project
diff -qr ../caveman-source/skills/caveman .agents/skills/caveman
codex exec --ephemeral --sandbox read-only '$caveman What is an HTTP 304 response? Mention the status code and why the response has no body.'
```

- **Files preserved.** `SKILL.md` and `README.md` matched the source byte for byte
  under `.agents/skills/caveman/`.
- **Invocation to review.** The conversion exited `0` with lint warning `SP026`
  for references such as `/caveman` and `/caveman-compress`. Use `$caveman` in Codex.
- **Plugin behavior to review.** Automatic activation and hook-backed mode tracking
  require [Caveman's host-specific hooks](https://github.com/JuliusBrussee/caveman/blob/a192894723a8f47e7f504c7b5041967ff1f18e55/docs/technical/skills-hooks-and-plugins.md)
  outside the converted directory. In a fresh Codex session, an explicit `$caveman`
  status request returned `Caveman mode: off (not tracked by this host)`.

The HTTP example returned “HTTP `304 Not Modified`: cached resource is still
valid. Response has no body because client should reuse its cached representation.”

### Compatibility check

Tested on macOS on 2026-11-21 with Node.js `24.5.0`, npm `11.5.1`, Codex CLI
`0.144.6` and OpenCode `1.18.18`. A fresh install from the public npm registry
resolved both `@skillporter/cli` and `@skillporter/core` to `0.1.0` and listed
all six profiles. Each upstream directory was converted with `--from claude-code`
and installed into a fresh project for its target. Discovery was verified by path
with Codex's `skills/list` and `opencode debug skill --pure`.

| Upstream skill at the tested revision | Identical files per target | Codex exit | OpenCode exit | Behavior to review |
| --- | ---: | ---: | ---: | --- |
| [Caveman](https://github.com/JuliusBrussee/caveman/tree/a192894723a8f47e7f504c7b5041967ff1f18e55/skills/caveman) | 2/2 | 0 | 0 | Host hooks are outside the skill directory. |
| [Ultracave](https://github.com/JuliusBrussee/caveman/tree/a192894723a8f47e7f504c7b5041967ff1f18e55/skills/ultracave) | 2/2 | 2 | 0 | The Codex report marked `disable-model-invocation` as degraded. To keep invocation manual, review setting `policy.allow_implicit_invocation` to `false` in `agents/openai.yaml`. OpenCode documents support for the original field. |
| [Anthropic Skill Creator](https://github.com/anthropics/skills/tree/e4bb5d960d87126ff3b3a8af1a104b7db67560ba/skills/skill-creator) | 18/18 | 0 | 0 | The evaluation and description-tuning scripts still call `claude -p`. Running them requires a working Claude Code setup or a port to the target CLI. |
| [Vercel React Best Practices](https://github.com/vercel-labs/agent-skills/tree/5a37a6329fbad3666c3207392a6a7c0110e92efb/skills/react-best-practices) | 76/76 | 2 | 2 | Both reports flagged target handling of `license` and `metadata`. Both fields stayed in `SKILL.md`. |

**8/8** installs succeeded and were discovered, with **196/196** file copies
byte-identical. Five conversions exited `0` and three exited `2`. All eight had
lint warnings and zero lint errors. A separate `--strict` run of Ultracave to
Codex exited `1` before writing the skill. The published CLI reports `0.1.0`
with `--version`, but its JSON conversion reports label `tool.version` as `0.0.0`.
Live model checks covered Caveman in Codex. Claude Code served as the source
format, and the Skill Creator scripts were only checked for file preservation
and their CLI dependency.

### Help test and improve Skillporter

Try migrating one skill you use and report the outcome in
[GitHub Issues](https://github.com/Stevesadr/skillporter/issues). Include the
Skillporter version, source and target agent versions, and the skill revision.
For an incompatibility, include a minimal `SKILL.md` and any required companion
files, the exact command, and the expected and actual results. The first round
tracks reported successful migrations and reproducible incompatibilities.

If you want to contribute a pull request, reproduce the JSON report version
mismatch, check how a target agent handles a field marked `unknown`, or add a
small fixture for a real migration edge case. See the
[contribution guide](CONTRIBUTING.md) for profile evidence and test commands.

## Commands

```bash
skillporter inspect <path> [--from <agent>] [--json]
skillporter lint <path> --for <agent> [--from <agent>] [--format text|json] [--ignore-unknown]
skillporter convert <path> --to <agent[,agent...]> [--from <agent|auto>] [--out DIR] [--install]
                          [--global|--project] [--dry-run] [--strict] [--force]
                          [--shell-injection=neutralize|keep|strip] [--report text|json|md]
skillporter agents [--json]
```

`inspect` parses a skill and prints its intermediate representation plus every diagnostic.
It reads; it never writes and never executes. Exit code is `0` when there are no errors and
`1` when there are.

```
$ skillporter inspect fixtures/skills/report-builder --from claude-code
report-builder  ·  fixtures/skills/report-builder

  origin       Claude Code (claude-code, agent-skills, directory layout)
  identity     report-builder  [from frontmatter]
  text         line endings LF  ·  BOM no
  body         1.1 KB  ·  sha256 ef70c8ccd3ef
  frontmatter  4 field(s)
  …

  fields
    name           string   honoured
    description    string   honoured
    allowed-tools  string   honoured
    x-acme-owner   string   unknown (line 5)

  …

  shell syntax found: 2 occurrence(s), none executed
    line 23  inline-bang  git rev-parse --short HEAD
    line 27  fenced-bang  python scripts/build_report.py --input sample.csv --out /tmp

  diagnostics  0 error(s), 3 warning(s), 0 info
  warning UNKNOWN_CAPABILITY      SKILL.md:5      field "x-acme-owner" is not understood by claude-code; preserved verbatim
  warning SHELL_INJECTION         SKILL.md:23     claude-code executes this placeholder before the body is loaded
  …
```

Lines elided above are marked `…`; nothing is reordered or reworded. The full output also
lists the description, how the source was detected, every bundled file with its size and
mode, and the tool limits in force.

### Why `--from` is sometimes required

`.agents/skills` is read natively by Codex, DeepSeek Harness and Kimi Code, and as a
compatibility source by OpenCode. Their rules differ, so `skillporter` refuses to pick one:

```
$ skillporter inspect fixtures/shared-root/.agents/skills/shared-helper
error: cannot tell which agent this skill belongs to.

  .agents/skills is read natively by codex-cli, deepseek-harness, kimi-code, so it has no single owning agent
```

A skill under `.claude/skills`, `.dsh/skills`, `.opencode/skills` or `.kimi-code/skills` is
detected automatically, because one agent owns that directory.

`lint` is the exception: it does not refuse. It assumes a source only to read the file, says
so, and reports that the target rules are unaffected.

## Linting

`lint` answers one question: *will this skill work on that agent?* It reads, it never writes,
it never fixes anything, and it never executes the skill.

```
$ skillporter lint fixtures/skills/report-builder --for deepseek-harness --from claude-code
report-builder  ·  fixtures/skills/report-builder

  target    DeepSeek Harness (dsh) (deepseek-harness) [verified]
  source    claude-code  (given with --from)
  identity  report-builder  [from frontmatter]
  layout    directory

  warning SP011  SKILL.md:4      DeepSeek Harness (dsh) accepts "allowed-tools" but does nothing with it
          hint: Parsed into the metadata bag and otherwise ignored. dsh has no equivalent pre-approval.
          fix:  Keep the field if the file must stay portable, and move the behaviour it expresses into the body or into the target configuration.
          see:  https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill-filesystem/src/index.ts
  warning SP013  SKILL.md:5      "x-acme-owner" is not mentioned anywhere in the deepseek-harness capability profile
          hint: skillporter has no verified answer for this field and will not guess. The field is preserved verbatim.
          fix:  Check the target documentation, then record the answer in the capability profile rather than in this skill.
          see:  https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill-filesystem/src/index.ts
  warning SP017  SKILL.md        DeepSeek Harness (dsh) does not execute shell syntax in the body; 2 occurrence(s) will appear as literal text, and the source agent executed it
          hint: These placeholders expanded in the source agent. Here they are text the model reads, which changes the prompt.
          fix:  Replace the placeholder with the text it produced in the source agent, or keep it as documentation and say so.
          see:  https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/skills.md

  result  warnings  ·  0 error(s), 3 warning(s), 0 info
```

Every finding carries a stable rule id, a severity, the file and line where it applies, the
capability-profile URL it rests on, and a suggested fix you apply yourself. The full
catalogue, with the diagnostic-code mapping, is in [`docs/lint-rules.md`](docs/lint-rules.md).

Severity follows what the agent *does*, not how bad the news feels:

| The agent… | Severity |
| --- | --- |
| refuses to load the skill (`reject`), or drops it silently (`silent-skip`) | `error` |
| shortens a display string (`truncate`), or ignores the field | `warning` |
| does not enforce anything (`none`) | `info` |
| behaviour is undocumented (`unknown`, `null`) | `warning`, and `--ignore-unknown` suppresses it |

Exit codes: `0` clean or informational only, `1` at least one error, `2` warnings only.

### Why `lint` has no per-agent code

Every rule reads the target capability profile. There is no `if (agent === 'codex-cli')`
anywhere in the engine: adding an agent brings its rules with it. The test suite proves this
by writing a synthetic profile to a temporary directory and asserting that ten rules fire
for an agent the codebase has never heard of.

### Tool limits

`inspect` and `lint` refuse to read unbounded input. These are **skillporter's** limits, not
any agent's, and every report says so. A limit that is hit is reported under rule SP023,
labelled as a tool limit, and never confused with an agent limit:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--max-file-bytes` | 10 MiB | Largest single bundled file |
| `--max-files` | 500 | Most bundled files to enumerate |
| `--max-total-bytes` | 50 MiB | Total size of bundled files |
| `--max-depth` | 8 | Deepest nesting below the skill root |

Symlinks that resolve outside the skill root are skipped and reported, never followed.

## Why

A skill is a directory with a `SKILL.md` (YAML frontmatter plus Markdown instructions) and
optional `scripts/`, `references/` and `assets/`. The [Agent Skills](https://agentskills.io)
specification defines that core, and most modern coding agents read it — but they disagree
about where to look, how deep to scan, what to name things, how long a description may be,
and which extra frontmatter fields they honour.

So a skill written for one agent does not just work in another, and the ways it fails are
quiet. `DeepSeek Harness`, for example, ignores an invalid skill with a log line: the skill
simply never appears, and nothing tells you why.

`skillporter` converts a skill into another agent's layout and tells you, field by field,
what was preserved, adapted, degraded or dropped — and why. It never converts silently.

## Principles

1. **Never silently lossy.** Every run produces a report; the exit code tells you whether
   anything was degraded.
2. **Never executes skill content.** Skills may contain scripts; the tool only reads and
   copies bytes.
3. **Data over code.** Adding a new Agent Skills agent means adding one YAML file, not a
   module.
4. **No guessing.** An unverified agent behaviour is reported as a warning, never inferred.

## Supported agents

Six capability profiles: five agents that discover a skill directory on disk, and one
upload form. The full matrix — discovery roots, name grammar, description limits, which
frontmatter fields each agent honours, and the source behind every fact — is generated
from the profiles themselves and lives in [`docs/agents.md`](docs/agents.md). It is not
repeated here, because a table maintained by hand drifts from the data.

| Agent | id | Reads | Verified |
| --- | --- | --- | --- |
| Claude Code | `claude-code` | `.claude/skills` | verified |
| DeepSeek Harness (`dsh`) | `deepseek-harness` | `.dsh/skills`, `.agents/skills` | verified |
| Codex CLI | `codex-cli` | `.agents/skills` | verified |
| OpenCode | `opencode` | `.opencode/skills`, `.claude/skills`, `.agents/skills` | verified |
| Kimi Code CLI | `kimi-code` | `.kimi-code/skills`, `.agents/skills` | verified |
| Claude.ai / Skills API upload | `claude-ai-upload` | nothing: a bundle is uploaded | partial |

Four of the five directory agents read `.agents/skills`, which is why it is the default
shared output; only Claude Code does not. `claude-ai-upload` is `partial` because only its
name and description rules are documented — see [Honest limitations](#honest-limitations).

The machine-readable form is in [`agents/`](agents/); the evidence, with URLs and retrieval
dates, is in [`docs/research.md`](docs/research.md).

## Fidelity reporting

Every conversion classifies each field and feature as one of:

| Category | Meaning | Counts as a loss |
| --- | --- | --- |
| `preserved` | Carried over unchanged | no |
| `adapted` | Changed so it keeps working (a flat `.md` wrapped in a directory, an inline placeholder turned into a code span) | no |
| `renamed` | Same meaning, different spelling the target requires | no |
| `degraded` | Still there, but the target will not act on it, or its behaviour is unknown | yes |
| `dropped` | Cannot be represented; the target has no equivalent | yes |

Exit codes: `0` clean, `1` error, `2` converted with losses. `--strict` rejects
planned losses or staged lint errors before changing any destination. Omitted
bundled files appear by path with their reason in the fidelity report.

The report is validated against [`schema/conversion-report.schema.json`](schema/conversion-report.schema.json),
so `--report json` is stable enough to feed another tool.

## Converting

```bash
# one copy per target under a directory you choose
skillporter convert ./my-skill --to codex-cli,claude-code --out ./converted

# straight into each agent's own skill directory
skillporter convert ./my-skill --to codex-cli,deepseek-harness,kimi-code,opencode,claude-code --install

# look, do not write
skillporter convert ./my-skill --to claude-code --dry-run

# the upload form for claude.ai / the Skills API: a folder to upload, not a root to install into
skillporter convert ./my-skill --to claude-ai-upload --out ./upload
```

```
$ skillporter convert fixtures/skills/report-builder --from codex-cli --to claude-code --out /tmp/out
report-builder  ·  fixtures/skills/report-builder

  source   codex-cli (given with --from) · directory · identity report-builder · directory layout
  mode     written under --out
  targets  claude-code

  Claude Code (claude-code)
    → /tmp/out/report-builder
    9 preserved · 3 adapted · 0 renamed · 1 degraded · 0 dropped
      layout                              preserved directory layout kept
      field:name                          preserved kept unchanged
      field:description                   preserved kept unchanged; a display-only limit is reported by lint rather than enforced here
      field:allowed-tools                 preserved kept verbatim
      field:x-acme-owner                  degraded  claude-code's capability profile does not mention this field, so it was kept verbatim and its effect is unknown
      body                                adapted   rewritten for claude-code: 2 shell occurrence(s) changed, everything else byte-exact
      shell-injection:inline-bang@23      adapted   the placeholder was rewritten as a plain code span: claude-code would have executed it, and the source agent did not
      shell-injection:fenced-bang@27      adapted   the placeholder was rewritten as a plain code span: claude-code would have executed it, and the source agent did not
      file:assets/chart.png               preserved copied byte-for-byte
      file:assets/logo.svg                preserved copied byte-for-byte
      file:references/nested/checklist.md  preserved copied byte-for-byte
      file:references/STYLE.md            preserved copied byte-for-byte
      file:scripts/build_report.py        preserved copied byte-for-byte with the executable bit

    lint of the output  warnings  ·  0 error(s), 1 warning(s), 0 info
      warning SP013  "x-acme-owner" is not mentioned anywhere in the claude-code capability profile:5

  roots
    /tmp/out  [project]  write  for claude-code

  note  post-conversion lint ran on a staged copy of each output, so rules that depend on the destination location are not part of it

  result  converted with losses  ·  9 preserved · 3 adapted · 0 renamed · 1 degraded · 0 dropped
```

Notes that follow from the pipeline:

- **The output is linted, not the source.** A flat `.md` is a lint error for an agent that
  needs a directory, and wrapping it is exactly what `convert` just did — so that output is
  reported clean.
- **Nothing is ever executed.** A skill whose script would `touch` a file is converted without
  running it; a test asserts this.
- **Replacing is never silent.** An existing skill is an error unless `--force` is passed, and
  the replacement is staged in full before the previous copy is moved aside.
  An install keeps the previous copy in a timestamped `.skillporter-backups/` folder.
  Every destination is checked before writing. If a write fails, the report
  shows which destinations were written and why each remaining write stopped.
- **Four agents share `.agents/skills`.** Byte-identical outputs are written once. Outputs that
  differ collapse to a least-common-denominator copy, and the loss is reported. Claude Code
  always gets a real copy under `.claude/skills`, never a symlink.

## Honest limitations

These are known gaps, not bugs. They are listed here because the project's premise is that
silence is the enemy.

- **Claude Code's extensions cannot be converted.** `context: fork`, shell-injection
  placeholders, argument substitution, `hooks`, `paths` and turn-scoped `allowed-tools`
  have no equivalent in `dsh` or Codex. They are reported as `dropped`.
- **Codex's `agents/openai.yaml` has no analogue elsewhere.** Interface metadata,
  `policy.allow_implicit_invocation` and `dependencies.tools` are dropped when converting
  away from Codex.
- **`when_to_use` and `whenToUse` are different spellings of the same idea.** Converting
  between them is a rename, and the report says so.
- **Kimi Code's `type: flow` has no equivalent elsewhere.** The type is documented as
  "manual invocation only"; its body format is not documented at all, so a Mermaid or D2
  requirement cannot be relied on. Converting away from Kimi keeps the body as plain text,
  reports `type` as `degraded` with an explicit warning, and never invents a `flow` type on
  the way in.
- **Precedence differs per agent, so a shared directory is not a shared meaning.** In
  `.agents/skills`, `dsh` gives project roots a lower rank number than user roots, so project
  wins; Codex does **not** merge duplicate names at all — both skills stay visible in the
  selector; OpenCode lets the later-registered source supply the skill; and Kimi Code keeps
  same-name skills from different configured directories as variants you pick between. The
  report names the rule that decides a duplicate name for each target.
- **Body adaptation is rules-based only.** Known tool names and syntax are mapped from a
  data table. Anything not in the table is flagged, never guessed. An optional LLM-assisted
  mode is planned but will be off by default and require an explicit flag.
- **Shell-injection syntax is neutralised by default.** Claude Code's `` !`cmd` `` placeholders
  and ` ```! ` blocks are executable. Converting *to* Claude Code from an agent that does not
  execute them never produces executable content that was not executable in the source:
  the syntax becomes a plain code span, reported as `adapted`, unless `--shell-injection=keep`
  is passed (reported as `degraded`) or `strip` (reported as `dropped`). Converting *away* from
  Claude Code preserves the text and reports `degraded`, listing each occurrence.
- **Claude Code has two surfaces and both are targets, with different evidence behind them.**
  Local `.claude/skills` directories are `verified` and accept every field. The upload form
  (claude.ai / the Skills API) is a separate profile, `claude-ai-upload`, and it is only
  `partial` pending an end-to-end upload test. The documentation states that `name` and `description` are required and gives
  their rules, but it does **not** say whether `license`, `compatibility`, `metadata` or
  `allowed-tools` are accepted. Those four are therefore dropped and reported, rather than
  emitted on the assumption that the upload will tolerate them. If you can show, from an
  official source, that they are accepted, the profile changes in one file — see
  [CONTRIBUTING.md](CONTRIBUTING.md). `convert --install` refuses this target, because an
  uploaded bundle has no discovery root to install into; `--out` writes the folder to upload.
- **What is `unknown`, in full.** Nothing is ever inferred. These facts are undocumented and
  are reported as warnings rather than filled in:
  - **Codex CLI** — its name grammar, and whether it honours `license`, `compatibility`,
    `metadata` or `allowed-tools`.
  - **OpenCode** — whether it honours `allowed-tools`, and whether it follows symlinks.
  - **Kimi Code** — whether it honours `license`, `compatibility`, `metadata` or
    `allowed-tools`, and whether it follows symlinks.
  - **The upload form** — the same four fields, plus its symlink handling.
  - **Everyone** — the maximum description length is undocumented for every agent except the
    upload form; what *is* documented is a display truncation, which is a different thing and
    is reported as such.

  `--ignore-unknown` suppresses only these findings. [`docs/agents.md`](docs/agents.md) is
  generated from the profiles, so it lists every gap and cannot drift from the data.
- **The flow body format is not documented at all** for Kimi Code, so a Mermaid or D2
  requirement cannot be relied on and is not invented.
- **`dsh` is in developer preview** and promises breaking changes. Its filesystem
  discovery is the most stable part; the profiles are pinned to a retrieval date.

## Roadmap

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Research doc + capability profiles for Claude Code, `dsh`, Codex CLI | done |
| 0.5 | Research + profiles for OpenCode and Kimi Code CLI | done |
| 1a | IR, schema, parsers, `inspect`, `agents`, CI on 3 OSes | done |
| 1b | `lint --for <agent>` with rule IDs, severities and source URLs | done |
| 1c | `convert`, conversion report, install with backup | done |
| 1d | Fixtures with attribution, golden/round-trip/property tests, package check, CONTRIBUTING, issue templates | done |
| 2 | More Agent Skills agents via profiles (Cursor, Gemini CLI, Copilot, Zed, ZCode, Cline, Roo, Windsurf, Deep Agents) | planned |
| 3 | Non-`SKILL.md` formats (`AGENTS.md`, Cursor rules, Gemini commands, legacy Claude commands) | planned |
| 4 | Optional `--ai` adaptation, `doctor`, interop with `npx skills` | planned |

Two things are deliberately deferred rather than forgotten:

- **Git URL input** (`convert https://github.com/org/repo`). It needs a network fetch, a
  cache, a trust decision about what a repository may contain, and a story for a private
  repository's credentials. That is a release of its own, and it is not in the first one.
  Until then, clone the repository and pass the directory.
- **Publishing.** There is no npm publish, no tag and no release step in CI. The package
  check proves the tarballs work; publishing them is a separate, deliberate decision.

## Repository layout

```
agents/            capability profiles, one YAML per agent (data, not code)
schema/            JSON Schema for capability profiles, the IR, the lint and conversion reports
docs/agents.md     generated supported-agents matrix; edit the profiles, not the document
docs/research.md   verified per-agent facts with source URLs and retrieval dates
docs/lint-rules.md generated rule catalogue; edit the code, not the document
docs/adr/          architecture decision records
RELEASING.md       the manual release procedure; nothing publishes automatically
fixtures/          test inputs; fixtures/README.md records their provenance and licence
fixtures/lint/     skills that each exercise one lint rule
fixtures/golden/   committed conversion output, compared byte-for-byte by the tests
scripts/           repository tooling
tests/             test suite
packages/          core, cli (Phase 1)
```

## Working on it

```bash
npm install
npm run build              # tsc -b, project references
npm run typecheck          # full rebuild with checking
npm run validate:profiles  # schema + semantic checks over agents/*.yaml
npm run rules              # regenerate docs/lint-rules.md from the rule catalogue
npm run rules:check        # fail if docs/lint-rules.md has drifted
npm run agents:docs        # regenerate docs/agents.md from the profiles
npm run agents:docs:check  # fail if docs/agents.md has drifted
npm test                   # build, then the test suite
npm run check:package      # pack both workspaces, install into an empty project, run the CLI
```

`npm run check:package` exists because the source tree and an installed package are not the
same thing: `agents/` and `schema/` sit above `dist/` in the repository and have to travel
inside the tarball. The check packs both workspaces, installs them into an empty directory,
and runs `agents`, `inspect`, `lint` and `convert` from there.

[`CONTRIBUTING.md`](CONTRIBUTING.md) has a step-by-step guide to adding an agent — it is a
data change, and it takes about fifteen minutes if the documentation is good. If it is not,
the guide says what to do about that too: write `unknown`, explain why, and cite what you
read.

## License

[Apache-2.0](LICENSE). Chosen over MIT for the explicit patent grant, which matters for a
tool that companies will embed in their own agent tooling, and for the trademark clause
that keeps the name from being used to imply endorsement of a fork.
