# Changelog

Notable changes, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project intends to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once
there is a published release.

A fidelity tool has one unusual rule: a change that makes the report *more* accurate is a
change worth listing, even when no behaviour changed. If a release starts reporting a loss
it previously called `preserved`, that belongs here, because someone's existing pipeline
may start failing on exit code 2.

## [Unreleased]

**Alpha, pre-1.0.** Nothing has been published yet, and this entry describes the first
release. Until 1.0 the command surface, the JSON report format and the lint rule ids may
change without a major-version bump, and a capability-profile correction can change how a
skill is reported without any code changing. Pin an exact version if a pipeline depends on
the exit code.

### Added

- `inspect` — parse a skill into the intermediate representation and show what was found,
  including every field the target agent would ignore, with line numbers.
- `agents` — list the capability profiles, the roots each agent discovers, and the
  verification level of each profile.
- `lint --for <agent>` — 25 rules derived from the target's capability profile, with
  stable ids (SP001–SP025), per-target severities, a source URL on every finding, and
  exit codes 0/1/2.
- `convert` — hub-and-spoke conversion through the IR, with a fidelity report that
  classifies every field and feature as `preserved`, `adapted`, `renamed`, `degraded` or
  `dropped`. `--report json` is validated against a schema.
- Conversion targets: Claude Code, DeepSeek Harness (`dsh`), Codex CLI, OpenCode, Kimi
  Code CLI, and the Claude.ai / Skills API upload form.
- `.agents/skills` as a shared output: byte-identical results are written once, and
  differing results collapse to a least-common-denominator copy that the report explains.
- `convert --install` writes into each agent's own skill directory, staging the copy and
  renaming it into place, backing up an existing skill rather than overwriting it.
- Zip input, with limits on entry count, per-file size and expanded size enforced from the
  archive's central directory before anything is extracted.
- Shell-injection handling: inline `` !`cmd` `` and fenced ` ```! ` blocks are detected,
  never executed, and rewritten only when the target would execute them and the source
  did not. `--shell-policy` chooses `neutralize`, `keep` or `strip`.
- Capability profiles are data (`agents/*.yaml`), validated against a JSON Schema plus
  semantic checks. No command in the tool names an agent.
- `docs/agents.md` is generated from the profiles; CI fails if it has drifted.

### Fixed

- A skill whose frontmatter name does not satisfy the target's documented name grammar is
  now renamed to a name the target accepts, reported once as `adapted` with the rule that
  forced it. Previously the invalid name was written through and the target dropped the
  skill silently.
- A block-scalar or quoted frontmatter value is emitted as a block scalar or a quoted
  scalar, not re-spelled. A `description: |` that lost its indentation made the whole
  frontmatter unparseable while the report still called it `preserved`.
- A field the target's profile does not describe is dropped, not emitted, when the profile
  records a `dropReason`. The upload target was previously given a vendor field that it
  would reject.
- The conversion report no longer says "converted cleanly" when the lint of the output
  found an error.
- `convert --install` now lints the skill where it was installed, not only in staging, so
  a collision with an existing skill in the same root is reported.
- `--version` reads the package manifest instead of a hard-coded string.
- The packed tarballs carry `agents/` and `schema/`; without them an installed CLI
  could not load a single profile.

### Security

- No skill content is ever executed, and the test suite fails if a marker file from an
  executed payload appears.
- Archive extraction refuses absolute paths, drive letters, `..` segments, and any entry
  that resolves outside the extraction directory, and enforces its limits before
  decompressing.
- Symlinks pointing outside the skill root are skipped and reported, never followed.

### Known limitations of this release

- The Claude.ai / Skills API upload profile is `partial`. Its name and description rules
  are documented; whether it accepts `license`, `compatibility`, `metadata` and
  `allowed-tools` is not, so those are dropped rather than guessed at.
- Codex CLI's name grammar, OpenCode's and Kimi Code's symlink handling, and the flow body
  format are `unknown`. The converter reports a warning instead of assuming.
- `dsh` is in developer preview and promises breaking changes. Its profile is pinned to a
  retrieval date.
- Git URL input is not implemented; see the roadmap.
