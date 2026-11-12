import type { Diagnostic } from '@skillporter/core';
import type { AgentProfile } from '@skillporter/core';
import type { Detection } from '@skillporter/core';
import type { LintResult } from '@skillporter/core';
import type { SkillIR } from '@skillporter/core';

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function indent(text: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line.length === 0 ? line : prefix + line))
    .join('\n');
}

function renderDiagnostic(item: Diagnostic): string {
  const location = item.file ? `${item.file}${item.line ? `:${item.line}` : ''}` : '';
  const head = `  ${pad(item.severity, 8)}${pad(item.code, 24)}${pad(location, 16)}${item.message}`;
  if (!item.hint) return head.trimEnd();
  return `${head.trimEnd()}\n${indent(`hint: ${item.hint}`, 10)}`;
}

export function renderInspect(ir: SkillIR, detection: Detection, requestedPath: string): string {
  const lines: string[] = [];
  const errors = ir.diagnostics.filter((item) => item.severity === 'error');
  const warnings = ir.diagnostics.filter((item) => item.severity === 'warning');
  const infos = ir.diagnostics.filter((item) => item.severity === 'info');

  lines.push(`${ir.identity.name}  ·  ${requestedPath}`);
  lines.push('');

  const detectedBy =
    detection.agent === ir.origin.agent
      ? detection.reason
      : `given with --from; auto-detection said: ${detection.reason}`;

  const rows: [string, string][] = [
    ['origin', `${ir.origin.agentDisplayName} (${ir.origin.agent}, ${ir.origin.format}, ${ir.origin.layout} layout)`],
    ['identity', `${ir.identity.name}${ir.identity.displayName && ir.identity.displayName !== ir.identity.name ? ` (label: ${ir.identity.displayName})` : ''}  [from ${ir.identity.source}]`],
    ['description', ir.description === '' ? '(none)' : ir.description],
    ['text', `line endings ${ir.text.lineEnding.toUpperCase()}  ·  BOM ${ir.text.hasBom ? 'yes' : 'no'}`],
    ['body', `${formatBytes(Buffer.byteLength(ir.body, 'utf8'))}  ·  sha256 ${ir.bodyHash.slice(0, 12)}`],
    ['frontmatter', ir.frontmatter.present ? `${ir.frontmatter.fields.length} field(s)` : 'absent'],
    ['detected by', detectedBy],
  ];

  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value] of rows) {
    lines.push(`  ${pad(label, width)}  ${value}`);
  }

  if (ir.frontmatter.fields.length > 0) {
    lines.push('');
    lines.push('  fields');
    const keyWidth = Math.max(...ir.frontmatter.fields.map((field) => field.key.length));
    for (const field of ir.frontmatter.fields) {
      const kind = Array.isArray(field.value) ? 'list' : field.value === null ? 'null' : typeof field.value;
      const flag = field.effect === 'unknown' ? `unknown (line ${field.line})` : field.effect;
      lines.push(`    ${pad(field.key, keyWidth)}  ${pad(kind, 7)}  ${flag}`);
    }
  }

  lines.push('');
  if (ir.files.length === 0) {
    lines.push('  files        none');
  } else {
    lines.push(`  files        ${ir.files.length}`);
    const pathWidth = Math.max(...ir.files.map((file) => file.path.length));
    for (const file of ir.files) {
      const mode = file.mode === 0 ? '----' : file.mode.toString(8).padStart(4, '0');
      const ending = file.lineEnding === null ? '' : `  ${file.lineEnding}`;
      lines.push(`    ${pad(file.path, pathWidth)}  ${pad(formatBytes(file.size), 8)}  ${pad(file.encoding, 6)}${ending}  ${mode}`);
    }
  }

  lines.push('');
  lines.push(
    `  limits       tool limits, not agent limits: file ${formatBytes(ir.limits.maxFileBytes)} · files ${ir.limits.maxFiles} · total ${formatBytes(ir.limits.maxTotalBytes)} · depth ${ir.limits.maxDepth}`,
  );

  if (ir.shellInjection.length > 0) {
    lines.push('');
    lines.push(`  shell syntax found: ${ir.shellInjection.length} occurrence(s), none executed`);
    for (const occurrence of ir.shellInjection) {
      const first = occurrence.command.split('\n')[0] ?? '';
      lines.push(`    line ${occurrence.line}  ${occurrence.kind}  ${first.slice(0, 60)}`);
    }
  }

  const all = [...errors, ...warnings, ...infos];
  lines.push('');
  if (all.length === 0) {
    lines.push('  diagnostics  none');
  } else {
    lines.push(`  diagnostics  ${errors.length} error(s), ${warnings.length} warning(s), ${infos.length} info`);
    for (const item of all) lines.push(renderDiagnostic(item));
  }

  lines.push('');
  lines.push(errors.length > 0 ? '  result  error' : '  result  ok');
  return lines.join('\n');
}

export function renderAgents(profiles: readonly AgentProfile[]): string {
  const lines: string[] = [`${profiles.length} supported agents`, ''];
  const idWidth = Math.max(...profiles.map((profile) => profile.id.length));

  for (const profile of profiles) {
    const supported = Object.values(profile.fields).filter((field) => field.status === 'supported').length;
    const ignored = Object.values(profile.fields).filter((field) => field.status === 'ignored').length;
    const unknown = Object.values(profile.fields).filter((field) => field.status === 'unknown').length;

    lines.push(`${pad(profile.id, idWidth)}  ${profile.displayName}  [${profile.verification}]`);

    const project = profile.paths.project.map((entry) => entry.path).join(', ');
    const global = profile.paths.global.map((entry) => entry.path).join(', ');
    lines.push(`  ${pad('project', 9)} ${project}`);
    lines.push(`  ${pad('global', 9)} ${global}`);

    const discovery = profile.discovery;
    const symlinks = discovery.followsSymlinks === null ? 'unknown' : discovery.followsSymlinks ? 'yes' : 'no';
    lines.push(
      `  ${pad('discover', 9)} depth ${String(discovery.skillDirDepth)} · upward ${discovery.upwardSearch ? 'yes' : 'no'} · symlinks ${symlinks} · flat .md ${discovery.acceptsFlatMarkdown ? 'yes' : 'no'}`,
    );

    const required =
      profile.identity.requiredInDirectoryForm === true
        ? 'required'
        : profile.identity.requiredInDirectoryForm === false
          ? 'optional'
          : 'unknown';
    lines.push(`  ${pad('identity', 9)} ${profile.identity.source} · name ${required}`);

    const pattern = profile.name.pattern === null ? 'no grammar' : profile.name.pattern;
    lines.push(`  ${pad('name', 9)} ${pattern} · ${profile.name.enforcement}`);

    const truncation = profile.description.truncation;
    const describe = truncation
      ? `no hard limit · truncates at ${truncation.at} ${truncation.unit}`
      : profile.description.maxLength === null
        ? 'no limit documented'
        : `max ${profile.description.maxLength}`;
    lines.push(`  ${pad('describe', 9)} ${describe}`);

    lines.push(`  ${pad('fields', 9)} ${supported} supported, ${ignored} ignored, ${unknown} unknown`);

    const executed = profile.bodyExecution.shellInjection.executed;
    lines.push(`  ${pad('executes', 9)} shell syntax in body: ${executed === 'unknown' ? 'unknown' : executed ? 'yes' : 'no'}`);

    const dates = [...new Set(profile.sources.map((source) => source.retrieved))].sort();
    lines.push(`  ${pad('sources', 9)} ${profile.sources.length} (${dates.join(', ')})`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function renderFinding(item: Diagnostic): string {
  const location = item.file ? `${item.file}${item.line === undefined ? '' : `:${item.line}`}` : '';
  const head = `  ${pad(item.severity, 8)}${pad(item.ruleId ?? '', 7)}${pad(location, 16)}${item.message}`;
  const lines = [head.trimEnd()];
  if (item.hint !== undefined) lines.push(indent(`hint: ${item.hint}`, 10));
  if (item.fix !== undefined) lines.push(indent(`fix:  ${item.fix}`, 10));
  if (item.source !== undefined) lines.push(indent(`see:  ${item.source}`, 10));
  return lines.join('\n');
}

export function renderLint(result: LintResult, requestedPath: string): string {
  const lines: string[] = [`${result.skill.identity}  ·  ${requestedPath}`, ''];

  const { detection } = result.source;
  const sourceLine = result.source.explicit
    ? `${result.source.agent}  (given with --from)`
    : result.source.assumed
      ? `${result.source.agent}  (assumed: ${detection.reason})`
      : `${result.source.agent}  (${detection.reason})`;

  const rows: [string, string][] = [
    ['target', `${result.target.displayName} (${result.target.id}) [${result.target.verification}]`],
    ['source', sourceLine],
    ['identity', `${result.skill.identity}  [from ${result.skill.identitySource}]`],
    ['layout', result.skill.layout],
  ];

  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value] of rows) lines.push(`  ${pad(label, width)}  ${value}`);

  if (result.source.assumed) {
    lines.push('');
    if (detection.candidates.length > 0) {
      lines.push(
        `  ${pad('note', width)}  ${detection.matchedRoot ?? 'this location'} is read natively by ` +
          `${detection.candidates.join(', ')}, so no single agent owns it.`,
      );
      lines.push(`  ${pad('', width)}  A source was assumed only to read the file; the rules below are ${result.target.id}'s.`);
      lines.push(`  ${pad('', width)}  Pass --from to remove the assumption.`);
    } else {
      lines.push(
        `  ${pad('note', width)}  A source was assumed only to read the file; the rules below are ${result.target.id}'s.`,
      );
    }
  }

  lines.push('');
  if (result.findings.length === 0) {
    lines.push(`  no findings for ${result.target.id}`);
  } else {
    for (const item of result.findings) lines.push(renderFinding(item));
  }

  const { summary } = result;
  lines.push('');
  if (summary.suppressed > 0) {
    lines.push(`  ${summary.suppressed} unknown-capability finding(s) suppressed by --ignore-unknown`);
  }
  const tally = `${summary.errors} error(s), ${summary.warnings} warning(s), ${summary.info} info`;
  const verdict = summary.result === 'error' ? 'error' : summary.result === 'warning' ? 'warnings' : 'ok';
  lines.push(`  result  ${verdict}  ·  ${tally}`);
  return lines.join('\n');
}
