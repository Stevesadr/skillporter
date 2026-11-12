# ADR-0003: `.agents/skills` is the default output root

**Status:** accepted (Phase 0)

## Context

Phase 0 found that the three surveyed agents do not share a single skill directory:

- Claude Code reads `.claude/skills` (project) and `~/.claude/skills` (personal).
- `dsh` reads `<projectRoot>/.dsh/skills` at rank 100 and `<projectRoot>/.agents/skills`
  at rank 200, then `customSkillDirs`, then `~/.dsh/skills`, then `~/.agents/skills`.
- Codex CLI reads `.agents/skills` from the working directory and every ancestor up to the
  repository root, plus `~/.agents/skills`.

`.agents/skills` is therefore read natively by two of the three, and by OpenCode per the
`npx skills` documentation. `.claude/skills` is read by exactly one agent.

The obvious optimisation — write once into `.agents/skills` and symlink from
`.claude/skills` — is not safe yet: no agent documents a symlink policy for the shared
root, and `dsh` follows symlinks while the others do not say. Guessing here would violate
the project's rule against inventing agent behaviour.

## Decision

1. `--install --project` defaults to `.agents/skills/<name>`.
2. When the target list includes an agent whose root is not `.agents/skills`, write a real
   copy into that agent's directory. Do not symlink by default.
3. Symlinking is offered as an explicit opt-in flag (planned Phase 4), and only for pairs
   whose symlink behaviour has been verified.
4. The report states, per target, the exact directory written and whether it was a copy or
   a link.

## Consequences

- Converting to all three agents writes three copies. That is more disk, but it is
  correct, and skills are small.
- A user who converts to Codex only gets the file where Codex will actually find it, which
  is the whole point.
- The default is defensible today and can become smarter later without breaking anyone,
  because the report already names the directory written.

## Alternatives rejected

- **Default to `.claude/skills`.** Claude Code is the most feature-rich target, but it is
  one agent out of an open set, and defaulting to the most proprietary root contradicts the
  project's premise.
- **Write to all known roots always.** Surprising, and silently creates directories for
  agents the user does not have.
- **Symlink everywhere.** Unverified for the shared root; would be exactly the kind of
  silent, undocumented assumption the report exists to prevent.
