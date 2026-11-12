import { LineCounter, parseDocument, isMap, type YAMLMap } from 'yaml';

export interface RawField {
  key: string;
  value: unknown;
  /** Exact YAML source for this entry, from the key to the end of its value. */
  raw: string;
  /** 1-based line in the skill file (not in the frontmatter fragment). */
  line: number;
  column: number;
}

export interface FrontmatterSplit {
  present: boolean;
  /** Raw YAML text between the delimiters. */
  yaml: string;
  /** Offset in the file where the body starts. */
  bodyStart: number;
  /** Line number of the opening delimiter, or null when absent. */
  openLine: number | null;
}

/**
 * Split a skill file into frontmatter and body without touching either.
 *
 * The body is defined as everything after the closing delimiter's line
 * terminator, so it is byte-exact: CRLF stays CRLF, trailing newlines stay put.
 */
export function splitFrontmatter(text: string): FrontmatterSplit {
  const firstNewline = text.indexOf('\n');
  const firstLine = (firstNewline === -1 ? text : text.slice(0, firstNewline)).replace(/\r$/, '');

  if (firstLine !== '---') {
    return { present: false, yaml: '', bodyStart: 0, openLine: null };
  }

  let lineStart = firstNewline === -1 ? text.length : firstNewline + 1;
  const yamlStart = lineStart;

  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd).replace(/\r$/, '');

    if (line === '---' || line === '...') {
      return {
        present: true,
        yaml: text.slice(yamlStart, lineStart),
        bodyStart: newline === -1 ? text.length : newline + 1,
        openLine: 1,
      };
    }

    if (newline === -1) break;
    lineStart = newline + 1;
  }

  // An opening delimiter with no closing one: treat the whole file as body and
  // let the caller report it, rather than guessing where the frontmatter ended.
  return { present: false, yaml: '', bodyStart: 0, openLine: null };
}

export interface ParsedFrontmatter {
  fields: RawField[];
  errors: string[];
}

/**
 * Parse the frontmatter fragment and recover, for each top-level key, the exact
 * source text and its position in the file.
 *
 * This is what makes the IR source-oriented: an unknown field can be re-emitted
 * byte-for-byte instead of being round-tripped through a YAML serialiser that
 * would reflow block scalars and drop comments.
 */
export function parseFrontmatterFields(yamlText: string): ParsedFrontmatter {
  const lineCounter = new LineCounter();
  const document = parseDocument(yamlText, { lineCounter, keepSourceTokens: true });

  if (document.errors.length > 0) {
    return { fields: [], errors: document.errors.map((error) => error.message) };
  }

  if (document.contents === null) return { fields: [], errors: [] };
  if (!isMap(document.contents)) {
    return { fields: [], errors: ['frontmatter must be a YAML mapping'] };
  }

  const map = document.contents as YAMLMap;
  const fields: RawField[] = [];

  for (const pair of map.items) {
    const keyNode = pair.key as { value?: unknown; range?: [number, number, number] } | null;
    const key = typeof keyNode?.value === 'string' ? keyNode.value : String(keyNode?.value ?? '');
    if (key === '') continue;

    const valueNode = pair.value as { range?: [number, number, number] } | null;
    const start = keyNode?.range?.[0] ?? 0;
    const end = valueNode?.range?.[1] ?? keyNode?.range?.[1] ?? start;

    const position = lineCounter.linePos(start);
    fields.push({
      key,
      value: valueNode === null ? null : (pair.value as { toJSON(): unknown }).toJSON(),
      raw: yamlText.slice(start, end),
      // +1 because the opening `---` occupies line 1 of the file.
      line: position.line + 1,
      column: position.col,
    });
  }

  return { fields, errors: [] };
}

/** Read a string field, ignoring non-strings rather than coercing them. */
export function stringField(fields: readonly RawField[], key: string): string | undefined {
  const field = fields.find((candidate) => candidate.key === key);
  return typeof field?.value === 'string' ? field.value : undefined;
}
