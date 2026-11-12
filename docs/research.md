# Research: agent skill formats

**Status:** Phase 0 deliverable. Everything below was fetched on **2026-11-12** and is
recorded with its source URL. Facts that could not be traced to a primary source are
marked `UNVERIFIED` and are encoded in the capability profiles as `unknown` so the
converter warns instead of guessing.

Scope of this document: the Agent Skills base format plus the three Phase 0/1 agents —
Claude Code, DeepSeek Harness (`dsh`) and Codex CLI. Phase 2 agents are deliberately
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

---

## 3. The base format (Agent Skills)

Source: <https://agentskills.io/specification>, retrieved 2026-11-12.

| Fact | Value |
| --- | --- |
| Required file | `SKILL.md` with YAML frontmatter followed by Markdown |
| Optional dirs | `scripts/`, `references/`, `assets/`, plus arbitrary others |
| `name` | Required. 1–64 chars. `a-z`, `0-9`, `-` only. No leading/trailing hyphen, no `--`. Must match the parent directory name. |
| `description` | Required. 1–1,024 chars. Should state what it does and when to use it. |
| `license` | Optional. Name or reference to a bundled license file. |
| `compatibility` | Optional. 1–500 chars. Environment requirements. |
| `metadata` | Optional. Map of string keys to string values. |
| `allowed-tools` | Optional. Space-separated pre-approved tool list. Marked experimental; "support for this field may vary between agent implementations". |
| Body size guidance | `SKILL.md` under 500 lines; full body under ~5,000 tokens |
| File references | Relative to the skill root, one level deep, no deep chains |
| Progressive disclosure | Metadata (~100 tokens) always loaded; body on activation; resources on demand |
| Reference validator | `skills-ref validate ./my-skill` |

The spec is permissive about the body — "no format restrictions" — which is why body
adaptation must be rules-based and conservative. There is nothing to validate against.

---

## 4. Claude Code

Source: <https://code.claude.com/docs/en/skills>, retrieved 2026-11-12.

### 4.1 Scopes and paths

| Scope | Path | Loads in |
| --- | --- | --- |
| Enterprise | `.claude/skills/<name>/SKILL.md` under the managed settings dir (e.g. `/etc/claude-code/.claude/skills/`) | All users on the machine |
| Personal | `~/.claude/skills/<name>/SKILL.md` | All projects for that user |
| Project | `.claude/skills/<name>/SKILL.md` | Sessions in the repo |
| Nested | `<subdir>/.claude/skills/<name>/SKILL.md` | Loads the first time Claude reads or edits a file in that subdir, then persists for the session |
| Added dir | `.claude/skills/<name>/SKILL.md` in a `--add-dir` directory | That session; clashes get a prefixed name |
| Plugin | `<plugin>/skills/<name>/SKILL.md` | Wherever the plugin is enabled, as `/plugin-name:skill-name` |
| Synced | `~/.claude/skills/synced/` | Downloaded from a claude.ai account; `synced` and `anthropic-skills` are reserved |

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

| Field | Meaning |
| --- | --- |
| `name` | Command name; defaults to the directory name |
| `description` | What and when; drives auto-loading |
| `when_to_use` | Extra trigger phrases; appended to `description` in the listing |
| `argument-hint` | Autocomplete hint |
| `arguments` | Named positional args for `$name` substitution |
| `disable-model-invocation` | `true` = manual `/name` only; also blocks preloading into subagents |
| `user-invocable` | `false` = hidden from the `/` menu; model-only |
| `allowed-tools` | Pre-approves tools **for the invoking turn only**; does not restrict the tool pool |
| `disallowed-tools` | Removes tools while the skill is active |
| `model` | Model for the rest of the turn; with `context: fork`, the subagent's model |
| `effort` | `low`/`medium`/`high`/`xhigh`/`max` for the turn |
| `context` | Exactly `fork` to run in a forked subagent |
| `agent` | Subagent type with `context: fork` |
| `background` | With `context: fork`; default `true` |
| `hooks` | Hooks registered at invocation, kept for the session |
| `paths` | Glob patterns limiting auto-activation |
| `shell` | `bash` (default) or `powershell` for injected commands |
| `metadata` | Free-form map for your own tooling; Claude Code does not act on it |
| `license` | Spec field; accepted, not acted on |
| `compatibility` | Spec field; accepted, not acted on |

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

| Rank | Source | Root |
| --- | --- | --- |
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 250 | `runtime` | in-process registrations |
| 300 | `custom` | `customSkillDirs[]` |
| 400 | `user-dsh` | `$DSH_HOME` or `~/.dsh`, `/skills` |
| 500 | `user-agents` | `$DSH_AGENTS_HOME` or `~/.agents`, `/skills` |
| 600 | `bundled` | `bundledSkillDir`, only when configured |

`projectRoot` is the nearest ancestor containing `.git`; without one, the working directory
is used. The user `dsh` root skips its `.system` child. A root that fails to scan
contributes no candidates and logs a warning; discovery retries on the next lookup, so a
lower-priority same-name skill can serve until recovery.

### 5.2 Verified config keys (`dsh-skill-filesystem`)

Read from source, because the generated config catalog does not cover the skill packages:

| Key | Type | Default |
| --- | --- | --- |
| `providerName` | string | `filesystem` |
| `includeDefaultRoots` | boolean | `true` |
| `dshHome` | string | `$DSH_HOME` or `~/.dsh` |
| `agentsHome` | string | `$DSH_AGENTS_HOME` or `~/.agents` |
| `customSkillDirs` | string[] | `[]` |
| `watch` | boolean | `true` |
| `watchUsePolling` | boolean | `false` |
| `watchStabilityThresholdMs` | number | `200` |
| `watchPollIntervalMs` | number | `100` |
| `watchMaxProjects` | number | `128` |
| `watchFollowSymlinks` | boolean | `true` |
| `bundledSkillDir` | string | `$DSH_BUNDLED_SKILL_DIR` when default roots are included |

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

| Scope | Location |
| --- | --- |
| `REPO` | `$CWD/.agents/skills` |
| `REPO` | every ancestor `.agents/skills` up to the repository root |
| `REPO` | `$REPO_ROOT/.agents/skills` |
| `USER` | `$HOME/.agents/skills` |
| `ADMIN` | `/etc/codex/skills` |
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

## 7. Side-by-side

### 7.1 Discovery

| | Claude Code | dsh | Codex CLI |
| --- | --- | --- | --- |
| Project root | `.claude/skills` | `.dsh/skills`, `.agents/skills` | `.agents/skills` |
| Upward walk | yes, to repo root | no (nearest `.git` only) | yes, every ancestor to repo root |
| Depth below root | 1 | 1 | 1 |
| Flat `<name>.md` | no | **yes** | no |
| Nested lazy load | yes | no | no |
| Symlinks | yes | yes | yes |
| Duplicate handling | precedence chain | rank order | not merged, both listed |

### 7.2 Constraints

| | Claude Code | dsh | Codex CLI |
| --- | --- | --- | --- |
| Name grammar | none (character blocklist) | `^[a-z0-9]+(?:-[a-z0-9]+)*$` | unknown |
| Name optional | yes (dir name fallback) | no | no |
| Name must match dir | no | no | unknown |
| Name violation | skill does not load | ignored with warning | unknown |
| Description hard cap | none | none | none |
| Description truncation | 1,536 chars, +`when_to_use` | 500 chars (configurable) | 2% context / 8,000 chars |
| Failure visibility | silent non-load | warn log | unknown |

### 7.3 Field support

`s` = supported, `i` = ignored, `u` = unsupported, `?` = unknown.

| Field | Claude Code | dsh | Codex CLI |
| --- | --- | --- | --- |
| `name` | s | s | s |
| `description` | s | s | s |
| `license` | i | i | ? |
| `compatibility` | i | i | ? |
| `metadata` | i | i | ? |
| `allowed-tools` | s (turn-scoped) | i | ? |
| `when_to_use` / `whenToUse` | s | s (camelCase) | u |
| `disable-model-invocation` | s | s | ~ `policy.allow_implicit_invocation` |
| `user-invocable` | s | s | u |
| `argument-hint` | s | i | u |
| `arguments` | s | i | u |
| `disallowed-tools` | s | i | u |
| `model` / `effort` | s | i | u |
| `context` / `agent` / `background` | s | i | u |
| `hooks` | s | i | u |
| `paths` | s | i | u |
| `shell` | s | i | u |

The portable intersection across all three is exactly `name` and `description`. Anything
beyond that is a per-pair decision, which is why the pipeline must consult the target
profile field by field instead of passing frontmatter through.

---

## 8. Implications for the architecture

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
   four. Alternatively `adapted` with a `rename` reason — decide in Phase 1.

---

## 9. Needs verification (carried into the README)

| Item | Why it matters |
| --- | --- |
| Codex name grammar enforcement | Determines whether `lint --for codex-cli` should warn on names |
| Codex support for `license`, `compatibility`, `metadata`, `allowed-tools` | Determines whether emitting them is a loss |
| Whether `dsh` enforces a maximum file or skill size | Affects the security limits and the report |
| Whether Claude Code reads `.agents/skills` at all | No evidence it does; do not assume it for interop |
| Whether `.agents/skills` has a documented symlink policy | Blocks the "write once, symlink everywhere" strategy |
| Claude Code behaviour for names over 64 characters | The spec caps at 64; Claude Code does not document a cap |
| Exact `dsh` behaviour when the directory name and frontmatter name disagree | Source suggests the frontmatter wins and the directory is ignored |

Phase 2 agents (Cursor, Gemini CLI, GitHub Copilot, Zed, ZCode, OpenCode, Cline, Roo Code,
Windsurf, LangChain Deep Agents) are **not** researched here. Do not add a profile for any
of them without fetching its official docs first.

---

## 10. Sources

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
