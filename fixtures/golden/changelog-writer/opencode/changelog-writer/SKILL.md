---
name: changelog-writer
description: Draft a changelog entry from merged pull requests. Use when the user asks for release notes, a changelog, or a summary of what shipped.
---

# Changelog writer

Write a changelog entry for the range the user names, or for everything since the
last tag when they do not name one.

1. Collect the merged pull requests in the range.
2. Drop anything labelled `skip-changelog`.
3. Group the rest under **Added**, **Changed**, **Fixed**, **Removed**.
4. Write one line per change, in the imperative mood, naming the user-visible effect
   rather than the implementation.

Do not invent entries. If a pull request has no description, say so in the output
instead of guessing what it did.

## Example

Input: three merged PRs, one labelled `skip-changelog`.

Output:

```markdown
## Added
- Support reading configuration from `skillporter.config.json`.

## Fixed
- Stop rewriting CRLF line endings when copying bundled files.
```
