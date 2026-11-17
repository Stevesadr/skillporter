/**
 * The guard for the packaging copies.
 *
 * `prepack` copies `agents/` and `schema/` into `packages/core/` so a published
 * tarball carries them, and `postpack` removes them again. If a pack is
 * interrupted between the two, the copies stay behind — and they win: the
 * runtime walks up from `dist/` and finds `packages/core/agents` before the
 * repository's `agents/`. A stale copy then shadows the real profiles, silently,
 * and every test that reads a profile is really reading last week's file.
 *
 * This test does not care whether the copies exist. It cares that whatever the
 * runtime actually loads is byte-identical to the repository's own data, so a
 * stale copy fails here instead of in a release.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveAgentsDir } from '../packages/core/dist/index.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Every file under `dir`, as posix paths relative to it. */
async function filesUnder(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}

/**
 * Assert that `loaded` holds exactly the files in `expected`, byte for byte.
 *
 * Reports the offending paths rather than the first mismatch, because the useful
 * question after a stale copy is "what changed", not "did anything".
 */
async function assertSameData(loaded, expected, what) {
  const loadedFiles = await filesUnder(loaded);
  const expectedFiles = await filesUnder(expected);

  const missing = expectedFiles.filter((file) => !loadedFiles.includes(file));
  const extra = loadedFiles.filter((file) => !expectedFiles.includes(file));
  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    `${what}: ${loaded} does not hold the same files as ${expected}`,
  );

  const changed = [];
  for (const file of expectedFiles) {
    const [a, b] = await Promise.all([readFile(join(loaded, file)), readFile(join(expected, file))]);
    if (!a.equals(b)) changed.push(file);
  }
  assert.deepEqual(changed, [], `${what}: ${loaded} has stale copies of ${changed.join(', ')}`);
}

test('the profiles the runtime loads are the profiles in the repository', async () => {
  // The runtime resolves `agents/` by walking up, so this is the directory that
  // shadows the repository when a pack was interrupted.
  const loaded = resolveAgentsDir();
  const expected = join(ROOT, 'agents');

  if (loaded !== expected) {
    // Worth saying out loud: this is the packaging copy, and it is only correct
    // while it matches. `npm run pack` removes it again in `postpack`.
    assert.ok(
      loaded.startsWith(join(ROOT, 'packages')),
      `resolveAgentsDir returned ${loaded}, which is neither the repository copy nor a package copy`,
    );
  }

  await assertSameData(loaded, expected, 'agents/');
});

test('the schema the runtime loads is the schema in the repository', async () => {
  // `schemaPath()` sits beside the agents directory, so it shadows in the same
  // way and is checked the same way.
  const loaded = join(resolveAgentsDir(), '..', 'schema');
  await assertSameData(loaded, join(ROOT, 'schema'), 'schema/');
});

test('no packaging copy is left behind with content the repository does not have', async () => {
  // The two tests above compare what is loaded. This one names the leftovers, so
  // a failing build says "run npm run clean:pack" instead of showing a diff.
  // `prepack` copies the licence too, for the same reason and with the same risk.
  for (const name of ['agents', 'schema']) {
    const copy = join(ROOT, 'packages', 'core', name);
    if (!existsSync(copy)) continue;

    const real = join(ROOT, name);
    const [copyFiles, realFiles] = await Promise.all([filesUnder(copy), filesUnder(real)]);
    const stale = [];
    for (const file of copyFiles) {
      if (!realFiles.includes(file)) {
        stale.push(`${file} (not in ${name}/)`);
        continue;
      }
      const [a, b] = await Promise.all([readFile(join(copy, file)), readFile(join(real, file))]);
      if (!a.equals(b)) stale.push(file);
    }

    assert.deepEqual(
      stale,
      [],
      `packages/core/${name} is a leftover packaging copy that disagrees with ${name}/: ${stale.join(', ')}. Run \`npm run clean:pack\` (or delete packages/core/${name}) before continuing.`,
    );
  }

  for (const packageName of ['core', 'cli']) {
    const copy = join(ROOT, 'packages', packageName, 'LICENSE');
    if (!existsSync(copy)) continue;
    const [a, b] = await Promise.all([readFile(copy), readFile(join(ROOT, 'LICENSE'))]);
    assert.ok(
      a.equals(b),
      `packages/${packageName}/LICENSE is a leftover packaging copy that disagrees with LICENSE. Run \`npm run clean:pack\`.`,
    );
  }
});
