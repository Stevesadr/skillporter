import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse as parseYaml } from 'yaml';
import type { RuleArea } from './rules.js';

export type FieldStatus = 'supported' | 'ignored' | 'emulated' | 'unsupported' | 'unknown';
export type Enforcement = 'reject' | 'silent-skip' | 'truncate' | 'none' | 'unknown';
export type PathRole = 'native' | 'compatibility';
export type IdentitySource = 'frontmatter' | 'path' | 'frontmatter-or-directory' | 'frontmatter-or-filename';

export interface PathEntry {
  path: string;
  scope: 'project' | 'user' | 'admin' | 'system' | 'plugin' | 'custom';
  role?: PathRole;
  precedence?: number | null;
  note?: string;
}

export interface ProfileField {
  status: FieldStatus;
  mapsTo?: string | null;
  note?: string;
  source?: string;
}

export interface ProfileExtension {
  id: string;
  description: string;
  fidelityImpact: 'preserved' | 'adapted' | 'degraded' | 'dropped';
  /** Declarative condition. When a skill matches, the rule engine reports the extension at risk. */
  trigger?: { field: string; equals?: unknown };
  source?: string;
}

export interface AgentProfile {
  id: string;
  displayName: string;
  format: 'agent-skills' | 'proprietary';
  verification: 'verified' | 'partial' | 'unverified';
  notes?: string;
  paths: { project: PathEntry[]; global: PathEntry[] };
  discovery: {
    skillDirDepth: number | 'recursive';
    acceptsFlatMarkdown: boolean;
    followsSymlinks: boolean | null;
    upwardSearch: boolean;
    nestedLazyLoad?: boolean;
    duplicateResolution?: string;
    note?: string;
  };
  identity: {
    source: IdentitySource;
    requiredInDirectoryForm?: boolean;
    requiredInFlatForm?: boolean;
    displayNameFrom?: string | null;
    note?: string;
  };
  bodyExecution: {
    shellInjection: {
      executed: true | false | 'unknown';
      syntaxes?: ('inline-bang' | 'fenced-bang')[];
      source?: string;
      note?: string;
    };
  };
  name: {
    pattern: string | null;
    maxLength: number | null;
    mustMatchDirectory: boolean | null;
    enforcement: Enforcement;
    note?: string;
  };
  description: {
    maxLength: number | null;
    enforcement: Enforcement;
    requiredInDirectoryForm?: boolean;
    requiredInFlatForm?: boolean;
    truncation?: {
      at: number;
      unit: 'characters' | 'tokens';
      configurableBy?: string;
      combinesWith?: string[];
      note?: string;
    };
    note?: string;
  };
  limits?: Record<string, unknown>;
  fieldAliases?: Record<string, string>;
  fields: Record<string, ProfileField>;
  extensions?: ProfileExtension[];
  sources: { url: string; retrieved: string; covers?: RuleArea[]; note?: string }[];
}

export class ProfileError extends Error {}

const AGENTS_DIR_ENV = 'SKILLPORTER_AGENTS_DIR';
let cached: AgentProfile[] | null = null;

/**
 * Find `agents/`. Works from `packages/core/dist` by walking up, and can be
 * overridden for tests and for a future bundled layout.
 */
export function resolveAgentsDir(startDir?: string): string {
  const override = process.env[AGENTS_DIR_ENV];
  if (override) {
    if (!existsSync(override)) throw new ProfileError(`${AGENTS_DIR_ENV} points at a missing directory: ${override}`);
    return resolve(override);
  }

  let current = startDir ?? dirname(fileURLToPath(import.meta.url));
  for (let hops = 0; hops < 8; hops += 1) {
    const candidate = join(current, 'agents');
    if (existsSync(join(candidate, 'claude-code.yaml'))) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new ProfileError(
    'could not locate the agents/ directory. Set SKILLPORTER_AGENTS_DIR to the directory holding the capability profiles.',
  );
}

function schemaPath(): string {
  const agentsDir = resolveAgentsDir();
  return join(dirname(agentsDir), 'schema', 'agent-profile.schema.json');
}

export async function loadProfiles(options: { refresh?: boolean } = {}): Promise<AgentProfile[]> {
  if (cached && !options.refresh) return cached;

  const agentsDir = resolveAgentsDir();
  const files = (await readdir(agentsDir)).filter((name) => name.endsWith('.yaml')).sort();
  if (files.length === 0) throw new ProfileError(`no capability profiles found in ${agentsDir}`);

  const schema = JSON.parse(await readFile(schemaPath(), 'utf8')) as object;
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

  const profiles: AgentProfile[] = [];
  for (const file of files) {
    const profile = parseYaml(await readFile(join(agentsDir, file), 'utf8')) as AgentProfile;
    if (!validate(profile)) {
      const detail = (validate.errors ?? [])
        .map((error: { instancePath?: string; message?: string }) =>
          `${error.instancePath ?? '(root)'} ${error.message ?? ''}`.trim(),
        )
        .join('; ');
      throw new ProfileError(`agents/${file} does not match the schema: ${detail}`);
    }
    profiles.push(profile);
  }

  profiles.sort((left, right) => left.id.localeCompare(right.id));
  cached = profiles;
  return profiles;
}

export function clearProfileCache(): void {
  cached = null;
}

export async function getProfile(id: string): Promise<AgentProfile> {
  const profiles = await loadProfiles();
  const found = profiles.find((profile) => profile.id === id);
  if (!found) {
    throw new ProfileError(`unknown agent "${id}". Known agents: ${profiles.map((p) => p.id).join(', ')}`);
  }
  return found;
}

export function profileIds(profiles: readonly AgentProfile[]): string[] {
  return profiles.map((profile) => profile.id);
}

/** Fields the agent accepts in some way. Everything else is unknown to it. */
export function knownFields(profile: AgentProfile): Set<string> {
  return new Set(Object.keys(profile.fields));
}

export function fieldStatus(profile: AgentProfile, key: string): FieldStatus {
  return profile.fields[key]?.status ?? 'unknown';
}

/** All path entries with an explicit role, defaulting to native. */
export function pathEntries(profile: AgentProfile): (PathEntry & { role: PathRole })[] {
  return [...profile.paths.project, ...profile.paths.global].map((entry) => ({
    ...entry,
    role: entry.role ?? 'native',
  }));
}

/**
 * The trailing path segments of a discovery root, e.g. `~/.claude/skills` becomes
 * `.claude/skills`. Placeholder segments such as `<projectRoot>` carry no fixed
 * location and are dropped.
 */
export function rootSuffix(entry: PathEntry): string | null {
  const segments = entry.path
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .filter((segment) => segment !== '~' && !segment.startsWith('<'));
  if (segments.length < 2) return null;
  return segments.join('/');
}
