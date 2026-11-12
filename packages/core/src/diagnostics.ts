/**
 * Diagnostic codes. These are a stable, documented surface: tests assert on them,
 * and the report in later phases groups by them. Never rename one without a note
 * in the changelog.
 */
export const DIAGNOSTIC_CODES = [
  /** The skill body contains shell syntax the source agent executes. Never executed by us. */
  'SHELL_INJECTION',
  /** A field or behaviour the target agent does not document. We warn, we do not guess. */
  'UNKNOWN_CAPABILITY',
  /** A symlink pointed outside the skill root and was not followed. */
  'SYMLINK_OUTSIDE_ROOT',
  /** A symlink could not be resolved. */
  'SYMLINK_BROKEN',
  /** A path contained `..` and was refused. */
  'PATH_TRAVERSAL_REJECTED',
  /** A path was absolute where a relative one was required. */
  'ABSOLUTE_PATH_REJECTED',
  /** A tool limit (file size, count, total size, depth) was hit. Not an agent limit. */
  'LIMIT_EXCEEDED',
  /** More than one agent could own the directory the skill was found in. */
  'AMBIGUOUS_SOURCE',
  /** A field the agent requires is absent. */
  'MISSING_REQUIRED_FIELD',
  /** Frontmatter exists but is not a valid YAML map. */
  'FRONTMATTER_INVALID',
  /** No frontmatter block at all. */
  'FRONTMATTER_MISSING',
  /** A file or directory was deliberately not included. */
  'FILE_SKIPPED',
  /** The skill is a bare `.md` file rather than a directory. */
  'FLAT_LAYOUT',
  /** The identity was derived from the path because frontmatter did not supply it. */
  'IDENTITY_DERIVED',
] as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  code: DiagnosticCode;
  severity: Severity;
  message: string;
  /** Path relative to the skill root, posix separators. */
  file?: string;
  /** 1-based line in that file. */
  line?: number;
  /** 1-based column. */
  column?: number;
  /** What the user can do about it. */
  hint?: string;
  detail?: Record<string, unknown>;
}

export function diagnostic(
  code: DiagnosticCode,
  severity: Severity,
  message: string,
  extra: Omit<Diagnostic, 'code' | 'severity' | 'message'> = {},
): Diagnostic {
  return { code, severity, message, ...extra };
}

export function countBySeverity(diagnostics: readonly Diagnostic[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const item of diagnostics) counts[item.severity] += 1;
  return counts;
}
