import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { extractZip, isZipPath } from '../archive.js';
import { lintSkill } from '../lint.js';
import { resolveLimits, type ToolLimits } from '../limits.js';
import { AmbiguousSourceError, parseSkill } from '../parse.js';
import { loadProfiles, ProfileError, type AgentProfile } from '../profile.js';
import { planConversion, type PlannedSkill } from './plan.js';
import { planSharedConversion } from './lcd.js';
import {
  ConversionError,
  summariseReport,
  type ConversionReport,
  type ConversionItem,
  type OverlapReport,
  type RootReport,
  type TargetReport,
} from './report.js';
import { assignRoots, defaultRootContext, rootsFor, type Scope } from './roots.js';
import { writeSkill, writeSkillToOutput, type WriteSkillResult } from '../install.js';
import type { ShellPolicy } from './body.js';

export interface ConvertOptions {
  path: string;
  /** Target agent ids. */
  to: string[];
  from?: string;
  /** Output directory. Mutually exclusive with `install`. */
  out?: string;
  /** Write into the target agents' own discovery roots. */
  install?: boolean;
  scope?: Scope;
  dryRun?: boolean;
  strict?: boolean;
  force?: boolean;
  shellPolicy?: ShellPolicy;
  limits?: Partial<ToolLimits>;
  /** Where project roots resolve from. Defaults to the working directory. */
  projectRoot?: string;
  /** Home directory override, for tests. */
  home?: string;
  /**
   * Where to stage a converted output so lint can read it back.
   *
   * Defaults to the OS temporary directory. Set it when that directory is
   * missing, read-only, or untrusted — a container with a locked-down `/tmp`, for
   * instance. The staged copy is only ever read and then removed.
   */
  stagingRoot?: string;
  now?: Date;
  confirm?: (destination: string) => Promise<boolean>;
}

const TOOL = { name: 'skillporter', version: '0.0.0' } as const;

function planFiles(plan: PlannedSkill) {
  return plan.files.map((file) => ({ path: file.path, bytes: file.bytes, mode: file.mode }));
}

/**
 * Lint a converted output.
 *
 * The bytes are staged in a temporary directory first, so lint sees exactly what
 * would be written rather than what the planner believes it wrote. The staged
 * copy is not inside a discovery root, so location-dependent rules (depth,
 * duplicate names) stay silent here; they are evaluated by `lint` at the real
 * destination.
 *
 * The staging root is created if it is missing: it is a caller-supplied
 * location, and failing with ENOENT would blame the wrong thing.
 */
async function lintOutput(
  plan: PlannedSkill,
  targetId: string,
  stagingRoot: string,
): Promise<NonNullable<TargetReport['lint']>> {
  await mkdir(stagingRoot, { recursive: true });
  const staging = await mkdtemp(join(stagingRoot, 'skillporter-out-'));
  try {
    const skillDir = join(staging, plan.directoryName);
    for (const file of plan.files) {
      const path = join(skillDir, ...file.path.split('/'));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.bytes);
    }
    const result = await lintSkill({ path: skillDir, for: targetId, from: targetId });
    return { findings: result.findings, summary: result.summary };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Lint a converted output where it was actually installed.
 *
 * The staged copy answers questions about the file's content. It cannot answer
 * questions about the file's *place*: how deep it sits below the root, whether
 * another skill already claims the same name, whether the root is a symlink.
 * Those are exactly the failures an install can introduce, so after writing they
 * are evaluated against the real destination.
 *
 * A failure here is reported as a note rather than thrown: the skill is already
 * on disk, and turning a post-write check into an exception would leave the
 * caller with a written skill and an error.
 */
async function lintInstalled(
  destination: string,
  targetId: string,
): Promise<{ lint: NonNullable<TargetReport['lint']> | null; note?: string }> {
  try {
    const result = await lintSkill({ path: destination, for: targetId, from: targetId });
    return { lint: { findings: result.findings, summary: result.summary } };
  } catch (error) {
    return {
      lint: null,
      note: `could not lint ${destination} after installing it, so only the staged copy was checked: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function findingKey(finding: { ruleId?: string; line?: number; message: string }): string {
  return `${finding.ruleId ?? ''}|${finding.line ?? ''}|${finding.message}`;
}

/** Union of two lint runs, counting each distinct finding once. */
function mergeLint(
  staged: NonNullable<TargetReport['lint']>,
  installed: NonNullable<TargetReport['lint']> | null,
): NonNullable<TargetReport['lint']> {
  if (installed === null) return staged;
  const seen = new Set(staged.findings.map(findingKey));
  const findings = [...staged.findings, ...installed.findings.filter((finding) => !seen.has(findingKey(finding)))];
  const errors = findings.filter((finding) => finding.severity === 'error').length;
  const warnings = findings.filter((finding) => finding.severity === 'warning').length;
  const info = findings.filter((finding) => finding.severity === 'info').length;
  return {
    findings,
    summary: {
      errors,
      warnings,
      info,
      suppressed: staged.summary.suppressed + installed.summary.suppressed,
      result: errors > 0 ? 'error' : warnings > 0 ? 'warning' : 'clean',
    },
  };
}

function bytesEqual(left: readonly { path: string; bytes: Buffer }[], right: readonly { path: string; bytes: Buffer }[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort((a, b) => a.path.localeCompare(b.path));
  const sortedRight = [...right].sort((a, b) => a.path.localeCompare(b.path));
  return sortedLeft.every((file, index) => {
    const other = sortedRight[index];
    return other !== undefined && other.path === file.path && other.bytes.equals(file.bytes);
  });
}

/**
 * Convert a skill to one or more agents.
 *
 * Read-only in spirit even when it writes: the source is never modified, nothing
 * in the skill is executed, and every decision is recorded in the report.
 */
export async function convertSkill(options: ConvertOptions): Promise<ConversionReport> {
  if (options.install === true && options.out !== undefined) {
    throw new ConversionError('--out and --install write to different places; pass one of them');
  }
  if (options.install !== true && options.out === undefined && options.dryRun !== true) {
    throw new ConversionError('pass --out <dir> to write a copy, --install to install it, or --dry-run to only look');
  }

  const profiles = await loadProfiles();
  const targets: AgentProfile[] = [];
  for (const id of options.to) {
    const profile = profiles.find((candidate) => candidate.id === id);
    if (profile === undefined) {
      throw new ProfileError(`unknown agent "${id}". Known agents: ${profiles.map((candidate) => candidate.id).join(', ')}`);
    }
    if (!targets.some((candidate) => candidate.id === profile.id)) targets.push(profile);
  }
  if (targets.length === 0) throw new ConversionError('no target agents given');

  const limits = resolveLimits(options.limits);
  const zip = isZipPath(options.path);
  const extracted = zip ? await extractZip(resolve(options.path), limits) : null;

  try {
    const sourcePath = extracted === null ? options.path : extracted.root;
    const requestedFrom = options.from === 'auto' ? undefined : options.from;

    let parsed;
    try {
      parsed = await parseSkill({
        path: sourcePath,
        ...(requestedFrom === undefined ? {} : { from: requestedFrom }),
        limits: options.limits ?? {},
      });
    } catch (error) {
      // A conversion has to read the file even when nobody owns the directory.
      // The source is then an assumption, and everything that depends on it says
      // so instead of pretending to know.
      if (!(error instanceof AmbiguousSourceError)) throw error;
      const fallback = error.detection.candidates[0] ?? profiles[0]?.id;
      if (fallback === undefined) throw error;
      parsed = await parseSkill({ path: sourcePath, from: fallback, limits: options.limits ?? {} });
    }

    const { ir, detection } = parsed;

    const fatal = ir.diagnostics.find((item) => item.code === 'FRONTMATTER_INVALID');
    if (fatal !== undefined) {
      throw new ConversionError(`the frontmatter is not valid YAML, so there is nothing to convert: ${fatal.message}`);
    }

    const sourceKnown = requestedFrom !== undefined || detection.agent !== null;
    const sourceProfile = profiles.find((profile) => profile.id === ir.origin.agent) ?? null;
    const sourceExecutes: true | false | 'unknown' = sourceKnown
      ? (sourceProfile?.bodyExecution.shellInjection.executed ?? 'unknown')
      : 'unknown';
    const policy: ShellPolicy = options.shellPolicy ?? 'neutralize';

  const context = defaultRootContext(options.projectRoot ?? process.cwd());
  if (options.home !== undefined) context.home = options.home;
  const scope: Scope = options.scope ?? 'project';
  const stagingRoot = options.stagingRoot ?? tmpdir();

    const targetReports: TargetReport[] = [];
    const roots: RootReport[] = [];
    const overlaps: OverlapReport[] = [];
    const notes: string[] = [];

    const planFor = async (target: AgentProfile): Promise<PlannedSkill> =>
      planConversion({
        ir,
        target,
        sourceProfile,
        sourceKnown,
        sourceExecutes,
        shellPolicy: policy,
      });

    if (options.install === true) {
      // An archive target has no discovery root: there is nothing to install
      // into, and writing a directory somewhere the agent never looks would be
      // worse than saying so.
      const archive = targets.find((target) => (target.delivery ?? 'directory') === 'archive');
      if (archive !== undefined) {
        throw new ConversionError(
          `${archive.id} takes an uploaded bundle and has no skill directory to install into. ` +
            'Use --out to write the folder to upload.',
        );
      }

      const { assignments, ungrouped } = assignRoots(targets, scope, context);
      if (ungrouped.length > 0) {
        throw new ConversionError(
          `cannot resolve a ${scope} skill directory for ${ungrouped.join(', ')} without guessing. Use --out instead.`,
        );
      }

      for (const assignment of assignments) {
        const group = assignment.targets
          .map((id) => targets.find((target) => target.id === id))
          .filter((target): target is AgentProfile => target !== undefined);
        if (group.length === 0) continue;

        // One copy is written, but every target keeps its own account of what
        // the conversion means for it: two agents can receive identical bytes
        // and still lose different things.
        const plans = new Map<string, PlannedSkill>();
        let writtenPlan: PlannedSkill;

        if (group.length === 1) {
          const only = group[0];
          if (only === undefined) continue;
          writtenPlan = await planFor(only);
          plans.set(only.id, writtenPlan);
        } else {
          const individual = await Promise.all(group.map((target) => planFor(target)));
          const first = individual[0];
          const identical = first !== undefined && individual.every((candidate) => bytesEqual(candidate.files, first.files));

          if (identical && first !== undefined) {
            for (const plan of individual) plans.set(plan.target.id, plan);
            writtenPlan = first;
            notes.push(
              `${group.map((target) => target.id).join(', ')} produced byte-identical output, so it was written once to ${assignment.root.path}`,
            );
          } else {
            const shared = await planSharedConversion({
              ir,
              targets: group,
              sourceProfile,
              sourceKnown,
              sourceExecutes,
              policy,
            });
            for (const target of group) plans.set(target.id, shared);
            writtenPlan = shared;
            notes.push(
              `${group.map((target) => target.id).join(', ')} share ${assignment.root.path} but would produce different files, so a least-common-denominator copy was written. Pass --strict to make that a failure.`,
            );
          }
        }

        const destination = join(assignment.root.path, writtenPlan.directoryName);

        let written = false;
        let writeResult: WriteSkillResult | null = null;
        if (options.dryRun !== true) {
          writeResult = await writeSkill({
            root: assignment.root.path,
            directoryName: writtenPlan.directoryName,
            files: planFiles(writtenPlan),
            force: options.force === true,
            ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
            ...(options.now === undefined ? {} : { now: options.now }),
          });
          written = true;
        }

        roots.push({
          path: assignment.root.path,
          suffix: assignment.root.suffix,
          scope,
          targets: assignment.targets,
          action: options.dryRun === true ? 'dry-run' : group.length > 1 ? 'shared' : 'write',
          ...(writeResult?.backup === undefined ? {} : { backup: writeResult.backup }),
          ...(group.length > 1
            ? { note: 'one real copy serves every target listed; no symlinks are created' }
            : {}),
        });

        for (const target of group) {
          const plan = plans.get(target.id) ?? writtenPlan;
          const staged = await lintOutput(plan, target.id, stagingRoot);

          // Only a real install has a destination to check. --dry-run must not
          // read a directory that does not exist, and must not pretend it did.
          const installed: { lint: NonNullable<TargetReport['lint']> | null; note?: string } =
            options.dryRun === true ? { lint: null } : await lintInstalled(destination, target.id);
          if (installed.note !== undefined) notes.push(installed.note);

          const lint = mergeLint(staged, installed.lint);
          const items: ConversionItem[] =
            group.length === 1
              ? plan.items
              : plan.items.map((item) => ({
                  ...item,
                  detail: { ...item.detail, sharedWith: group.map((candidate) => candidate.id) },
                }));
          targetReports.push({
            target: target.id,
            displayName: target.displayName,
            verification: target.verification,
            layout: plan.layout,
            directoryName: plan.directoryName,
            destination,
            written,
            items,
            files: plan.files.map((file) => ({
              path: file.path,
              bytes: file.bytes.byteLength,
              mode: file.mode.toString(8).padStart(4, '0'),
              fidelity: file.fidelity,
              ...(file.reason === undefined ? {} : { reason: file.reason }),
            })),
            lint,
            summary: plan.summary,
          });
        }
      }

      // A root written for one target may also be read by another. That is
      // reported rather than duplicated, because two copies of one name is
      // exactly what a duplicate-resolution rule exists to arbitrate.
      for (const target of targets) {
        const readable = new Set(rootsFor(target, scope, context).map((root) => root.path));
        for (const root of roots) {
          if (root.targets.includes(target.id)) continue;
          if (!readable.has(root.path)) continue;
          const owner = root.targets[0] ?? 'another target';
          overlaps.push({
            target: target.id,
            root: root.path,
            writtenFor: owner,
            precedence:
              target.discovery.duplicateResolution ??
              `${target.id} does not document which of two skills with the same name wins`,
          });
        }
      }
    } else {
      const outRoot = resolve(options.out ?? process.cwd());
      const multi = targets.length > 1;

      for (const target of targets) {
        const plan = await planFor(target);
        const outDir = multi ? join(outRoot, target.id) : outRoot;
        const destination = join(outDir, plan.directoryName);

        let written = false;
        let writeResult: WriteSkillResult | null = null;
        if (options.dryRun !== true) {
          writeResult = await writeSkillToOutput(outDir, plan.directoryName, planFiles(plan), {
            force: options.force === true,
            ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
            ...(options.now === undefined ? {} : { now: options.now }),
          });
          written = true;
        }

        roots.push({
          path: outDir,
          suffix: outDir.split(/[/\\]/).slice(-2).join('/'),
          scope,
          targets: [target.id],
          action: options.dryRun === true ? 'dry-run' : 'write',
          ...(writeResult?.backup === undefined ? {} : { backup: writeResult.backup }),
        });

        targetReports.push({
          target: target.id,
          displayName: target.displayName,
          verification: target.verification,
          layout: plan.layout,
          directoryName: plan.directoryName,
          destination,
          written,
          items: plan.items,
          files: plan.files.map((file) => ({
            path: file.path,
            bytes: file.bytes.byteLength,
            mode: file.mode.toString(8).padStart(4, '0'),
            fidelity: file.fidelity,
            ...(file.reason === undefined ? {} : { reason: file.reason }),
          })),
          lint: await lintOutput(plan, target.id, stagingRoot),
          summary: plan.summary,
        });
      }
    }

    if (options.dryRun === true) {
      notes.push('--dry-run: nothing was written. The report describes what would be.');
    }
    for (const target of targets) {
      if ((target.delivery ?? 'directory') === 'archive') {
        notes.push(
          `${target.id} takes an uploaded bundle rather than a directory it scans: the folder written here is what you zip and upload, and there is no install step.`,
        );
      }
    }
    if (options.install === true && options.dryRun !== true) {
      notes.push(
        'post-conversion lint ran on a staged copy and again at the installed destination, so rules that depend on where the skill sits (depth, duplicate names, a symlinked root) are included',
      );
    } else if (options.install === true) {
      notes.push(
        'post-conversion lint ran on a staged copy only: --dry-run installs nothing, so rules that depend on the destination location could not be checked',
      );
    } else {
      notes.push(
        'post-conversion lint ran on a staged copy of each output; --out is not a discovery root, so rules that depend on the destination location are not part of it',
      );
    }
    if (!sourceKnown) {
      notes.push(
        `no agent owns this location, so ${ir.origin.agent} was assumed only to read the file. Everything that compares the source with the target uses warning severity and says the source is unknown; pass --from to remove the assumption.`,
      );
    }
    if (ir.text.lineEnding === 'mixed') {
      notes.push('the source mixes LF and CRLF; the body keeps its bytes, and generated frontmatter lines use LF');
    }

    return {
      tool: TOOL,
      source: {
        path: resolve(options.path),
        input: zip ? 'zip' : ir.origin.layout === 'flat' ? 'flat' : 'directory',
        agent: ir.origin.agent,
        explicit: requestedFrom !== undefined,
        assumed: !sourceKnown,
        detection,
        identity: ir.identity.name,
        layout: ir.origin.layout,
      },
      targets: targetReports,
      roots,
      overlaps,
      notes,
      mode: options.install === true ? 'install' : 'out',
      dryRun: options.dryRun === true,
      summary: summariseReport(targetReports),
    };
  } finally {
    if (extracted !== null) await extracted.cleanup();
  }
}
