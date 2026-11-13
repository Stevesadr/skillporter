import type { SkillIR } from '../ir.js';
import type { AgentProfile } from '../profile.js';
import type { ConversionItem, Fidelity } from './report.js';

/**
 * What to do with shell syntax in the body.
 *
 * `neutralize` keeps the command as text but removes the syntax that makes the
 * target execute it. `keep` copies it through unchanged. `strip` removes it.
 *
 * The project rule the default enforces: converting must never *create*
 * executable content. A placeholder that was inert in the source and would run
 * in the target is the one case where a silent copy would be a security bug.
 */
export type ShellPolicy = 'neutralize' | 'keep' | 'strip';

export interface BodyOccurrencePlan {
  kind: 'inline-bang' | 'fenced-bang';
  line: number;
  action: 'kept' | 'neutralized' | 'removed';
}

export interface BodyPlan {
  body: string;
  items: ConversionItem[];
  occurrences: BodyOccurrencePlan[];
}

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const INLINE_BANG = /(^|[\s])!`([^`\n]+)`/g;

/** The `!` removed, the command kept: a plain code span, not a placeholder. */
function neutralizeInline(line: string): { line: string; count: number } {
  let count = 0;
  const replaced = line.replace(INLINE_BANG, (_match, prefix: string, command: string) => {
    count += 1;
    return `${prefix}\`${command}\``;
  });
  return { line: replaced, count };
}

/**
 * Remove inline placeholders, taking one adjacent space with each.
 *
 * Deleting only the placeholder leaves `is  here` or a trailing space where a
 * sentence used to have one; the whitespace around it belongs to the words, not
 * to the syntax.
 */
function stripInline(line: string): { line: string; count: number } {
  const re = /!`([^`\n]+)`/g;
  const parts: string[] = [];
  let last = 0;
  let count = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(line)) !== null) {
    count += 1;
    let start = match.index;
    let end = start + match[0].length;
    const before = start > 0 ? line[start - 1] : '';
    if (before === ' ' || before === '\t') {
      start -= 1;
    } else if (line[end] === ' ' || line[end] === '\t') {
      // At the start of a line there is no leading space to take, so the
      // following one goes instead.
      end += 1;
    }
    parts.push(line.slice(last, start));
    last = end;
  }

  if (count === 0) return { line, count: 0 };
  parts.push(line.slice(last));
  return { line: parts.join(''), count };
}

/**
 * Apply a shell-injection policy to a body.
 *
 * Line endings are preserved exactly: the body is split on `\n` and rejoined
 * with `\n`, so a `\r` stays part of its line. Nothing here executes anything.
 */
export function applyShellPolicy(
  body: string,
  policy: ShellPolicy,
): { body: string; occurrences: BodyOccurrencePlan[] } {
  const lines = body.split('\n');
  const out: string[] = [];
  const occurrences: BodyOccurrencePlan[] = [];

  let fence: { char: string; length: number; bang: boolean; start: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const cr = raw.endsWith('\r') ? '\r' : '';
    const line = cr === '' ? raw : raw.slice(0, -1);
    const fenceMatch = FENCE_OPEN.exec(line);

    if (fence === null) {
      if (fenceMatch) {
        const marker = fenceMatch[2] ?? '```';
        const info = (fenceMatch[3] ?? '').trim();
        const bang = info.startsWith('!');
        if (bang && policy === 'strip') {
          // Drop the opening line now; the body lines and the closing fence are
          // dropped as they arrive.
          fence = { char: marker[0] ?? '`', length: marker.length, bang: true, start: index };
          continue;
        }
        if (bang && policy === 'neutralize') {
          // ```` ```! ```` becomes a plain code block. The command stays readable,
          // and no agent will run it.
          out.push(`${fenceMatch[1] ?? ''}${marker}text${cr}`);
          fence = { char: marker[0] ?? '`', length: marker.length, bang: true, start: index };
          occurrences.push({ kind: 'fenced-bang', line: index + 1, action: 'neutralized' });
          continue;
        }
        fence = { char: marker[0] ?? '`', length: marker.length, bang, start: index };
        out.push(raw);
        continue;
      }

      if (policy === 'neutralize') {
        const result = neutralizeInline(line);
        if (result.count > 0) {
          occurrences.push({ kind: 'inline-bang', line: index + 1, action: 'neutralized' });
        }
        out.push(result.line + cr);
      } else if (policy === 'strip') {
        const result = stripInline(line);
        if (result.count > 0) {
          occurrences.push({ kind: 'inline-bang', line: index + 1, action: 'removed' });
        }
        out.push(result.line + cr);
      } else {
        out.push(raw);
      }
      continue;
    }

    const closes =
      fenceMatch !== null &&
      (fenceMatch[2] ?? '')[0] === fence.char &&
      (fenceMatch[2] ?? '').length >= fence.length &&
      (fenceMatch[3] ?? '').trim() === '';

    if (closes) {
      if (fence.bang && policy === 'strip') {
        occurrences.push({ kind: 'fenced-bang', line: fence.start + 1, action: 'removed' });
        fence = null;
        continue;
      }
      out.push(raw);
      fence = null;
      continue;
    }

    if (!fence.bang) {
      if (policy === 'neutralize') {
        const result = neutralizeInline(line);
        if (result.count > 0) occurrences.push({ kind: 'inline-bang', line: index + 1, action: 'neutralized' });
        out.push(result.line + cr);
        continue;
      }
      if (policy === 'strip') {
        const result = stripInline(line);
        if (result.count > 0) occurrences.push({ kind: 'inline-bang', line: index + 1, action: 'removed' });
        out.push(result.line + cr);
        continue;
      }
    }

    if (fence.bang && policy === 'strip') continue;

    out.push(raw);
  }

  return { body: out.join('\n'), occurrences };
}

export interface BodyPlanOptions {
  ir: SkillIR;
  target: AgentProfile;
  sourceExecutes: true | false | 'unknown';
  /** False when the source agent was assumed, so its behaviour is not a fact. */
  sourceKnown: boolean;
  policy: ShellPolicy;
  eol: string;
}

/**
 * Decide what happens to the body for one target.
 *
 * The body is byte-exact unless a shell policy changes it, and every change is
 * reported with the line it happened on.
 */
export function planBody(options: BodyPlanOptions): BodyPlan {
  const { ir, target, sourceExecutes, sourceKnown, policy } = options;
  const targetExecutes = target.bodyExecution.shellInjection.executed;
  const occurrences = ir.shellInjection;
  const sourceUrl = target.sources[0]?.url;
  const items: ConversionItem[] = [];

  if (occurrences.length === 0) {
    items.push({
      subject: 'body',
      kind: 'body',
      fidelity: 'preserved',
      reason: 'copied byte-for-byte; line endings and spacing unchanged',
      ...(sourceUrl === undefined ? {} : { source: sourceUrl }),
    });
    return { body: ir.body, items, occurrences: [] };
  }

  // No transform is warranted when the target does not execute the syntax: the
  // text is inert there, and rewriting it would change the prompt for nothing.
  const shouldTransform = targetExecutes === true && sourceExecutes !== true;
  const effective: ShellPolicy = shouldTransform ? policy : 'keep';

  const transformed = effective === 'keep' ? { body: ir.body, occurrences: [] as BodyOccurrencePlan[] } : applyShellPolicy(ir.body, effective);

  // The transformer reports positions inside the body; the IR reports positions
  // in the file. Both walk the text in the same order, so the IR's line numbers
  // are the ones a reader can act on.
  const planned: BodyOccurrencePlan[] =
    transformed.occurrences.length === occurrences.length
      ? occurrences.map((occurrence, index) => ({
          kind: occurrence.kind,
          line: occurrence.line,
          action: transformed.occurrences[index]?.action ?? 'kept',
        }))
      : occurrences.map((occurrence) => ({ kind: occurrence.kind, line: occurrence.line, action: 'kept' as const }));

  let worst: Fidelity = 'preserved';

  for (const occurrence of planned) {
    let fidelity: Fidelity;
    let reason: string;

    if (occurrence.action === 'neutralized') {
      fidelity = 'adapted';
      reason = sourceKnown
        ? `the placeholder was rewritten as a plain code span: ${target.id} would have executed it, and the source agent did not`
        : `the placeholder was rewritten as a plain code span: ${target.id} would have executed it, and whether the source agent did is unknown, so execution was not introduced`;
    } else if (occurrence.action === 'removed') {
      fidelity = 'dropped';
      reason = sourceKnown
        ? `removed because ${target.id} would have executed it and the source agent did not`
        : `removed because ${target.id} would have executed it and whether the source agent did is unknown, so execution was not introduced`;
    } else if (targetExecutes === true && sourceExecutes === true) {
      fidelity = 'preserved';
      reason = 'kept: both agents execute this placeholder, so the behaviour is unchanged';
    } else if (targetExecutes === true) {
      // Kept on purpose with --shell-injection=keep, or because no policy could
      // be applied. Either way the target will run it, which the source did not.
      fidelity = 'degraded';
      reason = sourceKnown
        ? `kept unchanged because --shell-injection=keep was given: ${target.id} will execute this, and the source agent did not`
        : `kept unchanged: ${target.id} will execute this, and whether the source agent did is unknown because the source was assumed`;
    } else if (targetExecutes === false) {
      fidelity = sourceExecutes === true ? 'degraded' : 'preserved';
      reason =
        sourceExecutes === true
          ? `kept as text: ${target.id} does not execute it, so what used to expand is now something the model reads`
          : `${target.id} does not execute it and neither did the source, so nothing changes`;
    } else {
      fidelity = 'degraded';
      reason = sourceKnown
        ? `kept as text: whether ${target.id} executes it is not documented`
        : `kept as text: the source agent was assumed, so whether it executed this is unknown`;
    }

    items.push({
      subject: `shell-injection:${occurrence.kind}@${occurrence.line}`,
      kind: 'shell-injection',
      fidelity,
      reason,
      line: occurrence.line,
      ...(sourceUrl === undefined ? {} : { source: sourceUrl }),
      detail: { kind: occurrence.kind, action: occurrence.action },
    });

    if (fidelity === 'dropped') worst = 'dropped';
    else if (fidelity === 'degraded' && worst !== 'dropped') worst = 'degraded';
    else if (fidelity === 'adapted' && worst === 'preserved') worst = 'adapted';
  }

  const changed = transformed.body !== ir.body;
  items.unshift({
    subject: 'body',
    kind: 'body',
    fidelity: changed ? worst : 'preserved',
    reason: changed
      ? `rewritten for ${target.id}: ${planned.filter((item) => item.action !== 'kept').length} shell occurrence(s) changed, everything else byte-exact`
      : 'copied byte-for-byte; line endings and spacing unchanged',
    ...(sourceUrl === undefined ? {} : { source: sourceUrl }),
  });

  return { body: transformed.body, items, occurrences: planned };
}
