import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SkillIR } from '../ir.js';
import type { AgentProfile } from '../profile.js';
import { planBody, type ShellPolicy } from './body.js';
import { planFields, triggeredExtensions } from './frontmatter.js';
import { summarise, type ConversionItem, type Fidelity, type FidelitySummary } from './report.js';

export interface PlannedFile {
  /** Posix path relative to the skill directory. */
  path: string;
  bytes: Buffer;
  /** Permission bits to apply, or 0 when the platform does not report them. */
  mode: number;
  fidelity: Fidelity;
  reason?: string;
}

export interface PlannedSkill {
  target: AgentProfile;
  /** The identity the target will address the skill by. */
  identity: string;
  /** Directory the skill is written under. */
  directoryName: string;
  layout: 'directory';
  files: PlannedFile[];
  items: ConversionItem[];
  summary: FidelitySummary;
  /** The identity was changed to fit a directory name. */
  renamed: boolean;
}

export interface PlanOptions {
  ir: SkillIR;
  target: AgentProfile;
  /**
   * The profile the skill was written for. Extension triggers are phrased from
   * the owning agent's point of view, so this is what says which extensions the
   * skill is using. Null when the source agent could not be identified.
   */
  sourceProfile: AgentProfile | null;
  /** Whether the source agent's behaviour is a fact or an assumption. */
  sourceKnown: boolean;
  /** Behaviour of the source agent, when known. */
  sourceExecutes: true | false | 'unknown';
  shellPolicy: ShellPolicy;
}

/**
 * A directory name that cannot escape its parent or confuse a shell.
 *
 * Deliberately minimal: a name is part of how the skill is invoked, so changing
 * one is a change to the skill's identity and is reported, never silent.
 */
export function directoryNameFor(identity: string): { name: string; changed: boolean } {
  const cleaned = identity
    .replace(/[/\\]/g, '-')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  const name = cleaned === '' ? 'skill' : cleaned;
  return { name, changed: name !== identity };
}

function eolFor(ir: SkillIR): string {
  return ir.text.lineEnding === 'crlf' ? '\r\n' : '\n';
}

/**
 * Build the complete output for one target, in memory.
 *
 * Everything the conversion decides is decided here, so `--dry-run` can show
 * exactly what would be written without touching the filesystem.
 */
export async function planConversion(options: PlanOptions): Promise<PlannedSkill> {
  const { ir, target } = options;
  const items: ConversionItem[] = [];
  const sourceUrl = target.sources[0]?.url;

  // ---- identity and layout -------------------------------------------------
  const directory = directoryNameFor(ir.identity.name);
  if (directory.changed) {
    items.push({
      subject: 'identity:directory',
      kind: 'identity',
      fidelity: 'adapted',
      reason: `"${ir.identity.name}" cannot be used as a directory name, so the skill is written under "${directory.name}"`,
      ...(sourceUrl === undefined ? {} : { source: sourceUrl }),
      detail: { from: ir.identity.name, to: directory.name },
    });
  }

  if (ir.origin.layout === 'flat') {
    items.push({
      subject: 'layout',
      kind: 'layout',
      fidelity: 'adapted',
      reason: 'the flat .md file was wrapped in a directory as SKILL.md, which every surveyed agent reads',
      ...(sourceUrl === undefined ? {} : { source: sourceUrl }),
      detail: { from: 'flat', to: 'directory' },
    });
  } else {
    items.push({
      subject: 'layout',
      kind: 'layout',
      fidelity: 'preserved',
      reason: 'directory layout kept',
      ...(sourceUrl === undefined ? {} : { source: sourceUrl }),
    });
  }

  // ---- extensions the source used that this target lacks -------------------
  const triggered = options.sourceProfile === null ? [] : triggeredExtensions(options.sourceProfile, ir);
  const extensionFields = new Set<string>();
  for (const extension of triggered) {
    extensionFields.add(extension.field);
    const shared = (target.extensions ?? []).some((candidate) => candidate.id === extension.id);
    if (shared) {
      items.push({
        subject: `extension:${extension.id}`,
        kind: 'extension',
        fidelity: 'preserved',
        reason: `${target.id} has the same extension, so it keeps working`,
        ...(extension.source === undefined ? {} : { source: extension.source }),
      });
      continue;
    }
    const fidelity: Fidelity =
      extension.fidelityImpact === 'preserved' || extension.fidelityImpact === 'adapted'
        ? 'adapted'
        : extension.fidelityImpact === 'dropped'
          ? 'dropped'
          : 'degraded';
    items.push({
      subject: `extension:${extension.id}`,
      kind: 'extension',
      fidelity,
      reason: `${target.id} has no equivalent for this extension: ${extension.description}`,
      ...(extension.source === undefined ? {} : { source: extension.source }),
      detail: { field: extension.field, value: extension.value },
    });
  }

  // ---- frontmatter ---------------------------------------------------------
  const fields = planFields({ ir, target, identityName: directory.name, extensionFields });
  items.push(...fields.items);

  // ---- body ----------------------------------------------------------------
  const body = planBody({
    ir,
    target,
    sourceExecutes: options.sourceExecutes,
    sourceKnown: options.sourceKnown,
    policy: options.shellPolicy,
    eol: eolFor(ir),
  });
  items.push(...body.items);

  // ---- assemble SKILL.md ---------------------------------------------------
  const eol = eolFor(ir);
  const frontmatter = ['---', ...fields.lines, '---'].join(eol) + eol;
  const text = `${ir.text.hasBom ? '\uFEFF' : ''}${frontmatter}${body.body}`;
  const skillFile: PlannedFile = {
    path: 'SKILL.md',
    bytes: Buffer.from(text, 'utf8'),
    mode: 0o644,
    fidelity: 'preserved',
    reason: 'frontmatter rebuilt from the IR, body appended unchanged',
  };

  // ---- bundled files -------------------------------------------------------
  const files: PlannedFile[] = [skillFile];
  for (const bundled of ir.files) {
    const absolute = join(ir.origin.root, bundled.path);
    const bytes = await readFile(absolute);
    const executable = (bundled.mode & 0o111) !== 0;
    const canCarryMode = process.platform !== 'win32';
    const fidelity: Fidelity = executable && !canCarryMode ? 'degraded' : 'preserved';
    files.push({
      path: bundled.path,
      bytes,
      mode: bundled.mode,
      fidelity,
      ...(fidelity === 'degraded'
        ? { reason: 'copied byte-for-byte, but this platform cannot carry the executable bit' }
        : { reason: 'copied byte-for-byte' }),
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
      detail: { bytes: bundled.size, mode: bundled.mode.toString(8).padStart(4, '0') },
    });
  }

  if (ir.files.length === 0 && ir.origin.layout === 'directory') {
    items.push({
      subject: 'file:*',
      kind: 'file',
      fidelity: 'preserved',
      reason: 'the skill bundles no files of its own',
      ...(sourceUrl === undefined ? {} : { source: sourceUrl }),
    });
  }

  return {
    target,
    identity: directory.name,
    directoryName: directory.name,
    layout: 'directory',
    files,
    items,
    summary: summarise(items),
    renamed: directory.changed,
  };
}
