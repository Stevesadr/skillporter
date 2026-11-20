# skillporter

Convert AI agent skills between agent formats — and get an honest report of what changed.

A skill is a directory with a `SKILL.md`, YAML frontmatter and optional `scripts/`,
`references/` and `assets/`. Claude Code, Codex CLI, DeepSeek Harness, OpenCode and Kimi Code
all read a version of that format, and they disagree about paths, field names, name grammars,
precedence and what a body may contain. skillporter converts between them without converting
silently: every run tells you which fields were honoured, renamed, dropped, degraded or simply
not understood by the target.

> **Alpha.** Pre-1.0 and experimental. The command surface, the report format and the lint
> rule ids may all change before 1.0. Do not build a pipeline that depends on exit code 2
> without pinning a version.

## Install

```bash
npm install --global @skillporter/cli@0.1.0
skillporter agents
```

Requires Node 22.20.0 or newer. Preview a conversion and review its report:

```bash
skillporter convert ./my-skill --from claude-code --to codex-cli --dry-run
```

Use `--install --project` in place of `--dry-run` to write into the project's
`.agents/skills` directory. The Claude.ai upload profile is partial pending live
upload verification.

## Commands

```bash
skillporter inspect <path> [--from <agent>] [--json]
skillporter lint <path> --for <agent> [--from <agent>] [--format text|json] [--ignore-unknown]
skillporter convert <path> --to <agent[,agent...]> [--from <agent|auto>] [--out DIR] [--install]
                          [--global|--project] [--dry-run] [--strict] [--force]
                          [--shell-injection=neutralize|keep|strip] [--report text|json|md]
skillporter agents [--json]
```

```bash
$ skillporter inspect ./my-skill --from claude-code
report-builder  ·  ./my-skill

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
```

`inspect` reads; it never writes and never executes. `lint --for <agent>` reports what that
target would do with the skill, from a 26-rule catalogue. `convert` writes to a new directory
or installs into a discovered root. Each replacement is staged before the
previous copy is moved aside. `--strict` rejects planned losses or staged lint
errors before changing any destination. If a write fails after preflight, the
report shows the outcome for each destination.

## Safety

- **Nothing in a skill is ever executed.** Not scripts, not shell placeholders in the body.
  There is a test that plants a `touch` script and shell-injection syntax and asserts no file
  appears.
- **No telemetry.** No network access at runtime, no analytics, no update check.
- **Nothing is converted silently.** Every field that the target does not understand is
  reported as `unknown` and preserved verbatim, never guessed at and never dropped without
  saying so.

## Exit codes

| Command | `0` | `1` | `2` |
| --- | --- | --- | --- |
| `inspect` | no errors | at least one error | — |
| `lint` | clean, or informational only | at least one error | warnings only |
| `convert` | converted with nothing lost | a destination write failed, an output failed lint, or `--strict` rejected a planned loss | something was degraded or dropped |

## Links

- [Source, documentation and the supported-agent matrix](https://github.com/Stevesadr/skillporter)
- [How each agent's format differs, with a source for every claim](https://github.com/Stevesadr/skillporter/blob/main/docs/agents.md)
- [Release procedure](https://github.com/Stevesadr/skillporter/blob/main/RELEASING.md)

## Licence

Apache-2.0.
