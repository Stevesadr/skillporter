# ADR-0001: Hub-and-spoke conversion through an intermediate representation

**Status:** accepted (Phase 0)

## Context

There are N agents and the number of conversion pairs grows as N². Writing a converter per
pair means eleven agents produce 110 converters, each with its own drift and its own bugs.

The formats are also not symmetric. As documented in `docs/research.md`, the intersection
of supported frontmatter across Claude Code, `dsh` and Codex CLI is exactly `name` and
`description`. Everything else is per-pair.

## Decision

Convert through a single intermediate representation:

```
source directory -> Parser -> IR -> Emitter -> target directory
```

The IR is a versioned, schema-validated TypeScript type carrying `name`, `description`,
`body`, `frontmatterExtras` (unknown fields preserved verbatim with their origin agent
tagged), `files` (bundled scripts, references and assets with relative paths, modes and
encoding), `origin` (agent, version, path) and `warnings[]`.

Parsers only ever produce IR. Emitters only ever consume IR. No parser knows about a
target, and no emitter knows about a source.

## Consequences

- Adding an agent costs one adapter (or, for Agent Skills agents, one data file), not N
  converters.
- Fidelity can be computed once, in the emitter, by comparing IR against the target
  profile — not reimplemented per pair.
- The IR becomes a stable, documented artefact third parties can target. That is a
  liability as well as an asset: it must be versioned and schema-validated from day one.
- Round-trip tests (A→B→A) become meaningful, because the IR gives an exact definition of
  what "preserved" means: the IR after A→B→A must equal the IR after A alone, except for
  fields the report marked as degraded or dropped.

## Alternatives rejected

- **Pairwise converters.** Quadratic and unauditable.
- **Canonical format on disk, no IR.** Would force every conversion to materialise an
  intermediate directory, and loses in-memory warnings and provenance.
- **Lossy pass-through with a diff.** Cheap to build, but the project's core promise is
  that nothing is lost silently, and a text diff cannot say *why* something changed.
