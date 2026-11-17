---
name: slash-invoker
description: Summarise a changelog from the chat prompt. Run /slash-invoker to start, or /slash-invoker-compact for the one-paragraph form.
---

# Slash invoker

Run `/slash-invoker` at the start of a message to summarise a changelog.

For a shorter answer, run `/slash-invoker-compact` instead. It reads the same
files and prints one paragraph.

## Not a reference

These are here so the scanner has to tell them apart from an invocation:

- a path: `scripts/release/notes.sh`
- a URL: <https://example.com/docs/slash-invoker>
- a division: 12 / 4
- a shell command: `/usr/bin/env node`
- a built-in chat command: `/help`
- a link target: [the guide](./references/guide.md)

```
/this-is-inside-a-fence
```

The body is deliberately written for an agent that invokes a skill with a slash,
so the invocation rule has something to fire on for the other agents.
