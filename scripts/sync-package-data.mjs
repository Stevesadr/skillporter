#!/usr/bin/env node
/**
 * Copy the files a published package needs but the repository keeps at the top
 * level: the capability profiles, the schema, and the licence.
 *
 * In the repository the data lives where a contributor expects to find it, and
 * `npm run validate:profiles` reads it there. A published package has no
 * repository around it: `resolveAgentsDir` walks up from `dist/`, so the data
 * has to be inside the package directory itself.
 *
 * The licence is the same story for a different reason. npm always includes a
 * `LICENSE` file in a tarball, but only one that is inside the package
 * directory, and a symlink to the repository root would not work: a tarball
 * never contains symbolic links. Apache-2.0 section 4(a) requires handing
 * recipients a copy of the licence, so the file is copied rather than linked.
 *
 * Runs from `prepack`, so `npm pack` and `npm publish` always carry a copy.
 *
 * Usage: node scripts/sync-package-data.mjs <core|cli>
 */
import { cpSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** Directories the runtime reads at load time, per package. */
const DATA = {
  core: ['agents', 'schema'],
  cli: [],
};

/** Files every published package must carry, relative to the repository root. */
const FILES = ['LICENSE'];

const packageName = process.argv[2] ?? 'core';
if (!Object.hasOwn(DATA, packageName)) {
  console.error(`sync-package-data: unknown package "${packageName}"`);
  process.exit(1);
}
const target = join(root, 'packages', packageName);

let copied = 0;
for (const name of [...DATA[packageName], ...FILES]) {
  const from = join(root, name);
  const to = join(target, name);
  if (!existsSync(from)) {
    // Not a repository checkout, so there is nothing to copy. The package
    // already contains the file from the run that built it.
    continue;
  }
  cpSync(from, to, { recursive: true });
  copied += 1;
}

// Silent on purpose: this runs as `prepack`, and `npm pack --json` treats
// anything written to stdout as part of its JSON report.
if (process.env.SKILLPORTER_VERBOSE === '1') {
  console.error(`copied ${copied} file(s) into packages/${packageName}`);
}
