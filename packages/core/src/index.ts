export { DIAGNOSTIC_CODES, countBySeverity, diagnostic } from './diagnostics.js';
export type { Diagnostic, DiagnosticCode, Severity } from './diagnostics.js';

export { DEFAULT_TOOL_LIMITS, describeLimits, resolveLimits } from './limits.js';
export type { ToolLimits } from './limits.js';

export { checkSafeRelativePath, detectLineEnding, isInside, lineStartOffsets, splitLines, toPosix } from './paths.js';
export type { LineEnding, SafePathResult } from './paths.js';

export { scanShellInjection, hasShellInjection } from './body.js';
export type { ShellInjectionOccurrence, ShellSyntax } from './body.js';

export { collectBundledFiles, sha256 } from './files.js';
export type { BundledFile, CollectResult, FileEncoding } from './files.js';

export {
  clearProfileCache,
  fieldStatus,
  getProfile,
  knownFields,
  loadProfiles,
  pathEntries,
  profileIds,
  ProfileError,
  resolveAgentsDir,
  rootSuffix,
} from './profile.js';
export type {
  AgentProfile,
  Enforcement,
  FieldStatus,
  IdentitySource,
  PathEntry,
  PathRole,
  ProfileExtension,
  ProfileField,
} from './profile.js';

export { splitFrontmatter, parseFrontmatterFields, stringField } from './frontmatter.js';
export type { FrontmatterSplit, ParsedFrontmatter, RawField } from './frontmatter.js';

export { detectSource } from './detect.js';
export type { Detection } from './detect.js';

export { AmbiguousSourceError, deriveIdentity, parseSkill, SkillParseError } from './parse.js';
export type { DerivedIdentity, IdentityInputs, ParseOptions, ParseResult } from './parse.js';

export { IR_VERSION } from './ir.js';
export type { FieldEffect, IRFrontmatterField, IRIdentity, IROrigin, SkillIR } from './ir.js';

export {
  enforcementConsequence,
  LINT_RULES,
  ruleById,
  rulesByDiagnosticCode,
  rulesForArea,
  severityForEnforcement,
} from './rules.js';
export type { LintRule, RuleArea, RuleDerivation } from './rules.js';

export { caseCollisions, exitCodeForSummary, lintSkill } from './lint.js';
export type { LintOptions, LintResult, LintSummary } from './lint.js';

export { convertSkill } from './convert/index.js';
export type { ConvertOptions } from './convert/index.js';
export { applyShellPolicy, planBody } from './convert/body.js';
export type { BodyPlan, BodyPlanOptions, ShellPolicy } from './convert/body.js';
export { emitField, emitScalar, isFrontmatterKey, planFields, targetKeyFor, triggeredExtensions } from './convert/frontmatter.js';
export type { FieldPlan, FieldPlanOptions, TargetKey } from './convert/frontmatter.js';
export { directoryNameFor, planConversion, planIdentity } from './convert/plan.js';
export type { NamePlan, PlannedFile, PlannedSkill, PlanOptions } from './convert/plan.js';
export { planSharedConversion } from './convert/lcd.js';
export type { SharedPlanOptions } from './convert/lcd.js';
export {
  ConversionError,
  exitCodeForConversion,
  summarise,
  summariseReport,
} from './convert/report.js';
export type {
  ConversionItem,
  ConversionReport,
  ConversionSubject,
  ConvertedFileReport,
  Fidelity,
  FidelitySummary,
  OverlapReport,
  RootReport,
  TargetReport,
} from './convert/report.js';
export { assignRoots, defaultRootContext, primaryRoot, resolveDocumentedPath, rootsFor } from './convert/roots.js';
export type { ResolvedRoot, RootAssignment, RootContext, Scope } from './convert/roots.js';

export { writeSkill, writeSkillToOutput } from './install.js';
export type { FileToWrite, WriteSkillOptions, WriteSkillResult } from './install.js';

export { assertSafeArchiveEntry, extractZip, isZipPath } from './archive.js';
export type { ExtractedSkill } from './archive.js';
