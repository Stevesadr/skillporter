import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { Diagnostic } from './diagnostics.js';
import { diagnostic } from './diagnostics.js';
import { scanShellInjection } from './body.js';
import { detectSource, type Detection } from './detect.js';
import { collectBundledFiles, sha256 } from './files.js';
import { parseFrontmatterFields, splitFrontmatter, stringField, type RawField } from './frontmatter.js';
import { IR_VERSION, type FieldEffect, type IRFrontmatterField, type IRIdentity, type SkillIR } from './ir.js';
import { describeLimits, resolveLimits, type ToolLimits } from './limits.js';
import { detectLineEnding } from './paths.js';
import { loadProfiles, type AgentProfile, type FieldStatus } from './profile.js';

export interface ParseOptions {
  path: string;
  /** Explicit source agent. Required when detection is ambiguous. */
  from?: string;
  limits?: Partial<ToolLimits>;
}

export interface ParseResult {
  ir: SkillIR;
  detection: Detection;
}

export class SkillParseError extends Error {}

export class AmbiguousSourceError extends Error {
  constructor(readonly detection: Detection) {
    super(detection.reason);
    this.name = 'AmbiguousSourceError';
  }
}

function effectOf(status: FieldStatus): FieldEffect {
  if (status === 'supported' || status === 'emulated') return 'honoured';
  if (status === 'ignored') return 'ignored';
  return 'unknown';
}

function mapFields(
  profile: AgentProfile,
  fields: readonly RawField[],
  diagnostics: Diagnostic[],
  file: string,
): IRFrontmatterField[] {
  return fields.map((field) => {
    const entry = profile.fields[field.key];
    const status: FieldStatus = entry?.status ?? 'unknown';
    const effect = effectOf(status);

    if (entry === undefined) {
      diagnostics.push(
        diagnostic('UNKNOWN_CAPABILITY', 'warning', `field "${field.key}" is not understood by ${profile.id}; preserved verbatim`, {
          file,
          line: field.line,
          hint: 'skillporter carries the raw YAML into the IR unchanged. No agent behaviour is inferred from it.',
          detail: { kind: 'unmapped-field', field: field.key, agent: profile.id },
        }),
      );
    } else if (status === 'unknown') {
      diagnostics.push(
        diagnostic('UNKNOWN_CAPABILITY', 'warning', `whether ${profile.id} honours "${field.key}" is not verified`, {
          file,
          line: field.line,
          hint: 'The capability profile marks this as unknown, so skillporter reports it instead of guessing.',
          detail: { kind: 'unknown-capability', field: field.key, agent: profile.id },
        }),
      );
    }

    const mapped: IRFrontmatterField = {
      key: field.key,
      value: field.value,
      raw: field.raw,
      line: field.line,
      column: field.column,
      status,
      effect,
    };
    if (entry?.note) mapped.note = entry.note;
    return mapped;
  });
}

function resolveIdentity(
  profile: AgentProfile,
  layout: 'directory' | 'flat',
  fields: readonly RawField[],
  root: string,
  skillFile: string,
  diagnostics: Diagnostic[],
  file: string,
): IRIdentity {
  const fromFrontmatter = stringField(fields, 'name');
  const displayName = fromFrontmatter ?? null;
  const directoryName = basename(root);
  const fileName = basename(skillFile).replace(/\.md$/i, '');
  const required = layout === 'directory' ? profile.identity.requiredInDirectoryForm : profile.identity.requiredInFlatForm;

  if (profile.identity.source === 'path') {
    const name = layout === 'directory' ? directoryName : fileName;
    return { name, displayName, source: 'path' };
  }

  if (fromFrontmatter !== undefined) {
    return { name: fromFrontmatter, displayName, source: 'frontmatter' };
  }

  const fallback = profile.identity.source === 'frontmatter-or-directory' ? directoryName : fileName;

  if (required === true) {
    diagnostics.push(
      diagnostic('MISSING_REQUIRED_FIELD', 'error', `${profile.id} requires "name" in a ${layout} skill, and this one has none`, {
        file,
        hint: `As written, ${profile.id} would not load this skill. The identity shown below was derived from the path.`,
        detail: { field: 'name', agent: profile.id, layout },
      }),
    );
  } else {
    diagnostics.push(
      diagnostic('IDENTITY_DERIVED', 'info', `no "name" in frontmatter, so the identity comes from the ${layout === 'directory' ? 'directory name' : 'filename'}`, {
        file,
        hint: `${profile.id} documents this fallback, so nothing is lost.`,
        detail: { derived: fallback, agent: profile.id },
      }),
    );
  }

  return {
    name: fallback,
    displayName: null,
    source: layout === 'directory' ? 'directory' : 'filename',
  };
}

/**
 * Read a skill directory or flat `.md` file into the intermediate representation.
 *
 * Reads only. Nothing in a skill is executed, and nothing is written.
 */
export async function parseSkill(options: ParseOptions): Promise<ParseResult> {
  const target = resolve(options.path);
  const targetInfo = await stat(target).catch(() => null);
  if (targetInfo === null) throw new SkillParseError(`no such file or directory: ${options.path}`);

  let layout: 'directory' | 'flat';
  let root: string;
  let skillFile: string;

  if (targetInfo.isDirectory()) {
    layout = 'directory';
    root = target;
    skillFile = join(target, 'SKILL.md');
    const skillInfo = await stat(skillFile).catch(() => null);
    if (skillInfo === null || !skillInfo.isFile()) {
      throw new SkillParseError(`${options.path} is a directory but has no SKILL.md`);
    }
  } else {
    if (!/\.md$/i.test(target)) throw new SkillParseError('a flat skill must be a .md file');
    layout = 'flat';
    root = dirname(target);
    skillFile = target;
  }

  const profiles = await loadProfiles();
  const detection = detectSource(root, profiles);

  const agentId = options.from ?? detection.agent;
  if (agentId === null) throw new AmbiguousSourceError(detection);

  const profile = profiles.find((candidate) => candidate.id === agentId);
  if (profile === undefined) {
    throw new SkillParseError(`unknown agent "${agentId}". Known agents: ${profiles.map((p) => p.id).join(', ')}`);
  }

  const limits = resolveLimits(options.limits);
  const diagnostics: Diagnostic[] = [];
  const fileName = layout === 'directory' ? 'SKILL.md' : basename(skillFile);

  const raw = await readFile(skillFile, 'utf8');
  const hasBom = raw.charCodeAt(0) === 0xfeff;
  const text = hasBom ? raw.slice(1) : raw;
  const lineEnding = detectLineEnding(text);

  const split = splitFrontmatter(text);
  if (!split.present) {
    diagnostics.push(
      diagnostic('FRONTMATTER_MISSING', 'warning', 'no YAML frontmatter block found', {
        file: fileName,
        hint: 'A skill file must start with a `---` line, then YAML, then a closing `---`.',
      }),
    );
  }

  const parsed = split.present ? parseFrontmatterFields(split.yaml) : { fields: [], errors: [] };
  if (parsed.errors.length > 0) {
    diagnostics.push(
      diagnostic('FRONTMATTER_INVALID', 'error', `frontmatter is not valid YAML: ${parsed.errors[0] ?? 'unknown error'}`, {
        file: fileName,
        hint: 'Fix the YAML. skillporter will not guess what the author meant.',
        detail: { errors: parsed.errors },
      }),
    );
  }

  const fields = mapFields(profile, parsed.fields, diagnostics, fileName);
  const body = text.slice(split.bodyStart);
  const identity = resolveIdentity(profile, layout, parsed.fields, root, skillFile, diagnostics, fileName);

  const description = stringField(parsed.fields, 'description');
  const descriptionRequired =
    layout === 'directory' ? profile.description.requiredInDirectoryForm : profile.description.requiredInFlatForm;

  if (description === undefined) {
    diagnostics.push(
      diagnostic(
        'MISSING_REQUIRED_FIELD',
        descriptionRequired === true ? 'error' : 'warning',
        descriptionRequired === true
          ? `${profile.id} requires "description" in a ${layout} skill, and this one has none`
          : 'no "description" in frontmatter, so the model will not see this skill in its catalog',
        {
          file: fileName,
          hint: `Description behaviour for ${profile.id} is recorded in its capability profile.`,
          detail: { field: 'description', agent: profile.id, layout },
        },
      ),
    );
  }

  const bodyLineOffset = split.present ? countLines(split.yaml) + 2 : 0;
  const shellInjection = scanShellInjection(body, bodyLineOffset);
  const executed = profile.bodyExecution.shellInjection.executed;
  if (shellInjection.length > 0) {
    if (executed === true) {
      for (const occurrence of shellInjection) {
        diagnostics.push(
          diagnostic('SHELL_INJECTION', 'warning', `${profile.id} executes ${occurrence.kind === 'fenced-bang' ? 'this ```! block' : 'this placeholder'} before the body is loaded`, {
            file: fileName,
            line: occurrence.line,
            column: occurrence.column,
            hint: 'skillporter never runs it. Converting away from this agent preserves the text and reports it as degraded.',
            detail: { kind: occurrence.kind, command: occurrence.command, executed: true },
          }),
        );
      }
    } else if (executed === 'unknown') {
      diagnostics.push(
        diagnostic('UNKNOWN_CAPABILITY', 'warning', 'the body contains shell syntax and whether this agent executes it is not verified', {
          file: fileName,
          hint: 'skillporter does not execute anything. Treat the content as untrusted.',
          detail: { kind: 'shell-execution-unknown', agent: profile.id, count: shellInjection.length },
        }),
      );
    }
  }

  let files: SkillIR['files'] = [];
  if (layout === 'directory') {
    const collected = await collectBundledFiles(root, limits, { exclude: ['SKILL.md'] });
    files = collected.files;
    diagnostics.push(...collected.diagnostics);
  } else {
    diagnostics.push(
      diagnostic('FLAT_LAYOUT', 'info', 'this is a flat .md skill, so it has no directory of its own and no bundled files', {
        file: fileName,
        hint: 'Directory skills can carry scripts, references and assets alongside SKILL.md.',
      }),
    );
  }

  const ir: SkillIR = {
    irVersion: IR_VERSION,
    identity,
    description: description ?? '',
    body,
    bodyHash: sha256(Buffer.from(body, 'utf8')),
    frontmatter: {
      present: split.present,
      raw: split.yaml,
      fields,
    },
    files,
    origin: {
      agent: profile.id,
      agentDisplayName: profile.displayName,
      profileVerification: profile.verification,
      format: profile.format,
      layout,
      root,
      skillFile,
    },
    text: { lineEnding, hasBom },
    shellInjection,
    diagnostics,
    limits: describeLimits(limits),
  };

  return { ir, detection };
}

function countLines(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') count += 1;
  }
  return count;
}
