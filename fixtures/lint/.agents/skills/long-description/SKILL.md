---
name: migration-plan
description: >-
  Use this skill when the user asks for a migration plan between two versions of
  a library. It also applies when they describe an upgrade that broke their
  build and want the steps in order. Trigger it for questions about deprecated
  APIs, removed configuration keys, and renamed packages. It covers Python,
  Node.js and Go, and says plainly when it does not know a given ecosystem. Ask
  for the current and target versions before writing anything. If the user gives
  a lockfile, read the resolved versions from it rather than asking again. Never
  invent a changelog entry: cite the upstream release notes or say the entry is
  missing. Prefer a numbered list with one action per step, and put the rollback
  step last. When two migrations conflict, say so at the top instead of burying
  it in the middle. End with a short verification section the reader can run
  themselves. Use this skill when the user asks for a migration plan between two
  versions of a library. It also applies when they describe an upgrade that
  broke their build and want the steps in order. Trigger it for questions about
  deprecated APIs, removed configuration keys, and renamed packages. It covers
  Python, Node.js and Go, and says plainly when it does not know a given
  ecosystem. Ask for the current and target versions before writing anything. If
  the user gives a lockfile, read the resolved versions from it rather than
  asking again. Never invent a changelog entry: cite the upstream release notes
  or say the entry is missing. Prefer a numbered list with one action per step,
  and put the rollback step last. When two migrations conflict, say so at the
  top instead of burying it in the middle.
---

# Migration plan

Ask for the two versions, then write the plan.
