# Research: agent skill formats

**Status:** Phase 0 deliverable, extended in Phase 0.5. Everything below was fetched on **2026-11-12** and is  
recorded with its source URL. Facts that could not be traced to a primary source are  
marked `UNVERIFIED` and are encoded in the capability profiles as `unknown` so the  
converter warns instead of guessing.

Scope of this document: the Agent Skills base format plus the five MVP agents —  
Claude Code, DeepSeek Harness (`dsh`), Codex CLI, OpenCode and Kimi Code CLI. Phase 2 agents are deliberately  
absent; adding them without verification would violate the project's own rules.

---

## 1. Method

1. Read the base specification first (`agentskills.io/specification`), because every  
   agent below claims conformance to it and the differences only make sense relative to it.
2. For each agent, prefer official documentation. Where the documentation was silent or  
   incomplete, read the source code. This mattered twice:
   - the generated `config-catalog.md` for `dsh` does **not** contain the skill packages,  
     so the `dsh-skill-filesystem` config keys were read from `src/index.ts`;
   - the claim that `dsh` ignores invalid skill names is a log statement in source, not  
     a documented behaviour.
3. Cross-check third-party write-ups (the `pasqal-io/agent-marketplace` doc, the  
   `vercel-labs/skills` README) against the primary sources, and record them as  
   cross-checks only. One third-party claim did not survive: see C3 and C8.
4. Encode each verified fact in `agents/<agent>.yaml` and run `npm run validate:profiles`.
5. **Phase 0.5 addendum.** OpenCode and Kimi Code were researched the same way, with two
   extra constraints worth recording:
   - Kimi Code's documentation is Chinese-language and lives under
     `kimi.com/code/docs/kimi-code-cli/`. There is no English mirror and no `llms.txt`. The
     pages were fetched directly and the quotations below are translated. There is **no
     dedicated page for flow skills**; the full navigation tree was enumerated and `type:
     flow` is documented only as "manual invocation only" on the skills page.
   - When a claim could not be found on any official page, it was left out of the profile
     rather than inferred. The Mermaid/D2 requirement is the main casualty: see C18.

---


## 2. Corrections to the project brief

The brief asked to be corrected where it was wrong. These are the substantive errors and  
gaps found. Each one changes either a capability profile or the pipeline.

**C1 — Codex CLI does not use a `.codex/skills` project path.**  
Codex reads `.agents/skills` from the working directory **and every ancestor up to the  
repository root**, plus `$HOME/.agents/skills`, `/etc/codex/skills`, and bundled system  
skills. The brief listed Codex among agents that "read the same core format" without  
noting that it shares the `.agents/skills` root with `dsh` and OpenCode. This is the  
single most useful finding in Phase 0: **`.agents/skills` is the de facto interop point**,  
so it should be the default `--install` target whenever more than one target agent is  
selected, and the default project output directory. See ADR-0003.

**C2 — Claude Code does not enforce kebab-case names, and `name` is optional.**  
The spec requires `name` to be 1–64 chars of `[a-z0-9-]`, with no leading, trailing or  
consecutive hyphens, and to match the parent directory name. Claude Code enforces none of  
that. `name` may be omitted entirely and defaults to the directory name; the directory  
name also stays a valid invocation. The only refused characters are zero-width and control  
characters, private-use characters, direction-changing characters, `<`, `>`, and blanks  
other than a single plain space between words. Consequence: **name normalisation is a  
one-way street.** Claude → `dsh` needs rewriting; `dsh` → Claude does not. A converter  
that always rewrites names is lossy for no reason.

**C3 — `dsh`'s 500-character description limit is a display bound, not a validation rule.**  
The brief says `dsh` requires "description under 500 chars". More precisely:  
`catalogDescriptionMaxLength` is a config key on the **consumer** (`dsh-tool-skill`),  
default `500`, minimum `3`. It bounds what is injected into the model catalog, so an  
over-long description is **truncated, not rejected** — the skill still loads by name. The  
filesystem provider only requires a non-empty string. This changes the report category  
from `dropped`/error to `degraded`, and it means the profile needs a separate  
`description.truncation` block distinct from `description.maxLength` (the schema enforces  
that separation, and a test asserts no profile conflates them).

**C4 — `dsh` also accepts flat `<name>.md` files.**  
The brief states the requirement is `<name>/SKILL.md`, exactly one level deep. True, but  
incomplete: a bare `<name>.md` in a discovery root is also loaded as a flat skill. What  
*is* true is that recursive `**/SKILL.md` discovery is unsupported, so a skill nested two  
directories down is invisible rather than an error.

**C5 — `dsh` honours two frontmatter fields the brief did not list.**  
The brief says "frontmatter beyond `name`, `description`, optional `whenToUse` is parsed  
but ignored". In fact the filesystem provider reads `disable-model-invocation` and  
`user-invocable` and derives an invocation policy from them, defaulting both to `true`  
when omitted. Everything else lands in a `metadata` bag and is not acted on. So the  
portable subset for `dsh` is **five** fields, not three.

**C6 — `whenToUse` vs `when_to_use` is a rename, not a copy.**  
`dsh` uses camelCase `whenToUse`; Claude Code uses snake_case `when_to_use`, and it is  
the only Claude field spelled with underscores. Both feed the same idea (extra trigger  
text appended to the description). A byte-preserving converter silently loses the field.  
This is why the profile schema has `fieldAliases`: the pipeline renames instead of  
dropping. See ADR-0002.

**C7 — `dsh` fails silently, not loudly.**  
Invalid skills are **ignored with a logged warning**, not rejected: bad YAML, missing  
`name` or `description`, and names violating `^[a-z0-9]+(?:-[a-z0-9]+)*$` all produce  
`skill file ... ignored: ...` and the skill simply never appears. The brief's worry about  
nested skills being "silently invisible" generalises: **any** constraint violation makes a  
skill invisible in `dsh`. This raises the value of `lint --for deepseek-harness`, which  
becomes the only way a user learns why a skill vanished.

**C8 — Claude Code's 1,536-character cap is a combined budget, and it is not the spec cap.**  
The skill listing truncates `description` **plus** `when_to_use` at 1,536 characters  
combined. Since the spec caps `description` at 1,024, a spec-valid description is never  
truncated by Claude Code; only `when_to_use` can push a skill over. The brief treated  
1,024 as a universal constraint — it is a spec constraint that only `dsh` actually bites  
against.

**C9 — Codex has a sidecar file that the other two agents have no equivalent for.**  
`agents/openai.yaml` inside a skill directory carries `interface` (display name, short  
description, icons, brand colour, default prompt), `policy.allow_implicit_invocation`  
(default `true`), and `dependencies.tools` (e.g. MCP server requirements). None of this  
belongs in `SKILL.md`. It needs to be a first-class emission target for Codex and a  
reported loss for every other target. `policy.allow_implicit_invocation: false` is the  
closest analogue of Claude's `disable-model-invocation: true`, but it is not identical —  
Claude's field also blocks preloading into subagents.

**C10 — Codex's description budget is context-relative, not a fixed cap.**  
The initial skill list is limited to 2% of the model's context window, or 8,000 characters  
when the window is unknown, adjustable via `skills.max_context_tokens` up to 10,000  
tokens. When the budget is exceeded, Codex shortens descriptions first and may omit skills  
from the list entirely with a warning. There is no per-skill character limit to lint  
against, so `lint --for codex-cli` should reason about the total budget of a skill set,  
not one description.

**C11 — Claude Code has two distinct targets, and only one is permissive.**  
Local skill directories accept every field in the reference table. Uploading to claude.ai,  
the Skills API, or `package_skill.py` accepts **only** `name`, `description`, `license`,  
`compatibility`, `metadata`, `allowed-tools` and hard-errors on anything else. The brief  
treats "Claude Code" as a single target. It should be two profiles (`claude-code` and  
something like `claude-ai-skill`), otherwise the converter will happily emit  
`context: fork` for a surface that rejects the file outright.

**C12 — `.claude/commands/*.md` is no longer a separate format.**  
Claude Code merged custom commands into skills: `deploy.md` in `commands/` and  
`deploy/SKILL.md` both produce `/deploy`, and a skill beats a command of the same name.  
Phase 3's "Claude commands" item is therefore partly a legacy read path, not a foreign  
format. It also means `.claude/commands` should be a *source* the parser can read, and  
should not be an emission target.

**C13 — `npx skills` is not purely a path installer.**  
It normalises CRLF to LF for text files, excludes `.git`, `__pycache__`, `__py-packages__`  
and `metadata.json` from what it installs, dereferences symlinks for hashing, and publishes  
a `skills-lock.json` hash algorithm with a test vector. Interop is therefore feasible at  
the hash level rather than only at the directory level: a skill installed by `npx skills`  
can be recognised as unmodified. This belongs in Phase 4, but the file-exclusion list and  
CRLF normalisation should be adopted now, because they affect golden-file tests.

**C14 — Kimi Code has no `/flow:` namespace.**  
The brief's starting point says flow skills "run with `/flow:<name>`". The official slash
command reference states the opposite explicitly: flow skills are exposed through
`/skill:<name>` like any other external skill, and "there is no separate `/flow:` namespace".
Building a `/flow:` invocation would produce commands Kimi Code does not recognise.

**C15 — Kimi Code's `name` and `description` are not optional in the directory form.**  
The starting point says both are optional with the directory name as fallback. Only the
*flat* `.md` form has fallbacks: `name` comes from the filename, `description` from the first
non-empty body line truncated to 240 characters. In the directory form both are mandatory and
omitting either **fails to parse** — the skill does not load at all.

**C16 — `--skills-dir` replaces, it does not add.**  
The flag loads skills from the given directory and **replaces** the auto-discovered user and
project directories for that launch; it is repeatable. The additive mechanism is a different
thing entirely: `extra_skill_dirs` at the top level of `config.toml`, which layers on
permanently. Treating the flag as additive would silently hide every user skill.

**C17 — Kimi Code is the only surveyed agent that accepts three spellings of a field name.**  
`whenToUse` also accepts `when-to-use` and `when_to_use`; `disableModelInvocation` also
accepts `disable-model-invocation` and `disable_model_invocation`. This makes Kimi the
cheapest target for a converter: most foreign spellings already work. It does not make it
free, because Claude Code does not accept the camelCase form, so the rename still has to
happen in one direction.

**C18 — Kimi Code's flow body format is undocumented.**  
`type` is documented as `prompt` (default), `inline` (alias of `prompt`) or `flow` (manual
invocation only), and any other value causes the skill to be skipped. A required Mermaid or
D2 flowchart in the body is **not** mentioned anywhere in the official skills reference, the
plugins reference or the changelog. It may well be true of some internal or pre-release
build; it is not verifiable from the public docs, so the profile marks the body format
`unknown` and the `flow-skill-type` extension records only what is documented.

**C19 — OpenCode derives the skill ID from the path, not from frontmatter.**  
Frontmatter `name` is a display label only. `<source>/git-release/SKILL.md` and
`<source>/git-release.md` both produce the ID `git-release`, and `<source>/teams/release/SKILL.md`
produces `release`. IDs are exact and case-sensitive, the kebab-case pattern is only
*recommended*, and V2 enforces neither the pattern, nor the 1–64 bound, nor a match between
`name` and the directory. A converter that renames a directory therefore renames the skill.

**C20 — OpenCode is the only surveyed agent that reads a competitor's directory natively.**  
`.claude/skills` and `.agents/skills` are first-class discovery sources at both project and
global scope, alongside `.opencode/skills`. It also searches **six** levels below each source
root and accepts flat Markdown at the source root, so its discovery is both deeper and
broader than every other agent here. Precedence is registration order with the later source
winning, and duplicate IDs override silently rather than erroring.

---

## 3. The base format (Agent Skills)

Source: <https://agentskills.io/specification>, retrieved 2026-11-12.

| Fact                   | Value                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Required file          | `SKILL.md` with YAML frontmatter followed by Markdown                                                                                   |
| Optional dirs          | `scripts/`, `references/`, `assets/`, plus arbitrary others                                                                             |
| `name`                 | Required. 1–64 chars. `a-z`, `0-9`, `-` only. No leading/trailing hyphen, no `--`. Must match the parent directory name.                |
| `description`          | Required. 1–1,024 chars. Should state what it does and when to use it.                                                                  |
| `license`              | Optional. Name or reference to a bundled license file.                                                                                  |
| `compatibility`        | Optional. 1–500 chars. Environment requirements.                                                                                        |
| `metadata`             | Optional. Map of string keys to string values.                                                                                          |
| `allowed-tools`        | Optional. Space-separated pre-approved tool list. Marked experimental; "support for this field may vary between agent implementations". |
| Body size guidance     | `SKILL.md` under 500 lines; full body under ~5,000 tokens                                                                               |
| File references        | Relative to the skill root, one level deep, no deep chains                                                                              |
| Progressive disclosure | Metadata (~100 tokens) always loaded; body on activation; resources on demand                                                           |
| Reference validator    | `skills-ref validate ./my-skill`                                                                                                        |

The spec is permissive about the body — "no format restrictions" — which is why body  
adaptation must be rules-based and conservative. There is nothing to validate against.

---

## 4. Claude Code

Source: <https://code.claude.com/docs/en/skills>, retrieved 2026-11-12.

### 4.1 Scopes and paths

| Scope      | Path                                                                                                      | Loads in                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Enterprise | `.claude/skills/<name>/SKILL.md` under the managed settings dir (e.g. `/etc/claude-code/.claude/skills/`) | All users on the machine                                                                        |
| Personal   | `~/.claude/skills/<name>/SKILL.md`                                                                        | All projects for that user                                                                      |
| Project    | `.claude/skills/<name>/SKILL.md`                                                                          | Sessions in the repo                                                                            |
| Nested     | `<subdir>/.claude/skills/<name>/SKILL.md`                                                                 | Loads the first time Claude reads or edits a file in that subdir, then persists for the session |
| Added dir  | `.claude/skills/<name>/SKILL.md` in a `--add-dir` directory                                               | That session; clashes get a prefixed name                                                       |
| Plugin     | `<plugin>/skills/<name>/SKILL.md`                                                                         | Wherever the plugin is enabled, as `/plugin-name:skill-name`                                    |
| Synced     | `~/.claude/skills/synced/`                                                                                | Downloaded from a claude.ai account; `synced` and `anthropic-skills` are reserved               |

Discovery walks **upward** from the start directory to the repository root. Skill folders  
may be symlinks and are loaded once even when several locations point at the same target.  
Watched directories reload live; a brand-new top-level skills dir needs `/reload-skills`.

### 4.2 Precedence

Enterprise > Personal > Project. A user or project skill replaces a bundled skill or  
built-in command. A skill beats a `.claude/commands/` file of the same name. Root and  
nested skills with the same name both load; the nested one is addressed as  
`/subdir/path:name`.

### 4.3 Frontmatter

All fields are optional; only `description` is recommended. Field names must match  
exactly; unrecognised fields are silently ignored. Booleans accept `true/false`,  
`yes/no`, `on/off`, `1/0` in any case.

| Field                      | Meaning                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `name`                     | Command name; defaults to the directory name                                       |
| `description`              | What and when; drives auto-loading                                                 |
| `when_to_use`              | Extra trigger phrases; appended to `description` in the listing                    |
| `argument-hint`            | Autocomplete hint                                                                  |
| `arguments`                | Named positional args for `$name` substitution                                     |
| `disable-model-invocation` | `true` = manual `/name` only; also blocks preloading into subagents                |
| `user-invocable`           | `false` = hidden from the `/` menu; model-only                                     |
| `allowed-tools`            | Pre-approves tools **for the invoking turn only**; does not restrict the tool pool |
| `disallowed-tools`         | Removes tools while the skill is active                                            |
| `model`                    | Model for the rest of the turn; with `context: fork`, the subagent's model         |
| `effort`                   | `low`/`medium`/`high`/`xhigh`/`max` for the turn                                   |
| `context`                  | Exactly `fork` to run in a forked subagent                                         |
| `agent`                    | Subagent type with `context: fork`                                                 |
| `background`               | With `context: fork`; default `true`                                               |
| `hooks`                    | Hooks registered at invocation, kept for the session                               |
| `paths`                    | Glob patterns limiting auto-activation                                             |
| `shell`                    | `bash` (default) or `powershell` for injected commands                             |
| `metadata`                 | Free-form map for your own tooling; Claude Code does not act on it                 |
| `license`                  | Spec field; accepted, not acted on                                                 |
| `compatibility`            | Spec field; accepted, not acted on                                                 |

### 4.4 Extensions with no equivalent elsewhere

- **Dynamic context injection** — `` !`command` `` inline or fenced ` ```! ` blocks run  
  *before* the body is sent, output replaces the placeholder, output is not re-scanned.  
  Any non-zero exit aborts the whole invocation. Org-wide kill switch  
  `disableSkillShellExecution`.
- **Subagent execution** — `context: fork` turns the skill body into the prompt of a new  
  subagent with no conversation history, background by default. Backgrounded fork edits  
  fall outside checkpoints.
- **Substitutions** — `$ARGUMENTS`, `$ARGUMENTS[N]`, `$N`, `$name`,  
  `${CLAUDE_SESSION_ID}`, `${CLAUDE_EFFORT}`, `${CLAUDE_SKILL_DIR}`,  
  `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`.
- **Turn-scoped tool grants** — `allowed-tools` clears on the next message, so it is a  
  one-turn grant, not a persistent allowlist.
- **Content lifecycle** — invoked content enters as one message and stays across turns;  
  auto-compaction re-attaches the latest invocation of each skill, first 5,000 tokens  
  each, within a combined 25,000-token budget.

### 4.5 Security-relevant behaviour

`allowed-tools` in a repo skill applies **even in untrusted `-p` directories** — workspace  
trust does not gate it. Deny rules still override. This is worth surfacing in the report  
when converting a skill that carries `allowed-tools` into an agent that does not.

---

## 5. DeepSeek Harness (`dsh`)

Sources: `docs/subsystems/skills.md`, `packages/skill/skill-filesystem/src/index.ts`,  
`packages/skill/skill/src/index.ts` in  
<https://github.com/deepseek-ai/deepseek-harness>, retrieved 2026-11-12. Cross-checked  
against <https://github.com/pasqal-io/agent-marketplace/blob/main/docs/agents/deepseek-harness.md>.

`dsh` is in **developer preview** and its README promises compatibility-breaking changes.  
Filesystem discovery is the part least likely to move. The `.dsh-plugin` repository plugin  
path was removed on 2026-08-09 with no compatibility parser, so tutorials describing  
`.dsh-plugin/plugin.json` are obsolete; packaged extensions are now profile bundles that  
declare `dsh.bundle.patch`.

### 5.1 Discovery roots, in rank order (lower wins)

| Rank | Source           | Root                                         |
| ---- | ---------------- | -------------------------------------------- |
| 100  | `project-dsh`    | `<projectRoot>/.dsh/skills`                  |
| 200  | `project-agents` | `<projectRoot>/.agents/skills`               |
| 250  | `runtime`        | in-process registrations                     |
| 300  | `custom`         | `customSkillDirs[]`                          |
| 400  | `user-dsh`       | `$DSH_HOME` or `~/.dsh`, `/skills`           |
| 500  | `user-agents`    | `$DSH_AGENTS_HOME` or `~/.agents`, `/skills` |
| 600  | `bundled`        | `bundledSkillDir`, only when configured      |

`projectRoot` is the nearest ancestor containing `.git`; without one, the working directory  
is used. The user `dsh` root skips its `.system` child. A root that fails to scan  
contributes no candidates and logs a warning; discovery retries on the next lookup, so a  
lower-priority same-name skill can serve until recovery.

### 5.2 Verified config keys (`dsh-skill-filesystem`)

Read from source, because the generated config catalog does not cover the skill packages:

| Key                         | Type     | Default                                                  |
| --------------------------- | -------- | -------------------------------------------------------- |
| `providerName`              | string   | `filesystem`                                             |
| `includeDefaultRoots`       | boolean  | `true`                                                   |
| `dshHome`                   | string   | `$DSH_HOME` or `~/.dsh`                                  |
| `agentsHome`                | string   | `$DSH_AGENTS_HOME` or `~/.agents`                        |
| `customSkillDirs`           | string[] | `[]`                                                     |
| `watch`                     | boolean  | `true`                                                   |
| `watchUsePolling`           | boolean  | `false`                                                  |
| `watchStabilityThresholdMs` | number   | `200`                                                    |
| `watchPollIntervalMs`       | number   | `100`                                                    |
| `watchMaxProjects`          | number   | `128`                                                    |
| `watchFollowSymlinks`       | boolean  | `true`                                                   |
| `bundledSkillDir`           | string   | `$DSH_BUNDLED_SKILL_DIR` when default roots are included |

Separately, the consumer (`dsh-tool-skill`) owns `catalogDescriptionMaxLength`  
(default `500`, minimum `3`), and the registry owns `collectCacheMaxEntries`  
(default `128` in source).

### 5.3 Constraints

- **Layout**: `<name>/SKILL.md` or flat `<name>.md`, exactly one level. No recursive  
  `**/SKILL.md`. A skill nested deeper is invisible, not an error.
- **Name**: `^[a-z0-9]+(?:-[a-z0-9]+)*$`, applied to the **frontmatter** `name`, which is  
  the skill's identity. The directory name is not validated and need not match.
- **Description**: non-empty string required; no hard length limit. Truncated for the  
  catalog at `catalogDescriptionMaxLength`.
- **Frontmatter**: `name`, `description`, `whenToUse`, `disable-model-invocation`,  
  `user-invocable` are read. Everything else is collected into a `metadata` record and not  
  acted on.
- **Failure mode**: every violation is `ignored` with a logged warning. Nothing throws at  
  the user, and nothing tells the user why the skill is missing.
- **Symlinks**: followed; a link to a directory is treated as a directory.
- **File size**: no limit found in source. `UNVERIFIED` whether one exists at another layer.

---

## 6. Codex CLI

Source: <https://developers.openai.com/codex/skills>, retrieved 2026-11-12.

### 6.1 Paths

| Scope    | Location                                                                    |
| -------- | --------------------------------------------------------------------------- |
| `REPO`   | `$CWD/.agents/skills`                                                       |
| `REPO`   | every ancestor `.agents/skills` up to the repository root                   |
| `REPO`   | `$REPO_ROOT/.agents/skills`                                                 |
| `USER`   | `$HOME/.agents/skills`                                                      |
| `ADMIN`  | `/etc/codex/skills`                                                         |
| `SYSTEM` | bundled with Codex (`skill-creator`, `skill-installer`), enabled by default |

Symlinked skill folders are supported and followed. Duplicate names are **not** merged;  
both can appear in the selectors. Skill changes are detected automatically.

### 6.2 Context budget

The initial list is capped at 2% of the model context window, or 8,000 characters when the  
window is unknown. `skills.max_context_tokens` raises it to at most 10,000 tokens. When  
over budget, Codex shortens descriptions first and may omit skills with a warning. The  
full `SKILL.md` is still read once a skill is selected. The list also includes each  
skill's file path, which no other surveyed agent does.

### 6.3 Sidecar metadata

`agents/openai.yaml`:

```yaml
interface:
  display_name: "..."
  short_description: "..."
  icon_small: "./assets/small-logo.svg"
  icon_large: "./assets/large-logo.png"
  brand_color: "#3B82F6"
  default_prompt: "..."
policy:
  allow_implicit_invocation: false
dependencies:
  tools:
    - type: "mcp"
      value: "openaiDeveloperDocs"
      description: "..."
      transport: "streamable_http"
      url: "https://..."
```

`allow_implicit_invocation` defaults to `true`; `false` blocks implicit invocation but  
explicit `$skill` invocation still works.

### 6.4 Disabling without deleting

```toml
[[skills.config]]
path = "/path/to/skill/SKILL.md"
enabled = false
```

One selector per entry: an absolute `path` matches one `SKILL.md`; a `name` matches every  
skill with that name; the last matching entry wins. `[skills.bundled] enabled = false`  
turns off bundled system skills for a project.

### 6.5 Not documented

`UNVERIFIED`: name grammar and length enforcement, and the effect of `license`,  
`compatibility`, `metadata`, `allowed-tools`. The docs state only that `SKILL.md` must  
include `name` and `description`. Encoded as `unknown` in the profile so the converter  
warns rather than assuming the spec grammar is enforced.

---

## 7. OpenCode

Source: <https://opencode.ai/docs/skills/>, retrieved 2026-11-12.

### 7.1 Discovery

| Scope | Sources |
| --- | --- |
| Global | `~/.config/opencode/skills` |
| Global compatibility | `~/.claude/skills`, `~/.agents/skills` |
| Project | `.opencode/skills` |
| Project compatibility | `.claude/skills`, `.agents/skills` |

For project sources, OpenCode searches from the current directory up to the project root and
includes matching directories at every level.

Each source may contain either form:

```
skills/
├── review.md
└── git-release/
    └── SKILL.md
```

- Markdown files must be at the source root, e.g. `skills/review.md`.
- Files named exactly `SKILL.md` may be nested in grouping directories, e.g.
  `skills/teams/release/SKILL.md`.
- A directory containing `SKILL.md` is one skill; OpenCode does not search inside it.
- Hidden files and directories and `node_modules` are skipped.
- **Search stops six directories below the source root.**

Additional sources come from a `skills` array in any `opencode.json` or `opencode.jsonc`:
relative paths resolve from the active OpenCode working directory (not the config file),
`~/` from the home directory, absolute paths as written, and `http(s)` entries load an HTTP
catalog. Entries from every discovered config file are combined, not replaced.

An HTTP catalog is a base URL with an `index.json` listing `{name, version, files[]}`; files
are fetched from `<base>/<name>/<file>`, must be safe, relative and same-origin, and the
`version` must be bumped for OpenCode to refresh its cache. Each downloaded directory becomes
a source root named after the entry.

### 7.2 IDs, not names

The file path determines the ID:

| File | ID |
| --- | --- |
| `<source>/git-release.md` | `git-release` |
| `<source>/git-release/SKILL.md` | `git-release` |
| `<source>/teams/release/SKILL.md` | `release` |

IDs are exact and case-sensitive. The kebab-case pattern `^[a-z0-9]+(-[a-z0-9]+)*$` and a
1–64 character bound are *recommended* for portable skills; **V2 enforces neither**, nor a
match between `name` and the directory, nor a maximum description length.

### 7.3 Frontmatter

All frontmatter is optional at runtime.

| Field | Behaviour |
| --- | --- |
| `name` | Display name; defaults to the path-derived ID |
| `description` | Used to show the skill to the model; without one the skill is not advertised |
| `metadata.opencode/autoinvoke` | `false` omits the skill from the model's available list |
| `disable-model-invocation` | `true` has the same effect as `opencode/autoinvoke: false` |
| `license`, `compatibility` | Accepted for portability by V2; not interpreted |

When both `disable-model-invocation` and `opencode/autoinvoke` are set, `opencode/autoinvoke`
wins. `opencode/autoinvoke: false` only hides the skill from the model list — it stays
registered and loadable by ID.

### 7.4 Precedence

Registration order, lower to higher; the source registered **later** supplies the skill when
two sources define the same ID:

1. Built-in skills
2. `.claude/skills`, global first then from the farthest ancestor toward the current directory
3. `.agents/skills`, same ordering
4. `~/.config/opencode/skills`
5. Project `.opencode/skills`, from the project root toward the current directory
6. Explicit `skills` config entries, in config priority and array order

### 7.5 Invocation and permissions

At each model step OpenCode lists permitted skills that have a description and do not set
`opencode/autoinvoke: false`, showing only ID, name and description. The model loads one by
calling the `skill` tool with the exact ID; a user can mention `@skill-id`. On load, OpenCode
adds the body without frontmatter, plus the skill's base directory and a sample of up to ten
supporting file paths (directory-form skills only).

Permissions use a `skill` action with the skill ID as the resource, effects `allow`, `ask` or
`deny`, last matching rule wins, and can be scoped per agent under `agents.<id>.permissions`.

---

## 8. Kimi Code CLI

Sources: <https://www.kimi.com/code/docs/kimi-code-cli/customization/skills.html>,
<https://www.kimi.com/code/docs/kimi-code-cli/reference/slash-commands.html>,
<https://www.kimi.com/code/docs/kimi-code-cli/reference/kimi-command.html>,
<https://www.kimi.com/code/docs/kimi-code-cli/customization/plugins.html>, all retrieved
2026-11-12. The documentation is Chinese-language; quotes below are translated.

The CLI is TypeScript on Node 22.19+, distributed as `@moonshot-ai/kimi-code`. Local data
lives in `~/.kimi-code/`, movable with `KIMI_CODE_HOME`.

### 8.1 Discovery, four scopes

Priority: **Project > User > Extra > Built-in**.

**User scope** (all projects):

- `$KIMI_CODE_HOME/skills/` — default `~/.kimi-code/skills/`. Moves with `KIMI_CODE_HOME`,
  so isolating the data root also isolates Kimi-specific skills.
- `~/.agents/skills/` — deliberately **not** moved; stays under the real OS home so it can
  be shared across tools.

**Project scope** (project root = nearest ancestor containing `.git`):

- `.kimi-code/skills/`
- `.agents/skills/`

**Extra scope**: `extra_skill_dirs` at the top level of `config.toml`, e.g.
`extra_skill_dirs = ["~/team-skills", ".agents/team-skills"]`. Adds to the auto-discovered
roots and persists.

**Built-in scope**: shipped with the CLI, lowest priority, exposed as `/<name>` without the
`skill:` prefix. The product-explanation subset can be disabled with `builtin_product_skills`.

In a workspace with several configured source directories, each source's project skills are
discovered and merged into one list; **same-name skills are all kept as variants** rather
than resolved to one winner. Invoking by bare name prefers the main directory, then the
workspace directory order; the menu shows the last path segment of each source so a variant
can be chosen. Skills with no owning directory are labelled "global", built-ins "built-in".
Directories added for one session only are not merged.

### 8.2 Two forms

```
skills/
├── review-pr/              # directory form -> skill name review-pr
│   ├── SKILL.md
│   └── checklist.md        # referenced from the body via ${KIMI_SKILL_DIR}
└── commit.md               # flat form -> skill name commit
```

- **Directory form** (recommended): `name` and `description` are **mandatory**; omitting
  either fails to parse.
- **Flat form**: `name` optional (filename without `.md`), `description` optional (first
  non-empty body line, truncated to 240 chars). The file on disk must still end in `.md`.
  Only `.md` files directly at the top of a skills directory count; stray `.md` files in
  subdirectories are not skills.
- If `<name>/SKILL.md` and `<name>.md` both exist, the directory form wins and the flat file
  is ignored.
- A flat skill has no directory of its own, so `${KIMI_SKILL_DIR}` points at the skills
  directory itself.

### 8.3 Frontmatter

| Field | Behaviour |
| --- | --- |
| `name` | Case-insensitive. Mandatory for directory form; filename fallback for flat form |
| `description` | One-line summary used for automatic invocation. Mandatory for directory form |
| `type` | `prompt` (default), `inline` (alias of `prompt`), `flow` (manual invocation only). Other values are skipped |
| `whenToUse` | Trigger description. Also accepts `when-to-use` and `when_to_use` |
| `disableModelInvocation` | `true` blocks automatic invocation. Also accepts `disable-model-invocation` and `disable_model_invocation` |
| `arguments` | Named parameter list: string array or whitespace-separated string (`arguments: target mode`) |

`disableModelInvocation: true` **or** `type: flow` both disable automatic invocation.

### 8.4 Body placeholders

- `$ARGUMENTS` — the full raw argument string
- `$ARGUMENTS[0]`, `$ARGUMENTS[1]`, and shorthand `$0`, `$1` — whitespace-split positional
  arguments, 0-based; single or double quotes group an argument
  (`/skill:commit "fix login" patch` makes `$0` = `fix login`)
- `$<name>` — named arguments declared in `arguments`
- `${KIMI_SKILL_DIR}` — the directory containing the current skill file

If the body contains no argument placeholder, the invocation text is appended as
`\n\nARGUMENTS: <text>`.

### 8.5 Invocation

```
/skill:<name> [extra text]
```

An external skill is also reachable as `/<name>` when that name is not taken by a system or
plugin command. Sub-skills appear as `/<parent>.<sub>` (e.g. `/code-style.review`), generated
from the hierarchy; the child's `SKILL.md` keeps its own local `name`. Plugin skills are
addressed as `<plugin-id>:<skill-name>`. Skill invocation may nest at most **three** levels.

Flow skills are exposed through the same `/skill:<name>` form. **There is no `/flow:`
namespace.**

### 8.6 Flow skills

`type: flow` is documented as "manual invocation only". That is the full public description:
the skills reference, the plugins reference and the changelog say nothing about the body
format, and a required Mermaid or D2 flowchart is **`UNVERIFIED`**. The profile therefore
records the type and its invocation behaviour, and marks the body format as unknown.

### 8.7 `--skills-dir` versus `extra_skill_dirs`

| Mechanism | Effect | Persistence |
| --- | --- | --- |
| `--skills-dir <dir>` (repeatable) | **Replaces** the auto-discovered user and project directories | This launch only |
| `extra_skill_dirs` in `config.toml` | **Adds** to the auto-discovered directories | Permanent |

### 8.8 Plugins

A plugin is a directory with `kimi.plugin.json` (or `.kimi-plugin/plugin.json`, the former
winning when both exist) declaring `name`, `version`, `description`, `keywords`, `author`,
`homepage`, `license`, `interface`, `skills` (path to a skills directory), `systemPromptPath`
and `sessionStart.skill`. Plugin skills use the same `SKILL.md` format and are addressed by
the fully qualified name `<plugin-id>:<skill-name>`. `sessionStart.skill` injects one plugin
skill's text into the main agent at session start; it injects text only and executes nothing.

---

## 9. Side-by-side

### 9.1 Discovery

| | Claude Code | dsh | Codex CLI | OpenCode | Kimi Code |
| --- | --- | --- | --- | --- | --- |
| Project root | `.claude/skills` | `.dsh/skills`, `.agents/skills` | `.agents/skills` | `.opencode/skills` | `.kimi-code/skills`, `.agents/skills` |
| Reads `.claude/skills` | — | no | no | **yes** | no |
| Reads `.agents/skills` | no | yes | yes | yes | yes |
| Upward walk | yes, to repo root | no (nearest `.git`) | yes, every ancestor | yes, every level | no (nearest `.git`) |
| Depth below root | 1 | 1 | 1 | **6** | 1 |
| Flat `<name>.md` | no | yes | no | yes (root only) | yes (root only) |
| Nested lazy load | yes | no | no | no | no |
| Symlinks | yes | yes | yes | unknown | unknown |
| Duplicate handling | precedence chain | rank order | not merged, both listed | later source wins, silent override | scope order, variants kept |

### 9.2 Constraints

| | Claude Code | dsh | Codex CLI | OpenCode | Kimi Code |
| --- | --- | --- | --- | --- | --- |
| Identity source | frontmatter `name` or dir | frontmatter `name` | frontmatter `name` | **path** | frontmatter `name` or filename |
| Name grammar | none (character blocklist) | `^[a-z0-9]+(?:-[a-z0-9]+)*$` | unknown | none enforced (kebab recommended) | none documented |
| Name optional | yes (dir fallback) | no | no | yes (ID from path) | directory: no; flat: yes |
| Description required | no | yes (non-empty) | yes | no (but then not advertised) | directory: yes; flat: no |
| Description hard cap | none | none | none | none | none |
| Description truncation | 1,536 chars, +`when_to_use` | 500 chars (configurable) | 2% context / 8,000 chars | none | 240 chars (flat fallback only) |
| Violation behaviour | skill does not load | ignored with warning | unknown | silently overridden | parse failure |
| Failure visibility | silent non-load | warn log | unknown | silent | parse error |

### 9.3 Field support

`s` = supported, `i` = ignored, `u` = unsupported, `?` = unknown, `~` = emulated by another
mechanism.

| Field | Claude Code | dsh | Codex CLI | OpenCode | Kimi Code |
| --- | --- | --- | --- | --- | --- |
| `name` | s | s | s | s (label) | s |
| `description` | s | s | s | s | s |
| `type` | u | u | u | u | s |
| `license` | i | i | ? | i | ? |
| `compatibility` | i | i | ? | i | ? |
| `metadata` | i | i | ? | s (`opencode/autoinvoke`) | ? |
| `allowed-tools` | s (turn-scoped) | i | ? | ? | ? |
| `when_to_use` / `whenToUse` | s (`when_to_use`) | s (`whenToUse`) | u | u | s (all 3 spellings) |
| `disable-model-invocation` | s | s | ~ `policy.allow_implicit_invocation` | s | s (`disableModelInvocation`) |
| `user-invocable` | s | s | u | u | u |
| `argument-hint` | s | i | u | u | u |
| `arguments` | s | i | u | u | s |
| `disallowed-tools` | s | i | u | u | u |
| `model` / `effort` | s | i | u | u | u |
| `context` / `agent` / `background` | s | i | u | u | u |
| `hooks` | s | i | u | u | u |
| `paths` | s | i | u | u | u |
| `shell` | s | i | u | u | u |

The portable intersection across all five is exactly `name` and `description`. Anything  
beyond that is a per-pair decision, which is why the pipeline must consult the target  
profile field by field instead of passing frontmatter through. The only other field any two
agents share is the trigger text, and each spells it differently.

---

## 10. Implications for the architecture

1. **`.agents/skills` is the hub.** It is read natively by Codex and `dsh` (and OpenCode,  
   per the `npx skills` docs). Default project output should be `.agents/skills`, with  
   `.claude/skills` written as an additional copy only when Claude Code is a target.  
   Writing to `.agents/skills` and symlinking is *not* safe as a default: `dsh` follows  
   symlinks, but the shared root has no documented symlink policy, so copy.
2. **Truncation and rejection must be separate concepts.** Three agents, three different  
   description behaviours: none, truncate-at-500, truncate-at-context-budget. A single  
   `descriptionMaxLength` integer in the profile cannot express this.
3. **Silent failure needs a lint pass.** `dsh` will not tell the user why a skill  
   disappeared. `lint --for deepseek-harness` is not a convenience; it is the only  
   diagnostic.
4. **Name normalisation is directional.** Only apply it when the target enforces a  
   grammar. Applying it unconditionally rewrites names that would have survived.
5. **Codex needs a second output file.** Emitting only `SKILL.md` for Codex silently drops  
   `agents/openai.yaml` semantics. The emitter needs to write the sidecar when the IR  
   carries interface or policy data.
6. **Claude Code should be two profiles.** Local and claude.ai-upload surfaces disagree  
   about which keys are legal, and one hard-errors.
7. **The report needs a `renamed` category** in addition to  
   preserved/adapted/degraded/dropped, because `when_to_use` → `whenToUse` is none of the  
   four. Decided in Phase 1: `renamed` is its own category.
8. **`.agents/skills` is read by four of the five agents**, not two. Codex, `dsh`, OpenCode  
   and Kimi Code all read it; only Claude Code does not. That strengthens ADR-0003: a
   conversion to four of the five targets can share one directory, and the outputs are only
   byte-identical when the frontmatter dialects agree.
9. **Precedence differs per agent, so a shared directory is not a shared meaning.** In
   `.agents/skills`, `dsh` ranks project over user, Codex walks ancestors and merges
   duplicates rather than resolving them, OpenCode lets the later source silently override,
   and Kimi keeps same-name skills as variants. The report must state, per target, which
   rule decides a duplicate name.
10. **OpenCode breaks the "identity is frontmatter" assumption.** Every other agent names a
    skill from frontmatter; OpenCode names it from the path. A converter that renames the
    directory renames the skill for OpenCode and only for OpenCode, so the emitter must
    choose the directory name deliberately rather than preserving the source one.
11. **Kimi Code is the cheapest target and the most dangerous source.** It already accepts
    kebab, snake and camel spellings of its own fields, so little renaming is needed going
    in. Coming out, `type: flow` has no equivalent and must degrade loudly rather than
    silently becoming a normal prompt skill.

---

## 11. Needs verification (carried into the README)

| Item | Why it matters |
| --- | --- |
| Codex name grammar enforcement | Determines whether `lint --for codex-cli` should warn on names |
| Codex support for `license`, `compatibility`, `metadata`, `allowed-tools` | Determines whether emitting them is a loss |
| Whether `dsh` enforces a maximum file or skill size | Affects the security limits and the report |
| Whether Claude Code reads `.agents/skills` at all | No evidence it does; do not assume it for interop |
| Whether `.agents/skills` has a documented symlink policy | Blocks the "write once, symlink everywhere" strategy |
| Claude Code behaviour for names over 64 characters | The spec caps at 64; Claude Code does not document a cap |
| Exact `dsh` behaviour when the directory name and frontmatter name disagree | Source suggests the frontmatter wins and the directory is ignored |
| OpenCode symlink handling | `followsSymlinks` is `null` in the profile; no doc statement found |
| OpenCode `allowed-tools` support | Not documented; OpenCode uses a `permissions` mechanism instead |
| Kimi Code symlink handling | `followsSymlinks` is `null`; no doc statement found |
| Kimi Code `license`, `compatibility`, `metadata`, `allowed-tools` | Not documented in the skills reference |
| Kimi Code flow body format (Mermaid / D2) | The claim is absent from every official page checked; treated as `UNVERIFIED` |
| Whether Kimi Code enforces a description length for an explicit description | Only the 240-char flat-form fallback is documented |

Phase 2 agents (Cursor, Gemini CLI, GitHub Copilot, Zed, ZCode, Cline, Roo Code, Windsurf,
LangChain Deep Agents) are **not** researched here. OpenCode and Kimi Code moved out of that
list in Phase 0.5. Do not add a profile for any remaining agent without fetching its official
docs first.

---

## 12. Sources

| # | URL | Retrieved | Used for |
| --- | --- | --- | --- |
| 1 | <https://agentskills.io/specification> | 2026-11-12 | Base format, field constraints, progressive disclosure |
| 2 | <https://agentskills.io/llms.txt> | 2026-11-12 | Documentation index |
| 3 | <https://code.claude.com/docs/en/skills> | 2026-11-12 | Claude Code scopes, frontmatter, extensions |
| 4 | <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/skills.md> | 2026-11-12 | dsh ranks, identity, catalog bound |
| 5 | <https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill-filesystem/src/index.ts> | 2026-11-12 | Verified dsh config defaults and ignore-with-warning |
| 6 | <https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill/src/index.ts> | 2026-11-12 | Verified `SKILL_NAME` regex and validation |
| 7 | <https://developers.openai.com/codex/skills> | 2026-11-12 | Codex paths, context budget, `agents/openai.yaml` |
| 8 | <https://github.com/vercel-labs/skills> | 2026-11-12 | `npx skills` behaviour, lockfile hashing, exclusions |
| 9 | <https://github.com/pasqal-io/agent-marketplace/blob/main/docs/agents/deepseek-harness.md> | 2026-11-12 | Third-party cross-check for dsh |
| 10 | <https://opencode.ai/docs/skills/> | 2026-11-12 | OpenCode discovery, IDs, precedence, permissions, catalogs |
| 11 | <https://www.kimi.com/code/docs/kimi-code-cli/customization/skills.html> | 2026-11-12 | Kimi Code forms, frontmatter, placeholders, roots, precedence |
| 12 | <https://www.kimi.com/code/docs/kimi-code-cli/reference/slash-commands.html> | 2026-11-12 | Kimi invocation syntax; verified no `/flow:` namespace |
| 13 | <https://www.kimi.com/code/docs/kimi-code-cli/reference/kimi-command.html> | 2026-11-12 | Verified `--skills-dir` replaces rather than adds |
| 14 | <https://www.kimi.com/code/docs/kimi-code-cli/customization/plugins.html> | 2026-11-12 | `kimi.plugin.json`, qualified names, `sessionStart.skill` |
