import { chmod, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isInside } from './paths.js';
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

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Write a skill directory atomically.
 *
 * The whole directory is built in a temporary directory inside the root and
 * renamed into place in one step, so an interrupted run never leaves a
 * half-written skill behind. An existing copy is moved aside first — by rename,
 * not by delete, so replacing never depends on being allowed to delete anything
 * — and that move is the backup. A backup lives outside the root, so it can
 * never be discovered as a skill.
 */
export async function writeSkill(options: WriteSkillOptions): Promise<WriteSkillResult> {
  const root = resolve(options.root);
  const destination = resolve(root, options.directoryName);

  if (!isInside(root, destination)) {
    throw new ConversionError(`refusing to write to ${destination}: it is outside the target root ${root}`);
  }

  const alreadyThere = await exists(destination);
  if (alreadyThere && !options.force) {
    const confirmed = options.confirm === undefined ? false : await options.confirm(destination);
    if (!confirmed) {
      throw new ConversionError(
        `${destination} already exists. Re-run with --force to replace it, or pick another --out. ` +
          'skillporter does not overwrite a skill without being asked to.',
      );
    }
  }

  // Where the old copy goes. A backup is kept and reported; a build artifact is
  // discarded. Either way it is outside the root, so a leftover cannot be read
  // back as a skill.
  const stampName = `${basename(root)}-${stamp(options.now ?? new Date())}`;
  const asideRoot =
    options.backup === false
      ? join(dirname(root), '.skillporter-trash', stampName)
      : join(dirname(root), '.skillporter-backups', stampName);
  const aside = join(asideRoot, options.directoryName);

  let backup: string | undefined;
  if (alreadyThere) {
    await mkdir(asideRoot, { recursive: true });
    await rename(destination, aside);
    if (options.backup !== false) backup = aside;
  }

  const staging = join(root, `.skillporter-tmp-${randomBytes(6).toString('hex')}`, options.directoryName);
  await mkdir(staging, { recursive: true });

  const modeFailures: string[] = [];
  try {
    for (const file of options.files) {
      const target = join(staging, ...file.path.split('/'));
      if (!isInside(staging, target)) {
        throw new ConversionError(`refusing to write ${file.path}: it escapes the skill directory`);
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.bytes);
      if (file.mode !== 0) {
        try {
          await chmod(target, file.mode);
        } catch {
          modeFailures.push(file.path);
        }
      }
    }

    try {
      await rename(staging, destination);
    } catch (error) {
      // Put the old copy back rather than leave the root without the skill it
      // had before this call.
      if (alreadyThere) await rename(aside, destination).catch(() => undefined);
      throw error;
    }
  } finally {
    await rm(dirname(staging), { recursive: true, force: true }).catch(() => undefined);
  }

  // A build artifact is not worth keeping. A backup is: it stays until the user
  // removes it.
  if (alreadyThere && options.backup === false) {
    await rm(asideRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  return {
    destination,
    ...(backup === undefined ? {} : { backup }),
    replaced: alreadyThere,
    modeFailures,
  };
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
  await mkdir(root, { recursive: true });
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
