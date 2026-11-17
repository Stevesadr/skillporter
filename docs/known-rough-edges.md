# Known rough edges

Things a real skill exposed that are worth fixing, in the order they cost the
most. None of them is a correctness bug in the conversion itself; each one is a
place where the report or the output makes the reader work harder than they
should. Recorded here rather than fixed in the same change, so each gets its own
test and its own commit.

Status: not started unless noted.

## 1. Paths are printed three ways

`convert --out` prints the destination as an absolute path, the source as a path
relative to the working directory, and the root as an absolute path again. In a
terminal that is three spellings of the same tree in one screen, and the reader
has to work out which ones are the same place.

What it should do: print every path relative to the working directory when that
is shorter and does not start with `..`, and absolute otherwise — the rule
`displayPath` already uses for the source. Paths inside JSON output stay
absolute; only the terminal report changes.

Why it was deferred: it touches every line of the text report and every test that
matches on a path, which is a large diff for a cosmetic gain. It should not be
bundled with a behaviour change.

## 2. Field status speaks two vocabularies

The same fact is described as `preserved` / `adapted` / `renamed` / `degraded` /
`dropped` in a conversion report, and as `supported` / `ignored` / `emulated` /
`unsupported` / `unknown` in a capability profile. `docs/agents.md` prints the
second set, `convert` prints the first, and the mapping between them is implied
rather than written down anywhere a reader would look.

What it should do: either one vocabulary, or a documented translation table in
`docs/lint-rules.md` next to the diagnostic-code mapping, which already solves
the same problem for codes.

Why it was deferred: the profile vocabulary is the input to severity decisions,
and changing it changes every profile and every severity test. It needs a
decision about which set survives, not just an edit.

## 3. `--install` is noisy

Installing to four agents prints a full item table per target, then a roots
section, then three notes. The interesting part — which roots were written, and
which of them serve more than one agent — is the shortest section and sits in the
middle. `--install` is also the mode a first-time user is most likely to run.

What it should do: a compact default (one line per root, one line per target with
its counts), and the per-item table behind `--verbose`, which already exists for
`lint`.

Why it was deferred: it is a change to the default output of the main command,
and the current verbosity is doing real work for the case where something *was*
degraded. The compact form needs to keep every loss visible, which is a design
question rather than a formatting one.

## 4. Claude-specific body features other than invocations

SP026 now covers the invocation case: a body that says `/caveman` is flagged for
an agent that wants `$caveman`. It does not cover the rest of what a Claude Code
body assumes. The real `caveman` skill, for example, says "Relay the hook's
output" — a hook is a Claude Code feature with no equivalent in any other
profile, and nothing in the report mentions it.

What it should do: a rule per body feature a profile documents as absent, driven
by a `bodyFeatures` block in the profile rather than by a list of agent names.
The hooks case is the only one observed so far, which is why the shape of that
block is not designed yet.

Why it was deferred: one observed instance is not enough to design a
profile field, and a rule that fires on the word "hook" in prose would be worse
than silence.

## Not deferred, for the record

- The `--out` shared-root note (fixed): a multi-target `--out` run now says the
  shared-root check did not run, because silence read as "checked and fine".
- Short agent names (fixed): `codex` and `dsh` are profile aliases now, validated
  so a duplicate is a load error rather than last-one-wins.
- Per-target versus unique counts (fixed): a five-item skill on three targets no
  longer reports "15 preserved" as its headline.
- `--to ""` (fixed): the CLI names the flag instead of reporting an unknown agent.
- Invocation mismatch (fixed): SP026 reads `invocation.syntax` from the target
  profile and warns when a body invokes a skill the way another agent does.
