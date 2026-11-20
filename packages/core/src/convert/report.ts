import type { Diagnostic } from '../diagnostics.js';
import type { Detection } from '../detect.js';
import type { LintSummary } from '../lint.js';

/**
 * How one thing survived the conversion.
 *
 * `renamed` and `adapted` are not losses: the meaning is intact and the report
 * says what changed. `degraded` and `dropped` are losses, and they are what the
 * exit code counts.
 */
export type Fidelity = 'preserved' | 'adapted' | 'renamed' | 'degraded' | 'dropped';

/**
 * What kind of thing was classified. Used for grouping in the text report.
 *
 * Every member is reachable: `tests/convert.test.mjs` asserts that, so a kind
 * that no code path produces cannot quietly stay in the type. Where a decision
 * has a section of its own in the report (`roots`, `lint`) it is not repeated as
 * an item.
 */
export type ConversionSubject =
  | 'identity'
  | 'layout'
  | 'field'
  | 'body'
  | 'shell-injection'
  | 'file'
  | 'extension';

export interface ConversionItem {
  /** Machine-readable subject, e.g. `field:when_to_use`, `body`, `file:scripts/x.py`. */
  subject: string;
  kind: ConversionSubject;
  fidelity: Fidelity;
  /** Why it ended up this way, in one sentence. */
  reason: string;
  /** Capability-profile URL that substantiates the classification. */
  source?: string;
  /** 1-based line in the source skill file, when the item came from a line. */
  line?: number;
  detail?: Record<string, unknown>;
}

export interface FidelitySummary {
  preserved: number;
  adapted: number;
  renamed: number;
  degraded: number;
  dropped: number;
  /** `clean` when nothing was degraded or dropped. */
  result: 'clean' | 'degraded';
}

export function summarise(items: readonly ConversionItem[]): FidelitySummary {
  const summary: FidelitySummary = {
    preserved: 0,
    adapted: 0,
    renamed: 0,
    degraded: 0,
    dropped: 0,
    result: 'clean',
  };
  for (const item of items) summary[item.fidelity] += 1;
  summary.result = summary.degraded + summary.dropped > 0 ? 'degraded' : 'clean';
  return summary;
}

export interface ConvertedFileReport {
  /** Posix path relative to the skill directory. */
  path: string;
  bytes: number;
  /** Octal permission bits that were applied, e.g. `0755`. */
  mode: string;
  fidelity: Fidelity;
  reason?: string;
}

/** A discovery root the conversion wrote to, and which agents it serves. */
export interface RootReport {
  /** Absolute path. */
  path: string;
  /** The documented suffix, e.g. `.agents/skills`. */
  suffix: string;
  scope: 'project' | 'global';
  /** Targets served by this single copy. */
  targets: string[];
  /** What happened here. */
  action: 'write' | 'shared' | 'overlap-skipped' | 'dry-run' | 'skipped';
  /** Where the previous contents were moved, when something was replaced. */
  backup?: string;
  note?: string;
}

/**
 * A target that already reads a root written for another target.
 *
 * Reported rather than written again, because two copies of one name in two
 * roots the same agent scans is exactly the situation its duplicate rule
 * resolves — and the resolution is not the same for every agent.
 */
export interface OverlapReport {
  target: string;
  /** The root this target reads. */
  root: string;
  /** The target the root was written for. */
  writtenFor: string;
  /** The reading target's own duplicate-resolution rule, quoted from its profile. */
  precedence: string;
}

export interface TargetReport {
  target: string;
  displayName: string;
  verification: string;
  /** `directory` in every case today; kept explicit so the report states it. */
  layout: 'directory' | 'flat';
  /** Directory name the skill was written under. */
  directoryName: string;
  /** Absolute path of the skill directory that was (or would be) written. */
  destination: string;
  /** Whether the destination received the new copy. */
  written: boolean;
  /** Why nothing was written, when that is not just --dry-run. */
  skipped?: string;
  items: ConversionItem[];
  files: ConvertedFileReport[];
  /** Lint run on the converted output, not on the source. */
  lint: { findings: Diagnostic[]; summary: LintSummary } | null;
  summary: FidelitySummary;
}

export interface ConversionReport {
  tool: { name: string; version: string };
  source: {
    path: string;
    /** Where the bytes came from: a directory, a flat file, or a zip archive. */
    input: 'directory' | 'flat' | 'zip';
    agent: string;
    /** True when --from was given. */
    explicit: boolean;
    /** True when no agent could be identified from the location and one was assumed. */
    assumed: boolean;
    detection: Detection;
    identity: string;
    layout: 'directory' | 'flat';
  };
  targets: TargetReport[];
  roots: RootReport[];
  overlaps: OverlapReport[];
  /** Cross-target facts that are not a per-target fidelity item. */
  notes: string[];
  /** Where the output went, or would have gone. */
  mode: 'install' | 'out';
  dryRun: boolean;
  /**
   * The items counted once each, across every target.
   *
   * `summary` adds up one item list per target, so a five-item skill converted
   * to three targets reports "15 preserved". That arithmetic is correct and
   * reads as a lie: there are five things, not fifteen. This counts each
   * subject once, at the worst fidelity any target gave it, so the report can
   * say "5 unique items" next to "15 per-target items".
   */
  unique: UniqueFidelitySummary;
  summary: FidelitySummary;
}

/** Per-subject counts, plus how many distinct subjects there were. */
export interface UniqueFidelitySummary extends FidelitySummary {
  /** Distinct subjects across every target. */
  items: number;
}

/**
 * Fidelity, ordered from closest to the source to furthest from it.
 *
 * Used to collapse one subject seen by several targets into a single verdict:
 * if one target degraded a field, the honest summary of "what happened to this
 * field" is `degraded`, not the best case.
 */
const FIDELITY_SEVERITY: Fidelity[] = ['preserved', 'adapted', 'renamed', 'degraded', 'dropped'];

export function summariseReport(targets: readonly TargetReport[]): FidelitySummary {
  const all = targets.flatMap((target) => target.items);
  return summarise(all);
}

/**
 * Every subject once, at its worst fidelity.
 *
 * A subject is identified by its `subject` string (`field:name`, `body`,
 * `file:scripts/x.py`), which is the same string every target uses for the same
 * thing. Two targets can disagree about it — Codex may preserve a field that
 * Kimi has to drop — and the merged verdict is the worse of the two.
 */
export function summariseUnique(targets: readonly TargetReport[]): UniqueFidelitySummary {
  const worst = new Map<string, Fidelity>();
  for (const target of targets) {
    for (const item of target.items) {
      const seen = worst.get(item.subject);
      if (seen === undefined || FIDELITY_SEVERITY.indexOf(item.fidelity) > FIDELITY_SEVERITY.indexOf(seen)) {
        worst.set(item.subject, item.fidelity);
      }
    }
  }

  const merged: UniqueFidelitySummary = {
    preserved: 0,
    adapted: 0,
    renamed: 0,
    degraded: 0,
    dropped: 0,
    result: 'clean',
    items: worst.size,
  };
  for (const fidelity of worst.values()) merged[fidelity] += 1;
  merged.result = merged.degraded + merged.dropped > 0 ? 'degraded' : 'clean';
  return merged;
}

/**
 * Exit code for a conversion.
 *
 * 1 when an output would not work on its target (post-conversion lint found an
 * error), 2 when something was degraded or dropped, 0 otherwise. `--strict`
 * rejects a lossy conversion before writing.
 */
export function exitCodeForConversion(report: ConversionReport, strict: boolean): 0 | 1 | 2 {
  const broken = report.targets.some((target) => (target.lint?.summary.errors ?? 0) > 0);
  if (broken || report.targets.some((target) => target.skipped !== undefined)) return 1;
  if (report.summary.degraded + report.summary.dropped > 0) return strict ? 1 : 2;
  return 0;
}

export class ConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversionError';
  }
}
