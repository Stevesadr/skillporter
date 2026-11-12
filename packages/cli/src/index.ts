#!/usr/bin/env node
import { Command, Option } from 'commander';
import {
  AmbiguousSourceError,
  ProfileError,
  SkillParseError,
  exitCodeForSummary,
  lintSkill,
  loadProfiles,
  parseSkill,
  type ToolLimits,
} from '@skillporter/core';
import { renderAgents, renderInspect, renderLint } from './format.js';

const program = new Command();

program
  .name('skillporter')
  .description('Convert AI agent skills between agent formats, with an explicit fidelity report.')
  .version('0.0.0');

function limitOptions(command: Command): Command {
  return command
    .addOption(new Option('--max-file-bytes <bytes>', 'tool limit: largest bundled file to read').argParser(Number))
    .addOption(new Option('--max-files <count>', 'tool limit: most bundled files to enumerate').argParser(Number))
    .addOption(new Option('--max-total-bytes <bytes>', 'tool limit: total size of bundled files').argParser(Number))
    .addOption(new Option('--max-depth <levels>', 'tool limit: deepest nesting below the skill root').argParser(Number));
}

function limitsFrom(options: Record<string, unknown>): Partial<ToolLimits> {
  const limits: Partial<ToolLimits> = {};
  if (typeof options.maxFileBytes === 'number') limits.maxFileBytes = options.maxFileBytes;
  if (typeof options.maxFiles === 'number') limits.maxFiles = options.maxFiles;
  if (typeof options.maxTotalBytes === 'number') limits.maxTotalBytes = options.maxTotalBytes;
  if (typeof options.maxDepth === 'number') limits.maxDepth = options.maxDepth;
  return limits;
}

limitOptions(
  program
    .command('inspect <path>')
    .description('parse a skill and show its intermediate representation plus any diagnostics')
    .option('--from <agent>', 'source agent, required when the directory is shared by several agents')
    .option('--json', 'emit the IR as JSON')
    .action(async (target: string, options: Record<string, unknown>) => {
      try {
        const result = await parseSkill({
          path: target,
          ...(typeof options.from === 'string' ? { from: options.from } : {}),
          limits: limitsFrom(options),
        });

        if (options.json === true) {
          process.stdout.write(`${JSON.stringify({ detection: result.detection, ir: result.ir }, null, 2)}\n`);
        } else {
          process.stdout.write(`${renderInspect(result.ir, result.detection, target)}\n`);
        }

        const failed = result.ir.diagnostics.some((item) => item.severity === 'error');
        process.exitCode = failed ? 1 : 0;
      } catch (error) {
        reportError(error);
      }
    }),
);

limitOptions(
  program
    .command('lint <path>')
    .description('check whether a skill will work on a target agent. Read-only: nothing is executed and nothing is written')
    .requiredOption('--for <agent>', 'target agent to check against')
    .option('--from <agent>', 'source agent; inferred from the path when omitted')
    .addOption(new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'))
    .option('--json', 'alias for --format json')
    .option('--ignore-unknown', 'suppress UNKNOWN_CAPABILITY findings')
    .action(async (target: string, options: Record<string, unknown>) => {
      try {
        const result = await lintSkill({
          path: target,
          for: String(options.for),
          ...(typeof options.from === 'string' ? { from: options.from } : {}),
          ...(options.ignoreUnknown === true ? { ignoreUnknown: true } : {}),
          limits: limitsFrom(options),
        });

        if (options.format === 'json' || options.json === true) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          process.stdout.write(`${renderLint(result, target)}\n`);
        }

        process.exitCode = exitCodeForSummary(result.summary);
      } catch (error) {
        reportError(error, 'lint');
      }
    }),
);

program
  .command('agents')
  .description('list supported agents and their capability summary')
  .option('--json', 'emit the capability profiles as JSON')
  .action(async (options: Record<string, unknown>) => {
    try {
      const profiles = await loadProfiles();
      if (options.json === true) {
        process.stdout.write(`${JSON.stringify(profiles, null, 2)}\n`);
      } else {
        process.stdout.write(`${renderAgents(profiles)}\n`);
      }
    } catch (error) {
      reportError(error);
    }
  });

function reportError(error: unknown, command = 'inspect'): void {
  if (error instanceof AmbiguousSourceError) {
    const { detection } = error;
    process.stderr.write(`error: cannot tell which agent this skill belongs to.\n\n`);
    process.stderr.write(`  ${detection.reason}\n\n`);
    if (detection.candidates.length > 0) {
      process.stderr.write(`  These agents read it natively: ${detection.candidates.join(', ')}\n`);
      if (detection.alsoReadBy.length > 0) {
        process.stderr.write(`  Also read, as a compatibility source: ${detection.alsoReadBy.join(', ')}\n`);
      }
      process.stderr.write(`  Their rules differ, so skillporter will not pick one for you.\n\n`);
      process.stderr.write(`  Re-run with --from <agent>, for example:\n`);
      process.stderr.write(`    skillporter ${command} <path> --from ${detection.candidates[0]}\n`);
    } else {
      process.stderr.write(`  Re-run with --from <agent>. Run \`skillporter agents\` to list them.\n`);
    }
    process.exitCode = 1;
    return;
  }

  if (error instanceof SkillParseError || error instanceof ProfileError) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

await program.parseAsync(process.argv);
