---
name: broken-frontmatter
description: This line is fine.
tags: [one, two
---

# Broken

The YAML above never closes its flow sequence, so nothing after it can be trusted.
