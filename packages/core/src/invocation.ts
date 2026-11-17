/**
 * How an agent's user invokes a skill, and how a skill's own text refers to it.
 *
 * A skill body is prose written for one agent. When it says "run `/caveman`",
 * that sentence is only true on an agent whose chat accepts `/caveman`. Copying
 * the body to an agent that wants `$caveman` keeps every byte and breaks the
 * instruction — the one kind of loss a fidelity report cannot see, because
 * nothing in the file changed.
 *
 * Everything here is driven by the `invocation` field of a capability profile.
 * Nothing in this module knows an agent's name, and a profile that says
 * `unknown` produces no findings at all: the rule only speaks when the target's
 * own documentation says what the syntax is.
 */

/**
 * A profile's `invocation` block.
 *
 * `syntax` is a template: the literal text a user types, with the skill's name
 * written as `{name}`. `unknown` means the agent's official documentation does
 * not state a per-skill invocation, and is a complete answer rather than a gap.
 */
export interface InvocationProfile {
  /** `/{name}`, `${name}`, `@{name}`, `/skill:{name}`, or `unknown`. */
  syntax: string;
  /** Official page that states the syntax. Required unless `syntax` is `unknown`. */
  source?: string;
  /** Why the syntax is unknown, or any qualification the source makes. */
  note?: string;
}

const PLACEHOLDER = '{name}';

export type InvocationFamily = 'slash' | 'dollar' | 'at' | 'unknown';

/** The character a syntax is built on, which is what a reference has to match. */
export function invocationFamily(syntax: string): InvocationFamily {
  if (!syntax.includes(PLACEHOLDER)) return 'unknown';
  switch (syntax[0]) {
    case '/':
      return 'slash';
    case '$':
      return 'dollar';
    case '@':
      return 'at';
    default:
      return 'unknown';
  }
}

/** The syntax with a real skill name in place of `{name}`. */
export function renderInvocation(syntax: string, name: string): string {
  return syntax.split(PLACEHOLDER).join(name);
}

/**
 * Whether a reference written with `prefix` reaches a skill on this target.
 *
 * Comparison is on the leading character, not the whole template, because a
 * leading character is what an agent actually parses. Two exceptions:
 *
 * - A target whose syntax is namespaced with a literal prefix (`/skill:{name}`)
 *   has only that one form in its documentation, so a bare `/name` does not
 *   resolve there and is a mismatch.
 * - A target whose syntax is the bare slash form also accepts the namespaced
 *   forms its documentation describes (`/plugin:name`), so those are not
 *   mismatches.
 */
export function referenceMatches(prefix: string, syntax: string): boolean {
  const family = invocationFamily(syntax);
  if (family === 'unknown') return true;
  if (prefix[0] !== syntax[0]) return false;
  if (family === 'slash' && syntax.startsWith('/') && syntax.includes(':')) {
    return prefix === syntax.slice(0, syntax.indexOf(PLACEHOLDER));
  }
  return true;
}

export interface InvocationReference {
  /** The reference as written, e.g. `/caveman-compress`. */
  raw: string;
  /** The skill name it addresses, e.g. `caveman-compress`. */
  name: string;
  /** Everything before the name, e.g. `/` or `/skill:` or `$`. */
  prefix: string;
  /** 1-based line in the text that was scanned, after `lineOffset`. */
  line: number;
  /** 1-based column of the leading character. */
  column: number;
}

/**
 * Words that follow a leading `/` or `$` in ordinary prose without naming a
 * skill: shell commands and the built-in commands every chat client has.
 *
 * Kept short and explicit. A false negative here is a missed warning, which is
 * the failure this rule prefers; a false positive teaches the reader to ignore
 * the rule, which is worse.
 */
const NOT_A_SKILL = new Set([
  'bash',
  'bin',
  'cat',
  'cd',
  'clear',
  'compact',
  'config',
  'dev',
  'echo',
  'env',
  'etc',
  'exit',
  'git',
  'grep',
  'help',
  'init',
  'login',
  'logout',
  'ls',
  'model',
  'node',
  'npm',
  'npx',
  'opt',
  'python',
  'python3',
  'pwd',
  'quit',
  'resume',
  'sh',
  'sudo',
  'tmp',
  'usr',
  'var',
  'version',
  'which',
]);

/**
 * A leading character, then an optional `namespace:` segment, then a name.
 *
 * The leading character must sit at the start of the text or after whitespace
 * or an opening bracket/quote, which is what keeps paths (`src/lib`, `./x`,
 * `https://x`) out: a path's slash follows a letter, a dot, or another slash.
 */
const REFERENCE = /(^|[\s([{"'`*_>~])([/$@])((?:[a-z][a-z0-9-]*:)?)([a-z][a-z0-9-]+)/g;

/** Characters that may follow a reference without it being part of a longer word or path. */
const TERMINATORS = new Set(['', ' ', '\t', '\r', '\n', '.', ',', ';', ':', '!', '?', ')', ']', '}', '"', "'", '`', '*', '_']);

/**
 * Every skill invocation the text mentions.
 *
 * Fenced code blocks are skipped: they hold shell commands far more often than
 * chat commands, and a block is where a path is most likely to start a line.
 * Inline code is scanned, because `` `/caveman` `` is how an invocation is
 * usually written down.
 *
 * `lineOffset` is added to every reported line, mirroring `scanShellInjection`,
 * so a caller scanning a body can report lines in the skill file.
 */
export function scanInvocationReferences(text: string, lineOffset = 0): InvocationReference[] {
  const found: InvocationReference[] = [];
  const lines = text.split('\n');
  let inFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').replace(/\r$/, '');

    // ``` or ~~~ opens and closes; an opening line is never a reference itself.
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    REFERENCE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = REFERENCE.exec(line)) !== null) {
      const [, lead = '', leadChar = '', namespace = '', name = ''] = match;
      const start = match.index + lead.length;
      const after = line[start + leadChar.length + namespace.length + name.length] ?? '';

      if (!TERMINATORS.has(after)) continue;
      if (NOT_A_SKILL.has(name)) continue;
      // A markdown link target: `[label](/guide)`.
      if (leadChar === '/' && lead === '(' && line[start - 2] === ']') continue;

      found.push({
        raw: `${leadChar}${namespace}${name}`,
        name,
        prefix: `${leadChar}${namespace}`,
        line: index + 1 + lineOffset,
        column: start + 1,
      });
    }
  }

  return found;
}
