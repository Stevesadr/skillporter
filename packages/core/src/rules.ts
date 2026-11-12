import type { DiagnosticCode, Severity } from './diagnostics.js';
import type { Enforcement } from './profile.js';

/**
 * Which part of a capability profile a rule reasons about. Matches the `covers`
 * enum on a profile source, so a rule can cite the document that substantiates it.
 */
export type RuleArea =
  | 'format'
  | 'paths'
  | 'discovery'
  | 'identity'
  | 'name'
  | 'description'
  | 'fields'
  | 'bodyExecution';

/**
 * Where a rule's authority comes from.
 *
 * - `profile`: the rule reads one or more fields of the target capability
 *   profile. No agent is named anywhere in the engine, so a new profile brings
 *   the rules with it.
 * - `tool`: the rule reports something skillporter itself observed or refused
 *   (a symlink it would not follow, a limit it hit). These are the same for
 *   every target and are always labelled as tool behaviour, never as an agent
 *   limit.
 */
export type RuleDerivation = 'profile' | 'tool';

export interface LintRule {
  /** Stable identifier. Never reused, never renumbered. */
  id: string;
  /** Stable machine name, used in JSON output and in `--rules` listings. */
  slug: string;
  title: string;
  area: RuleArea;
  /** The diagnostic code this rule emits. One code may back several rules. */
  code: DiagnosticCode;
  /**
   * Additional codes the same rule may emit when the underlying fact is
   * unknown, so the diagnostic-to-rule mapping stays complete.
   */
  alsoEmits?: DiagnosticCode[];
  /** Profile field(s) the rule reads, or `tool` for tool-level observations. */
  derivedFrom: string;
  derivation: RuleDerivation;
  /** How severity is decided. Rendered into the rule catalogue. */
  severityPolicy: string;
  /** What the reader should do about it. Lint never applies this. */
  fix: string;
  description: string;
}

/**
 * Severity is a function of what the agent *does*, taken from the profile.
 *
 * The project rule is: an agent that refuses to load the skill has a hard
 * problem, an agent that only shortens a display string does not.
 *
 * `silent-skip` counts as an error even though it is not a visible rejection,
 * because the outcome is the same for the user — the skill never appears — and
 * the only feedback is a log line most people never read.
 */
export function severityForEnforcement(enforcement: Enforcement): Severity {
  switch (enforcement) {
    case 'reject':
    case 'silent-skip':
      return 'error';
    case 'truncate':
      return 'warning';
    case 'none':
      return 'info';
    case 'unknown':
      return 'warning';
    default:
      return 'warning';
  }
}

/** How the target reacts, phrased for a finding message. Never guesses. */
export function enforcementConsequence(enforcement: Enforcement, agent: string): string {
  switch (enforcement) {
    case 'reject':
      return `${agent} rejects such a skill, so it will not load`;
    case 'silent-skip':
      return `${agent} drops such a skill from its catalog with only a logged warning, so it will silently never appear`;
    case 'truncate':
      return `${agent} shortens the value for display but still loads the skill`;
    case 'none':
      return `${agent} does not enforce this, but another agent may`;
    case 'unknown':
      return `whether ${agent} enforces this is not documented`;
    default:
      return `the documented behaviour of ${agent} is unclear`;
  }
}

export const LINT_RULES: readonly LintRule[] = [
  {
    id: 'SP001',
    slug: 'name-grammar',
    title: 'Name does not match the target name grammar',
    area: 'name',
    code: 'FIELD_INVALID',
    derivedFrom: 'name.pattern',
    derivation: 'profile',
    severityPolicy: 'severityForEnforcement(name.enforcement)',
    fix: 'Rename the skill to kebab-case, or keep the current name and accept that this target will not load it.',
    description:
      'The identity the target would address the skill by is tested against the target name pattern. When the profile documents no pattern the rule never fires.',
  },
  {
    id: 'SP002',
    slug: 'name-length',
    title: 'Name is longer than the target allows',
    area: 'name',
    code: 'LIMIT_EXCEEDED',
    derivedFrom: 'name.maxLength',
    derivation: 'profile',
    severityPolicy: 'severityForEnforcement(name.enforcement)',
    fix: 'Shorten the name. Names are part of the invocation surface, so this is a rename, not a cosmetic change.',
    description:
      'Fires only when the profile gives a numeric name.maxLength. A null bound means the agent documents no limit, which is not the same as a limit of zero.',
  },
  {
    id: 'SP003',
    slug: 'name-directory-mismatch',
    title: 'Name disagrees with the directory name where the target requires a match',
    area: 'name',
    code: 'FIELD_INVALID',
    derivedFrom: 'name.mustMatchDirectory',
    derivation: 'profile',
    severityPolicy: 'severityForEnforcement(name.enforcement)',
    fix: 'Make the directory name and the frontmatter name identical, or drop one of them.',
    description:
      'No surveyed agent currently enforces a match, so this rule is silent for all five profiles. It exists because the profile field does, and a new profile that sets it true must be honoured without new code.',
  },
  {
    id: 'SP004',
    slug: 'name-required',
    title: 'Target requires an identity and the skill has none',
    area: 'identity',
    code: 'MISSING_REQUIRED_FIELD',
    derivedFrom: 'identity.requiredInDirectoryForm, identity.requiredInFlatForm',
    derivation: 'profile',
    severityPolicy: 'always error',
    fix: 'Add a name to the frontmatter. Deriving one from the path is what the target does silently when it is allowed to; here it is not allowed.',
    description:
      'Read per layout: a directory skill consults requiredInDirectoryForm, a flat .md skill consults requiredInFlatForm. Undefined means the profile does not say, and the rule stays silent rather than guess.',
  },
  {
    id: 'SP005',
    slug: 'identity-source',
    title: 'Target takes the identity from somewhere other than where the skill keeps it',
    area: 'identity',
    code: 'IDENTITY_DERIVED',
    derivedFrom: 'identity.source, identity.displayNameFrom',
    derivation: 'profile',
    severityPolicy: 'warning when the two identities differ, info when they agree or the fallback is lossless',
    fix: 'Keep the directory name, the filename and the frontmatter name in agreement so the skill is addressable by the same string everywhere.',
    description:
      'Covers the fallback case the brief calls out: a target whose identity.source is `path` addresses the skill by its location and treats frontmatter name as a label, so renaming the directory renames the skill.',
  },
  {
    id: 'SP006',
    slug: 'description-required',
    title: 'Target requires a description and the skill has none',
    area: 'description',
    code: 'MISSING_REQUIRED_FIELD',
    derivedFrom: 'description.requiredInDirectoryForm, description.requiredInFlatForm',
    derivation: 'profile',
    severityPolicy: 'always error',
    fix: 'Write a description. Front-load the use case: several agents shorten it in the catalog rather than showing all of it.',
    description:
      'A skill without a description is invisible to model-driven selection even where it is technically loadable, so this is reported as an error wherever the profile marks it required.',
  },
  {
    id: 'SP007',
    slug: 'description-length',
    title: 'Description exceeds a hard target limit',
    area: 'description',
    code: 'LIMIT_EXCEEDED',
    derivedFrom: 'description.maxLength',
    derivation: 'profile',
    severityPolicy: 'severityForEnforcement(description.enforcement)',
    fix: 'Shorten the description. This is a validation bound, not a display bound: the skill will not load as written.',
    description:
      'Distinct from SP008 on purpose. A hard validation limit is a different fact from a display truncation, and the profiles record them in different fields because the agents behave differently.',
  },
  {
    id: 'SP008',
    slug: 'description-truncated',
    title: 'Description will be shortened in the target catalog',
    area: 'description',
    code: 'LIMIT_EXCEEDED',
    derivedFrom: 'description.truncation, description.truncation.combinesWith',
    derivation: 'profile',
    severityPolicy: 'always warning: the skill still loads, only the listing is shortened',
    fix: 'Move the key use case and trigger words to the first sentence. Everything after the bound is never shown to the model.',
    description:
      'Accounts for combinesWith: agents that append a second field to the description share one budget, so the rule sums both before comparing against the bound.',
  },
  {
    id: 'SP009',
    slug: 'flat-layout-unsupported',
    title: 'Skill is a bare .md file and the target does not read flat skills',
    area: 'format',
    code: 'FLAT_LAYOUT',
    derivedFrom: 'discovery.acceptsFlatMarkdown',
    derivation: 'profile',
    severityPolicy: 'always error: the target never enumerates the file',
    fix: 'Move the file into a directory of its own as SKILL.md. `skillporter convert` does this automatically.',
    description:
      'Applies only to the flat form. A directory skill is read by every surveyed agent, so the rule is silent for directory layouts.',
  },
  {
    id: 'SP010',
    slug: 'discovery-depth',
    title: 'Skill sits deeper below a discovery root than the target scans',
    area: 'discovery',
    code: 'LIMIT_EXCEEDED',
    derivedFrom: 'discovery.skillDirDepth',
    derivation: 'profile',
    severityPolicy: 'always error: the target never reaches the directory',
    fix: 'Move the skill closer to the root, or add its parent directory to the target configuration.',
    description:
      'Counts directory levels between the matched root and the skill directory. `recursive` in the profile disables the rule. Depth is only measured when the skill sits under a root the target documents, so an unusual layout is not punished for being unrecognised.',
  },
  {
    id: 'SP011',
    slug: 'field-ignored',
    title: 'Target accepts the field but does nothing with it',
    area: 'fields',
    code: 'UNKNOWN_CAPABILITY',
    derivedFrom: 'fields[].status = ignored',
    derivation: 'profile',
    severityPolicy: 'always warning: the field survives the file but not the behaviour',
    fix: 'Keep the field if the file must stay portable, and move the behaviour it expresses into the body or into the target configuration.',
    description:
      'The distinction between accepted-and-ignored and unknown matters: an ignored field is safe to emit, it just will not do anything.',
  },
  {
    id: 'SP012',
    slug: 'field-unsupported',
    title: 'Target has no equivalent for the field',
    area: 'fields',
    code: 'UNKNOWN_CAPABILITY',
    derivedFrom: 'fields[].status = unsupported',
    derivation: 'profile',
    severityPolicy: 'always warning',
    fix: 'Express the intent in prose in the body, or accept the loss and record it in the conversion report.',
    description: 'No surveyed profile currently uses this status, but the rule honours it if a profile does.',
  },
  {
    id: 'SP013',
    slug: 'field-unknown',
    title: 'Target support for the field is not verified',
    area: 'fields',
    code: 'UNKNOWN_CAPABILITY',
    derivedFrom: 'fields (absent key), fields[].status = unknown',
    derivation: 'profile',
    severityPolicy: 'always warning; suppressible with --ignore-unknown',
    fix: 'Check the target documentation, then record the answer in the capability profile rather than in this skill.',
    description:
      'Two reasons share one rule: the profile never mentions the field, or the profile mentions it and marks it unknown. Both mean skillporter has no verified answer, and the project rule is to report that instead of guessing. This is the only rule --ignore-unknown suppresses.',
  },
  {
    id: 'SP014',
    slug: 'field-renamed',
    title: 'Field is honoured under a different spelling',
    area: 'fields',
    code: 'UNKNOWN_CAPABILITY',
    derivedFrom: 'fieldAliases, fields[].mapsTo',
    derivation: 'profile',
    severityPolicy: 'always info: nothing is lost, the spelling changes',
    fix: 'None required. The converter renames the field; the finding is recorded so the conversion report can show the rename.',
    description:
      'The whenToUse case: Claude Code spells the field when_to_use, dsh spells it whenToUse, Kimi Code accepts all three. Without this rule the alias would be misreported as an unknown field.',
  },
  {
    id: 'SP015',
    slug: 'extension-at-risk',
    title: 'Skill uses a target extension that has no equivalent elsewhere',
    area: 'format',
    code: 'UNKNOWN_CAPABILITY',
    derivedFrom: 'extensions[].trigger, extensions[].fidelityImpact',
    derivation: 'profile',
    severityPolicy: 'warning for dropped and degraded extensions, info for adapted and preserved',
    fix: 'Read the extension description and decide whether the behaviour matters. Converting away from this agent cannot carry it.',
    description:
      'Purely declarative: an extension fires when its trigger matches a frontmatter field. Kimi Code `type: flow` is the motivating case, and no agent-specific code exists for it.',
  },
  {
    id: 'SP016',
    slug: 'shell-injection-executed',
    title: 'Target executes shell syntax found in the body',
    area: 'bodyExecution',
    code: 'SHELL_INJECTION',
    derivedFrom: 'bodyExecution.shellInjection.executed, bodyExecution.shellInjection.syntaxes',
    derivation: 'profile',
    severityPolicy:
      'error when the source agent did not execute it, warning when it did, warning when the source behaviour is unknown',
    fix: 'Remove the placeholder, or keep it deliberately. Nothing is executed by skillporter; the target will execute it.',
    description:
      'One finding per occurrence, with the line number, so the author can look at the exact command. Whether this is new behaviour is decided by comparing the source profile with the target profile, which is why both are read.',
  },
  {
    id: 'SP017',
    slug: 'shell-injection-inert',
    title: 'Body contains shell syntax the target will not execute',
    area: 'bodyExecution',
    code: 'SHELL_INJECTION',
    alsoEmits: ['UNKNOWN_CAPABILITY'],
    derivedFrom: 'bodyExecution.shellInjection.executed',
    derivation: 'profile',
    severityPolicy:
      'warning when the source agent executed it, info when neither agent executes it, warning when either behaviour is unknown',
    fix: 'Replace the placeholder with the text it produced in the source agent, or keep it as documentation and say so.',
    description:
      'The mirror of SP016. A placeholder that used to expand becomes literal text, which changes what the model reads even though the file is unchanged.',
  },
  {
    id: 'SP018',
    slug: 'symlink-outside-root',
    title: 'A symlink pointed outside the skill root and was not followed',
    area: 'paths',
    code: 'SYMLINK_OUTSIDE_ROOT',
    derivation: 'tool',
    derivedFrom: 'tool',
    severityPolicy: 'always warning: nothing is silently dropped',
    fix: 'Copy the target into the skill directory if it belongs to the skill, or remove the link.',
    description:
      'Tool behaviour, not an agent limit. The project rule is to warn rather than skip silently, because a missing bundled file changes what the skill can do.',
  },
  {
    id: 'SP019',
    slug: 'symlink-broken',
    title: 'A symlink could not be resolved',
    area: 'paths',
    code: 'SYMLINK_BROKEN',
    derivation: 'tool',
    derivedFrom: 'tool',
    severityPolicy: 'always warning',
    fix: 'Fix or remove the dangling link.',
    description: 'Tool behaviour. A broken link is reported once and not retried.',
  },
  {
    id: 'SP020',
    slug: 'symlink-unsupported',
    title: 'Skill is reached through a symlink and the target does not document symlink handling',
    area: 'paths',
    code: 'SYMLINK_ROOT',
    derivedFrom: 'discovery.followsSymlinks',
    derivation: 'profile',
    severityPolicy: 'error when the profile says false, warning when it says null (undocumented)',
    fix: 'Place a real directory in the target skill root instead of a link, or confirm the target follows links before relying on it.',
    description:
      'Fires only when the skill root itself is a symbolic link. A null in the profile means the agent does not document the behaviour, which the project treats as unknown rather than as a denial.',
  },
  {
    id: 'SP021',
    slug: 'duplicate-name',
    title: 'Another skill in the same root resolves to the same name',
    area: 'paths',
    code: 'DUPLICATE_NAME',
    derivedFrom: 'discovery.duplicateResolution',
    derivation: 'profile',
    severityPolicy: 'always warning: which skill wins depends on the target',
    fix: 'Rename one of the skills, or remove the duplicate from this root.',
    description:
      'Only siblings in the same discovery root are compared, because that is the only collision the target resolves. The finding quotes the profile duplicateResolution text when there is one and says plainly when the target documents no winner.',
  },
  {
    id: 'SP022',
    slug: 'bundled-file-anomaly',
    title: 'Two bundled files differ only by case',
    area: 'format',
    code: 'FILE_ANOMALY',
    derivation: 'tool',
    derivedFrom: 'tool',
    severityPolicy: 'always warning',
    fix: 'Rename one of the files. On a case-insensitive filesystem one will overwrite or shadow the other.',
    description:
      'SKILL.md is included in the comparison, so a stray skill.md beside SKILL.md is caught. Tool behaviour: the same two files are a problem for every target.',
  },
  {
    id: 'SP023',
    slug: 'tool-limit',
    title: 'A skillporter limit was reached while reading the skill',
    area: 'format',
    code: 'LIMIT_EXCEEDED',
    derivation: 'tool',
    derivedFrom: 'tool',
    severityPolicy: 'always warning, and always labelled as a tool limit rather than an agent limit',
    fix: 'Raise the limit with --max-file-bytes, --max-files, --max-total-bytes or --max-depth if the skill really is that large.',
    description:
      'Kept separate from every agent limit on purpose. This says skillporter stopped reading, not that the target would refuse the skill.',
  },
  {
    id: 'SP024',
    slug: 'frontmatter-problem',
    title: 'Frontmatter is missing or is not valid YAML',
    area: 'format',
    code: 'FRONTMATTER_INVALID',
    alsoEmits: ['FRONTMATTER_MISSING'],
    derivation: 'profile',
    derivedFrom: 'identity.source, identity.requiredInDirectoryForm, description.requiredInDirectoryForm',
    severityPolicy:
      'error when the YAML is invalid, or when it is absent and the target takes its identity or description from frontmatter; warning otherwise',
    fix: 'Add or repair the frontmatter block. skillporter will not guess what an unparseable document meant.',
    description:
      'Absent frontmatter is only fatal where the target needs it. A target that falls back to the path can still load a skill with no frontmatter, so the same fact produces a different severity per profile.',
  },
];

const BY_ID = new Map(LINT_RULES.map((rule) => [rule.id, rule]));

export function ruleById(id: string): LintRule | undefined {
  return BY_ID.get(id);
}

export function rulesForArea(area: RuleArea): LintRule[] {
  return LINT_RULES.filter((rule) => rule.area === area);
}

/** Diagnostic codes that at least one rule emits, for the mapping table. */
export function rulesByDiagnosticCode(): Map<DiagnosticCode, LintRule[]> {
  const map = new Map<DiagnosticCode, LintRule[]>();
  for (const rule of LINT_RULES) {
    for (const code of [rule.code, ...(rule.alsoEmits ?? [])]) {
      const list = map.get(code) ?? [];
      if (!list.includes(rule)) list.push(rule);
      map.set(code, list);
    }
  }
  return map;
}
