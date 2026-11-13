import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { unzipSync } from 'fflate';
import { ConversionError } from './convert/report.js';
import { isInside, toPosix } from './paths.js';
import type { ToolLimits } from './limits.js';

export interface ExtractedSkill {
  /** Directory holding the skill root. */
  root: string;
  /** Whether the archive held a directory skill or a bare .md file. */
  layout: 'directory' | 'flat';
  /** The .md file, when the archive held a flat skill. */
  skillFile: string;
  /** Remove the temporary directory. */
  cleanup: () => Promise<void>;
}

/**
 * Refuse an archive entry that would land outside the extraction directory.
 *
 * This is the zip-slip guard. It rejects absolute paths, drive letters, `..`
 * segments and names that normalise to nothing, and it is checked twice: once on
 * the name as written, once on the resolved path.
 */
export function assertSafeArchiveEntry(name: string): string {
  const posix = toPosix(name).replace(/^\.\//, '');

  if (posix === '' || posix === '.') throw new ConversionError(`refusing an empty archive entry name`);
  if (posix.startsWith('/')) throw new ConversionError(`refusing absolute archive entry "${name}"`);
  if (/^[A-Za-z]:/.test(posix)) throw new ConversionError(`refusing archive entry "${name}" with a drive letter`);

  const segments = posix.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new ConversionError(`refusing archive entry "${name}" because it contains ".."`);
  }
  if (segments.some((segment) => segment === '')) {
    throw new ConversionError(`refusing archive entry "${name}" because it contains an empty segment`);
  }

  return posix;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Extract a .zip into a temporary directory and locate the skill inside it.
 *
 * Nothing is executed and nothing is written outside the temporary directory.
 * An archive that contains more than the tool limits allow is refused rather
 * than partially extracted, because a partial skill is worse than none.
 */
export async function extractZip(zipPath: string, limits: ToolLimits): Promise<ExtractedSkill> {
  const buffer = await readFile(zipPath);
  if (buffer.byteLength > limits.maxTotalBytes) {
    throw new ConversionError(
      `the archive is ${buffer.byteLength} bytes, over the tool limit of ${limits.maxTotalBytes}. Raise it with --max-total-bytes.`,
    );
  }

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(buffer));
  } catch (error) {
    throw new ConversionError(`could not read ${basename(zipPath)} as a zip archive: ${error instanceof Error ? error.message : String(error)}`);
  }

  const names = Object.keys(entries).sort();
  const files = names.filter((name) => !name.endsWith('/') && !name.endsWith('\\'));

  if (files.length > limits.maxFiles) {
    throw new ConversionError(
      `the archive holds ${files.length} files, over the tool limit of ${limits.maxFiles}. Raise it with --max-files.`,
    );
  }

  const directory = await mkdtemp(join(tmpdir(), 'skillporter-zip-'));
  const cleanup = async (): Promise<void> => {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  };

  let total = 0;
  try {
    for (const name of files) {
      const safe = assertSafeArchiveEntry(name);
      const bytes = entries[name];
      if (bytes === undefined) continue;

      if (bytes.byteLength > limits.maxFileBytes) {
        throw new ConversionError(
          `"${safe}" is ${bytes.byteLength} bytes, over the tool limit of ${limits.maxFileBytes}. Raise it with --max-file-bytes.`,
        );
      }
      total += bytes.byteLength;
      if (total > limits.maxTotalBytes) {
        throw new ConversionError(
          `the archive expands past the tool limit of ${limits.maxTotalBytes} bytes. Raise it with --max-total-bytes.`,
        );
      }

      const destination = join(directory, ...safe.split('/'));
      if (!isInside(directory, destination)) {
        throw new ConversionError(`refusing archive entry "${name}": it resolves outside the extraction directory`);
      }
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
  } catch (error) {
    await cleanup();
    throw error;
  }

  // The skill may be at the top level or inside a single wrapper directory,
  // which is what every "zip this folder" tool produces.
  if (await exists(join(directory, 'SKILL.md'))) {
    return { root: directory, layout: 'directory', skillFile: join(directory, 'SKILL.md'), cleanup };
  }

  const top = [...new Set(files.map((name) => assertSafeArchiveEntry(name).split('/')[0] ?? ''))].filter(
    (name) => name !== '',
  );

  if (top.length === 1 && top[0] !== undefined) {
    const nested = join(directory, top[0]);
    if (await exists(join(nested, 'SKILL.md'))) {
      return { root: nested, layout: 'directory', skillFile: join(nested, 'SKILL.md'), cleanup };
    }
  }

  const flat = top.filter((name) => /\.md$/i.test(name));
  if (top.length === 1 && flat.length === 1) {
    const file = join(directory, flat[0] ?? '');
    return { root: directory, layout: 'flat', skillFile: file, cleanup };
  }

  await cleanup();
  throw new ConversionError(
    `no skill found in the archive: expected SKILL.md at the top level, a single folder containing it, or one .md file`,
  );
}

/** True when the path looks like an archive rather than a skill directory. */
export function isZipPath(path: string): boolean {
  return /\.zip$/i.test(path);
}

export function resolveInput(path: string): string {
  return resolve(path);
}
