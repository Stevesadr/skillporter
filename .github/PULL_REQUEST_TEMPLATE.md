## What changed

<!-- One paragraph. If it is a profile change, name the agent and the field. -->

## Why

<!-- The behaviour that was wrong, or the gap that was missing. Link the issue if there is one. -->

## Type

- [ ] Capability profile (data only, no code)
- [ ] Bug fix
- [ ] New behaviour
- [ ] Tests only
- [ ] Documentation only

## Checklist

- [ ] `npm run validate:profiles` passes (profile changes)
- [ ] `npm run build` and `npm run typecheck` pass
- [ ] `npm run rules:check` passes (or `docs/lint-rules.md` is regenerated in this pull request)
- [ ] `npm run agents:docs:check` passes (or `docs/agents.md` is regenerated in this pull request)
- [ ] `npm test` passes
- [ ] `npm run check:package` passes, if anything about packaging or the runtime file layout changed

## For a profile change

- [ ] Every new claim has a source URL with the date it was retrieved
- [ ] Anything I could not verify is `unknown` or `null` with a note, not copied from a similar agent
- [ ] The profile is not referenced by id anywhere in `packages/core`

## For a bug fix

- [ ] There is a test that fails without this change
- [ ] The test reproduces the input that exposed the bug, not just the symptom

## For a golden-file change

<!-- Delete if not applicable. -->

- [ ] I can say exactly which bytes changed and why
- [ ] No golden file was updated only to make a test pass
