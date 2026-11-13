import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SkillIR } from '../ir.js';
import type { AgentProfile } from '../profile.js';
import { applyShellPolicy, type ShellPolicy } from './body.js';
import { isFrontmatterKey, planFields, targetKeyFor, triggeredExtensions } from './frontmatter.js';
import { directoryNameFor, type PlannedFile, type PlannedSkill } from './plan.js';
import { summarise, type ConversionItem, type Fidelity } from './report.js';

export interface SharedPlanOptions {
  ir: SkillIR;
  /** Every target that has to be served by this one copy. */
  targets: AgentProfile[];
  sourceProfile: AgentProfile | null;
  sourceKnown: boolean;
  sourceExecutes: true | false | 'unknown';
  policy: ShellPolicy;
}

/** A field only one output can carry has to be one every target understands. */
function commonFields(ir: SkillIR, targets: readonly AgentProfile[]): Set<string> {
  const allowed = new Set<string>();

  for (const field of ir.frontmatter.fields) {
    if (field.key === 'name' || field.key === 'description') {
      allowed.add(field.key);
      continue;
    }

    const keys = targets.map((target) => targetKeyFor(target, field.key));
    const firstKey = keys[0]?.key;
    if (firstKey === undefined) continue;

    // Every target must spell it the same way; a rename one of them needs
    // cannot be expressed in a single file.
    const sameSpelling = keys.every((candidate) => candidate.key === firstKey);
    if (!sameSpelling) continue;

    const supportedEverywhere = targets.every((target) => {
      const entry = target.fields[firstKey];
      if (entry === undefined || !isFrontmatterKey(firstKey)) return false;
      return entry.status === 'supported' || entry.status === 'emulated';
    });

    if (supportedEverywhere) allowed.add(field.key);
  }

  return allowed;
}

/**
 * One output that is valid for several agents at once.
 *
 * Used only when several targets share a discovery root and their ideal outputs
 * differ. Everything that cannot be expressed for all of them is dropped and
 * reported, because a field that one agent silently ignores is worse than a
 * field the report says was removed.
 */
export async function planSharedConversion(options: SharedPlanOptions): Promise<PlannedSkill> {
  const { ir, targets } = options;
  const items: ConversionItem[] = [];
  const [first] = targets;
  if (first === undefined) throw new Error('internal: a shared conversion needs at least one target');

  const groupNote = `${targets.length} targets share one root: ${targets.map((target) => target.id).join(', ')}`;
  const sourceUrl = first.sources[0]?.url;

  const directory = directoryNameFor(ir.identity.name);
  if (directory.changed) {
    items.push({
      subject: 'identity:directory',
      kind: 'identity',
      fidelity: 'adapted',
      reason: `"${ir.identity.name}" cannot be used as a directory name, so the skill is written under "${directory.name}"`,
      ...(sourceUrl === undefined ? {} : { source: sourceUrl }),
    });
  }

  items.push({
    subject: 'layout',
    kind: 'layout',
    fidelity: ir.origin.layout === 'flat' ? 'adapted' : 'preserved',
    reason:
      ir.origin.layout === 'flat'
        ? 'the flat .md file was wrapped in a directory as SKILL.md, which every surveyed agent reads'
        : 'directory layout kept',
    ...(sourceUrl === undefined ? {} : { source: sourceUrl }),
  });

  // ---- extensions: only if every target has it -----------------------------
  const triggered = options.sourceProfile === null ? [] : triggeredExtensions(options.sourceProfile, ir);
  const extensionFields = new Set<string>();
  for (const extension of triggered) {
    extensionFields.add(extension.field);
    const everywhere = targets.every((target) =>
      (target.extensions ?? []).some((candidate) => candidate.id === extension.id),
    );
    items.push({
      subject: `extension:${extension.id}`,
      kind: 'extension',
      fidelity: everywhere ? 'preserved' : 'dropped',
      reason: everywhere
        ? `every target in this group has the same extension, so it keeps working`
        : `dropped: not every target in the group has this extension, and one file cannot carry it selectively — ${extension.description}`,
      ...(extension.source === undefined ? {} : { source: extension.source }),
      detail: { targets: targets.map((target) => target.id) },
    });
  }

  // ---- fields --------------------------------------------------------------
  const allowed = commonFields(ir, targets);
  const fieldPlan = planFields({
    ir,
    target: first,
    identityName: directory.name,
    extensionFields,
    allow: {
      keys: allowed,
      reason: (key) =>
        `dropped: one shared file must be valid for every target in the group, and "${key}" is not supported identically by all of them — ${groupNote}`,
    },
  });
  items.push(...fieldPlan.items);

  // ---- body ----------------------------------------------------------------
  const executesSomewhere = targets.some((target) => target.bodyExecution.shellInjection.executed === true);
  const executesUnknown = targets.some((target) => target.bodyExecution.shellInjection.executed === 'unknown');
  const mustTransform = executesSomewhere && options.sourceExecutes !== true;
  const body =
    mustTransform && options.policy !== 'keep' ? applyShellPolicy(ir.body, options.policy) : null;
  const bodyText = body?.body ?? ir.body;

  if (ir.shellInjection.length === 0) {
    items.push({
      subject: 'body',
      kind: 'body',
      fidelity: 'preserved',
      reason: 'copied byte-for-byte; line endings and spacing unchanged',
      ...(sourceUrl === undefined ? {} : { source: sourceUrl }),
    });
  } else {
    // `body.occurrences` are body-relative; the IR's are file lines. Same order,
    // so zip them rather than compare positions.
    const actions = body?.occurrences ?? [];
    ir.shellInjection.forEach((occurrence, index) => {
      const transformed = actions[index]?.action;
      const fidelity: Fidelity = transformed === undefined ? (executesUnknown ? 'degraded' : 'preserved') : 'adapted';
      items.push({
        subject: `shell-injection:${occurrence.kind}@${occurrence.line}`,
        kind: 'shell-injection',
        fidelity,
        reason:
          transformed === undefined
            ? executesSomewhere
              ? 'kept unchanged: every target in the group would execute it, as the source did'
              : `kept as text: no target in the group executes shell syntax${executesUnknown ? ', and one target does not document its behaviour' : ''}`
            : `rewritten as plain text so no target in the group executes it: ${groupNote}`,
        line: occurrence.line,
        ...(sourceUrl === undefined ? {} : { source: sourceUrl }),
      });
    });
    items.push({
      subject: 'body',
      kind: 'body',
      fidelity: body === null ? 'preserved' : 'adapted',
      reason:
        body === null
          ? 'copied byte-for-byte; line endings and spacing unchanged'
          : `${body.occurrences.length} shell occurrence(s) rewritten for the shared output; everything else byte-exact`,
      ...(sourceUrl === undefined ? {} : { source: sourceUrl }),
    });
  }

  // ---- assemble ------------------------------------------------------------
  const eol = ir.text.lineEnding === 'crlf' ? '\r\n' : '\n';
  const frontmatter = ['---', ...fieldPlan.lines, '---'].join(eol) + eol;
  const files: PlannedFile[] = [
    {
      path: 'SKILL.md',
      bytes: Buffer.from(`${ir.text.hasBom ? '\uFEFF' : ''}${frontmatter}${bodyText}`, 'utf8'),
      mode: 0o644,
      fidelity: 'preserved',
      reason: 'one copy serving every target in the group',
    },
  ];

  for (const bundled of ir.files) {
    const bytes = await readFile(join(ir.origin.root, bundled.path));
    const executable = (bundled.mode & 0o111) !== 0;
    const canCarryMode = process.platform !== 'win32';
    const fidelity: Fidelity = executable && !canCarryMode ? 'degraded' : 'preserved';
    files.push({
      path: bundled.path,
      bytes,
      mode: bundled.mode,
      fidelity,
      reason: fidelity === 'degraded' ? 'copied byte-for-byte, but this platform cannot carry the executable bit' : 'copied byte-for-byte',
    });
    items.push({
      subject: `file:${bundled.path}`,
      kind: 'file',
      fidelity,
      reason:
        fidelity === 'degraded'
          ? 'copied byte-for-byte; the executable bit cannot be represented on this platform'
          : `copied byte-for-byte${executable ? ' with the executable bit' : ''}`,
      ...(sourceUrl === undefined ? {} : { source: sourceUrl }),
    });
  }

  return {
    target: first,
    identity: directory.name,
    directoryName: directory.name,
    layout: 'directory',
    files,
    items,
    summary: summarise(items),
    renamed: directory.changed,
  };
}
