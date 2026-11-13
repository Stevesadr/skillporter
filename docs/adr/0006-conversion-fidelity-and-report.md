# ADR-0006: Conversion is lossy, and the report is the product

**Status:** accepted (Phase 1c)

## Context

`convert` writes files into another agent's format. Every such write can lose something: a
field the target does not understand, a placeholder that expanded in the source and will not
expand here, an executable bit, a directory name that has to change. The project's premise is
that a conversion which does not say what it lost is worse than no conversion at all, because
the user cannot tell a faithful port from a quiet mangling.

Three questions had to be settled before any of this could be written.

1. **Where does the report come from?** A separate conversion-report vocabulary would drift
   from `lint`, which already classifies the same facts per target.
2. **What is a loss?** Renaming `whenToUse` to `when_to_use` changes the file but not the
   meaning. Counting that as a loss would make almost every conversion look broken, and the
   exit code would stop being useful.
3. **Which file is linted?** The source, or the thing that was actually produced?

## Decision

### 1. One pipeline, five steps, each one reporting

`parse → restructure → frontmatter → body → bundled files`. Every step appends
`ConversionItem`s to the report as it goes. There is no separate "reporting pass" that could
disagree with what was written: the items are produced by the same functions that produce the
bytes.

The IR is the only input to the emitter (ADR-0001), so a step cannot quietly reach back into
the source file and copy a field the profile said it would drop.

### 2. Five fidelities, and only two of them are losses

| Fidelity | Meaning | Counts as a loss |
| --- | --- | --- |
| `preserved` | Byte-identical, or the same field under the same key | no |
| `adapted` | Changed so it keeps working: a flat `.md` wrapped in a directory, an inline placeholder turned into a code span | no |
| `renamed` | Same meaning, different spelling the target requires | no |
| `degraded` | Still present, but the target will not act on it, or its behaviour is unknown | **yes** |
| `dropped` | Removed | **yes** |

`degraded` is the interesting one. It covers "kept verbatim because the profile does not
mention this field" — the honest answer when the research has not established what the target
does with it. It is a loss because the user cannot rely on it, not because bytes were removed.

`ConversionSubject` has exactly seven members (`identity`, `layout`, `field`, `body`,
`shell-injection`, `file`, `extension`) and a test asserts every one is reachable. Decisions
that already have a section of their own in the report — which roots were written, what the
post-conversion lint found — are not repeated as items.

### 3. The output is linted, not the source

`convert` runs `lint` on each converted output and puts the result in the report. Linting the
source would answer the wrong question: a flat `.md` file is a lint error for an agent that
requires a directory, and wrapping it in a directory is exactly what `convert` just did. The
output of that conversion must be reported clean.

The bytes are staged in a temporary directory and read back, so lint sees what would be
written rather than what the planner believes it wrote. Because the staged copy is not inside
a discovery root, rules that depend on the destination location (scan depth, duplicate names)
stay silent there, and the report says so. For `--install` those rules are answered by
running `lint` at the real destination.

### 4. Converting never creates executable content

Claude Code executes `` !`cmd` `` and ```` ```! ```` blocks before the body is loaded. The
other four agents do not. So `claude-code → anything else` is a loss of behaviour (the text
stays, and is reported `degraded`), while `anything else → claude-code` would *introduce*
execution that the skill did not have.

The default policy, `neutralize`, therefore rewrites the syntax only in that direction:
`` !`cmd` `` becomes `` `cmd` ``, and ```` ```! ```` becomes ```` ```text ````. The command
stays readable and the model still sees it; nothing runs it. `--shell-injection=keep` keeps
the syntax and reports each occurrence as `degraded`, naming the flag that caused it.
`--shell-injection=strip` removes the placeholder together with one adjacent space, and
reports each removal as `dropped`.

Nothing in the pipeline ever executes a skill's content. A test converts a skill whose script
would `touch` a marker file, through every agent and through both `--out` and `--install`,
and asserts the marker never appears.

### 5. A shared root gets one copy, or an honest compromise

Four of the five agents read `.agents/skills` (ADR-0003). When several targets share a root,
`convert` compares the planned outputs:

- **byte-identical** → one copy is written, and the note says so;
- **different** → a least-common-denominator copy is written that keeps only the fields every
  member of the group spells the same way, everything else is reported `dropped` with the
  group named in the reason, and the note says a compromise was made.

Either way each target keeps its own fidelity items, because two agents can receive identical
bytes and still lose different things.

Claude Code is written to `.claude/skills` as a real copy, never a symlink: a symlink is not
what the agent documents, and it breaks the moment the source directory moves. When a target
also reads a root that was written for another target (OpenCode reads `.claude/skills`), the
overlap is reported instead of writing a second copy, quoting that target's own
duplicate-resolution rule — because two copies of one name is exactly the situation that rule
exists to arbitrate.

### 6. Writing is atomic, and never silent

- The skill is built in `.skillporter-tmp-<random>/` inside the root and `rename`d into place.
- An existing copy is moved aside **by rename, not by delete**, into
  `<parent>/.skillporter-backups/<root>-<timestamp>/`. Replacing therefore never depends on
  being allowed to delete anything, the backup is the previous copy rather than a copy of it,
  and a backup can never be discovered as a skill because it lives outside the root.
- If the final rename fails, the old copy is moved back.
- An existing destination is an error unless `--force` is passed. There is no interactive
  prompt: silence must never mean overwrite.
- Nothing is written outside the resolved root; `isInside` is checked on the destination and
  again on every file path.
- `--dry-run` writes nothing at all, not even the output directory, and prints the same report.

### 7. Exit codes

`0` clean, `2` converted with `degraded`/`dropped` items, `1` error — including a
post-conversion lint error, which means the output would not work. `--strict` turns every loss
into `1` without changing what was written.

## Consequences

- A conversion that loses nothing exits `0` and prints a report full of `preserved` lines. That
  is the common case for the four non-executing agents, and it is why the byte-identical
  shortcut matters: the report can say "nothing happened" and be right.
- Adding an agent means adding a profile; the emitter has no agent-specific branches. The only
  behavioural fact it reads is `bodyExecution.shellInjection.executed`, which is data.
- `--strict` makes the exit code a CI gate: a skill can be converted in a pipeline and the
  build fails the day a new field starts being dropped.
- The fidelity vocabulary is a public surface. Adding a sixth category is a breaking change to
  the report schema (`schema/conversion-report.schema.json`), which is validated in the tests.
