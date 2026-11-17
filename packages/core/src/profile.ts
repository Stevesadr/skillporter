import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse as parseYaml } from 'yaml';
import type { InvocationProfile } from './invocation.js';
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
  /**
   * Set when the field must be dropped even though its status is `unknown`.
   * Used where the target's acceptance of the field is undocumented and
   * emitting it would be a guess rather than a fact.
   */
  dropReason?: string;
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
  /**
   * Other names this agent is known by, accepted wherever an id is.
   *
   * Only names the agent's own documentation uses for the same product — the
   * binary name, or the short form its docs print. An alias never resolves to a
   * different profile, and a duplicate alias is a profile error rather than a
   * silent last-one-wins.
   */
  aliases?: string[];
  format: 'agent-skills' | 'proprietary';
  /** `archive` means the agent is fed a bundle, not a discovery root. */
  delivery?: 'directory' | 'archive';
  /** `drop` means a field the profile does not describe is removed, not emitted. */
  unknownFields?: 'emit' | 'drop';
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
  /**
   * How a user invokes a skill in this agent's chat, as documented by the agent.
   *
   * Absent and `unknown` mean the same thing: the syntax could not be verified,
   * so no rule may claim a reference is wrong. SP026 reads this field and stays
   * silent without it.
   */
  invocation?: InvocationProfile;
  name: {
    pattern: string | null;
    maxLength: number | null;
    mustMatchDirectory: boolean | null;
    /** Substrings a name may not contain, e.g. an agent's own product names. */
    reserved?: string[];
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
 *
 * The innermost match wins. In an installed tarball that is the package's own
 * copy, which `prepack` places beside `dist/`. In a repository checkout the
 * copy only exists while a tarball is being built, because `postpack` removes
 * it again; the rest of the time the walk reaches the real `agents/`.
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
  assertUniqueAliases(profiles);
  cached = profiles;
  return profiles;
}

export function clearProfileCache(): void {
  cached = null;
}

export async function getProfile(id: string): Promise<AgentProfile> {
  const profiles = await loadProfiles();
  const found = findProfile(profiles, id);
  if (!found) {
    throw new ProfileError(`unknown agent "${id}". Known agents: ${knownAgentsText(profiles)}`);
  }
  return found;
}

/**
 * Resolve an id or a documented alias.
 *
 * An exact id always wins over an alias, so adding an alias can never take a
 * name away from an existing profile.
 */
export function findProfile(
  profiles: readonly AgentProfile[],
  idOrAlias: string,
): AgentProfile | undefined {
  const wanted = idOrAlias.trim();
  if (wanted === '') return undefined;
  return (
    profiles.find((profile) => profile.id === wanted) ??
    profiles.find((profile) => (profile.aliases ?? []).includes(wanted))
  );
}

/**
 * Every accepted name, for help text and for the "unknown agent" error.
 *
 * Aliases are shown next to the id that owns them so the list doubles as the
 * answer to "which spelling do I type". A duplicate alias is reported rather
 * than resolved silently: two profiles answering to one name would make the
 * result depend on file order.
 */
export function knownAgentsText(profiles: readonly AgentProfile[]): string {
  return profiles
    .map((profile) => {
      const aliases = profile.aliases ?? [];
      return aliases.length === 0 ? profile.id : `${profile.id} (alias: ${aliases.join(', ')})`;
    })
    .join(', ');
}

/** Throw when two profiles claim the same alias, or one claims another's id. */
export function assertUniqueAliases(profiles: readonly AgentProfile[]): void {
  const seen = new Map<string, string>();
  for (const profile of profiles) seen.set(profile.id, profile.id);
  for (const profile of profiles) {
    for (const alias of profile.aliases ?? []) {
      const owner = seen.get(alias);
      if (owner !== undefined) {
        throw new ProfileError(
          `agents/${profile.id}.yaml claims the alias "${alias}", which is already the id or alias of ${owner}`,
        );
      }
      seen.set(alias, profile.id);
    }
  }
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
