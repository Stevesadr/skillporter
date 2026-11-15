---
name: "quoting-demo"
description: |
  Show that quoting and block scalars survive a conversion.

  The second paragraph is what makes a block scalar necessary: a single-line
  value cannot hold a blank line.
license: MIT
metadata:
  owner: platform
---

# Quoting demo

This skill exists to be converted. It is deliberately written with a quoted
name, a block-scalar description and two optional fields, so a round trip has
something to preserve or something to report losing.

Steps:

1. Read the frontmatter as written, not as normalised.
2. Convert it to another agent and back.
3. Compare the bytes.

Nothing here is executable.
