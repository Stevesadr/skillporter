# ADR-0002: Capability profiles are data, and truncation is not rejection

**Status:** accepted (Phase 0)

## Context

The brief requires that a contributor can add an agent by writing one YAML file. That only
works if the YAML can express every real difference between agents. Phase 0 research found
three that a naive schema cannot express:

1. **Three different description behaviours.** Claude Code has no hard cap and truncates a
   combined `description` + `when_to_use` listing at 1,536 characters. `dsh` has no hard
   cap and truncates at 500 characters for its catalog, configurable. Codex has no per-skill
   cap at all and instead shortens descriptions to fit a context-relative budget, possibly
   omitting skills entirely. A single `descriptionMaxLength` integer cannot represent this,
   and modelling truncation as rejection would make the report lie.
2. **Field names disagree.** `when_to_use` (Claude Code) and `whenToUse` (`dsh`) are the
   same concept with different spelling. A byte-preserving converter drops one of them and
   reports nothing.
3. **Silent failure is normal.** `dsh` ignores invalid skills with a log line. A profile
   that says "name must match this regex" is useless without also saying what happens when
   it does not.

## Decision

1. `agents/*.yaml` is the single source of truth, validated by
   `schema/agent-profile.schema.json`. No agent-specific knowledge lives in code for an
   Agent Skills agent.
2. `description.maxLength` (a hard validation limit) and `description.truncation`
   (a display bound, with `at`, `unit`, `configurableBy` and `combinesWith`) are separate
   fields. A profile may have one, the other, or both. A test asserts no profile sets a
   hard limit *and* truncation, because that combination is a contradiction.
3. `fieldAliases` maps a foreign spelling to the profile's spelling, so the pipeline
   renames rather than drops. It is declared on the **target** profile.
4. Every field entry carries a status of `supported | ignored | emulated | unsupported |
   unknown`, and `unknown` requires a note. An unverified capability must be visible as a
   warning, never inferred.
5. `verification: verified | partial | unverified` is mandatory, so a profile cannot
   silently claim more confidence than it has.

## Consequences

- Adding a basic agent is a YAML file plus `npm run validate:profiles`.
- The validator is load-bearing: it must reject profiles that would make the report
  dishonest, not just malformed ones.
- Some agents need a custom adapter anyway. Claude Code's shell-injection placeholders and
  `context: fork` have no representation in a profile, because they change the body, not
  the metadata. Those are `extensions[]` entries with a `fidelityImpact`, handled by
  rules-based body adaptation plus explicit report entries.
- The schema will need versioning once a third party writes a profile.

## Alternatives rejected

- **Per-agent TypeScript modules only.** Fast to write, but makes the "add an agent in 15
  minutes" promise false and puts agent quirks in the hot path of the pipeline.
- **One flat `limits` object.** Cannot express combined budgets (`description` +
  `when_to_use`) or context-relative limits.
- **Treating truncation as a validation failure.** Would make `lint` and `convert` disagree
  and would mislabel `degraded` as `dropped`.
