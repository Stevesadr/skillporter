# Fixtures

Every skill in this directory was written for skillporter by its contributors and is
covered by the repository's [Apache-2.0 licence](../LICENSE). None of them is copied
from another project, so there is no third-party attribution to carry.

That is a deliberate choice rather than a convenience. A fixture is a test input: if it
came from somewhere else, its licence would decide what the test suite may do with it,
and a licence change upstream would silently change what the tests prove. Skills that
were *modelled* on the shapes real skills take are marked as such below, and the shape
is described rather than reproduced.

If you add a fixture that is not your own work, you must:

1. confirm that its licence permits redistribution **and** modification, because the
   golden tests rewrite it;
2. record the source URL, the licence name and the copyright line in the table below;
3. keep the upstream licence text next to the fixture if it asks for that.

A fixture whose licence cannot be established is not accepted, however useful it is.

## Skills

| Directory | What it exercises | Origin |
| --- | --- | --- |
| `skills/changelog-writer` | The happy path: a small skill with a frontmatter description and a plain body. Used as the clean conversion case and the source of most golden files. | Original |
| `skills/report-builder` | Everything that can be lost at once: `allowed-tools`, an unknown vendor field, two shell placeholders (one inline, one fenced), and bundled binary and text assets. | Original |
| `skills/flow-release` | A body that reads as a workflow rather than prose, to check that the body is never rewritten when there is nothing to rewrite. | Original |
| `skills/quoting-demo` | Frontmatter spelling that must survive: a quoted `name`, a block-scalar `description`, and a nested `metadata` map. | Original |
| `lint/.agents/skills/*` | One skill per lint rule, named after the rule it triggers. `flat-skill.md` and `alias-spelling` cover the flat and aliased forms. | Original |
| `shared-root/.agents/skills/*` | A root that four agents read natively, used to check that the shared copy is written once. | Original |
| `golden/*` | Committed conversion output, compared byte-for-byte. Regenerated with `--force` when a change is intentional. | Generated |

## Golden files

`golden/` holds the exact bytes `convert` must produce. They are generated, not
hand-written: when a conversion changes on purpose, the golden file changes with it in
the same commit, so the diff is reviewable. A golden file that changes without a
matching change to the emitter is a regression.
