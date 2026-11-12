/**
 * Detection of shell-injection syntax in skill bodies.
 *
 * This module only *finds* text. Nothing here executes anything, and nothing in
 * this package ever will: a skill is data, and the converter's contract is that
 * it reads bytes and writes bytes.
 */

export type ShellSyntax = 'inline-bang' | 'fenced-bang';

export interface ShellInjectionOccurrence {
  kind: ShellSyntax;
  /** 1-based line in the skill file. */
  line: number;
  column: number;
  /** Exact source text of the placeholder. */
  text: string;
  /** The command body. Recorded for the report; never run. */
  command: string;
  /** True when the placeholder sits inside a fenced block that is not a `!` block. */
  insideCodeFence: boolean;
}

interface FenceState {
  char: string;
  length: number;
  bang: boolean;
  startLineIndex: number;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const INLINE_BANG = /(^|[\s])!`([^`\n]+)`/g;

function scanInline(line: string, lineNumber: number, insideCodeFence: boolean, out: ShellInjectionOccurrence[]): void {
  INLINE_BANG.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_BANG.exec(line)) !== null) {
    const prefix = match[1] ?? '';
    const command = match[2] ?? '';
    out.push({
      kind: 'inline-bang',
      line: lineNumber,
      column: prefix.length + 1,
      text: match[0].slice(prefix.length),
      command,
      insideCodeFence,
    });
  }
}

/**
 * Find every `!`command`` placeholder and every ```! block.
 *
 * Inline placeholders are reported even inside ordinary code fences. Claude Code
 * substitutes before the body reaches the model, so a placeholder shown inside a
 * bash example is still executable; a false positive here is much cheaper than a
 * missed one.
 *
 * `lineOffset` is added to every reported line, so the result is a line number in
 * the skill file rather than in the body fragment.
 */
export function scanShellInjection(body: string, lineOffset = 0): ShellInjectionOccurrence[] {
  const lines = body.split('\n');
  const occurrences: ShellInjectionOccurrence[] = [];
  let fence: FenceState | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').replace(/\r$/, '');
    const fenceMatch = FENCE_OPEN.exec(line);
    const lineNumber = index + 1 + lineOffset;

    if (fence === null) {
      if (fenceMatch) {
        const marker = fenceMatch[1] ?? '```';
        fence = {
          char: marker[0] ?? '`',
          length: marker.length,
          bang: (fenceMatch[2] ?? '').trim().startsWith('!'),
          startLineIndex: index,
        };
        continue;
      }
      scanInline(line, lineNumber, false, occurrences);
      continue;
    }

    const closes =
      fenceMatch !== null &&
      (fenceMatch[1] ?? '')[0] === fence.char &&
      (fenceMatch[1] ?? '').length >= fence.length &&
      (fenceMatch[2] ?? '').trim() === '';

    if (closes) {
      if (fence.bang) {
        const content = lines.slice(fence.startLineIndex + 1, index).map((raw) => raw.replace(/\r$/, ''));
        occurrences.push({
          kind: 'fenced-bang',
          line: fence.startLineIndex + 1 + lineOffset,
          column: 1,
          text: ['```!', ...content, '```'].join('\n'),
          command: content.join('\n'),
          insideCodeFence: true,
        });
      }
      fence = null;
      continue;
    }

    if (!fence.bang) scanInline(line, lineNumber, true, occurrences);
  }

  return occurrences;
}

/** True when the body contains syntax the given agent would execute. */
export function hasShellInjection(occurrences: readonly ShellInjectionOccurrence[]): boolean {
  return occurrences.length > 0;
}
