# skillporter

Convert AI agent skills between agent formats — and get an honest report of what changed.

> **Status: Phase 0 complete.** Research and capability profiles for three agents are
> finished and validated. There is no working converter yet; `packages/` is empty and the
> package is not published. See [Roadmap](#roadmap).

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

Phase 0/1 scope. `verified` means every fact in the profile traces to a primary source
retrieved on the date shown.

| Agent | Format | Project root | Global root | Name rule | Description | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | Agent Skills + extensions | `.claude/skills` | `~/.claude/skills` | none (character blocklist only) | truncates at 1,536 chars | verified |
| DeepSeek Harness (`dsh`) | Agent Skills | `.dsh/skills`, `.agents/skills` | `~/.dsh/skills`, `~/.agents/skills` | `^[a-z0-9]+(?:-[a-z0-9]+)*$` | truncates at 500 chars | verified |
| Codex CLI | Agent Skills + `agents/openai.yaml` | `.agents/skills` | `~/.agents/skills` | unknown | context budget, ~8,000 chars | verified |

Full detail, including source URLs and retrieval dates, is in [`docs/research.md`](docs/research.md).
The machine-readable form is in [`agents/`](agents/).

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
- **Body adaptation is rules-based only.** Known tool names and syntax are mapped from a
  data table. Anything not in the table is flagged, never guessed. An optional LLM-assisted
  mode is planned but will be off by default and require an explicit flag.
- **Unverified behaviours.** Codex's name grammar, its handling of `license`,
  `compatibility`, `metadata` and `allowed-tools`, and whether any agent enforces a maximum
  skill size are all `unknown`. The converter warns rather than assumes.
- **`dsh` is in developer preview** and promises breaking changes. Its filesystem
  discovery is the most stable part; the profiles are pinned to a retrieval date.

## Roadmap

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Research doc + capability profiles for Claude Code, `dsh`, Codex CLI | done |
| 1 | IR, pipeline, report, CLI (`convert`, `inspect`, `lint`, `agents`), tests, CI | next |
| 2 | More Agent Skills agents via profiles (Cursor, Gemini CLI, Copilot, Zed, ZCode, OpenCode, Cline, Roo, Windsurf, Deep Agents) | planned |
| 3 | Non-`SKILL.md` formats (`AGENTS.md`, Cursor rules, Gemini commands, legacy Claude commands) | planned |
| 4 | Optional `--ai` adaptation, `doctor`, interop with `npx skills` | planned |

## Repository layout

```
agents/            capability profiles, one YAML per agent (data, not code)
schema/            JSON Schema for capability profiles
docs/research.md   verified per-agent facts with source URLs and retrieval dates
docs/adr/          architecture decision records
scripts/           repository tooling
tests/             test suite
packages/          core, cli (Phase 1)
```

## Working on it

```bash
npm install
npm run validate:profiles   # schema + semantic checks over agents/*.yaml
npm test
```

Adding an agent: copy an existing profile in `agents/`, verify every field against that
agent's official documentation, cite the URL and retrieval date, and run
`npm run validate:profiles`. If a fact cannot be verified, set it to `unknown` with a note.

## License

[Apache-2.0](LICENSE). Chosen over MIT for the explicit patent grant, which matters for a
tool that companies will embed in their own agent tooling, and for the trademark clause
that keeps the name from being used to imply endorsement of a fork.
