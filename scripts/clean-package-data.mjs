#!/usr/bin/env node
/**
 * Remove the copies that `prepack` put inside a package directory.
 *
 * `resolveAgentsDir` walks up from `dist/` and takes the first `agents/` it
 * finds. In the repository that walk would now stop at `packages/core/agents`
 * instead of the real `agents/`, so a stale copy would quietly shadow the
 * profiles a contributor is editing. Packing is a one-shot operation, so the
 * copy is removed again as soon as the tarball exists.
 *
 * The copied licence goes too, for the same reason: two copies of the licence
 * can drift, and the root one is the one in review.
 *
 * Usage: node scripts/clean-package-data.mjs <core|cli>
 */
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const DATA = {
  core: ['agents', 'schema'],
  cli: [],
};
const FILES = ['LICENSE'];

const packageName = process.argv[2] ?? 'core';
if (!Object.hasOwn(DATA, packageName)) {
  console.error(`clean-package-data: unknown package "${packageName}"`);
  process.exit(1);
}
const target = join(root, 'packages', packageName);

for (const name of [...DATA[packageName], ...FILES]) {
  const path = join(target, name);
  if (!existsSync(path)) continue;
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    // Never fail a pack because of this: a leftover copy is untidy, not broken.
    if (process.env.SKILLPORTER_VERBOSE === '1') {
      console.error(`could not remove ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
