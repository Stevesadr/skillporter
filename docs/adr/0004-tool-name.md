# ADR-0004: The tool is called `skillporter`

**Status:** accepted (Phase 0)

## Context

The brief requires a short, memorable name, verified free on npm and GitHub before use.

Candidates checked against `registry.npmjs.org/<name>` and `github.com/<name>` on
2026-11-12:

| Name | npm | GitHub |
| --- | --- | --- |
| `skillport` | free | taken |
| `skillbridge` | free | taken |
| `skillcast` | free | taken |
| `skillmux` | taken | — |
| `skillforge` | taken | — |
| `agentport` | taken | — |
| `transskill` | taken | — |
| `skillswap` | taken | taken |
| `skillmorph` | free | taken |
| `skillrelay` | free | taken |
| `skillshim` | free | free |
| `skillconv` | free | free |
| **`skillporter`** | **free** | **free** |

## Decision

Use **`skillporter`**. Package name `skillporter`, CLI binary `skillporter`.

Rationale beyond availability: "port" is the correct verb for moving something between
platforms while accepting that some behaviour will not survive the trip. It sets the
expectation of a fidelity report rather than promising a perfect copy. `skillshim` implies
a compatibility shim that makes the old thing keep working, which is not what this does;
`skillconv` is a description of the mechanism rather than the job.

## Consequences

- Both names must be claimed promptly on npm and GitHub, since availability was only
  checked, not reserved. Re-verify immediately before the first publish.
- The binary name is long for typing. An alias (`skp`) can be added later; do not add one
  now, because aliases are hard to remove and easy to collide.
- Nothing in the code should hardcode the name; it belongs in one constant so a rename
  stays cheap if the name is lost before publication.
