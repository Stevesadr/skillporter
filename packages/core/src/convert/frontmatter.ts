import { stringify as stringifyYaml } from 'yaml';
import type { Diagnostic } from '../diagnostics.js';
import type { IRFrontmatterField, SkillIR } from '../ir.js';
import type { AgentProfile, ProfileField } from '../profile.js';
import type { ConversionItem, Fidelity } from './report.js';

/**
 * Fields whose key contains a dot are not frontmatter keys: Codex records its
 * `agents/openai.yaml` sidecar that way. They take part in `agents` output and in
 * the capability report, but a skill's frontmatter can never set them.
 */
export function isFrontmatterKey(key: string): boolean {
  return !key.includes('.');
}

export interface TargetKey {
  key: string;
  /** How the target spells the field. */
  via: 'same' | 'alias' | 'mapsTo' | 'none';
}

/**
 * Work out what the target calls this field.
 *
 * Alias first: an alias is an explicit statement that this target accepts the
 * field only under another spelling. Then `mapsTo`, which is how a profile
 * records that one of its own fields carries the meaning.
 */
export function targetKeyFor(target: AgentProfile, sourceKey: string): TargetKey {
  const alias = target.fieldAliases?.[sourceKey];
  if (alias !== undefined && isFrontmatterKey(alias)) return { key: alias, via: 'alias' };

  if (isFrontmatterKey(sourceKey) && target.fields[sourceKey] !== undefined) {
    return { key: sourceKey, via: 'same' };
  }

  for (const [key, field] of Object.entries(target.fields)) {
    if (!isFrontmatterKey(key)) continue;
    if (field.mapsTo === sourceKey) return { key, via: 'mapsTo' };
  }

  return { key: sourceKey, via: 'none' };
}

/** Serialise a scalar for a generated field, without a trailing newline. */
export function emitScalar(value: string): string {
  return stringifyYaml(value, { lineWidth: 0 }).replace(/\n$/, '');
}

/**
 * Re-emit a source field under a new key.
 *
 * The raw YAML is reused whenever the key is unchanged, which is what keeps
 * block scalars, quoting and flow style byte-identical. Renaming rewrites only
 * the key token, so the value keeps its original formatting.
 */
export function emitField(field: IRFrontmatterField, outKey: string): string {
  if (outKey === field.key) return field.raw;
  if (field.raw.startsWith(field.key)) return `${outKey}${field.raw.slice(field.key.length)}`;
  return `${outKey}: ${emitScalar(String(field.value ?? ''))}`;
}

function statusOf(target: AgentProfile, key: string): ProfileField | undefined {
  return target.fields[key];
}

export interface FieldPlanOptions {
  ir: SkillIR;
  target: AgentProfile;
  /** The identity the skill keeps; used for the emitted `name`. */
  identityName: string;
  /** Fields that a matched source extension already reports on. */
  extensionFields?: ReadonlySet<string>;
  /**
   * Restrict the output to these source keys, for a shared root where one file
   * must be valid for several agents at once. Everything else is reported as
   * dropped with the caller's reason.
   */
  allow?: { keys: ReadonlySet<string>; reason: (key: string) => string };
  /**
   * Set when the identity had to change to satisfy the target's name rule. The
   * name item then says so, instead of blaming the source for a label change
   * the target's grammar forced.
   */
  nameRuleReason?: string;
}

export interface FieldPlan {
  /** YAML lines, in emission order. */
  lines: string[];
  items: ConversionItem[];
  /** The identity the target will address the skill by. */
  name: string;
}

/**
 * Decide what every frontmatter field becomes for one target.
 *
 * Pure: it reads the IR and one capability profile and returns text plus
 * findings. Nothing is written and no agent is named.
 */
export function planFields(options: FieldPlanOptions): FieldPlan {
  const { ir, target, identityName } = options;
  const extensionFields = options.extensionFields ?? new Set<string>();
  const lines: string[] = [];
  const items: ConversionItem[] = [];
  const sourceUrl = target.sources[0]?.url;

  const sourceName = ir.frontmatter.fields.find((field) => field.key === 'name');
  const sourceDescription = ir.frontmatter.fields.find((field) => field.key === 'description');

  // ---- name ---------------------------------------------------------------
  // Always written. Every surveyed agent needs an identity in directory form,
  // and two of them refuse to load a skill without one.
  lines.push(`name: ${emitScalar(identityName)}`);
  if (sourceName === undefined) {
    items.push({
      subject: 'field:name',
      kind: 'field',
      fidelity: 'adapted',
      reason:
        options.nameRuleReason === undefined
          ? 'the skill had no name in frontmatter, so the identity it was addressed by was written out explicitly'
          : `the skill had no name in frontmatter and the identity did not satisfy ${target.id}'s name rule, so "${identityName}" was written`,
      ...(sourceUrl === undefined ? {} : { source: sourceUrl }),
    });
  } else if (sourceName.value !== identityName) {
    items.push({
      subject: 'field:name',
      kind: 'field',
      fidelity: 'adapted',
      reason:
        options.nameRuleReason ??
        `the source kept "${String(sourceName.value)}" as a display label and was addressed as "${identityName}"; the target addresses a skill by its name, so the identity was written out and the label is not carried`,
      line: sourceName.line,
      ...(sourceUrl === undefined ? {} : { source: sourceUrl }),
      detail: { from: sourceName.value, to: identityName },
    });
  } else {
    items.push({
      subject: 'field:name',
      kind: 'field',
      fidelity: 'preserved',
      reason: 'kept unchanged',
      line: sourceName.line,
      ...(sourceUrl === undefined ? {} : { source: sourceUrl }),
    });
  }

  // ---- description --------------------------------------------------------
  const descriptionRequired =
    (target.description.requiredInDirectoryForm ?? false) === true || (target.description.requiredInFlatForm ?? false) === true;
  if (ir.description !== '' || descriptionRequired) {
    lines.push(`description: ${emitScalar(ir.description)}`);
    if (sourceDescription === undefined) {
      items.push({
        subject: 'field:description',
        kind: 'field',
        fidelity: 'adapted',
        reason: descriptionRequired
          ? `the skill had no description and ${target.id} requires one, so an empty one was written`
          : 'the skill had no description in frontmatter',
        ...(sourceUrl === undefined ? {} : { source: sourceUrl }),
      });
    } else {
      items.push({
        subject: 'field:description',
        kind: 'field',
        fidelity: 'preserved',
        reason: 'kept unchanged; a display-only limit is reported by lint rather than enforced here',
        line: sourceDescription.line,
        ...(sourceUrl === undefined ? {} : { source: sourceUrl }),
      });
    }
  } else {
    items.push({
      subject: 'field:description',
      kind: 'field',
      fidelity: 'preserved',
      reason: 'the skill has no description and the target does not require one, so none was invented',
      ...(sourceUrl === undefined ? {} : { source: sourceUrl }),
    });
  }

  // ---- every other field --------------------------------------------------
  for (const field of ir.frontmatter.fields) {
    if (field.key === 'name' || field.key === 'description') continue;

    const mapped = targetKeyFor(target, field.key);
    const entry = statusOf(target, mapped.key);

    if (options.allow !== undefined && !options.allow.keys.has(field.key)) {
      items.push({
        subject: `field:${field.key}`,
        kind: 'field',
        fidelity: 'dropped',
        reason: options.allow.reason(field.key),
        line: field.line,
        ...(sourceUrl === undefined ? {} : { source: sourceUrl }),
      });
      continue;
    }

    // A field that selects a source-only extension is reported once, as the
    // extension, so one loss does not appear twice in the summary.
    if (extensionFields.has(field.key)) continue;

    if (entry !== undefined && entry.status === 'unsupported') {
      items.push({
        subject: `field:${field.key}`,
        kind: 'field',
        fidelity: 'dropped',
        reason: `${target.id} has no equivalent for this field, so it was removed rather than emitted as noise`,
        line: field.line,
        ...(entry.note === undefined ? {} : { detail: { note: entry.note } }),
        ...(sourceUrl === undefined ? {} : { source: sourceUrl }),
      });
      continue;
    }

    lines.push(emitField(field, mapped.key));

    const renamedReason =
      mapped.via === 'alias'
        ? `${target.id} accepts this field as "${mapped.key}"`
        : mapped.via === 'mapsTo'
          ? `${target.id} carries this meaning in "${mapped.key}"`
          : null;

    let fidelity: Fidelity = 'preserved';
    let reason = 'kept verbatim';
    if (mapped.via !== 'same' && mapped.via !== 'none' && renamedReason !== null) {
      fidelity = 'renamed';
      reason = renamedReason;
    }
    if (entry === undefined) {
      fidelity = 'degraded';
      reason = `${target.id}'s capability profile does not mention this field, so it was kept verbatim and its effect is unknown`;
    } else if (entry.status === 'ignored') {
      fidelity = 'degraded';
      reason = `${target.id} accepts this field but does nothing with it, so it was kept for portability and its behaviour is lost`;
    } else if (entry.status === 'unknown') {
      fidelity = 'degraded';
      reason = `whether ${target.id} honours this field is not verified, so it was kept verbatim rather than guessed at`;
    }

    const detail: Record<string, unknown> = {};
    if (mapped.via !== 'same') {
      detail.emittedAs = mapped.key;
      detail.via = mapped.via;
    }
    if (entry?.note !== undefined) detail.note = entry.note;

    items.push({
      subject: `field:${field.key}`,
      kind: 'field',
      fidelity,
      reason,
      line: field.line,
      ...(Object.keys(detail).length === 0 ? {} : { detail }),
      ...(sourceUrl === undefined ? {} : { source: sourceUrl }),
    });
  }

  return { lines, items, name: identityName };
}

/**
 * Extensions the source skill actually uses.
 *
 * Declarative: an extension counts as used when its trigger matches a
 * frontmatter field. No agent is named, so a new profile brings its own
 * extensions with it.
 */
export function triggeredExtensions(profile: AgentProfile, ir: SkillIR): { id: string; field: string; value: unknown; fidelityImpact: string; description: string; source?: string }[] {
  const hits = [];
  for (const extension of profile.extensions ?? []) {
    const trigger = extension.trigger;
    if (trigger === undefined) continue;
    const field = ir.frontmatter.fields.find((candidate) => candidate.key === trigger.field);
    if (field === undefined) continue;
    if (trigger.equals !== undefined && String(field.value) !== String(trigger.equals)) continue;
    hits.push({
      id: extension.id,
      field: trigger.field,
      value: field.value,
      fidelityImpact: extension.fidelityImpact,
      description: extension.description,
      ...(extension.source === undefined ? {} : { source: extension.source }),
    });
  }
  return hits;
}

/** Findings that belong to the conversion report rather than to lint. */
export function frontmatterProblems(ir: SkillIR): Diagnostic[] {
  return ir.diagnostics.filter(
    (item) => item.code === 'FRONTMATTER_INVALID' || item.code === 'FRONTMATTER_MISSING',
  );
}
