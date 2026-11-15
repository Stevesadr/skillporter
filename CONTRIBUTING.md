# Contributing

Two things are welcome: a new agent, and a correction to an existing one. Everything else
follows from those.

The rule that governs both is the one in the README: **never convert silently or
lossily**. A profile that guesses is worse than a profile that admits it does not know,
because the guess becomes a report that says `preserved` when the field was thrown away.

---

## Add a new agent in about fifteen minutes

If the agent reads `SKILL.md` with YAML frontmatter, this is a data change. No TypeScript
is involved, and if you find yourself editing `packages/core`, stop and open an issue
first: either the profile is missing a field the engine should read, or the agent is not
an Agent Skills agent at all and needs a different discussion.

### 1. Copy the closest existing profile

```bash
cp agents/opencode.yaml agents/your-agent.yaml
```

Pick the closest neighbour, not the simplest one: an agent that takes its identity from
the path behaves like OpenCode, one with a strict name grammar behaves like `dsh`.

### 2. Fill in every field, from primary sources

Open the agent's official documentation. Not a blog post, not a summary, not another
converter's source code. You need, at minimum:

| Section | What to find | Where it usually is |
| --- | --- | --- |
| `paths` | Where the agent looks for skills, per scope | "Skills", "Extensions", "Customisation" |
| `discovery` | Depth, flat `.md`, symlinks, upward search | The same page, often a paragraph below the paths |
| `identity` | Whether the name comes from frontmatter or the path | Search the docs for the word "identifier" |
| `name` | Grammar, max length, what happens on a violation | Often absent — that is an answer, see below |
| `description` | Max length, truncation, whether it is required | Frequently a table of frontmatter fields |
| `bodyExecution` | Whether `!`cmd`` or ` ```! ` blocks are executed | Search for "shell", "bash", "dynamic context" |
| `fields` | What happens to `license`, `metadata`, `allowed-tools` | The frontmatter reference |

Two habits make this fast:

- **Read the changelog.** An agent that just changed its skill format will say so there,
  and the docs will lag behind it.
- **Check the agent's own source** when the docs are silent and the repository is public.
  Cite the file you read. A source URL is a promise that a reader can check you.

### 3. Record what you could not find

This is the part that matters, and the part that is easy to skip.

- A fact you could not confirm becomes `null`, `unknown`, or an `enforcement: unknown`.
  **Never** copy a value from a similar agent "because it is probably the same".
- Add a `note` explaining what is missing and why it could not be established.
- If the agent probably accepts a field but you cannot prove it, use
  `status: unknown` plus a `dropReason`. The converter will then drop the field and
  report the loss, instead of emitting something the agent might reject.

`npm run validate:profiles` enforces the honesty rules: an `unknown` without a note is an
error, a `dropReason` on a non-unknown field is an error, and a `verification` below
`verified` without notes is an error.

### 4. Cite your sources

Every profile needs sources whose `covers` lists cover `paths`, `discovery`, `identity`,
`name`, `description` and `fields`. Without them a lint finding for that area would have
no URL behind it, and the validator refuses the profile.

```yaml
sources:
  - url: https://example.com/docs/skills
    retrieved: 2026-11-15
    note: Discovery paths, frontmatter table, name rules.
    covers: [paths, discovery, identity, name, description, fields]
```

Use the date you actually read the page. A future date is rejected; a stale date is
information, and a reviewer will ask you to refresh it if the page has changed.

### 5. Validate

```bash
npm run validate:profiles   # schema + semantic checks
npm run build
npm run agents:docs         # regenerate docs/agents.md from your profile
npm run lint -- fixtures/skills/report-builder --for your-agent   # does it look sane?
npm run test:only
```

`npm run agents:docs` writes the matrix in `docs/agents.md`. Commit the regenerated file
with the profile; CI fails if the two disagree.

### 6. Open the pull request

Use the capability profile checklist. Reviewers will check three things:

1. **Every non-obvious claim has a source.** A line with no citation is a line that will
   be trusted and then be wrong.
2. **Unknowns are marked, not filled in.** A profile that says "I do not know" is a
   correct profile.
3. **The agent is not named anywhere in the engine.** If you had to touch
   `packages/core`, explain why in the pull request.

### When code *is* needed

Only two cases so far:

- The agent does not read `SKILL.md` at all (an `AGENTS.md` or a rules file). That is
  Phase 3 and needs a new emitter, not a profile.
- The agent needs a field the engine does not model yet. Add the field to the IR and to
  the profile schema first, in a separate pull request, so the data change stays a data
  change.

---

## Correcting an existing profile

Documentation moves. If you find a profile that says `unknown` and the answer is now
documented — or worse, says `verified` and is now wrong — open a **capability profile
correction** issue. It requires the URL that shows the new behaviour and the date you
retrieved it. A correction without a source is not actionable, because the maintainers
would be replacing one unverified claim with another.

If the agent's behaviour changed and the old behaviour was real, say so. A profile change
can mean that conversions made by the previous release were lossy in a way the report did
not mention, and that belongs in `CHANGELOG.md`.

---

## Working on the tool

```bash
npm install
npm run build              # tsc -b, project references
npm run typecheck          # full rebuild with checking
npm run validate:profiles  # schema + semantic checks over agents/*.yaml
npm run rules              # regenerate docs/lint-rules.md
npm run rules:check        # fail if docs/lint-rules.md has drifted
npm run agents:docs        # regenerate docs/agents.md
npm run agents:docs:check  # fail if docs/agents.md has drifted
npm test                   # build, then the test suite
npm run check:package      # pack, install into an empty project, run the CLI from there
```

### The rules the tests enforce

These are not style preferences. A change that breaks one of them is a change that makes
the report lie.

- **Nothing in a skill is ever executed.** No `eval`, no `exec` on skill content, no
  importing a bundled script. There is a test with a `touch` payload and a
  `PWNED-BY-SKILLPORTER` marker; if a marker ever appears, the suite fails.
- **The body is byte-exact unless a shell policy rewrites it**, and every rewrite is
  reported with a line number.
- **Every emitted field is accounted for.** If a field is written, the report says
  `preserved`; if it is not, the report says why.
- **No rule names an agent.** Rules read the profile. A rule that says `if (target ===
  'claude-code')` is a bug, even if it passes.
- **Unknown is never resolved by guessing.** It is reported as `UNKNOWN_CAPABILITY`.

### Tests

| File | Covers |
| --- | --- |
| `tests/parse.test.mjs` | Frontmatter parsing, the IR, byte-exact bodies, line endings |
| `tests/lint.test.mjs` | Every rule, and that severity follows the profile |
| `tests/convert.test.mjs` | Conversion, the report, round trips, golden files, archives |
| `tests/properties.test.mjs` | Invariants over generated names and bodies |
| `tests/security.test.mjs` | Nothing executes; symlinks, limits, traversal |
| `tests/cli.test.mjs` | Command surface and exit codes |

A bug fix needs a test that fails before the fix. If the bug was found by hand, the test
should reproduce the exact input that exposed it — a name with a space, a quoted field, a
skill whose directory and frontmatter disagree.

### Golden files

`fixtures/golden/` holds committed conversion output, compared byte-for-byte. When a
change is intentional, regenerate and commit the new bytes in the same commit as the
emitter change, so a reviewer sees both. Never update a golden file to make a test pass
without being able to say what changed and why.

### Commits

One logical change per commit, with a message that says what changed and why. Present
tense, no prefix conventions beyond the existing `feat:`, `fix:`, `test:`, `docs:`.

---

## Reporting a security problem

Do not open a public issue. Email the maintainer listed in `package.json`, or use GitHub's
private vulnerability reporting on the repository. Everything in this tool treats skill
content as hostile input: a report about a path escaping a skill root, an archive entry
writing outside the extraction directory, or a limit that can be bypassed is taken
seriously and fixed before the next release.
