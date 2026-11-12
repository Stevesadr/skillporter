import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { diagnostic, type Diagnostic, type DiagnosticCode, type Severity } from './diagnostics.js';
import { detectSource, type Detection } from './detect.js';
import { parseFrontmatterFields, splitFrontmatter, stringField } from './frontmatter.js';
import type { SkillIR } from './ir.js';
import type { ToolLimits } from './limits.js';
import { deriveIdentity, parseSkill, SkillParseError } from './parse.js';
import { toPosix } from './paths.js';
import { loadProfiles, ProfileError, type AgentProfile } from './profile.js';
import { enforcementConsequence, ruleById, severityForEnforcement, type RuleArea } from './rules.js';

export interface LintOptions {
  path: string;
  /** Target agent. Every rule is derived from this agent's capability profile. */
  for: string;
  /** Source agent. Optional: inferred from the path, and the inference is reported. */
  from?: string;
  /** Suppress UNKNOWN_CAPABILITY findings. */
  ignoreUnknown?: boolean;
  limits?: Partial<ToolLimits>;
}

export interface LintSummary {
  errors: number;
  warnings: number;
  info: number;
  /** Findings dropped by --ignore-unknown. */
  suppressed: number;
  result: 'clean' | 'warning' | 'error';
}

export interface LintResult {
  skill: {
    path: string;
    root: string;
    layout: 'directory' | 'flat';
    /** The identity the *target* would address the skill by. */
    identity: string;
    identitySource: string;
  };
  target: { id: string; displayName: string; verification: string };
  source: {
    agent: string;
    /** True when --from was given. */
    explicit: boolean;
    /** True when the location is shared by several agents and one had to be assumed. */
    assumed: boolean;
    detection: Detection;
  };
  findings: Diagnostic[];
  summary: LintSummary;
}

/**
 * Parse diagnostics that describe the skill itself rather than the source
 * agent's opinion of it. Everything else parseSkill emits is source-relative
 * and has no place in a report about a target.
 */
const STRUCTURAL_CODES: ReadonlySet<DiagnosticCode> = new Set<DiagnosticCode>([
  'SYMLINK_OUTSIDE_ROOT',
  'SYMLINK_BROKEN',
  'LIMIT_EXCEEDED',
  'FILE_ANOMALY',
]);

/** Diagnostic code to the rule that owns it, for pass-through tool findings. */
const STRUCTURAL_RULE: Record<string, string> = {
  SYMLINK_OUTSIDE_ROOT: 'SP018',
  SYMLINK_BROKEN: 'SP019',
  LIMIT_EXCEEDED: 'SP023',
  FILE_ANOMALY: 'SP022',
};

/** How many siblings to inspect when looking for a name collision. */
const DUPLICATE_SCAN_LIMIT = 200;

type Emitter = (
  list: Diagnostic[],
  ruleId: string,
  severity: Severity,
  message: string,
  extra?: Omit<Diagnostic, 'code' | 'severity' | 'message' | 'ruleId'> & { code?: DiagnosticCode },
) => void;

function stringValue(ir: SkillIR, key: string): string | undefined {
  const field = ir.frontmatter.fields.find((candidate) => candidate.key === key);
  return typeof field?.value === 'string' ? field.value : undefined;
}

/**
 * The URL that substantiates a rule's area for this profile. Uses the
 * declarative `covers` list, falls back to the shell-injection source, then to
 * the profile's first source, so every finding can cite something.
 */
function sourceFor(profile: AgentProfile, area: RuleArea): string | undefined {
  const covering = profile.sources.find((source) => source.covers?.includes(area));
  if (covering) return covering.url;
  if (area === 'bodyExecution') {
    const explicit = profile.bodyExecution.shellInjection.source;
    if (explicit) return explicit;
  }
  return profile.sources[0]?.url;
}

/**
 * Build a finding emitter bound to one target profile. It fills `fix` from the
 * rule catalogue and `source` from the profile, so a rule can never be reported
 * without both.
 */
function emitterFor(target: AgentProfile): Emitter {
  return (list, ruleId, severity, message, extra = {}) => {
    const rule = ruleById(ruleId);
    if (rule === undefined) throw new Error(`internal: no lint rule ${ruleId}`);

    const { code, ...rest } = extra;
    const item = diagnostic(code ?? rule.code, severity, message, rest);
    item.ruleId = ruleId;
    item.fix ??= rule.fix;
    item.source ??= sourceFor(target, rule.area);
    list.push(item);
  };
}

/**
 * Depth of the skill directory below the matched discovery root.
 * The skill directory itself counts as level 1.
 */
function depthBelowRoot(root: string, matchedRoot: string | null): number | null {
  if (matchedRoot === null) return null;
  const posix = toPosix(root);
  const marker = `/${matchedRoot}`;
  const index = posix.lastIndexOf(marker);
  if (index === -1) return null;
  const rest = posix.slice(index + marker.length);
  return rest.split('/').filter((segment) => segment.length > 0).length;
}

/**
 * Siblings in the same root that resolve to the same name.
 *
 * Only the same root is compared, because that is the only collision an agent
 * resolves. Reads are bounded and failures are ignored: a sibling that cannot
 * be read is not a finding about this skill.
 */
async function findDuplicates(parent: string, selfPath: string, name: string): Promise<string[]> {
  if (parent === dirname(parent)) return [];

  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch {
    return [];
  }

  const hits: string[] = [];

  for (const entry of entries.slice(0, DUPLICATE_SCAN_LIMIT)) {
    // Never count the skill itself. `selfPath` is the directory for a directory
    // skill and the file for a flat one, so compare against the entry path.
    if (resolve(join(parent, entry.name)) === selfPath) continue;

    let candidatePath: string | null = null;
    let fallback = '';

    if (entry.isDirectory()) {
      candidatePath = join(parent, entry.name, 'SKILL.md');
      fallback = entry.name;
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      candidatePath = join(parent, entry.name);
      fallback = entry.name.replace(/\.md$/i, '');
    }
    if (candidatePath === null) continue;

    const text = await readFile(candidatePath, 'utf8').catch(() => null);
    if (text === null) continue;

    const split = splitFrontmatter(text);
    const fields = split.present ? parseFrontmatterFields(split.yaml).fields : [];
    const candidate = stringField(fields, 'name') ?? fallback;
    if (candidate === name) hits.push(entry.name);
  }

  return hits;
}

/**
 * Paths that differ only by case, in the order they were seen.
 *
 * Pure, so it can be tested on a case-insensitive filesystem that cannot hold
 * both files at once. `SKILL.md` is included by the caller so a stray
 * `skill.md` beside it is caught too.
 */
export function caseCollisions(paths: readonly string[]): [string, string][] {
  const seen = new Map<string, string>();
  const collisions: [string, string][] = [];

  for (const path of paths) {
    const folded = path.toLowerCase();
    const previous = seen.get(folded);
    if (previous !== undefined && previous !== path) {
      collisions.push([previous, path]);
    } else if (previous === undefined) {
      seen.set(folded, path);
    }
  }

  return collisions;
}

/**
 * Lint a skill for one target agent.
 *
 * Read-only. Nothing in the skill is executed, and no file is written. Every
 * rule reads the target capability profile; no agent is named in this file.
 */
export async function lintSkill(options: LintOptions): Promise<LintResult> {
  const profiles = await loadProfiles();
  const target = profiles.find((profile) => profile.id === options.for);
  if (target === undefined) {
    throw new ProfileError(
      `unknown agent "${options.for}". Known agents: ${profiles.map((profile) => profile.id).join(', ')}`,
    );
  }

  const absolute = resolve(options.path);
  const info = await stat(absolute).catch(() => null);
  if (info === null) throw new SkillParseError(`no such file or directory: ${options.path}`);

  const layout: 'directory' | 'flat' = info.isDirectory() ? 'directory' : 'flat';
  const root = layout === 'directory' ? absolute : dirname(absolute);

  const detection = detectSource(root, profiles);
  const inferred = options.from ?? detection.agent ?? undefined;

  // Never refuse on ambiguity: pick a source so the file can be parsed, and say
  // so. Source-relative diagnostics are filtered out below, so the choice can
  // only affect display, never the target rules.
  const sourceAgentId = inferred ?? detection.candidates[0] ?? profiles[0]?.id;
  if (sourceAgentId === undefined) throw new ProfileError('no capability profiles are installed');
  const assumed = inferred === undefined;

  const { ir } = await parseSkill({
    path: options.path,
    from: sourceAgentId,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });

  const source = profiles.find((profile) => profile.id === sourceAgentId) ?? null;
  const file = layout === 'directory' ? 'SKILL.md' : basename(absolute);
  const frontmatterName = stringValue(ir, 'name');
  const directoryName = basename(root);
  const fileName = basename(absolute).replace(/\.md$/i, '');
  const identity = deriveIdentity(target, { layout, frontmatterName, directoryName, fileName });

  const findings: Diagnostic[] = [];
  const emit = emitterFor(target);

  // ---- SP024: frontmatter present and parseable -----------------------------
  const invalid = ir.diagnostics.find((item) => item.code === 'FRONTMATTER_INVALID');
  if (invalid !== undefined) {
    emit(findings, 'SP024', 'error', invalid.message, {
      file,
      hint: invalid.hint,
    });
  } else if (!ir.frontmatter.present) {
    const needsIdentity =
      target.identity.source !== 'path' &&
      (layout === 'directory' ? target.identity.requiredInDirectoryForm : target.identity.requiredInFlatForm) === true;
    const needsDescription =
      (layout === 'directory' ? target.description.requiredInDirectoryForm : target.description.requiredInFlatForm) ===
      true;
    const fatal = needsIdentity || needsDescription;
    emit(
      findings,
      'SP024',
      fatal ? 'error' : 'warning',
      fatal
        ? `there is no frontmatter block, and ${target.displayName} takes its ${needsIdentity ? 'identity' : 'description'} from it`
        : 'there is no frontmatter block',
      {
        file,
        hint: fatal
          ? `Without frontmatter, ${target.id} cannot read the field it requires.`
          : `${target.displayName} can load a skill with no frontmatter, but no field can be set.`,
      },
    );
  }

  // ---- SP009: flat layout ---------------------------------------------------
  if (layout === 'flat' && !target.discovery.acceptsFlatMarkdown) {
    emit(
      findings,
      'SP009',
      'error',
      `${target.displayName} does not read a bare .md file as a skill, so "${fileName}.md" would never be discovered`,
      {
        file,
        hint: `discovery.acceptsFlatMarkdown is false in the ${target.id} profile.`,
        detail: { layout, agent: target.id },
      },
    );
  }

  // ---- SP010: discovery depth ----------------------------------------------
  const depth = depthBelowRoot(root, detection.matchedRoot);
  const maxDepth = target.discovery.skillDirDepth;
  if (depth !== null && maxDepth !== 'recursive' && depth > maxDepth) {
    emit(
      findings,
      'SP010',
      'error',
      `the skill sits ${depth} directories below ${detection.matchedRoot}, and ${target.displayName} scans only ${maxDepth}`,
      {
        hint: `Anything deeper is invisible to ${target.id}, not an error it reports.`,
        detail: { depth, maxDepth, root: detection.matchedRoot },
      },
    );
  }

  // ---- SP004: identity required --------------------------------------------
  if (frontmatterName === undefined && target.identity.source !== 'path' && identity.required === true) {
    emit(findings, 'SP004', 'error', `${target.displayName} requires "name" in a ${layout} skill, and this one has none`, {
      file,
      hint: `As written, ${target.id} would not load this skill.`,
      detail: { field: 'name', layout, agent: target.id },
    });
  }

  // ---- SP001 / SP002 / SP003: name rules ------------------------------------
  const pattern = target.name.pattern;
  if (pattern !== null) {
    let matcher: RegExp | null = null;
    try {
      matcher = new RegExp(pattern);
    } catch {
      matcher = null;
    }
    if (matcher !== null && !matcher.test(identity.name)) {
      emit(
        findings,
        'SP001',
        severityForEnforcement(target.name.enforcement),
        `"${identity.name}" does not match ${target.displayName}'s name grammar ${pattern}`,
        {
          file,
          line: ir.frontmatter.fields.find((field) => field.key === 'name')?.line,
          hint: enforcementConsequence(target.name.enforcement, target.id),
          detail: { name: identity.name, pattern, enforcement: target.name.enforcement },
        },
      );
    }
  }

  const maxNameLength = target.name.maxLength;
  if (maxNameLength !== null && identity.name.length > maxNameLength) {
    emit(
      findings,
      'SP002',
      severityForEnforcement(target.name.enforcement),
      `"${identity.name}" is ${identity.name.length} characters and ${target.displayName} allows ${maxNameLength}`,
      {
        file,
        hint: enforcementConsequence(target.name.enforcement, target.id),
        detail: { length: identity.name.length, maxLength: maxNameLength },
      },
    );
  }

  if (target.name.mustMatchDirectory === true && frontmatterName !== undefined && frontmatterName !== directoryName) {
    emit(
      findings,
      'SP003',
      severityForEnforcement(target.name.enforcement),
      `frontmatter name "${frontmatterName}" does not match the directory "${directoryName}", and ${target.displayName} requires them to agree`,
      {
        file,
        line: ir.frontmatter.fields.find((field) => field.key === 'name')?.line,
        hint: enforcementConsequence(target.name.enforcement, target.id),
        detail: { frontmatterName, directoryName },
      },
    );
  }

  // ---- SP005: identity source ----------------------------------------------
  if (target.identity.source === 'path') {
    const label = frontmatterName;
    if (label !== undefined && label !== identity.name) {
      emit(
        findings,
        'SP005',
        'warning',
        `${target.displayName} addresses this skill as "${identity.name}" from the path, not "${label}" from frontmatter`,
        {
          file,
          hint: `${target.id} treats the frontmatter name as a display label, so renaming the directory renames the skill.`,
          detail: { identity: identity.name, label },
        },
      );
    } else {
      emit(findings, 'SP005', 'info', `${target.displayName} takes the identity from the path: "${identity.name}"`, {
        file,
        hint: `${target.id} does not consult frontmatter for the identifier.`,
        detail: { identity: identity.name },
      });
    }
  } else if (frontmatterName === undefined && identity.required !== true) {
    emit(
      findings,
      'SP005',
      'info',
      `no "name" in frontmatter, so ${target.displayName} falls back to the ${layout === 'directory' ? 'directory name' : 'filename'} "${identity.name}"`,
      {
        file,
        hint: `${target.id} documents this fallback, so nothing is lost.`,
        detail: { identity: identity.name, fallback: layout },
      },
    );
  }

  // ---- SP006: description required -----------------------------------------
  const descriptionRequired =
    (layout === 'directory' ? target.description.requiredInDirectoryForm : target.description.requiredInFlatForm) ===
    true;
  if (ir.description === '' && descriptionRequired) {
    emit(
      findings,
      'SP006',
      'error',
      `${target.displayName} requires "description" in a ${layout} skill, and this one has none`,
      {
        file,
        hint: `A skill without a description is invisible to model-driven selection in ${target.id}.`,
        detail: { field: 'description', layout, agent: target.id },
      },
    );
  }

  // ---- SP007: description hard limit ---------------------------------------
  const maxDescription = target.description.maxLength;
  if (maxDescription !== null && ir.description.length > maxDescription) {
    emit(
      findings,
      'SP007',
      severityForEnforcement(target.description.enforcement),
      `the description is ${ir.description.length} characters and ${target.displayName} allows ${maxDescription}`,
      {
        file,
        line: ir.frontmatter.fields.find((field) => field.key === 'description')?.line,
        hint: enforcementConsequence(target.description.enforcement, target.id),
        detail: { length: ir.description.length, maxLength: maxDescription },
      },
    );
  }

  // ---- SP008: description truncated in the catalog -------------------------
  const truncation = target.description.truncation;
  if (truncation !== undefined) {
    let total = ir.description.length;
    const parts = [`description ${ir.description.length}`];
    for (const combined of truncation.combinesWith ?? []) {
      const value = stringValue(ir, combined);
      if (value !== undefined && value !== '') {
        total += value.length;
        parts.push(`${combined} ${value.length}`);
      }
    }
    if (total > truncation.at) {
      const configurable =
        truncation.configurableBy === undefined ? '' : ` It can be raised with ${truncation.configurableBy}.`;
      emit(
        findings,
        'SP008',
        'warning',
        `${target.displayName} shows at most ${truncation.at} ${truncation.unit} of description in its catalog; this skill has ${total} (${parts.join(' + ')})`,
        {
          file,
          hint: `${truncation.note ?? 'Only the listing is shortened; the skill still loads.'}${configurable}`,
          detail: { total, at: truncation.at, unit: truncation.unit, parts },
        },
      );
    }
  }

  // ---- SP011..SP014: per-field support -------------------------------------
  for (const field of ir.frontmatter.fields) {
    const entry = target.fields[field.key];
    const alias = target.fieldAliases?.[field.key];

    if (alias !== undefined) {
      const aliased = target.fields[alias];
      emit(findings, 'SP014', 'info', `"${field.key}" is spelled "${alias}" in ${target.displayName}`, {
        file,
        line: field.line,
        hint: aliased?.note ?? `${target.id} accepts this field only under its own spelling.`,
        detail: { from: field.key, to: alias, via: 'fieldAliases', status: aliased?.status ?? 'unknown' },
      });
      continue;
    }

    if (entry === undefined) {
      emit(findings, 'SP013', 'warning', `"${field.key}" is not mentioned anywhere in the ${target.id} capability profile`, {
        file,
        line: field.line,
        hint: 'skillporter has no verified answer for this field and will not guess. The field is preserved verbatim.',
        detail: { field: field.key, reason: 'unmapped', agent: target.id },
      });
      continue;
    }

    if (typeof entry.mapsTo === 'string' && entry.mapsTo !== '') {
      emit(findings, 'SP014', 'info', `"${field.key}" is carried by "${entry.mapsTo}" in ${target.displayName}`, {
        file,
        line: field.line,
        hint: entry.note ?? 'Same meaning, different location.',
        detail: { from: field.key, to: entry.mapsTo, via: 'mapsTo' },
      });
    }

    if (entry.status === 'ignored') {
      emit(findings, 'SP011', 'warning', `${target.displayName} accepts "${field.key}" but does nothing with it`, {
        file,
        line: field.line,
        hint: entry.note ?? 'The field survives the file but has no effect on behaviour.',
        detail: { field: field.key, agent: target.id },
      });
    } else if (entry.status === 'unsupported') {
      emit(findings, 'SP012', 'warning', `${target.displayName} has no equivalent for "${field.key}"`, {
        file,
        line: field.line,
        hint: entry.note ?? 'Nothing in the target reproduces this behaviour.',
        detail: { field: field.key, agent: target.id },
      });
    } else if (entry.status === 'unknown') {
      emit(findings, 'SP013', 'warning', `whether ${target.displayName} honours "${field.key}" is not verified`, {
        file,
        line: field.line,
        hint: 'The capability profile marks this as unknown, so skillporter reports it instead of guessing.',
        detail: { field: field.key, reason: 'unverified', agent: target.id },
      });
    }
  }

  // ---- SP015: extensions matched by a declarative trigger -------------------
  for (const extension of target.extensions ?? []) {
    const trigger = extension.trigger;
    if (trigger === undefined) continue;

    const field = ir.frontmatter.fields.find((candidate) => candidate.key === trigger.field);
    if (field === undefined) continue;
    if (trigger.equals !== undefined && String(field.value) !== String(trigger.equals)) continue;

    const severity: Severity =
      extension.fidelityImpact === 'dropped' || extension.fidelityImpact === 'degraded' ? 'warning' : 'info';

    emit(
      findings,
      'SP015',
      severity,
      `this skill uses the ${target.displayName} extension "${extension.id}" (${trigger.field}: ${String(field.value)}), which no other surveyed agent has`,
      {
        file,
        line: field.line,
        hint: extension.description,
        source: extension.source,
        detail: {
          extension: extension.id,
          fidelityImpact: extension.fidelityImpact,
          trigger: { field: trigger.field, value: field.value },
        },
      },
    );
  }

  // ---- SP016 / SP017: shell syntax -----------------------------------------
  const targetExecutes = target.bodyExecution.shellInjection.executed;
  const sourceExecutes = source?.bodyExecution.shellInjection.executed;
  const occurrences = ir.shellInjection;

  if (occurrences.length > 0) {
    if (targetExecutes === true) {
      const severity: Severity = sourceExecutes === false ? 'error' : 'warning';
      for (const occurrence of occurrences) {
        const what = occurrence.kind === 'fenced-bang' ? 'this ```! block' : 'this placeholder';
        emit(
          findings,
          'SP016',
          severity,
          sourceExecutes === false
            ? `${target.displayName} executes ${what} before the body is loaded, and the source agent only displayed it`
            : `${target.displayName} executes ${what} before the body is loaded`,
          {
            file,
            line: occurrence.line,
            column: occurrence.column,
            hint:
              sourceExecutes === false
                ? 'Converting to this agent would introduce execution the skill did not have. skillporter never runs it, but the target will.'
                : 'skillporter never runs it. The behaviour is unchanged from the source agent.',
            detail: { kind: occurrence.kind, command: occurrence.command, sourceExecuted: sourceExecutes ?? 'unknown' },
          },
        );
      }
    } else if (targetExecutes === false) {
      emit(
        findings,
        'SP017',
        sourceExecutes === true ? 'warning' : 'info',
        `${target.displayName} does not execute shell syntax in the body; ${occurrences.length} occurrence(s) will appear as literal text`,
        {
          file,
          hint:
            sourceExecutes === true
              ? 'These placeholders expanded in the source agent. Here they are text the model reads, which changes the prompt.'
              : 'Neither agent executes them, so nothing changes.',
          detail: { count: occurrences.length, sourceExecuted: sourceExecutes ?? 'unknown' },
        },
      );
    } else {
      emit(
        findings,
        'SP017',
        'warning',
        `the body contains ${occurrences.length} shell occurrence(s) and whether ${target.displayName} executes them is not documented`,
        {
          file,
          hint: 'skillporter does not execute anything. Treat the content as untrusted until the target behaviour is verified.',
          code: 'UNKNOWN_CAPABILITY',
          detail: { count: occurrences.length, reason: 'execution-unknown', agent: target.id },
        },
      );
    }
  }

  // ---- SP020: the skill is reached through a symlink -----------------------
  const rootIsSymlink = await lstat(root)
    .then((entry) => entry.isSymbolicLink())
    .catch(() => false);
  if (rootIsSymlink) {
    const follows = target.discovery.followsSymlinks;
    emit(
      findings,
      'SP020',
      follows === false ? 'error' : 'warning',
      follows === false
        ? `the skill directory is a symlink and ${target.displayName} does not follow symlinks`
        : `the skill directory is a symlink and ${target.displayName} does not document symlink handling`,
      {
        hint:
          follows === null
            ? 'discovery.followsSymlinks is null in the profile, which means undocumented, not denied.'
            : `discovery.followsSymlinks is ${String(follows)} in the ${target.id} profile.`,
        detail: { followsSymlinks: follows },
      },
    );
  }

  // ---- SP021: duplicate name in the same root ------------------------------
  if (detection.matchedRoot !== null) {
    const selfPath = layout === 'directory' ? root : absolute;
    const duplicates = await findDuplicates(dirname(root), selfPath, identity.name);
    if (duplicates.length > 0) {
      const resolution = target.discovery.duplicateResolution;
      emit(findings, 'SP021', 'warning', `"${identity.name}" is also defined by ${duplicates.join(', ')} in the same root`, {
        hint:
          resolution === undefined
            ? `${target.displayName} does not document which of them wins.`
            : `${target.displayName} resolves duplicates like this: ${resolution}`,
        detail: { duplicates, name: identity.name },
      });
    }
  }

  // ---- SP022: bundled files differing only by case ------------------------
  for (const [previous, bundled] of caseCollisions([...ir.files.map((entry) => entry.path), file])) {
    emit(findings, 'SP022', 'warning', `"${previous}" and "${bundled}" differ only by case`, {
      hint: 'On a case-insensitive filesystem one of them shadows the other, so the skill behaves differently per platform.',
      detail: { paths: [previous, bundled] },
    });
  }

  // ---- SP018 / SP019 / SP023 / SP025: tool-level parse diagnostics ---------
  for (const item of ir.diagnostics) {
    if (!STRUCTURAL_CODES.has(item.code)) continue;
    const ruleId = STRUCTURAL_RULE[item.code];
    if (ruleId === undefined) continue;

    emit(findings, ruleId, item.severity, item.message, {
      file: item.file,
      line: item.line,
      column: item.column,
      hint: item.hint,
      detail: item.detail,
    });
  }

  // ---- suppression and ordering -------------------------------------------
  let suppressed = 0;
  const kept = findings.filter((item) => {
    if (options.ignoreUnknown === true && item.code === 'UNKNOWN_CAPABILITY') {
      suppressed += 1;
      return false;
    }
    return true;
  });

  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  kept.sort((left, right) => {
    const bySeverity = order[left.severity] - order[right.severity];
    if (bySeverity !== 0) return bySeverity;
    const byRule = (left.ruleId ?? '').localeCompare(right.ruleId ?? '');
    if (byRule !== 0) return byRule;
    return (left.line ?? 0) - (right.line ?? 0);
  });

  const summary: LintSummary = {
    errors: kept.filter((item) => item.severity === 'error').length,
    warnings: kept.filter((item) => item.severity === 'warning').length,
    info: kept.filter((item) => item.severity === 'info').length,
    suppressed,
    result: 'clean',
  };
  summary.result = summary.errors > 0 ? 'error' : summary.warnings > 0 ? 'warning' : 'clean';

  return {
    skill: {
      path: absolute,
      root,
      layout,
      identity: identity.name,
      identitySource: identity.source,
    },
    target: { id: target.id, displayName: target.displayName, verification: target.verification },
    source: {
      agent: sourceAgentId,
      explicit: options.from !== undefined,
      assumed,
      detection,
    },
    findings: kept,
    summary,
  };
}

/** Exit code for a lint result: 0 clean, 1 at least one error, 2 warnings only. */
export function exitCodeForSummary(summary: LintSummary): 0 | 1 | 2 {
  if (summary.errors > 0) return 1;
  if (summary.warnings > 0) return 2;
  return 0;
}
