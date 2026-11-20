# @skillporter/core

The engine behind [`skillporter`](https://www.npmjs.com/package/@skillporter/cli): parse an agent
skill into a source-faithful intermediate representation, and know what every target agent
does and does not understand.

> **Alpha.** Pre-1.0 and experimental. The API surface, the report shape and the lint rule ids
> may change without a major version bump. Pin an exact version.

## Install

```bash
npm install @skillporter/core@0.1.0
```

Requires Node 22.20.0 or newer.

## Use

```js
import { parseSkill } from '@skillporter/core';

const { ir } = await parseSkill({ path: './my-skill', from: 'claude-code' });

console.log(ir.identity.name);       // report-builder
console.log(ir.frontmatter.fields);  // every field, with its origin and whether the source agent honoured it
```

`from` names the source agent. It can be omitted when the skill sits inside a root that only
one agent reads; when several agents share the root — `.agents/skills` is read by four of them
— parsing throws `AmbiguousSourceError` rather than guessing.

The parsed IR keeps the body byte-exact, records the line ending style, preserves every
unknown field verbatim with its origin agent and line number, and notes any shell-injection
syntax the source agent would have executed. Nothing is normalised away silently.

## What ships in the package

The capability profiles (`agents/*.yaml`) and their JSON schemas (`schema/*.json`) are bundled
with the code. They are data, not code: each profile declares one agent's paths, field support,
name grammar, limits and unknown fields, and adding an agent means adding a file. The linter
reads them, so it knows what the target understands without a single per-agent branch in the
engine.

## Links

- [The CLI](https://www.npmjs.com/package/@skillporter/cli)
- [Source, documentation and the supported-agent matrix](https://github.com/Stevesadr/skillporter)
- [Capability profiles, with a source URL for every claim](https://github.com/Stevesadr/skillporter/blob/main/docs/agents.md)

## Licence

Apache-2.0.
