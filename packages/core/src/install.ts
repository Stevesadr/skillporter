import { access, chmod, lstat, mkdir, mkdtemp, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { checkSafeRelativePath, isInside } from './paths.js';
import { ConversionError } from './convert/report.js';

export interface FileToWrite {
  /** Posix path relative to the skill directory. */
  path: string;
  bytes: Buffer;
  mode: number;
}

export interface WriteSkillOptions {
  /** The discovery root the skill belongs in. Nothing outside it is ever written. */
  root: string;
  /** Directory name under the root. */
  directoryName: string;
  files: readonly FileToWrite[];
  /** Replace an existing skill without asking. */
  force: boolean;
  strict?: boolean;
  /**
   * Asked once when the destination exists and `force` is not set. Returning
   * false aborts. When no handler is given, an existing destination is an error:
   * silence must never mean overwrite.
   */
  confirm?: (destination: string) => Promise<boolean>;
  /** Injected for tests, so a backup folder name is predictable. */
  now?: Date;
  /** Move an existing skill aside before replacing it. Off for build output. */
  backup?: boolean;
}

export interface WriteSkillResult {
  destination: string;
  /** Where the previous contents were moved, when there were any. */
  backup?: string;
  replaced: boolean;
  /** Files whose permission bits could not be applied. */
  modeFailures: string[];
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

async function entry(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function checkWritableDirectory(path: string): Promise<string> {
  let current = path;
  while ((await entry(current)) === undefined) current = dirname(current);
  if (!(await stat(current)).isDirectory()) {
    throw new ConversionError(`${current} is not a directory`);
  }
  await access(current, constants.W_OK | constants.X_OK);
  return resolve(await realpath(current), relative(current, path));
}

export async function prepareSkillWrite(options: WriteSkillOptions): Promise<{
  destination: string;
  commit: () => Promise<WriteSkillResult>;
}> {
  const root = resolve(options.root);
  const destination = resolve(root, options.directoryName);

  if (!isInside(root, destination) || dirname(destination) !== root) {
    throw new ConversionError(`refusing to write to ${destination}: it is outside the target root ${root}`);
  }

  const paths = new Set<string>();
  for (const file of options.files) {
    const path = join(destination, ...file.path.split('/'));
    if (!checkSafeRelativePath(file.path).ok || !isInside(destination, path) || path === destination) {
      throw new ConversionError(`refusing to write ${file.path}: it escapes the skill directory`);
    }
    const key = process.platform === 'win32' ? path.toLowerCase() : path;
    if (paths.has(key)) throw new ConversionError(`duplicate output file: ${file.path}`);
    paths.add(key);
  }
  for (const path of paths) {
    for (let parent = dirname(path); isInside(destination, parent) && parent !== destination; parent = dirname(parent)) {
      if (paths.has(parent)) throw new ConversionError(`output file conflicts with a directory: ${parent}`);
    }
  }

  const realRoot = await checkWritableDirectory(root);
  const previous = await entry(destination);
  const alreadyThere = previous !== undefined;
  if (alreadyThere && !options.force) {
    const confirmed = options.confirm === undefined ? false : await options.confirm(destination);
    if (!confirmed) {
      throw new ConversionError(
        `${destination} already exists. Re-run with --force to replace it, or pick another --out. ` +
          'skillporter does not overwrite a skill without being asked to.',
      );
    }
  }

  const asideParent = join(dirname(root), options.backup === false ? '.skillporter-trash' : '.skillporter-backups');
  if (alreadyThere) await checkWritableDirectory(asideParent);

  async function commit(): Promise<WriteSkillResult> {
    await mkdir(root, { recursive: true });
    const stagingParent = await mkdtemp(join(root, '.skillporter-tmp-'));
    const staging = join(stagingParent, basename(destination));
    const modeFailures: string[] = [];
    let asideDirectory: string | undefined;
    let backup: string | undefined;
    let movedAside = false;
    let installed = false;

    try {
      await mkdir(staging);
      for (const file of options.files) {
        const target = join(staging, ...file.path.split('/'));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.bytes, { flag: 'wx' });
        if (file.mode !== 0) {
          try {
            await chmod(target, file.mode);
          } catch (error) {
            if (options.strict === true) throw error;
            modeFailures.push(file.path);
          }
        }
      }

      const current = await entry(destination);
      if (current?.ino !== previous?.ino || current?.dev !== previous?.dev) {
        throw new ConversionError(`${destination} changed after preflight`);
      }
      if (alreadyThere) {
        await mkdir(asideParent, { recursive: true });
        asideDirectory = await mkdtemp(join(asideParent, `${basename(root)}-${stamp(options.now ?? new Date())}-`));
        backup = join(asideDirectory, basename(destination));
        await rename(destination, backup);
        movedAside = true;
      }

      try {
        await rename(staging, destination);
        installed = true;
      } catch (error) {
        if (movedAside && backup !== undefined) {
          try {
            await rename(backup, destination);
            movedAside = false;
          } catch (restoreError) {
            throw new ConversionError(`could not replace ${destination}: ${String(error)}. Previous copy is at ${backup}. Automatic restoration failed: ${String(restoreError)}`);
          }
        }
        throw error;
      }

      return {
        destination,
        ...(backup === undefined || options.backup === false ? {} : { backup }),
        replaced: alreadyThere,
        modeFailures,
      };
    } finally {
      await rm(stagingParent, { recursive: true, force: true }).catch(() => undefined);
      if (asideDirectory !== undefined && (!movedAside || (installed && options.backup === false))) {
        await rm(asideDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  return { destination: join(realRoot, basename(destination)), commit };
}

/** Build the complete replacement before moving the previous copy aside. */
export async function writeSkill(options: WriteSkillOptions): Promise<WriteSkillResult> {
  return (await prepareSkillWrite(options)).commit();
}

/**
 * Write into a plain output directory, which is not a discovery root.
 *
 * Same atomicity and the same refusal to overwrite, but no backup folder: an
 * `--out` directory is a build artifact, not someone's installed skill.
 */
export async function writeSkillToOutput(
  outDir: string,
  directoryName: string,
  files: readonly FileToWrite[],
  options: { force: boolean; confirm?: (destination: string) => Promise<boolean>; now?: Date },
): Promise<WriteSkillResult> {
  const root = resolve(outDir);
  return writeSkill({
    root,
    directoryName,
    files,
    force: options.force,
    backup: false,
    ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}
