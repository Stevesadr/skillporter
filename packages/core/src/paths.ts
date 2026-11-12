import type { Diagnostic } from './diagnostics.js';

/**
 * Path helpers. Everything that crosses the IR boundary is posix, because the IR
 * is compared byte-for-byte in golden tests and must not vary by platform.
 */

export function toPosix(value: string): string {
  return value.split('\\').join('/');
}

export interface SafePathResult {
  ok: boolean;
  diagnostic?: Diagnostic;
}

/**
 * Reject absolute paths and any `..` segment in a relative path.
 *
 * The walker builds paths from `readdir`, so it cannot produce a bad one today.
 * This exists so the same guard can be reused for archive entries in Phase 1d,
 * and so a bug in a future caller fails closed instead of escaping the skill root.
 */
export function checkSafeRelativePath(candidate: string): SafePathResult {
  const posix = toPosix(candidate);

  if (posix.startsWith('/') || /^[A-Za-z]:\//.test(posix)) {
    return {
      ok: false,
      diagnostic: {
        code: 'ABSOLUTE_PATH_REJECTED',
        severity: 'error',
        message: `refusing absolute path "${candidate}"`,
        hint: 'Only paths relative to the skill root are accepted.',
      },
    };
  }

  const segments = posix.split('/');
  if (segments.some((segment) => segment === '..')) {
    return {
      ok: false,
      diagnostic: {
        code: 'PATH_TRAVERSAL_REJECTED',
        severity: 'error',
        message: `refusing path "${candidate}" because it contains ".."`,
        hint: 'A skill may only reference files inside its own root.',
      },
    };
  }

  if (posix === '' || posix === '.') {
    return {
      ok: false,
      diagnostic: {
        code: 'PATH_TRAVERSAL_REJECTED',
        severity: 'error',
        message: `refusing empty path "${candidate}"`,
      },
    };
  }

  return { ok: true };
}

/** True when `child` is inside `parent` after resolution. */
export function isInside(parent: string, child: string): boolean {
  const fold = (value: string): string => {
    const posix = toPosix(value).replace(/\/+$/, '');
    // Windows paths are case-insensitive, and `realpath` casing can differ from
    // the casing a caller supplied.
    return process.platform === 'win32' ? posix.toLowerCase() : posix;
  };
  const parentPosix = fold(parent);
  const childPosix = fold(child);
  if (childPosix === parentPosix) return true;
  return childPosix.startsWith(`${parentPosix}/`);
}

export function splitLines(text: string): string[] {
  return text.split('\n');
}

/** Offsets at which each line starts. Index 0 is always 0. */
export function lineStartOffsets(text: string): number[] {
  const offsets = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') offsets.push(index + 1);
  }
  return offsets;
}

export type LineEnding = 'lf' | 'crlf' | 'mixed';

export function detectLineEnding(text: string): LineEnding {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  if (crlf === 0) return 'lf';
  if (lf === 0) return 'crlf';
  return 'mixed';
}
