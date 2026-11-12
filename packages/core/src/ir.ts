import type { ShellInjectionOccurrence } from './body.js';
import type { Diagnostic } from './diagnostics.js';
import type { BundledFile } from './files.js';
import type { ToolLimits } from './limits.js';
import type { FieldStatus, IdentitySource } from './profile.js';

export const IR_VERSION = '1.0' as const;

/** How the source agent treats a frontmatter field it saw. */
export type FieldEffect = 'honoured' | 'ignored' | 'unknown';

export interface IRFrontmatterField {
  key: string;
  /** Parsed value, kept as YAML produced it. */
  value: unknown;
  /** Exact YAML source for this entry, so it can be re-emitted unchanged. */
  raw: string;
  /** 1-based line in the skill file. */
  line: number;
  column: number;
  /** What the source agent's capability profile says about this field. */
  status: FieldStatus;
  effect: FieldEffect;
  note?: string;
}

export interface IROrigin {
  agent: string;
  agentDisplayName: string;
  profileVerification: string;
  format: string;
  layout: 'directory' | 'flat';
  /** Absolute path of the skill root. */
  root: string;
  /** Absolute path of the file that carried the frontmatter. */
  skillFile: string;
}

export interface IRIdentity {
  /** The name the source agent addresses the skill by. */
  name: string;
  /** Human-facing label when it differs from the identity. */
  displayName: string | null;
  source: IdentitySource | 'directory' | 'filename';
}

export interface SkillIR {
  irVersion: typeof IR_VERSION;
  identity: IRIdentity;
  description: string;
  /** Markdown after the frontmatter, byte-exact: line endings are not rewritten. */
  body: string;
  bodyHash: string;
  frontmatter: {
    present: boolean;
    /** Raw YAML between the delimiters, byte-exact. */
    raw: string;
    fields: IRFrontmatterField[];
  };
  files: BundledFile[];
  origin: IROrigin;
  text: {
    lineEnding: 'lf' | 'crlf' | 'mixed';
    hasBom: boolean;
  };
  /** Shell syntax found in the body. Recorded, never executed. */
  shellInjection: ShellInjectionOccurrence[];
  diagnostics: Diagnostic[];
  limits: ToolLimits & { scope: 'tool' };
}
