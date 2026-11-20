import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Diagnostic } from './diagnostics.js';
import type { ToolLimits } from './limits.js';
import { detectLineEnding, isInside, toPosix } from './paths.js';

export type FileEncoding = 'utf8' | 'binary';

export interface BundledFile {
  /** Posix path relative to the skill root. */
  path: string;
  size: number;
  /** Permission bits, or 0 when the platform does not report them. */
  mode: number;
  sha256: string;
  encoding: FileEncoding;
  /** Null for binary files. */
  lineEnding: 'lf' | 'crlf' | 'mixed' | null;
}

export interface CollectResult {
  files: BundledFile[];
  diagnostics: Diagnostic[];
}

const ALWAYS_SKIP = new Set(['.git', 'node_modules', '.DS_Store']);

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function classify(buffer: Buffer): { encoding: FileEncoding; lineEnding: 'lf' | 'crlf' | 'mixed' | null } {
  if (buffer.includes(0)) return { encoding: 'binary', lineEnding: null };
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return { encoding: 'utf8', lineEnding: detectLineEnding(text) };
  } catch {
    return { encoding: 'binary', lineEnding: null };
  }
}

/**
 * Enumerate the files bundled alongside a skill.
 *
 * Symlinks that resolve outside the skill root are skipped and reported, never
 * followed. The walker is depth-limited, count-limited and size-limited by the
 * tool's own limits, which are configurable and reported as tool limits.
 */
export async function collectBundledFiles(
  root: string,
  limits: ToolLimits,
  options: { exclude?: string[] } = {},
): Promise<CollectResult> {
  const diagnostics: Diagnostic[] = [];
  const files: BundledFile[] = [];
  const exclude = new Set(options.exclude ?? []);

  const rootReal = await realpath(root);
  let totalBytes = 0;
  let stopped: 'maxFiles' | 'maxTotalBytes' | undefined;

  function reportLimit(path: string, limit: 'maxFiles' | 'maxTotalBytes'): void {
    diagnostics.push({
      code: 'LIMIT_EXCEEDED',
      severity: 'warning',
      message: `skipped "${path}" because the tool limit of ${limits[limit]} ${limit === 'maxFiles' ? 'files' : 'total bytes'} was reached; the file was not read`,
      hint: `This is a skillporter limit. Raise it with ${limit === 'maxFiles' ? '--max-files' : '--max-total-bytes'}.`,
      file: path,
      detail: { scope: 'tool', limit, value: limits[limit], path },
    });
  }

  function reportUnreadable(path: string, error: unknown): void {
    diagnostics.push({
      code: 'FILE_SKIPPED',
      severity: 'warning',
      message: `could not read "${path}": ${error instanceof Error ? error.message : String(error)}`,
      file: path,
    });
  }

  async function walk(directory: string, depth: number, prefix: string): Promise<void> {

    if (depth > limits.maxDepth) {
      diagnostics.push({
        code: 'LIMIT_EXCEEDED',
        severity: 'warning',
        message: `not descending into "${prefix || '.'}" because it is deeper than the tool limit of ${limits.maxDepth}`,
        hint: 'This is a skillporter limit, not an agent limit. Raise it with --max-depth.',
        detail: { scope: 'tool', limit: 'maxDepth', value: limits.maxDepth, path: prefix },
      });
      return;
    }

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (prefix === '') throw error;
      reportUnreadable(toPosix(prefix), error);
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const posix = toPosix(relative);

      if (ALWAYS_SKIP.has(entry.name)) continue;
      if (depth === 0 && exclude.has(entry.name)) continue;

      let kind: 'file' | 'directory' | 'other' = 'other';
      let target = absolute;

      if (entry.isSymbolicLink()) {
        try {
          const resolved = await realpath(absolute);
          if (!isInside(rootReal, resolved)) {
            diagnostics.push({
              code: 'SYMLINK_OUTSIDE_ROOT',
              severity: 'warning',
              message: `skipped symlink "${posix}" because it points outside the skill root`,
              hint: 'The target was not read. Copy the file into the skill if it is meant to be bundled.',
              file: posix,
              detail: { target: resolved },
            });
            continue;
          }
          target = resolved;
          const info = await stat(resolved);
          kind = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other';
        } catch {
          diagnostics.push({
            code: 'SYMLINK_BROKEN',
            severity: 'warning',
            message: `skipped broken symlink "${posix}"`,
            file: posix,
          });
          continue;
        }
      } else if (entry.isDirectory()) {
        kind = 'directory';
      } else if (entry.isFile()) {
        kind = 'file';
      }

      if (kind === 'other') {
        diagnostics.push({
          code: 'FILE_SKIPPED',
          severity: 'warning',
          message: `skipped "${posix}" because it is not a regular file or directory`,
          file: posix,
        });
        continue;
      }

      if (kind === 'directory') {
        await walk(target, depth + 1, relative);
        continue;
      }

      if (files.length >= limits.maxFiles) stopped ??= 'maxFiles';
      if (stopped !== undefined) {
        reportLimit(posix, stopped);
        continue;
      }

      let info;
      try {
        info = await stat(target);
      } catch (error) {
        reportUnreadable(posix, error);
        continue;
      }
      if (info.size > limits.maxFileBytes) {
        diagnostics.push({
          code: 'LIMIT_EXCEEDED',
          severity: 'warning',
          message: `skipped "${posix}" (${info.size} bytes) because it exceeds the tool limit of ${limits.maxFileBytes} bytes`,
          hint: 'This is a skillporter limit. Raise it with --max-file-bytes.',
          file: posix,
          detail: { scope: 'tool', limit: 'maxFileBytes', value: limits.maxFileBytes, size: info.size },
        });
        continue;
      }

      if (totalBytes + info.size > limits.maxTotalBytes) {
        stopped = 'maxTotalBytes';
        reportLimit(posix, stopped);
        continue;
      }

      let buffer: Buffer;
      try {
        buffer = await readFile(target);
      } catch (error) {
        reportUnreadable(posix, error);
        continue;
      }
      totalBytes += buffer.byteLength;
      const { encoding, lineEnding } = classify(buffer);

      files.push({
        path: posix,
        size: buffer.byteLength,
        mode: info.mode & 0o777,
        sha256: sha256(buffer),
        encoding,
        lineEnding,
      });
    }
  }

  await walk(rootReal, 0, '');

  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files, diagnostics };
}

export { sha256 };
