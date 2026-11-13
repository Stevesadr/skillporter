import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { AgentProfile, PathRole } from '../profile.js';
import { toPosix } from '../paths.js';

export type Scope = 'project' | 'global';

export interface ResolvedRoot {
  /** Absolute path. */
  path: string;
  /** Trailing segments, for display and for the report. */
  suffix: string;
  scope: Scope;
  role: PathRole;
  precedence: number | null;
}

export interface RootContext {
  /** Where relative project roots are resolved from. */
  projectRoot: string;
  home: string;
}

export function defaultRootContext(projectRoot: string = process.cwd()): RootContext {
  return { projectRoot, home: homedir() };
}

/**
 * Turn a documented path into an absolute one, or null when it cannot be.
 *
 * Placeholders (`<subdir>`), environment variables (`$KIMI_CODE_HOME`) and the
 * repeatable custom-dir entries describe a location that depends on how the
 * agent was launched. Writing a converted skill into a guess is worse than
 * saying the location is unknown, so those entries are not candidates.
 */
/**
 * Placeholders that name the project root itself.
 *
 * Codex writes `<cwd>/.agents/skills` and dsh writes `<projectRoot>/.dsh/skills`
 * for the same directory. Those are resolvable; `<subdir>`, `<add-dir>` and
 * `<managed-settings-dir>` are not, because they depend on how the agent was
 * launched.
 */
const PROJECT_ROOT_PLACEHOLDERS = new Set(['<projectRoot>', '<cwd>', '<repoRoot>', '<ancestor>']);

export function resolveDocumentedPath(documented: string, context: RootContext, scope: Scope): string | null {
  let raw = documented.trim();
  if (raw === '') return null;

  const posixRaw = toPosix(raw);
  const [first = '', ...rest] = posixRaw.split('/');
  if (PROJECT_ROOT_PLACEHOLDERS.has(first)) raw = rest.join('/');
  if (raw === '') return null;

  if (raw.includes('<') || raw.includes('>')) return null;

  const posix = toPosix(raw);

  if (posix.startsWith('$')) return null;
  if (posix === '~') return context.home;
  if (posix.startsWith('~/')) return join(context.home, posix.slice(2));
  if (isAbsolute(posix)) return resolve(posix);
  if (posix.startsWith('.')) {
    return resolve(scope === 'project' ? context.projectRoot : context.home, posix);
  }
  return null;
}

function suffixOf(absolute: string): string {
  const segments = toPosix(absolute).split('/').filter((segment) => segment.length > 0);
  return segments.slice(-2).join('/');
}

/** Every root the agent documents for one scope, in the order it documents them. */
export function rootsFor(profile: AgentProfile, scope: Scope, context: RootContext): ResolvedRoot[] {
  const entries = scope === 'project' ? profile.paths.project : profile.paths.global;
  const roots: ResolvedRoot[] = [];

  for (const entry of entries) {
    const path = resolveDocumentedPath(entry.path, context, scope);
    if (path === null) continue;
    roots.push({
      path,
      suffix: suffixOf(path),
      scope,
      role: entry.role ?? 'native',
      precedence: entry.precedence ?? null,
    });
  }

  return roots;
}

/** The root a conversion writes to when this agent is targeted on its own. */
export function primaryRoot(profile: AgentProfile, scope: Scope, context: RootContext): ResolvedRoot {
  const roots = rootsFor(profile, scope, context);
  const native = roots.find((root) => root.role === 'native');
  const chosen = native ?? roots[0];
  if (chosen === undefined) {
    throw new Error(
      `${profile.id} documents no ${scope} skill directory that skillporter can resolve without guessing`,
    );
  }
  return chosen;
}

export interface RootAssignment {
  /** Absolute path written once for the whole group. */
  root: ResolvedRoot;
  /** Targets this single copy serves. */
  targets: string[];
  /** True when the root is not every target's own first choice. */
  shared: boolean;
}

/**
 * Assign targets to roots, preferring one copy that several agents already read.
 *
 * The rule is the one the project adopted in ADR-0003: `.agents/skills` is the
 * interop hub, so writing there once beats writing four near-identical copies.
 * A target only joins a group if it documents that root, so nothing is written
 * where an agent would never look.
 */
export function assignRoots(
  profiles: readonly AgentProfile[],
  scope: Scope,
  context: RootContext,
): { assignments: RootAssignment[]; ungrouped: string[] } {
  const readable = new Map<string, Set<string>>();
  const rootsById = new Map<string, ResolvedRoot[]>();
  const primary = new Map<string, string>();

  for (const profile of profiles) {
    const roots = rootsFor(profile, scope, context);
    rootsById.set(profile.id, roots);
    readable.set(profile.id, new Set(roots.map((root) => root.path)));
    const first = roots.find((root) => root.role === 'native') ?? roots[0];
    if (first !== undefined) primary.set(profile.id, first.path);
  }

  const remaining = new Set(profiles.map((profile) => profile.id));
  const assignments: RootAssignment[] = [];
  const ungrouped: string[] = [];

  while (remaining.size > 0) {
    let best: { path: string; members: string[]; nativeCount: number } | null = null;

    const candidates = new Set<string>();
    for (const id of remaining) for (const path of readable.get(id) ?? []) candidates.add(path);

    for (const path of [...candidates].sort()) {
      const members = [...remaining].filter((id) => readable.get(id)?.has(path)).sort();
      if (members.length < 2) continue;
      const nativeCount = members.filter((id) => primary.get(id) === path).length;
      const better =
        best === null ||
        members.length > best.members.length ||
        (members.length === best.members.length && nativeCount > best.nativeCount);
      if (better) best = { path, members, nativeCount };
    }

    if (best === null) {
      // No root is shared by two of the agents that are left, so each of them
      // gets its own documented root. A target with no resolvable root is
      // reported separately: guessing where it looks would be worse than saying
      // we do not know.
      for (const id of [...remaining].sort()) {
        const primaryPath = primary.get(id);
        const root = rootsById.get(id)?.find((candidate) => candidate.path === primaryPath);
        if (root === undefined) {
          ungrouped.push(id);
          continue;
        }
        assignments.push({ root, targets: [id], shared: false });
      }
      break;
    }

    const root = rootsById.get(best.members[0] ?? '')?.find((candidate) => candidate.path === best?.path);
    if (root === undefined) {
      for (const id of [...remaining].sort()) ungrouped.push(id);
      break;
    }

    assignments.push({
      root,
      targets: best.members,
      shared: best.members.some((id) => primary.get(id) !== best?.path),
    });
    for (const id of best.members) remaining.delete(id);
  }

  return { assignments, ungrouped };
}
