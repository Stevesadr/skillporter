import { resolve } from 'node:path';
import { pathEntries, rootSuffix, type AgentProfile } from './profile.js';
import { toPosix } from './paths.js';

export interface Detection {
  /** The single owning agent, or null when the directory is shared or unknown. */
  agent: string | null;
  /** Agents that natively own the matched root. More than one means ambiguous. */
  candidates: string[];
  /** Agents that read the matched root but do not own it, e.g. OpenCode on .claude/skills. */
  alsoReadBy: string[];
  ambiguous: boolean;
  reason: string;
  /** The root suffix that matched, e.g. `.agents/skills`. */
  matchedRoot: string | null;
}

function containsSuffix(path: string, suffix: string): boolean {
  return path === suffix || path.endsWith(`/${suffix}`) || path.includes(`/${suffix}/`);
}

/**
 * Work out which agent a skill directory belongs to from its location alone.
 *
 * `.agents/skills` is deliberately reported as ambiguous: four agents read it
 * natively, and picking one of their rule sets would silently apply the wrong
 * constraints. The caller must pass `--from`.
 */
export function detectSource(skillDirectory: string, profiles: readonly AgentProfile[]): Detection {
  const absolute = toPosix(resolve(skillDirectory));

  const bySuffix = new Map<string, { native: string[]; compatibility: string[] }>();
  for (const profile of profiles) {
    for (const entry of pathEntries(profile)) {
      const suffix = rootSuffix(entry);
      if (!suffix) continue;
      const bucket = bySuffix.get(suffix) ?? { native: [], compatibility: [] };
      bucket[entry.role].push(profile.id);
      bySuffix.set(suffix, bucket);
    }
  }

  let best: { suffix: string; native: string[]; compatibility: string[] } | null = null;
  for (const [suffix, bucket] of bySuffix) {
    if (!containsSuffix(absolute, suffix)) continue;
    if (best === null || suffix.length > best.suffix.length) {
      best = { suffix, ...bucket };
    }
  }

  if (best === null) {
    return {
      agent: null,
      candidates: [],
      alsoReadBy: [],
      ambiguous: true,
      reason: 'the skill is not inside any known agent skill root, so the source agent cannot be inferred from its location',
      matchedRoot: null,
    };
  }

  const native = [...new Set(best.native)].sort();
  const compatibility = [...new Set(best.compatibility)].sort();

  if (native.length === 1) {
    const only = native[0] ?? null;
    const extra = compatibility.length > 0 ? ` (also read by ${compatibility.join(', ')})` : '';
    return {
      agent: only,
      candidates: native,
      alsoReadBy: compatibility,
      ambiguous: false,
      reason: `found under ${best.suffix}${extra}`,
      matchedRoot: best.suffix,
    };
  }

  return {
    agent: null,
    candidates: native,
    alsoReadBy: compatibility,
    ambiguous: true,
    reason: `${best.suffix} is read natively by ${native.join(', ')}, so it has no single owning agent`,
    matchedRoot: best.suffix,
  };
}
