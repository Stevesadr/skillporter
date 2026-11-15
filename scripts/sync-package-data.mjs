#!/usr/bin/env node
/**
 * Copy the capability profiles and the schema next to the code that reads them.
 *
 * In the repository they live at the top level, where a contributor expects to
 * find them and where `npm run validate:profiles` reads them. A published
 * package has no repository around it: `resolveAgentsDir` walks up from
 * `dist/`, so the data has to be inside the package directory itself.
 *
 * Runs from `prepack`, so `npm pack` and `npm publish` always carry a copy. It
 * is deliberately a copy rather than a symlink: a tarball cannot hold a link
 * that points outside itself.
 */
import { cpSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, 'packages', 'core');

/** Directories the runtime reads at load time, relative to the repository root. */
const DATA = ['agents', 'schema'];

let copied = 0;
for (const name of DATA) {
  const from = join(root, name);
  const to = join(target, name);
  if (!existsSync(from)) {
    // Not a repository checkout, so there is nothing to copy. The package
    // already contains the data from the run that built it.
    continue;
  }
  cpSync(from, to, { recursive: true });
  copied += 1;
}

// Silent on purpose: this runs as `prepack`, and `npm pack --json` treats
// anything written to stdout as part of its JSON report.
if (process.env.SKILLPORTER_VERBOSE === '1') {
  console.error(`copied ${copied} data director${copied === 1 ? 'y' : 'ies'} into packages/core`);
}
