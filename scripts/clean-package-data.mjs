#!/usr/bin/env node
/**
 * Remove the copies that `prepack` put inside `packages/core`.
 *
 * `resolveAgentsDir` walks up from `dist/` and takes the first `agents/` it
 * finds. In the repository that walk would now stop at `packages/core/agents`
 * instead of the real `agents/`, so a stale copy would quietly shadow the
 * profiles a contributor is editing. Packing is a one-shot operation, so the
 * copy is removed again as soon as the tarball exists.
 */
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, 'packages', 'core');

for (const name of ['agents', 'schema']) {
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
