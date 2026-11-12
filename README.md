# skillporter

Convert AI agent skills between agent formats — and get an honest report of what changed.

> **Status: Phase 1b complete.** The IR, the parsers for all five agents, `inspect`, `agents`
> and `lint` are working and tested on Linux, macOS and Windows. `convert` is not built yet,
> and the package is not published. See [Roadmap](#roadmap).

## Commands

```bash
skillporter inspect <path> [--from <agent>] [--json]
skillporter lint <path> --for <agent> [--from <agent>] [--format text|json] [--ignore-unknown]
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
  body         1.1 KB  ·  sha256 ef70c8ccd3ef
  frontmatter  4 field(s)

  fields
    name           string   honoured
    allowed-tools  string   honoured
    x-acme-owner   string   unknown (line 5)

  shell syntax found: 2 occurrence(s), none executed
    line 23  inline-bang  git rev-parse --short HEAD
    line 27  fenced-bang  python scripts/build_report.py --input sample.csv

  diagnostics  0 error(s), 3 warning(s), 0 info
  warning UNKNOWN_CAPABILITY      SKILL.md:5      field "x-acme-owner" is not understood by claude-code; preserved verbatim
  warning SHELL_INJECTION         SKILL.md:23     claude-code executes this placeholder before the body is loaded
```

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
  warning SP017  SKILL.md        DeepSeek Harness (dsh) does not execute shell syntax in the body; 2 occurrence(s) will appear as literal text
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
by writing a synthetic profile to a temporary directory and asserting that a dozen rules fire
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

Phase 1 scope. `verified` means every fact in the profile traces to a primary source
retrieved on the date shown.

| Agent | Project root | Global root | Name / identity | Description | Status |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `.claude/skills` | `~/.claude/skills` | none enforced (character blocklist) | truncates at 1,536 chars | verified |
| DeepSeek Harness (`dsh`) | `.dsh/skills`, `.agents/skills` | `~/.dsh/skills`, `~/.agents/skills` | `^[a-z0-9]+(?:-[a-z0-9]+)*$` | truncates at 500 chars | verified |
| Codex CLI | `.agents/skills` | `~/.agents/skills` | unknown | context budget, ~8,000 chars | verified |
| OpenCode | `.opencode/skills`, `.claude/skills`, `.agents/skills` | `~/.config/opencode/skills` | derived from path, not frontmatter | none enforced | verified |
| Kimi Code CLI | `.kimi-code/skills`, `.agents/skills` | `~/.kimi-code/skills`, `~/.agents/skills` | case-insensitive, no grammar | required (directory form) | verified |

Four of the five read `.agents/skills`; only Claude Code does not. Full detail, including
source URLs and retrieval dates, is in [`docs/research.md`](docs/research.md). The
machine-readable form is in [`agents/`](agents/).

## Fidelity reporting

Every conversion classifies each field and feature as one of:

| Category | Meaning |
| --- | --- |
| `preserved` | Carried over with identical meaning |
| `adapted` | Carried over with a documented change (renamed, truncated, path moved) |
| `degraded` | Carried over but the target will behave differently |
| `dropped` | Cannot be represented; the target has no equivalent |
| `unknown` | The target's behaviour is not verified |

Exit codes: `0` clean, `1` error, `2` converted with degradations (make it fatal with
`--strict`).

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
  `.agents/skills`, `dsh` ranks project over user, Codex merges duplicates rather than
  resolving them, OpenCode lets the later source silently override, and Kimi Code keeps
  same-name skills as variants. The report names the rule that decides a duplicate name for
  each target.
- **Body adaptation is rules-based only.** Known tool names and syntax are mapped from a
  data table. Anything not in the table is flagged, never guessed. An optional LLM-assisted
  mode is planned but will be off by default and require an explicit flag.
- **Shell-injection syntax is neutralised by default.** Claude Code's `` !`cmd` `` placeholders
  and ` ```! ` blocks are executable. Converting *to* Claude Code from an agent that does not
  execute them never produces executable content that was not executable in the source:
  the syntax is escaped and a warning is emitted, unless `--shell-injection=keep` is passed.
  Converting *away* from Claude Code preserves the text and reports `degraded`, listing each
  occurrence.
- **Unverified behaviours.** Codex's name grammar, OpenCode and Kimi Code symlink handling,
  Kimi Code's `license`/`compatibility`/`metadata`/`allowed-tools` support, and the flow body
  format are all `unknown`. The converter warns rather than assumes.
- **`dsh` is in developer preview** and promises breaking changes. Its filesystem
  discovery is the most stable part; the profiles are pinned to a retrieval date.

## Roadmap

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Research doc + capability profiles for Claude Code, `dsh`, Codex CLI | done |
| 0.5 | Research + profiles for OpenCode and Kimi Code CLI | done |
| 1a | IR, schema, parsers, `inspect`, `agents`, CI on 3 OSes | done |
| 1b | `lint --for <agent>` with rule IDs, severities and source URLs | done |
| 1c | `convert`, conversion report, install with backup | next |
| 1d | Fixtures with attribution, golden/round-trip/security tests, CONTRIBUTING | planned |
| 2 | More Agent Skills agents via profiles (Cursor, Gemini CLI, Copilot, Zed, ZCode, Cline, Roo, Windsurf, Deep Agents) | planned |
| 3 | Non-`SKILL.md` formats (`AGENTS.md`, Cursor rules, Gemini commands, legacy Claude commands) | planned |
| 4 | Optional `--ai` adaptation, `doctor`, interop with `npx skills` | planned |

## Repository layout

```
agents/            capability profiles, one YAML per agent (data, not code)
schema/            JSON Schema for capability profiles, the IR and the lint report
docs/research.md   verified per-agent facts with source URLs and retrieval dates
docs/lint-rules.md generated rule catalogue; edit the code, not the document
docs/adr/          architecture decision records
fixtures/lint/     skills that each exercise one lint rule
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
npm test                   # build, then the test suite
```

Adding an agent: copy an existing profile in `agents/`, verify every field against that
agent's official documentation, cite the URL and retrieval date, and run
`npm run validate:profiles`. If a fact cannot be verified, set it to `unknown` with a note.
No code is needed unless the agent does not read `SKILL.md` at all.

## License

[Apache-2.0](LICENSE). Chosen over MIT for the explicit patent grant, which matters for a
tool that companies will embed in their own agent tooling, and for the trademark clause
that keeps the name from being used to imply endorsement of a fork.
