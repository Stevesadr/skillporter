---
name: shared-helper
description: Normalise CSV headers before analysis. Use when a CSV has inconsistent column names.
---

# Shared helper

Rewrite headers to `snake_case`, keep the original order, and report any column
that collides with another after normalisation.
