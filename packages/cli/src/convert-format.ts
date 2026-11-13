import { relative as pathRelative } from 'node:path';
import type { ConversionItem, ConversionReport, Fidelity, TargetReport } from '@skillporter/core';

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

const FIDELITY_ORDER: Fidelity[] = ['preserved', 'adapted', 'renamed', 'degraded', 'dropped'];

function tally(summary: { preserved: number; adapted: number; renamed: number; degraded: number; dropped: number }): string {
  return FIDELITY_ORDER.map((key) => `${summary[key]} ${key}`).join(' · ');
}

function sourceLine(report: ConversionReport): string {
  const { source } = report;
  const how = source.explicit ? 'given with --from' : source.assumed ? 'assumed, not verified' : 'detected';
  return `${source.agent} (${how}) · ${source.input} · identity ${source.identity} · ${source.layout} layout`;
}

function modeLine(report: ConversionReport): string {
  const where = report.mode === 'install' ? 'installed into the target roots' : 'written under --out';
  return report.dryRun ? `dry run: nothing written (would be ${where})` : where;
}

/**
 * The source path as the user would type it.
 *
 * The report stores an absolute path so it is unambiguous, but a terminal
 * report is read next to the command that produced it. `inspect` prints the
 * argument it was given; `convert` only has the resolved path, so it is shown
 * relative to the working directory when that is shorter.
 */
function displayPath(absolute: string): string {
  const relative = pathRelative(process.cwd(), absolute);
  return relative !== '' && !relative.startsWith('..') ? relative : absolute;
}

export function renderConvert(report: ConversionReport): string {
  const lines: string[] = [];
  lines.push(`${report.source.identity}  ·  ${displayPath(report.source.path)}`);
  lines.push('');

  const rows: [string, string][] = [
    ['source', sourceLine(report)],
    ['mode', modeLine(report)],
    ['targets', report.targets.map((target) => target.target).join(', ')],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value] of rows) lines.push(`  ${pad(label, width)}  ${value}`);

  for (const target of report.targets) {
    lines.push('');
    const state = target.written ? '' : report.dryRun ? '  (not written)' : '  (skipped)';
    lines.push(`  ${target.displayName} (${target.target})${state}`);
    lines.push(`    → ${target.destination}`);
    lines.push(`    ${tally(target.summary)}`);

    if (target.items.length > 0) {
      const subjectWidth = Math.min(34, Math.max(...target.items.map((item) => item.subject.length)));
      for (const item of target.items) {
        lines.push(`      ${pad(item.subject, subjectWidth)}  ${pad(item.fidelity, 10)}${item.reason}`);
      }
    }

    const lint = target.lint;
    if (lint !== null) {
      lines.push('');
      const verdict = lint.summary.errors > 0 ? 'error' : lint.summary.warnings > 0 ? 'warnings' : 'clean';
      lines.push(
        `    lint of the output  ${verdict}  ·  ${lint.summary.errors} error(s), ${lint.summary.warnings} warning(s), ${lint.summary.info} info`,
      );
      for (const finding of lint.findings) {
        if (finding.severity === 'info') continue;
        const where = finding.line === undefined ? '' : `:${finding.line}`;
        lines.push(`      ${pad(finding.severity, 8)}${pad(finding.ruleId ?? '', 7)}${finding.message}${where}`);
      }
    }
  }

  if (report.roots.length > 0) {
    lines.push('');
    lines.push('  roots');
    for (const root of report.roots) {
      const targets = root.targets.join(', ');
      lines.push(`    ${root.path}  [${root.scope}]  ${root.action}  for ${targets}`);
      if (root.backup !== undefined) lines.push(`      previous contents moved to ${root.backup}`);
      if (root.note !== undefined) lines.push(`      ${root.note}`);
    }
  }

  if (report.overlaps.length > 0) {
    lines.push('');
    lines.push('  overlaps');
    for (const overlap of report.overlaps) {
      lines.push(`    ${overlap.target} also reads ${overlap.root}, written for ${overlap.writtenFor}`);
      lines.push(`      ${overlap.precedence}`);
    }
  }

  if (report.notes.length > 0) {
    lines.push('');
    for (const note of report.notes) lines.push(`  note  ${note}`);
  }

  lines.push('');
  const { summary } = report;
  const verdict = summary.result === 'degraded' ? 'converted with losses' : 'converted cleanly';
  lines.push(`  result  ${verdict}  ·  ${tally(summary)}`);
  return lines.join('\n');
}

function mdCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

export function renderConvertMarkdown(report: ConversionReport): string {
  const lines: string[] = [];
  lines.push(`# Conversion report: ${report.source.identity}`);
  lines.push('');
  lines.push(`- Source: \`${report.source.path}\` (${report.source.agent}, ${report.source.input}, ${report.source.layout} layout)`);
  lines.push(`- Source agent: ${report.source.explicit ? 'given with `--from`' : report.source.assumed ? 'assumed, not verified' : 'detected from the location'}`);
  lines.push(`- Mode: ${modeLine(report)}`);
  lines.push(`- Targets: ${report.targets.map((target) => `\`${target.target}\``).join(', ')}`);
  lines.push('');

  for (const target of report.targets) {
    lines.push(`## ${target.displayName} (\`${target.target}\`)`);
    lines.push('');
    lines.push(`Destination: \`${target.destination}\`${target.written ? '' : ' (not written)'}`);
    lines.push('');
    lines.push(`| Preserved | Adapted | Renamed | Degraded | Dropped |`);
    lines.push(`| --- | --- | --- | --- | --- |`);
    lines.push(
      `| ${target.summary.preserved} | ${target.summary.adapted} | ${target.summary.renamed} | ${target.summary.degraded} | ${target.summary.dropped} |`,
    );
    lines.push('');
    lines.push('| Item | Fidelity | Why | Source |');
    lines.push('| --- | --- | --- | --- |');
    for (const item of target.items) {
      lines.push(
        `| \`${mdCell(item.subject)}\` | ${item.fidelity} | ${mdCell(item.reason)} | ${item.source === undefined ? '' : `<${item.source}>`} |`,
      );
    }
    lines.push('');

    if (target.lint !== null && target.lint.findings.length > 0) {
      lines.push(`Post-conversion lint: ${target.lint.summary.errors} error(s), ${target.lint.summary.warnings} warning(s).`);
      lines.push('');
      lines.push('| Severity | Rule | Line | Finding |');
      lines.push('| --- | --- | --- | --- |');
      for (const finding of target.lint.findings) {
        lines.push(
          `| ${finding.severity} | \`${finding.ruleId ?? ''}\` | ${finding.line ?? ''} | ${mdCell(finding.message)} |`,
        );
      }
      lines.push('');
    }
  }

  if (report.roots.length > 0) {
    lines.push('## Roots');
    lines.push('');
    for (const root of report.roots) {
      lines.push(`- \`${root.path}\` (${root.scope}, ${root.action}) for ${root.targets.join(', ')}`);
      if (root.backup !== undefined) lines.push(`  - previous contents moved to \`${root.backup}\``);
      if (root.note !== undefined) lines.push(`  - ${root.note}`);
    }
    lines.push('');
  }

  if (report.overlaps.length > 0) {
    lines.push('## Overlaps');
    lines.push('');
    for (const overlap of report.overlaps) {
      lines.push(
        `- \`${overlap.target}\` also reads \`${overlap.root}\`, written for \`${overlap.writtenFor}\`. ${overlap.precedence}`,
      );
    }
    lines.push('');
  }

  if (report.notes.length > 0) {
    lines.push('## Notes');
    lines.push('');
    for (const note of report.notes) lines.push(`- ${note}`);
    lines.push('');
  }

  const { summary } = report;
  lines.push(
    `**Result:** ${summary.result === 'degraded' ? 'converted with losses' : 'converted cleanly'} — ${tally(summary)}.`,
  );
  return lines.join('\n');
}

export function countByFidelity(items: readonly ConversionItem[]): Record<Fidelity, number> {
  const counts: Record<Fidelity, number> = { preserved: 0, adapted: 0, renamed: 0, degraded: 0, dropped: 0 };
  for (const item of items) counts[item.fidelity] += 1;
  return counts;
}
