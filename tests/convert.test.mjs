import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse as parseYaml } from 'yaml';
import { renderConvert, renderConvertMarkdown } from '../packages/cli/dist/convert-format.js';

import {
  applyShellPolicy,
  assertSafeArchiveEntry,
  convertSkill,
  exitCodeForConversion,
  emitField,
  emitScalarField,
  extractZip,
  loadProfiles,
  parseSkill,
  resolveDocumentedPath,
  resolveLimits,
  rootsFor,
  summariseUnique,
  writeSkill,
} from '../packages/core/dist/index.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'index.js');
const GOLDEN = 'fixtures/golden';
const SIMPLE = 'fixtures/skills/changelog-writer';
const REPORT_BUILDER = 'fixtures/skills/report-builder';
const FLOW = 'fixtures/skills/flow-release';
const ALIAS = 'fixtures/lint/.agents/skills/alias-spelling';

function run(args, options = {}) {
  return new Promise((settle) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd: ROOT, maxBuffer: 8 * 1024 * 1024, ...options },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        settle({ code, stdout, stderr });
      },
    );
  });
}

/** Every regular file under `dir`, as a sorted list of posix paths relative to it. */
async function listFiles(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}

/**
 * The skills an agent would actually find in `root`: direct children that hold a
 * `SKILL.md`.
 *
 * Root contents are asserted through this rather than by listing every entry,
 * because the property that matters is "an agent scanning this directory finds
 * exactly the skill we meant to write". A hidden staging directory that was
 * created and then could not be removed — a sandbox may forbid the delete —
 * holds no `SKILL.md` of its own and is therefore not a skill.
 */
async function discoverableSkills(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (existsSync(join(root, entry.name, 'SKILL.md'))) found.push(entry.name);
  }
  return found.sort();
}

/**
 * A throwaway directory under the repo's ignored `.tmp`, cleaned up afterwards.
 *
 * Deliberately not the OS temp directory: a sandbox policy can block deleting
 * there. Cleanup is best-effort and must never fail a test — a locked-down
 * environment that refuses the delete leaves a directory under `.tmp/`, which is
 * ignored, rather than a red build.
 */
async function sandbox(t) {
  const base = join(ROOT, '.tmp');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'convert-'));
  t.after(async () => {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // Left behind under .tmp/, which is gitignored.
    }
  });
  return dir;
}

async function read(path) {
  return readFile(path, 'utf8');
}

/**
 * `convertSkill` with the staging directory pinned inside the repo.
 *
 * The default is the OS temporary directory, which a restrictive sandbox may
 * refuse to clean up. Staging is only ever read and then removed, so moving it
 * changes nothing about what the test asserts.
 */
async function convert(options) {
  const stagingRoot = join(ROOT, '.tmp', 'stage');
  await mkdir(stagingRoot, { recursive: true });
  return convertSkill({ ...options, stagingRoot });
}

function subjects(target) {
  return target.items.map((item) => item.subject);
}

function itemsOf(target, kind) {
  return target.items.filter((item) => item.kind === kind);
}

function targetOf(report, id) {
  const found = report.targets.find((candidate) => candidate.target === id);
  assert.ok(found, `no report section for ${id}`);
  return found;
}

// ---------------------------------------------------------------------------
// 1. Golden files, one per source/target pair class.
//
// The five agents fall into two classes for conversion purposes: Claude Code
// executes shell syntax in the body, the other four do not. A simple skill with
// no shell syntax and no agent-specific field is therefore byte-identical
// everywhere, and a skill with shell syntax differs only in the body. Both
// claims are checked against committed bytes, not against the planner's own
// idea of what it wrote.
// ---------------------------------------------------------------------------

const GOLDEN_CASES = [
  // Class A: no shell syntax, no agent-specific fields -> identical everywhere.
  ...['codex-cli', 'deepseek-harness', 'kimi-code', 'opencode', 'claude-code'].map((agent) => ({
    name: `changelog-writer -> ${agent}`,
    path: SIMPLE,
    from: 'claude-code',
    to: agent,
    golden: `${GOLDEN}/changelog-writer/${agent}/changelog-writer`,
  })),
  // Class B: non-executing source -> non-executing target. The body is copied
  // as text and each occurrence is reported as degraded, never rewritten.
  {
    name: 'report-builder -> codex-cli (text kept, reported)',
    path: REPORT_BUILDER,
    from: 'claude-code',
    to: 'codex-cli',
    golden: `${GOLDEN}/report-builder/codex-cli/report-builder`,
  },
  // Class C: non-executing source -> executing target. The default policy
  // neutralizes, so the output is not executable where the source was not.
  {
    name: 'report-builder -> claude-code (neutralized)',
    path: REPORT_BUILDER,
    from: 'codex-cli',
    to: 'claude-code',
    golden: `${GOLDEN}/report-builder/claude-neutralized/report-builder`,
  },
  // Class D: a target that documents a closed field set. Everything except
  // name and description is removed, and the output is a bundle to upload
  // rather than a directory anything scans.
  {
    name: 'changelog-writer -> claude-ai-upload',
    path: SIMPLE,
    from: 'claude-code',
    to: 'claude-ai-upload',
    golden: `${GOLDEN}/changelog-writer/claude-ai-upload/changelog-writer`,
  },
  {
    name: 'report-builder -> claude-ai-upload (fields dropped)',
    path: REPORT_BUILDER,
    from: 'claude-code',
    to: 'claude-ai-upload',
    golden: `${GOLDEN}/report-builder/claude-ai-upload/report-builder`,
  },
];

for (const testCase of GOLDEN_CASES) {
  test(`golden: ${testCase.name}`, async (t) => {
    const out = await sandbox(t);
    const report = await convert({
      path: resolve(ROOT, testCase.path),
      from: testCase.from,
      to: [testCase.to],
      out,
    });
    assert.equal(report.targets.length, 1);

    const written = join(out, report.targets[0].directoryName);
    const expectedDir = join(ROOT, testCase.golden);

    const expected = await listFiles(expectedDir);
    const actual = await listFiles(written);
    assert.deepEqual(actual, expected, 'the set of written files must match the golden set');

    for (const relative of expected) {
      const want = await readFile(join(expectedDir, relative));
      const got = await readFile(join(written, relative));
      assert.ok(got.equals(want), `${relative} differs from ${testCase.golden}/${relative}`);
    }
  });
}

test('golden: a simple skill converts to identical bytes for all five agents', async (t) => {
  const out = await sandbox(t);
  const report = await convert({
    path: resolve(ROOT, SIMPLE),
    from: 'claude-code',
    to: ['codex-cli', 'deepseek-harness', 'kimi-code', 'opencode', 'claude-code'],
    out,
  });
  const source = await readFile(join(ROOT, SIMPLE, 'SKILL.md'));
  for (const target of report.targets) {
    const written = await readFile(join(out, target.target, 'changelog-writer', 'SKILL.md'));
    assert.ok(written.equals(source), `${target.target} changed a skill that had nothing to change`);
    assert.equal(target.summary.result, 'clean');
    assert.equal(target.lint.summary.errors, 0);
  }
});

test('golden: a report with bundled files copies them byte-for-byte and keeps the mode', async (t) => {
  const out = await sandbox(t);
  const report = await convert({ path: resolve(ROOT, REPORT_BUILDER), from: 'claude-code', to: ['codex-cli'], out });
  const target = report.targets[0];
  const written = join(out, 'report-builder');

  for (const relative of ['scripts/build_report.py', 'references/STYLE.md', 'references/nested/checklist.md', 'assets/logo.svg', 'assets/chart.png']) {
    const source = await readFile(join(ROOT, REPORT_BUILDER, relative));
    const copy = await readFile(join(written, relative));
    assert.ok(copy.equals(source), `${relative} was not copied byte-for-byte`);
  }

  // The mode the report states has to be the mode the file actually has on this
  // platform. NTFS has no executable bit, so on Windows a 0755 source is
  // checked out as 0666 and reported as 0666 — nothing was lost, because the
  // source never carried the bit there either.
  const sourceMode = (await stat(join(ROOT, REPORT_BUILDER, 'scripts/build_report.py'))).mode & 0o777;
  const script = target.files.find((file) => file.path === 'scripts/build_report.py');
  assert.equal(script.mode, sourceMode.toString(8).padStart(4, '0'), 'the report must state the mode that was applied');

  if (process.platform !== 'win32') {
    // Guard the fixture itself: if the checkout ever lost the executable bit,
    // the assertion above would still pass while testing nothing.
    assert.equal(sourceMode, 0o755, 'the fixture script should be executable in the repository');
    const copied = (await stat(join(written, 'scripts/build_report.py'))).mode & 0o777;
    assert.equal(copied, 0o755, 'the executable bit must survive the copy');
  }
});

test('golden: the body keeps Persian text and CRLF line endings untouched', async (t) => {
  const out = await sandbox(t);
  const crlf = await sandbox(t);
  const source = await read(join(ROOT, REPORT_BUILDER, 'SKILL.md'));
  const asCrlf = source.replace(/\n/g, '\r\n');
  await mkdir(join(crlf, 'crlf-skill'));
  await writeFile(join(crlf, 'crlf-skill', 'SKILL.md'), asCrlf);

  await convert({ path: join(crlf, 'crlf-skill'), from: 'claude-code', to: ['codex-cli'], out });
  const written = await readFile(join(out, 'report-builder', 'SKILL.md'), 'utf8');

  assert.ok(written.includes('این مهارت یک گزارش HTML مستقل'), 'Persian text must survive');
  assert.ok(written.includes('اعداد را با جداکنندهٔ هزارگان'), 'Persian text in a later section must survive');
  assert.equal(written.replace(/\r\n/g, '\n'), source, 'converting CRLF input must not normalize line endings');
  assert.equal((written.match(/\r\n/g) ?? []).length, (asCrlf.match(/\r\n/g) ?? []).length);
});

// ---------------------------------------------------------------------------
// 2. Nothing executes.
//
// A skill that would touch a marker file if anything ran it is converted to
// every agent, through both the library and the CLI. The marker must never
// appear. The shell-injection body is the interesting part: the converted
// output for a target that executes it must not contain the syntax that would
// run the script.
// ---------------------------------------------------------------------------

async function hostileSkill(dir) {
  const skill = join(dir, 'hostile-skill');
  await mkdir(join(skill, 'scripts'), { recursive: true });
  const marker = join(dir, 'MARKER');
  const script = join(skill, 'scripts', 'run-me.sh');
  await writeFile(script, `#!/bin/sh\ntouch "${marker}"\necho ran\n`, 'utf8');
  await chmod(script, 0o755);
  await writeFile(
    join(skill, 'SKILL.md'),
    [
      '---',
      'name: hostile-skill',
      'description: Prove that converting a skill never runs it. Use when testing the converter itself.',
      '---',
      '',
      '# Hostile skill',
      '',
      'The current branch is !`sh scripts/run-me.sh`.',
      '',
      '```!',
      'sh scripts/run-me.sh',
      '```',
      '',
      'If the marker file exists, something executed this skill.',
      '',
    ].join('\n'),
    'utf8',
  );
  return { skill, marker };
}

test('security: converting never executes a bundled script or a shell-injection body', async (t) => {
  const dir = await sandbox(t);
  const { skill, marker } = await hostileSkill(dir);
  const out = join(dir, 'out');

  const report = await convert({
    path: skill,
    from: 'claude-code',
    to: ['claude-code', 'codex-cli', 'deepseek-harness', 'kimi-code', 'opencode'],
    out,
  });
  assert.equal(report.targets.length, 5);
  assert.equal(existsSync(marker), false, 'the marker file must not exist after a conversion');

  // The same through the CLI, including --install, which is the risky path.
  const project = join(dir, 'project');
  await mkdir(project, { recursive: true });
  const cli = await run(['convert', skill, '--from', 'claude-code', '--to', 'codex-cli,deepseek-harness,kimi-code,opencode,claude-code', '--install'], {
    cwd: project,
  });
  assert.equal(existsSync(marker), false, 'the marker file must not exist after a CLI conversion');
  assert.ok(cli.code === 0 || cli.code === 2, `unexpected exit ${cli.code}: ${cli.stderr}`);
});

test('security: an executing target never receives executable shell syntax it did not have', async (t) => {
  const dir = await sandbox(t);
  const { skill } = await hostileSkill(dir);
  const out = join(dir, 'out');

  await convert({ path: skill, from: 'codex-cli', to: ['claude-code'], out });
  const written = await read(join(out, 'hostile-skill', 'SKILL.md'));

  assert.ok(!written.includes('!`'), 'an inline !`cmd` placeholder survived into claude-code');
  assert.ok(!written.includes('```!'), 'a fenced ```! block survived into claude-code');
  assert.ok(written.includes('`sh scripts/run-me.sh`'), 'the command should stay readable as plain text');
  assert.ok(written.includes('```text'), 'the fenced block should become a plain code block');
});

test('security: a skill that did execute in the source keeps its syntax for an executing target', async (t) => {
  const dir = await sandbox(t);
  const { skill } = await hostileSkill(dir);
  const out = join(dir, 'out');

  // Both ends execute, so nothing is introduced: the behaviour is unchanged.
  const report = await convert({ path: skill, from: 'claude-code', to: ['claude-code'], out });
  const written = await read(join(out, 'hostile-skill', 'SKILL.md'));
  assert.ok(written.includes('!`sh scripts/run-me.sh`'));
  const shell = itemsOf(report.targets[0], 'shell-injection');
  assert.equal(shell.length, 2);
  assert.ok(shell.every((item) => item.fidelity === 'preserved'));
});

// ---------------------------------------------------------------------------
// 3. Each shell-injection policy.
// ---------------------------------------------------------------------------

const POLICIES = [
  {
    policy: 'neutralize',
    fidelity: 'adapted',
    inline: '`git rev-parse --short HEAD`',
    fence: '```text',
    reason: /rewritten as a plain code span/,
  },
  {
    policy: 'keep',
    fidelity: 'degraded',
    inline: '!`git rev-parse --short HEAD`',
    fence: '```!',
    reason: /--shell-injection=keep/,
  },
  {
    policy: 'strip',
    fidelity: 'dropped',
    inline: null,
    fence: null,
    reason: /removed because claude-code would have executed it/,
  },
];

for (const testCase of POLICIES) {
  test(`shell policy: ${testCase.policy}`, async (t) => {
    const out = await sandbox(t);
    const report = await convert({
      path: resolve(ROOT, REPORT_BUILDER),
      from: 'codex-cli',
      to: ['claude-code'],
      out,
      shellPolicy: testCase.policy,
    });
    const written = await read(join(out, 'report-builder', 'SKILL.md'));
    const shell = itemsOf(report.targets[0], 'shell-injection');

    assert.equal(shell.length, 2, 'both occurrences must be reported');
    assert.deepEqual(
      shell.map((item) => item.line),
      [23, 27],
      'the reported lines must be file lines, not body lines',
    );
    for (const item of shell) {
      assert.equal(item.fidelity, testCase.fidelity);
      assert.match(item.reason, testCase.reason);
    }

    if (testCase.inline === null) {
      assert.ok(!written.includes('git rev-parse --short HEAD'), 'strip must remove the command');
      assert.ok(!written.includes('python scripts/build_report.py'), 'strip must remove the fenced command');
    } else {
      assert.ok(written.includes(testCase.inline), `expected ${testCase.inline} in the output`);
      assert.ok(written.includes(testCase.fence), `expected ${testCase.fence} in the output`);
    }
    assert.ok(!written.includes('!`') || testCase.policy === 'keep');
  });
}

test('shell policy: nothing is rewritten when the target does not execute the syntax', async (t) => {
  const out = await sandbox(t);
  const report = await convert({
    path: resolve(ROOT, REPORT_BUILDER),
    from: 'claude-code',
    to: ['codex-cli'],
    out,
    shellPolicy: 'strip',
  });
  const written = await read(join(out, 'report-builder', 'SKILL.md'));
  assert.ok(written.includes('!`git rev-parse --short HEAD`'), 'strip must not apply to a target that does not execute');
  const shell = itemsOf(report.targets[0], 'shell-injection');
  assert.ok(shell.every((item) => item.fidelity === 'degraded'));
});

test('shell policy: applyShellPolicy is pure and preserves line endings', () => {
  const body = 'a\r\nb !`x`\r\nc\r\n';
  const kept = applyShellPolicy(body, 'keep');
  assert.equal(kept.body, body);
  assert.equal(kept.occurrences.length, 0);

  const neutralized = applyShellPolicy(body, 'neutralize');
  assert.equal(neutralized.body, 'a\r\nb `x`\r\nc\r\n');
  assert.deepEqual(neutralized.occurrences, [{ kind: 'inline-bang', line: 2, action: 'neutralized' }]);

  const stripped = applyShellPolicy(body, 'strip');
  assert.equal(stripped.body, 'a\r\nb\r\nc\r\n');
  assert.deepEqual(stripped.occurrences, [{ kind: 'inline-bang', line: 2, action: 'removed' }]);
});

test('shell policy: a fenced block is removed whole by strip, not left as an empty fence', () => {
  const body = ['before', '```!', 'echo hi', '```', 'after', ''].join('\n');
  assert.equal(applyShellPolicy(body, 'strip').body, ['before', 'after', ''].join('\n'));
  assert.equal(applyShellPolicy(body, 'neutralize').body, ['before', '```text', 'echo hi', '```', 'after', ''].join('\n'));
});

// ---------------------------------------------------------------------------
// 4. Shared roots: one copy for several agents, and no silent second copy.
// ---------------------------------------------------------------------------

test('shared root: four agents that read .agents/skills get one copy', async (t) => {
  const project = await sandbox(t);
  const report = await convert({
    path: resolve(ROOT, REPORT_BUILDER),
    from: 'claude-code',
    to: ['codex-cli', 'deepseek-harness', 'kimi-code', 'opencode'],
    install: true,
    projectRoot: project,
    home: project,
  });

  const shared = report.roots.filter((root) => root.action === 'shared');
  assert.equal(shared.length, 1, 'exactly one shared root should be written');
  assert.equal(shared[0].path, join(project, '.agents', 'skills'));
  assert.deepEqual([...shared[0].targets].sort(), ['codex-cli', 'deepseek-harness', 'kimi-code', 'opencode']);

  const written = await discoverableSkills(join(project, '.agents', 'skills'));
  assert.deepEqual(written, ['report-builder'], 'the skill must be written once, not once per agent');

  // Every target still reports what the conversion means for it, even though
  // the bytes are shared.
  for (const target of report.targets) {
    assert.equal(target.destination, join(project, '.agents', 'skills', 'report-builder'));
    assert.ok(target.items.length > 0);
    assert.equal(target.items[0].detail?.sharedWith?.length ?? 0, 4);
  }
});

test('shared root: Claude Code gets a real copy, and the overlap is reported instead of duplicated', async (t) => {
  const project = await sandbox(t);
  const report = await convert({
    path: resolve(ROOT, REPORT_BUILDER),
    from: 'claude-code',
    to: ['codex-cli', 'deepseek-harness', 'kimi-code', 'opencode', 'claude-code'],
    install: true,
    projectRoot: project,
    home: project,
  });

  // Claude Code is written under .claude/skills as real files, never a symlink.
  const claudeSkill = join(project, '.claude', 'skills', 'report-builder');
  const info = await stat(claudeSkill);
  assert.ok(info.isDirectory(), '.claude/skills/report-builder must be a real directory');
  assert.ok(!info.isSymbolicLink());
  assert.ok(existsSync(join(claudeSkill, 'SKILL.md')));
  assert.ok(existsSync(join(claudeSkill, 'scripts', 'build_report.py')));

  // OpenCode reads .claude/skills as a compatibility path, so writing a second
  // copy there would create a duplicate name. It is reported instead.
  const overlap = report.overlaps.find((candidate) => candidate.target === 'opencode' && candidate.root === join(project, '.claude', 'skills'));
  assert.ok(overlap, 'the opencode overlap must be reported');
  assert.equal(overlap.writtenFor, 'claude-code');
  assert.ok(overlap.precedence.length > 0, 'the overlap must name the duplicate-resolution rule that applies');

  // Exactly two copies exist: one shared, one for Claude Code.
  assert.deepEqual(await discoverableSkills(join(project, '.agents', 'skills')), ['report-builder']);
  assert.deepEqual(await discoverableSkills(join(project, '.claude', 'skills')), ['report-builder']);
});

test('shared root: differing outputs collapse to a least-common-denominator copy and are reported', async (t) => {
  const project = await sandbox(t);
  const source = await sandbox(t);

  // codex-cli and kimi-code share `.agents/skills` but spell this field
  // differently: kimi renames `when_to_use` to `whenToUse`, codex keeps it. One
  // file cannot be both, so the shared copy keeps only what they agree on.
  await mkdir(join(source, 'lcd-skill'));
  await writeFile(
    join(source, 'lcd-skill', 'SKILL.md'),
    [
      '---',
      'name: lcd-skill',
      'description: A skill whose optional field two agents spell differently.',
      'when_to_use: The user asks for a least-common-denominator check.',
      '---',
      '',
      '# LCD skill',
      '',
      'Keep this body.',
      '',
    ].join('\n'),
  );

  const report = await convert({
    path: join(source, 'lcd-skill'),
    from: 'claude-code',
    to: ['codex-cli', 'kimi-code'],
    install: true,
    projectRoot: project,
    home: project,
  });

  const written = await read(join(project, '.agents', 'skills', 'lcd-skill', 'SKILL.md'));
  assert.ok(!written.includes('when_to_use'), 'the shared copy must not carry a field one member renames');
  assert.ok(!written.includes('whenToUse'));
  assert.ok(written.includes('Keep this body.'), 'the body must survive the collapse');
  assert.ok(report.notes.some((note) => note.includes('least-common-denominator')));

  for (const target of report.targets) {
    const dropped = target.items.filter((item) => item.fidelity === 'dropped');
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].subject, 'field:when_to_use');
    assert.match(dropped[0].reason, /codex-cli, kimi-code/);
  }
  assert.equal(exitCodeForConversion(report, false), 2);
  assert.equal(exitCodeForConversion(report, true), 1, '--strict must make a loss an error');
});

test('shared root: byte-identical outputs are written once and said so', async (t) => {
  const project = await sandbox(t);
  const report = await convert({
    path: resolve(ROOT, SIMPLE),
    from: 'claude-code',
    to: ['codex-cli', 'deepseek-harness', 'kimi-code', 'opencode'],
    install: true,
    projectRoot: project,
    home: project,
  });
  assert.ok(report.notes.some((note) => note.includes('byte-identical')));
  assert.equal(exitCodeForConversion(report, true), 0, 'a byte-identical shared copy loses nothing');
});

// ---------------------------------------------------------------------------
// 5. Overwriting: never silent, always backed up.
// ---------------------------------------------------------------------------

test('install: an existing skill is not overwritten without --force', async (t) => {
  const project = await sandbox(t);
  const options = {
    path: resolve(ROOT, SIMPLE),
    from: 'claude-code',
    to: ['codex-cli'],
    install: true,
    projectRoot: project,
    home: project,
  };
  await convertSkill(options);

  const skillFile = join(project, '.agents', 'skills', 'changelog-writer', 'SKILL.md');
  await writeFile(skillFile, 'edited by hand\n');

  await assert.rejects(
    () => convertSkill(options),
    (error) => {
      assert.match(error.message, /already exists/);
      assert.match(error.message, /--force/);
      return true;
    },
  );
  assert.equal(await read(skillFile), 'edited by hand\n', 'the refusal must leave the file alone');
});

test('install: --force backs the old copy up outside the root before replacing it', async (t) => {
  const project = await sandbox(t);
  const options = {
    path: resolve(ROOT, SIMPLE),
    from: 'claude-code',
    to: ['codex-cli'],
    install: true,
    projectRoot: project,
    home: project,
    now: new Date('2026-01-02T03:04:05Z'),
  };
  await convertSkill(options);

  const skillFile = join(project, '.agents', 'skills', 'changelog-writer', 'SKILL.md');
  await writeFile(skillFile, 'edited by hand\n');

  const report = await convert({ ...options, force: true });
  const root = report.roots[0];
  assert.ok(root.backup, 'the report must name the backup');

  const backedUp = await read(join(root.backup, 'SKILL.md'));
  assert.equal(backedUp, 'edited by hand\n', 'the backup must hold the previous contents');
  assert.notEqual(await read(skillFile), 'edited by hand\n', 'the destination must hold the new contents');

  // A backup inside the root would be discovered as a skill by the agent.
  assert.ok(!root.backup.startsWith(join(project, '.agents', 'skills')));
  assert.ok(root.backup.includes('.skillporter-backups'));

  // Backups are named so two runs in the same second do not collide.
  assert.match(root.backup, /2026-01-02T03-04-05/);
});

test('install: --global writes under the user-level root, never outside a documented root', async (t) => {
  const home = await sandbox(t);
  const report = await convert({
    path: resolve(ROOT, SIMPLE),
    from: 'claude-code',
    to: ['codex-cli', 'claude-code'],
    install: true,
    scope: 'global',
    projectRoot: home,
    home,
  });

  const paths = report.roots.map((root) => root.path).sort();
  assert.deepEqual(paths, [join(home, '.agents', 'skills'), join(home, '.claude', 'skills')].sort());
  for (const root of report.roots) {
    assert.ok(root.path.startsWith(home), `${root.path} is outside the sandbox home`);
  }
  assert.ok(existsSync(join(home, '.agents', 'skills', 'changelog-writer', 'SKILL.md')));
});

test('roots: a path that depends on how the agent was launched is not a candidate', async () => {
  // Built with the same primitives the resolver uses, so the expectation is
  // native on every platform rather than a hard-coded POSIX path.
  const context = { projectRoot: resolve('/work/project'), home: resolve('/home/person') };
  const under = (base, ...parts) => join(base, ...parts);

  // Resolvable: placeholders that name the project root itself.
  assert.equal(resolveDocumentedPath('<cwd>/.agents/skills', context, 'project'), under(context.projectRoot, '.agents', 'skills'));
  assert.equal(resolveDocumentedPath('<projectRoot>/.dsh/skills', context, 'project'), under(context.projectRoot, '.dsh', 'skills'));
  assert.equal(resolveDocumentedPath('.claude/skills', context, 'project'), under(context.projectRoot, '.claude', 'skills'));
  assert.equal(resolveDocumentedPath('~/.agents/skills', context, 'global'), under(context.home, '.agents', 'skills'));

  // Not resolvable: these depend on launch flags or the environment.
  for (const documented of ['<subdir>/.claude/skills', '<add-dir>/.claude/skills', '<managed-settings-dir>/.claude/skills', '$KIMI_CODE_HOME/skills', '<customSkillDirs[]>']) {
    assert.equal(resolveDocumentedPath(documented, context, 'project'), null, `${documented} must not resolve`);
  }

  // Every agent that reads a directory has at least one real project root, so
  // nothing is guessed. An archive target is the documented exception: it has
  // no discovery root at all, and inventing one would be exactly the guess this
  // rule exists to prevent.
  for (const profile of await loadProfiles()) {
    if ((profile.delivery ?? 'directory') === 'archive') {
      assert.deepEqual(profile.paths.project, [], `${profile.id} is an archive target and must not name a project root`);
      assert.deepEqual(profile.paths.global, [], `${profile.id} is an archive target and must not name a global root`);
      continue;
    }
    assert.ok(rootsFor(profile, 'project', context).length > 0, `${profile.id} has no resolvable project root`);
  }
});

test('out: an existing output directory is not overwritten without --force', async (t) => {
  const out = await sandbox(t);
  const options = { path: resolve(ROOT, SIMPLE), from: 'claude-code', to: ['codex-cli'], out };
  await convertSkill(options);
  await writeFile(join(out, 'changelog-writer', 'SKILL.md'), 'mine\n');

  await assert.rejects(() => convertSkill(options), /already exists/);
  assert.equal(await read(join(out, 'changelog-writer', 'SKILL.md')), 'mine\n');
  await convert({ ...options, force: true });
  assert.notEqual(await read(join(out, 'changelog-writer', 'SKILL.md')), 'mine\n');
});

// ---------------------------------------------------------------------------
// 6. Atomic writes: no half-written skill, ever.
// ---------------------------------------------------------------------------

test('atomic: a failed write leaves no skill behind, not even a partial one', async (t) => {
  const root = await sandbox(t);
  const skillRoot = join(root, 'skills');
  await mkdir(skillRoot, { recursive: true });

  await assert.rejects(
    () =>
      writeSkill({
        root: skillRoot,
        directoryName: 'escape-skill',
        force: false,
        files: [
          { path: 'SKILL.md', bytes: Buffer.from('---\nname: x\n---\n'), mode: 0o644 },
          { path: '../outside.txt', bytes: Buffer.from('nope'), mode: 0o644 },
        ],
      }),
    /escapes the skill directory/,
  );

  assert.deepEqual(await discoverableSkills(skillRoot), [], 'a failed write must not leave a loadable skill');
  assert.equal(existsSync(join(skillRoot, 'escape-skill')), false);
  assert.equal(existsSync(join(root, 'outside.txt')), false);
});

test('atomic: a successful write leaves exactly one skill and nothing else loadable', async (t) => {
  const root = await sandbox(t);
  const skillRoot = join(root, 'skills');
  const result = await writeSkill({
    root: skillRoot,
    directoryName: 'ok-skill',
    force: false,
    files: [{ path: 'SKILL.md', bytes: Buffer.from('---\nname: ok-skill\n---\n'), mode: 0o644 }],
  });
  assert.deepEqual(await discoverableSkills(skillRoot), ['ok-skill']);
  assert.equal(await read(join(result.destination, 'SKILL.md')), '---\nname: ok-skill\n---\n');
  assert.equal(result.replaced, false);
});

test('atomic: a write that escapes the root is refused', async (t) => {
  const root = await sandbox(t);
  const skillRoot = join(root, 'skills');
  await mkdir(skillRoot, { recursive: true });
  await assert.rejects(
    () =>
      writeSkill({
        root: skillRoot,
        directoryName: '../outside',
        force: true,
        files: [{ path: 'SKILL.md', bytes: Buffer.from('x'), mode: 0o644 }],
      }),
    /outside the target root/,
  );
  assert.equal(existsSync(join(root, 'outside')), false);
});

// ---------------------------------------------------------------------------
// 7. Archives: zip-slip protection.
// ---------------------------------------------------------------------------

test('zip: a hostile entry name is refused before anything is written', () => {
  for (const name of ['../evil.txt', 'a/../../evil.txt', '/etc/passwd', 'C:/Windows/evil.txt', '..\\evil.txt', 'a//b.txt', '']) {
    assert.throws(() => assertSafeArchiveEntry(name), /refus|absolute|empty|\.\./, `expected "${name}" to be refused`);
  }
  for (const name of ['SKILL.md', 'scripts/build_report.py', 'references/nested/checklist.md', './SKILL.md']) {
    assert.ok(assertSafeArchiveEntry(name).length > 0, `expected "${name}" to be accepted`);
  }
});

test('zip: a bomb is refused, and the reason is the expanded size', async (t) => {
  const dir = await sandbox(t);
  const zipPath = join(dir, 'bomb.zip');

  // Ten megabytes of one character deflates to a few kilobytes, so the
  // compressed file passes any check on the size of the input.
  const payload = 'a'.repeat(10 * 1024 * 1024);
  await writeFile(zipPath, Buffer.from(zipSync({ 'SKILL.md': strToU8(payload) })));
  const onDisk = (await stat(zipPath)).size;
  assert.ok(onDisk < 64 * 1024, `the bomb should be small on disk, got ${onDisk} bytes`);

  // What this pins down is the refusal and its reason. The stronger property —
  // that the ten megabytes are never allocated, because the limits are read
  // from the central directory before fflate inflates anything — cannot be
  // observed from outside without measuring the heap, which would be flaky.
  await assert.rejects(
    () => extractZip(zipPath, resolveLimits({ maxTotalBytes: 64 * 1024 })),
    /expands past the tool limit/,
  );
});

test('zip: too many entries is refused before extraction, and the count is the reason', async (t) => {
  const dir = await sandbox(t);
  const zipPath = join(dir, 'many.zip');
  const entries = {};
  for (let index = 0; index < 6; index += 1) entries[`file-${index}.md`] = strToU8(`# ${index}\n`);
  await writeFile(zipPath, Buffer.from(zipSync(entries)));

  await assert.rejects(
    () => extractZip(zipPath, resolveLimits({ maxFiles: 3 })),
    /holds more than 3 files/,
  );
});

test('zip: a single entry over the per-file limit is refused, and named', async (t) => {
  const dir = await sandbox(t);
  const zipPath = join(dir, 'big-file.zip');
  await writeFile(
    zipPath,
    Buffer.from(zipSync({ 'SKILL.md': strToU8('# small\n'), 'references/huge.md': strToU8('b'.repeat(200_000)) })),
  );

  await assert.rejects(
    () => extractZip(zipPath, resolveLimits({ maxFileBytes: 1024, maxTotalBytes: 1024 * 1024 })),
    /references\/huge\.md.*over the tool limit/,
  );
});

test('zip: converting an archive never writes outside the extraction directory', async (t) => {
  const dir = await sandbox(t);
  const zipPath = join(dir, 'hostile.zip');
  const archive = zipSync({
    'wrapper/SKILL.md': strToU8('---\nname: zipped-skill\ndescription: A skill from an archive.\n---\n\n# Zipped\n'),
    'wrapper/scripts/run.sh': strToU8('#!/bin/sh\necho hi\n'),
    '../evil.txt': strToU8('escaped'),
    'wrapper/../../evil2.txt': strToU8('escaped too'),
  });
  await writeFile(zipPath, Buffer.from(archive));

  await assert.rejects(
    () => convert({ path: zipPath, from: 'codex-cli', to: ['codex-cli'], dryRun: true }),
    /refus/,
  );
  assert.equal(existsSync(join(dir, 'evil.txt')), false);
  assert.equal(existsSync(join(dir, 'evil2.txt')), false);
  assert.equal(existsSync(join(dir, '..', 'evil.txt')), false);
});

test('zip: a clean archive converts, and the report says the input was a zip', async (t) => {
  const dir = await sandbox(t);
  const zipPath = join(dir, 'clean.zip');
  await writeFile(
    zipPath,
    Buffer.from(
      zipSync({
        'wrapper/SKILL.md': strToU8('---\nname: zipped-skill\ndescription: A skill from an archive.\n---\n\n# Zipped\n'),
        'wrapper/scripts/run.sh': strToU8('#!/bin/sh\necho hi\n'),
      }),
    ),
  );

  const out = join(dir, 'out');
  const report = await convert({ path: zipPath, from: 'codex-cli', to: ['codex-cli'], out });
  assert.equal(report.source.input, 'zip');
  assert.equal(report.source.identity, 'zipped-skill');
  assert.equal(await read(join(out, 'zipped-skill', 'scripts', 'run.sh')), '#!/bin/sh\necho hi\n');
});

// ---------------------------------------------------------------------------
// 8. Every report category is reachable, and the report matches its schema.
// ---------------------------------------------------------------------------

test('report: every fidelity and every subject kind is reachable', async (t) => {
  const out = await sandbox(t);
  const source = await sandbox(t);
  const seenFidelity = new Set();
  const seenKind = new Set();

  // An identity that cannot be a directory name.
  await mkdir(join(source, 'grouped'));
  await writeFile(
    join(source, 'grouped', 'SKILL.md'),
    '---\nname: "group/name"\ndescription: A skill whose name is not a directory name.\n---\n\n# Body\n',
  );

  const runs = [
    // A flat file: layout adaptation.
    { path: resolve(ROOT, 'fixtures/lint/.agents/skills/flat-skill.md'), from: 'deepseek-harness', to: ['codex-cli'] },
    // An identity that has to change to become a directory.
    { path: join(source, 'grouped'), from: 'codex-cli', to: ['codex-cli'] },
    // An extension the target lacks.
    { path: resolve(ROOT, FLOW), from: 'kimi-code', to: ['claude-code'] },
    // An alias rename.
    { path: resolve(ROOT, ALIAS), from: 'deepseek-harness', to: ['claude-code'] },
    // Shell injection, with a policy that drops.
    { path: resolve(ROOT, REPORT_BUILDER), from: 'codex-cli', to: ['claude-code'], shellPolicy: 'strip' },
    // Shell injection kept, which degrades.
    { path: resolve(ROOT, REPORT_BUILDER), from: 'codex-cli', to: ['claude-code'], shellPolicy: 'keep' },
    // Bundled files.
    { path: resolve(ROOT, REPORT_BUILDER), from: 'claude-code', to: ['codex-cli'] },
  ];

  let index = 0;
  for (const options of runs) {
    index += 1;
    const report = await convert({ ...options, out: join(out, String(index)) });
    for (const target of report.targets) {
      for (const item of target.items) {
        seenFidelity.add(item.fidelity);
        seenKind.add(item.kind);
      }
    }
  }

  assert.deepEqual([...seenFidelity].sort(), ['adapted', 'degraded', 'dropped', 'preserved', 'renamed']);
  assert.deepEqual([...seenKind].sort(), ['body', 'extension', 'field', 'file', 'identity', 'layout', 'shell-injection']);
});

test('report: a directory identity is adapted, and the reason says why', async (t) => {
  const out = await sandbox(t);
  const dir = await sandbox(t);
  await mkdir(join(dir, 'weird-name'));
  await writeFile(
    join(dir, 'weird-name', 'SKILL.md'),
    '---\nname: "group/name"\ndescription: A skill whose name cannot be a directory.\n---\n\n# Body\n',
  );

  const report = await convert({ path: join(dir, 'weird-name'), from: 'codex-cli', to: ['codex-cli'], out });
  const identity = itemsOf(report.targets[0], 'identity');
  assert.equal(identity.length, 1);
  assert.equal(identity[0].fidelity, 'adapted');
  assert.equal(report.targets[0].directoryName, 'group-name');
  assert.ok(existsSync(join(out, 'group-name', 'SKILL.md')));
});

test('report: an assumed source is marked and never claims to know what it did', async (t) => {
  const out = await sandbox(t);
  const report = await convert({
    path: resolve(ROOT, REPORT_BUILDER),
    to: ['codex-cli'],
    out,
  });
  assert.equal(report.source.explicit, false);
  assert.equal(report.source.assumed, true);
  assert.ok(report.notes.some((note) => note.includes('assumed')));
});

test('report: every report validates against the published JSON Schema', async (t) => {
  const schema = JSON.parse(await read(join(ROOT, 'schema', 'conversion-report.schema.json')));
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validate = ajv.compile(schema);
  assert.equal(validate.errors, null);

  const out = await sandbox(t);
  const project = await sandbox(t);
  const reports = [
    await convert({ path: resolve(ROOT, SIMPLE), from: 'claude-code', to: ['codex-cli', 'claude-code'], out: join(out, 'a') }),
    await convert({ path: resolve(ROOT, REPORT_BUILDER), from: 'claude-code', to: ['codex-cli'], out: join(out, 'b'), shellPolicy: 'strip' }),
    await convert({ path: resolve(ROOT, FLOW), from: 'kimi-code', to: ['kimi-code', 'opencode'], out: join(out, 'c') }),
    await convert({ path: resolve(ROOT, SIMPLE), from: 'claude-code', to: ['codex-cli'], dryRun: true }),
    await convert({
      path: resolve(ROOT, REPORT_BUILDER),
      from: 'claude-code',
      to: ['codex-cli', 'deepseek-harness', 'kimi-code', 'opencode', 'claude-code'],
      install: true,
      projectRoot: project,
      home: project,
    }),
  ];

  for (const [index, report] of reports.entries()) {
    const ok = validate(JSON.parse(JSON.stringify(report)));
    assert.ok(ok, `report ${index} does not match the schema: ${JSON.stringify(validate.errors, null, 2)}`);
  }
});

test('report: post-conversion lint is run on the output, not on the source', async (t) => {
  const out = await sandbox(t);
  // A flat .md file is not a valid skill for an agent that wants a directory, so
  // linting the source reports a problem. Linting the output must not.
  const report = await convert({
    path: resolve(ROOT, 'fixtures/lint/.agents/skills/flat-skill.md'),
    from: 'deepseek-harness',
    to: ['codex-cli'],
    out,
  });
  const target = report.targets[0];
  assert.equal(target.layout, 'directory');
  assert.ok(target.lint, 'the report must carry lint results for the output');
  assert.equal(target.lint.summary.errors, 0, 'the wrapped output is a clean skill');
  assert.equal(itemsOf(target, 'layout')[0].fidelity, 'adapted');
});

test('report: a staging root that does not exist yet is created, not rejected', async (t) => {
  const dir = await sandbox(t);
  // `stagingRoot` is a caller-supplied location, so it may not exist. Failing
  // with ENOENT from deep inside the lint step would blame the wrong thing.
  const stagingRoot = join(dir, 'does', 'not', 'exist', 'yet');

  const report = await convertSkill({
    path: resolve(ROOT, SIMPLE),
    from: 'claude-code',
    to: ['codex-cli'],
    out: join(dir, 'out'),
    stagingRoot,
  });

  assert.ok(existsSync(stagingRoot), 'the staging root should have been created');
  assert.equal(report.targets[0].lint.summary.errors, 0);
  assert.ok(existsSync(join(dir, 'out', 'changelog-writer', 'SKILL.md')));
});

test('report: a clean conversion exits 0, a loss exits 2, --strict exits 1, a broken output exits 1', async (t) => {
  const out = await sandbox(t);
  const clean = await convert({ path: resolve(ROOT, SIMPLE), from: 'claude-code', to: ['codex-cli'], out: join(out, '1') });
  assert.equal(exitCodeForConversion(clean, false), 0);
  assert.equal(exitCodeForConversion(clean, true), 0);

  const lossy = await convert({
    path: resolve(ROOT, REPORT_BUILDER),
    from: 'codex-cli',
    to: ['claude-code'],
    out: join(out, '2'),
    shellPolicy: 'strip',
  });
  assert.equal(exitCodeForConversion(lossy, false), 2);
  assert.equal(exitCodeForConversion(lossy, true), 1);

  // A synthetic error in the post-conversion lint must win over a loss.
  const broken = { ...lossy, targets: lossy.targets.map((target) => ({ ...target, lint: { findings: [], summary: { ...target.lint.summary, errors: 1 } } })) };
  assert.equal(exitCodeForConversion(broken, false), 1);
});

test('cli: convert honours the documented exit codes', async (t) => {
  const out = await sandbox(t);
  const clean = await run(['convert', SIMPLE, '--from', 'claude-code', '--to', 'codex-cli', '--out', join(out, 'clean')]);
  assert.equal(clean.code, 0, clean.stderr);

  const lossy = await run(['convert', REPORT_BUILDER, '--from', 'codex-cli', '--to', 'claude-code', '--out', join(out, 'lossy'), '--shell-injection', 'strip']);
  assert.equal(lossy.code, 2, lossy.stderr);

  const strict = await run([
    'convert',
    REPORT_BUILDER,
    '--from',
    'codex-cli',
    '--to',
    'claude-code',
    '--out',
    join(out, 'strict'),
    '--shell-injection',
    'strip',
    '--strict',
  ]);
  assert.equal(strict.code, 1, strict.stderr);
  assert.equal(existsSync(join(out, 'strict')), false);
});

test('cli: --dry-run writes nothing and still reports', async (t) => {
  const out = join(await sandbox(t), 'never');
  const result = await run(['convert', REPORT_BUILDER, '--from', 'claude-code', '--to', 'codex-cli', '--out', out, '--dry-run']);
  // Claude Code executes shell syntax and codex-cli does not, so the text is
  // kept and reported as degraded: 2, not 0.
  assert.equal(result.code, 2, result.stderr);
  assert.equal(existsSync(out), false, '--dry-run must not create the output directory');
  assert.match(result.stdout, /dry run: nothing written/);
  assert.match(result.stdout, /report-builder/);
});

test('cli: --report json emits a report that parses and matches the schema', async (t) => {
  const out = await sandbox(t);
  const result = await run(['convert', REPORT_BUILDER, '--from', 'claude-code', '--to', 'codex-cli', '--out', out, '--report', 'json']);
  const report = JSON.parse(result.stdout);
  assert.equal(report.tool.name, 'skillporter');
  assert.equal(report.mode, 'out');
  assert.equal(report.dryRun, false);
  assert.ok(Array.isArray(report.targets[0].items));
});

test('cli: --report md emits a markdown report with a fidelity table', async (t) => {
  const out = await sandbox(t);
  const result = await run(['convert', REPORT_BUILDER, '--from', 'claude-code', '--to', 'codex-cli', '--out', out, '--report', 'md']);
  assert.match(result.stdout, /^# /m);
  assert.match(result.stdout, /\|/);
  assert.match(result.stdout, /preserved/);
});

test('cli: an unknown agent is an error, not a guess', async () => {
  const result = await run(['convert', SIMPLE, '--to', 'not-an-agent', '--dry-run']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unknown agent/);
});

test('cli: --out and --install together is refused', async (t) => {
  const out = await sandbox(t);
  const result = await run(['convert', SIMPLE, '--to', 'codex-cli', '--out', out, '--install']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /one of them/);
});

test('name: an identity that breaks the target grammar is normalised and reported once', async (t) => {
  const dir = await sandbox(t);
  const source = join(dir, 'spacey');
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, 'SKILL.md'),
    '---\nname: Changelog Writer\ndescription: Turns merged pull requests into release notes.\n---\n\n# Notes\n\nWrite them.\n',
  );

  const out = join(dir, 'out');
  const report = await convert({ path: source, from: 'claude-code', to: ['deepseek-harness'], out });
  const target = targetOf(report, 'deepseek-harness');

  // dsh drops a skill whose name is not kebab-case without an error, so writing
  // the source name through would produce a skill that never appears in its
  // catalog. Normalising is what makes the conversion usable.
  assert.equal(target.directoryName, 'changelog-writer');
  const written = await read(join(out, 'changelog-writer', 'SKILL.md'));
  assert.match(written, /^name: changelog-writer$/m);

  const nameItems = target.items.filter((item) => item.subject === 'field:name');
  assert.equal(nameItems.length, 1, 'one change must be reported once, not once per mechanism');
  assert.equal(nameItems[0].fidelity, 'adapted');
  assert.match(nameItems[0].reason, /name rule/);
  assert.equal(nameItems[0].detail?.from, 'Changelog Writer');

  assert.equal(exitCodeForConversion(report, false), 0, 'a rename is not a loss');
});

test('name: a name that already satisfies the target is not touched', async (t) => {
  const out = join(await sandbox(t), 'out');
  const report = await convert({ path: resolve(ROOT, SIMPLE), from: 'claude-code', to: ['deepseek-harness'], out });
  const target = targetOf(report, 'deepseek-harness');
  assert.equal(target.directoryName, 'changelog-writer');
  const nameItems = target.items.filter((item) => item.subject === 'field:name');
  assert.equal(nameItems[0].fidelity, 'preserved');
});

// ---------------------------------------------------------------------------
// The upload target: a closed field set and no directory to install into.
// ---------------------------------------------------------------------------

test('upload: only the documented fields are emitted and every drop is reported', async (t) => {
  const out = join(await sandbox(t), 'out');
  const report = await convert({ path: resolve(ROOT, REPORT_BUILDER), from: 'claude-code', to: ['claude-ai-upload'], out });
  const target = targetOf(report, 'claude-ai-upload');

  const written = await read(join(out, 'report-builder', 'SKILL.md'));
  const frontmatter = written.slice(0, written.indexOf('\n---', 4));
  const keys = frontmatter
    .split('\n')
    .slice(1)
    .map((line) => line.slice(0, line.indexOf(':')))
    .sort();
  assert.deepEqual(keys, ['description', 'name'], 'the upload surface documents exactly two fields');

  const dropped = target.items.filter((item) => item.fidelity === 'dropped');
  assert.deepEqual(
    dropped.map((item) => item.subject).sort(),
    ['field:allowed-tools', 'field:x-acme-owner'],
    'both removed fields must be named',
  );
  for (const item of dropped) {
    assert.match(item.reason, /not documented|not .*published/, `the drop must say why: ${item.reason}`);
    assert.ok(item.source, 'a drop must cite the profile source');
  }

  // The body is untouched: the target does not execute shell syntax, so
  // rewriting it would change the prompt for nothing.
  assert.ok(written.includes('!`'), 'the shell syntax is inert here and must survive as text');
  const shell = target.items.filter((item) => item.kind === 'shell-injection');
  assert.equal(shell.length, 2);
  for (const item of shell) assert.equal(item.fidelity, 'degraded');

  assert.ok(report.notes.some((note) => note.includes('zip and upload')), 'the report must say how to use the output');
});

test('upload: a reserved word is an error, and the name is not invented for the author', async (t) => {
  const dir = await sandbox(t);
  const source = join(dir, 'claude-helper');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'SKILL.md'), '---\nname: claude-helper\ndescription: Helps with questions.\n---\n\nBody.\n');

  const out = join(dir, 'out');
  const report = await convert({ path: source, from: 'claude-code', to: ['claude-ai-upload'], out });
  const target = targetOf(report, 'claude-ai-upload');

  // The name is well formed, so it is not rewritten; the target simply refuses
  // it, and the report says so instead of producing an upload that will fail.
  assert.equal(target.directoryName, 'claude-helper');
  const error = target.lint.findings.find((finding) => finding.ruleId === 'SP025');
  assert.ok(error, 'a reserved word must be reported');
  assert.equal(error.severity, 'error');
  assert.match(error.message, /reserves/);
  assert.equal(exitCodeForConversion(report, false), 1, 'an output the target refuses is an error, not a loss');
});

test('upload: an over-long description is an error rather than a silent truncation', async (t) => {
  const dir = await sandbox(t);
  const source = join(dir, 'long-desc');
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, 'SKILL.md'),
    `---\nname: long-desc\ndescription: ${'x'.repeat(1200)}\n---\n\nBody.\n`,
  );

  const report = await convert({ path: source, from: 'claude-code', to: ['claude-ai-upload'], out: join(dir, 'out') });
  const target = targetOf(report, 'claude-ai-upload');

  assert.equal(target.items.find((item) => item.subject === 'field:description').fidelity, 'preserved');
  const error = target.lint.findings.find((finding) => finding.ruleId === 'SP007');
  assert.ok(error, 'the hard bound must be reported');
  assert.equal(error.severity, 'error');
  assert.equal(exitCodeForConversion(report, false), 1);
});

test('upload: --install is refused, because there is no root to install into', async (t) => {
  const project = await sandbox(t);
  await assert.rejects(
    () =>
      convert({
        path: resolve(ROOT, REPORT_BUILDER),
        from: 'claude-code',
        to: ['claude-ai-upload'],
        install: true,
        projectRoot: project,
        home: project,
      }),
    (error) => {
      assert.match(error.message, /uploaded bundle/);
      assert.match(error.message, /--out/);
      return true;
    },
  );
});

test('install: lint runs at the destination, so a duplicate name is found', async (t) => {
  const project = await sandbox(t);
  // A skill that already claims the name, under a directory called something
  // else. Only a scan of the real root can see it.
  await mkdir(join(project, '.dsh', 'skills', 'notes'), { recursive: true });
  await writeFile(
    join(project, '.dsh', 'skills', 'notes', 'SKILL.md'),
    '---\nname: changelog-writer\ndescription: An older skill that already claims this name.\n---\n\nOld body.\n',
  );

  const report = await convert({
    path: resolve(ROOT, SIMPLE),
    from: 'claude-code',
    to: ['deepseek-harness'],
    install: true,
    projectRoot: project,
    home: project,
  });
  const target = targetOf(report, 'deepseek-harness');

  const duplicate = target.lint.findings.find((finding) => finding.ruleId === 'SP021');
  assert.ok(duplicate, 'a duplicate in the destination root must be found');
  assert.match(duplicate.message, /notes/, 'the finding must name the other skill');
  assert.ok(
    report.notes.some((note) => note.includes('installed destination')),
    'the report must say the destination was checked',
  );

  // --dry-run writes nothing, so it must not claim to have checked a location.
  const dry = await convert({
    path: resolve(ROOT, SIMPLE),
    from: 'claude-code',
    to: ['deepseek-harness'],
    install: true,
    dryRun: true,
    projectRoot: project,
    home: project,
  });
  assert.equal(
    dry.targets[0].lint.findings.some((finding) => finding.ruleId === 'SP021'),
    false,
    'a dry run cannot find a duplicate it never created',
  );
  assert.ok(dry.notes.some((note) => note.includes('could not be checked')));
});

// ---------------------------------------------------------------------------
// Round trips: A -> B -> A.
//
// The claim under test is the one the whole tool rests on. If the report says a
// field was `preserved`, the bytes must come back identical after a detour
// through another agent. If a field does not come back, the report must have
// said so on the way out or on the way back. Either half failing means the
// report lied, which is worse than a lossy conversion.
// ---------------------------------------------------------------------------

/** The fidelity reported for each frontmatter field, per hop. */
function fieldFidelities(targets) {
  const seen = new Map();
  for (const target of targets) {
    for (const item of target.items) {
      if (!item.subject.startsWith('field:')) continue;
      const key = item.subject.slice('field:'.length);
      seen.set(key, [...(seen.get(key) ?? []), item.fidelity]);
    }
  }
  return seen;
}

const ROUND_TRIPS = [
  { path: 'fixtures/skills/report-builder', a: 'claude-code', b: 'codex-cli' },
  { path: 'fixtures/skills/report-builder', a: 'claude-code', b: 'deepseek-harness' },
  { path: 'fixtures/skills/quoting-demo', a: 'claude-code', b: 'codex-cli' },
  { path: 'fixtures/skills/quoting-demo', a: 'codex-cli', b: 'kimi-code' },
  { path: 'fixtures/skills/changelog-writer', a: 'claude-code', b: 'opencode' },
  { path: 'fixtures/skills/changelog-writer', a: 'deepseek-harness', b: 'claude-ai-upload' },
];

for (const trip of ROUND_TRIPS) {
  test(`round trip: ${trip.a} -> ${trip.b} -> ${trip.a} keeps what it calls preserved`, async (t) => {
    const base = await sandbox(t);
    const source = resolve(ROOT, trip.path);

    const out1 = join(base, 'hop1');
    const first = await convert({ path: source, from: trip.a, to: [trip.b], out: out1 });
    const dir1 = join(out1, first.targets[0].directoryName);

    const out2 = join(base, 'hop2');
    const second = await convert({ path: dir1, from: trip.b, to: [trip.a], out: out2 });
    const dir2 = join(out2, second.targets[0].directoryName);

    const before = await parseSkill({ path: source, from: trip.a });
    const after = await parseSkill({ path: dir2, from: trip.a });
    assert.deepEqual(
      after.ir.diagnostics.filter((item) => item.code === 'FRONTMATTER_INVALID'),
      [],
      'the round-tripped frontmatter must still be valid YAML',
    );

    const beforeFields = new Map(before.ir.frontmatter.fields.map((field) => [field.key, field]));
    const afterFields = new Map(after.ir.frontmatter.fields.map((field) => [field.key, field]));
    const fidelities = fieldFidelities([first.targets[0], second.targets[0]]);

    for (const [key, original] of beforeFields) {
      const reported = fidelities.get(key) ?? [];
      const survivor = afterFields.get(key);

      if (survivor === undefined) {
        assert.ok(
          reported.some((fidelity) => fidelity === 'dropped' || fidelity === 'degraded'),
          `"${key}" did not survive ${trip.a} -> ${trip.b} -> ${trip.a} but was reported as ${JSON.stringify(reported)}`,
        );
        continue;
      }

      if (reported.length > 0 && reported.every((fidelity) => fidelity === 'preserved')) {
        assert.equal(
          survivor.raw,
          original.raw,
          `"${key}" was reported preserved on both hops but came back different`,
        );
      }
    }

    // Nothing may be invented on the way round.
    for (const key of afterFields.keys()) {
      if (beforeFields.has(key)) continue;
      assert.ok(fidelities.has(key), `"${key}" appeared out of nowhere and was not reported`);
    }

    // The body is byte-exact whenever both hops said it was untouched.
    const bodyUntouched = [first.targets[0], second.targets[0]].every(
      (target) =>
        target.items.filter((item) => item.kind === 'body').every((item) => item.fidelity === 'preserved') &&
        target.items.filter((item) => item.kind === 'shell-injection').every((item) => item.fidelity === 'preserved'),
    );
    if (bodyUntouched) {
      assert.equal(after.ir.body, before.ir.body, 'the body was reported untouched but changed');
    }
  });
}

// ---------------------------------------------------------------------------
// Frontmatter emission. Found by the quoting-demo fixture: a block scalar was
// re-emitted through the scalar serialiser, which indents nothing at the
// document root, so `description: |` was followed by unindented lines and the
// whole frontmatter stopped parsing. Reported as "preserved" the whole time.
// ---------------------------------------------------------------------------

test('emit: a multi-line value is indented under its key', () => {
  const value = 'First paragraph.\n\nSecond paragraph.';
  const line = emitScalarField('description', value);

  assert.ok(line.startsWith('description: |'), `expected a block scalar, got ${JSON.stringify(line)}`);
  const body = line.split('\n').slice(1);
  for (const entry of body) {
    assert.ok(entry === '' || entry.startsWith('  '), `a block line must be indented: ${JSON.stringify(entry)}`);
  }
  // The property that matters: the emitted field parses back to the same value.
  // Parsed without a fence, because `---` starts a document rather than closing one.
  assert.equal(parseYaml(line).description, value);
});

test('emit: a source field keeps its raw text and loses only its trailing newline', () => {
  const raw = 'description: |\n  One.\n\n  Two.\n';
  const field = { key: 'description', raw, value: 'One.\n\nTwo.\n', line: 2 };

  assert.equal(emitField(field, 'description'), 'description: |\n  One.\n\n  Two.');
  // A rename rewrites only the key token.
  assert.equal(emitField(field, 'summary'), 'summary: |\n  One.\n\n  Two.');
  // No trailing newline survives, because the caller joins fields with one.
  assert.ok(!emitField(field, 'description').endsWith('\n'));
});

test('out: a multi-target run says the shared-root check did not run', async (t) => {
  // --out writes one directory per target, so two targets that would install
  // into the same root are never compared. Silence here reads as "checked and
  // fine", which is the one thing a report must never imply.
  const dir = await sandbox(t);
  const out = join(dir, 'out');

  const result = await run(['convert', SIMPLE, '--to', 'codex,dsh,opencode', '--from', 'claude-code', '--out', out]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /shared-root check did not run/);
  assert.match(result.stdout, /--install --dry-run/);
  // And it did in fact write one directory per target.
  assert.deepEqual(await discoverableSkills(join(out, 'codex-cli')), ['changelog-writer']);
  assert.deepEqual(await discoverableSkills(join(out, 'opencode')), ['changelog-writer']);

  // A single target has nothing to compare, so the note must not appear.
  const single = await run(['convert', SIMPLE, '--to', 'opencode', '--from', 'claude-code', '--out', join(dir, 'one')]);
  assert.doesNotMatch(single.stdout, /shared-root check did not run/);
});

test('install --dry-run shows the shared-root plan and writes nothing', async (t) => {
  const dir = await sandbox(t);

  const result = await run([
    'convert',
    resolve(ROOT, SIMPLE),
    '--to',
    'codex,dsh,opencode',
    '--from',
    'claude-code',
    '--install',
    '--project',
    '--dry-run',
  ], { cwd: dir });

  assert.equal(result.code, 0);
  // The plan: one root, listed once, serving all three.
  //
  // The root is built with the same primitives the resolver uses, so the
  // expectation is native on every platform. A literal '.agents/skills' cannot
  // match on Windows, where the report prints 'D:\\...\\.agents\\skills'.
  const rootLine = `${join(dir, '.agents', 'skills')}  [project]  dry-run  for codex-cli, deepseek-harness, opencode`;
  assert.ok(
    result.stdout.includes(rootLine),
    `the plan must list the shared root as "${rootLine}", got:\n${result.stdout}`,
  );
  assert.match(result.stdout, /one real copy serves every target listed/);
  // And the tense has to match reality: nothing was written.
  assert.match(result.stdout, /would be written to/);
  assert.doesNotMatch(result.stdout, /so it was written once/);
  assert.equal(existsSync(join(dir, '.agents')), false, '--dry-run must not create the root');
});

test('summary: unique counts and per-target counts are reported apart', async (t) => {
  // Five items on three targets is five things, not fifteen. The report used to
  // print only the sum, so a skill with nothing lost read as "15 preserved".
  const dir = await sandbox(t);
  const out = join(dir, 'out');

  const result = await run(['convert', SIMPLE, '--to', 'codex,dsh,opencode', '--from', 'claude-code', '--out', out]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /unique items\s+5 preserved/);
  assert.match(result.stdout, /per-target items\s+15 preserved/);
  assert.match(result.stdout, /5 item\(s\) × 3 targets/);
  // The unique count is the one that must not look like a per-target total.
  assert.match(result.stdout, /counted once each, not once per target/);

  // A single target's counts are already the skill's counts, so the extra
  // breakdown would only add noise.
  const single = await run(['convert', SIMPLE, '--to', 'opencode', '--from', 'claude-code', '--out', join(dir, 'one')]);
  assert.equal(single.code, 0);
  assert.match(single.stdout, /result\s+converted cleanly\s+·\s+5 preserved/);
  assert.doesNotMatch(single.stdout, /unique items/);
});

test('summary: the machine report carries the unique counts too', async () => {
  const report = await convert({
    path: resolve(ROOT, SIMPLE),
    from: 'claude-code',
    to: ['codex-cli', 'deepseek-harness', 'opencode'],
    dryRun: true,
  });

  assert.equal(report.summary.preserved, 15, 'the sum of every target item list');
  assert.equal(report.unique.items, 5, 'five subjects, however many targets saw them');
  assert.equal(report.unique.preserved, 5);
  assert.equal(report.unique.result, 'clean');
});

test('summary: a subject two targets treat differently counts once, at the worse fidelity', () => {
  // Codex may keep a field that another target has to drop. "What happened to
  // this field" then has one honest answer: the worse one. Reporting the best
  // case would hide a loss behind a target that happened to be generous.
  const merged = summariseUnique([
    targetWith('a', [{ subject: 'field:name', kind: 'field', fidelity: 'preserved', reason: '' }]),
    targetWith('b', [{ subject: 'field:name', kind: 'field', fidelity: 'dropped', reason: '' }]),
  ]);

  assert.equal(merged.items, 1);
  assert.equal(merged.dropped, 1);
  assert.equal(merged.preserved, 0);
  assert.equal(merged.result, 'degraded');
});

/** A TargetReport with only the fields summariseUnique reads. */
function targetWith(id, items) {
  return {
    target: id,
    displayName: id,
    verification: 'verified',
    layout: 'directory',
    directoryName: 'skill',
    destination: `/nowhere/${id}/skill`,
    written: false,
    items,
    files: [],
    lint: null,
    summary: { preserved: 0, adapted: 0, renamed: 0, degraded: 0, dropped: 0, result: 'clean' },
  };
}


test('conversion reports each omitted file by name and reason, and strict preserves existing destinations', async (t) => {
  const workspace = await sandbox(t);
  const source = join(workspace, 'source');
  const out = join(workspace, 'out');
  await mkdir(source);
  await writeFile(join(source, 'SKILL.md'), '---\nname: example\ndescription: Example skill\n---\nExample body\n');
  for (const file of ['a.txt', 'b.txt', 'c.txt']) await writeFile(join(source, file), file);

  const options = {
    path: source, from: 'claude-code', to: ['codex-cli', 'claude-code'], out, limits: { maxFiles: 1 },
  };
  const dryRun = await convert({ ...options, dryRun: true });
  for (const target of dryRun.targets) {
    const dropped = target.items.filter((item) => item.fidelity === 'dropped');
    assert.deepEqual(dropped.map((item) => item.subject), ['file:b.txt', 'file:c.txt']);
    for (const item of dropped) assert.match(item.reason, /tool limit of 1 files/);
  }

  const existing = dryRun.targets[0].destination;
  await mkdir(existing, { recursive: true });
  await writeFile(join(existing, 'SKILL.md'), 'previous version');
  const result = await convert({ ...options, force: true, strict: true });
  assert.equal(exitCodeForConversion(result, true), 1);
  assert.ok(result.targets.every((target) => !target.written && target.skipped.includes('--strict')));
  assert.equal(await read(join(existing, 'SKILL.md')), 'previous version');
  assert.equal(existsSync(dryRun.targets[1].destination), false);
});

test('preflight detects a later blocked output before writing the first destination', async (t) => {
  const out = await sandbox(t);
  await writeFile(join(out, 'claude-code'), 'blocked by a regular file');
  await assert.rejects(() => convert({
    path: resolve(ROOT, SIMPLE), from: 'claude-code', to: ['codex-cli', 'claude-code'], out,
  }), /not a directory/);
  assert.equal(existsSync(join(out, 'codex-cli')), false);
  assert.equal(await read(join(out, 'claude-code')), 'blocked by a regular file');
});

test('replacement retains the old version during staging and restores it if the final rename fails', async (t) => {
  const root = await sandbox(t);
  const destination = join(root, 'example');
  const existing = join(destination, 'SKILL.md');
  await mkdir(destination);
  await writeFile(existing, 'previous version');
  const options = {
    root, directoryName: 'example', force: true,
    files: [{ path: 'SKILL.md', bytes: Buffer.from('replacement'), mode: 0 }],
  };

  const write = fs.writeFile;
  const writeMock = t.mock.method(fs, 'writeFile', async () => {
    assert.equal(await read(existing), 'previous version');
    throw new Error('staging write failed');
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => writeSkill(options), /staging write failed/);
  } finally {
    writeMock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(fs.writeFile, write);
  assert.equal(await read(existing), 'previous version');

  const rename = fs.rename;
  const renameMock = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === destination && from.includes('.skillporter-tmp-')) {
      assert.equal(await read(join(from, 'SKILL.md')), 'replacement');
      throw new Error('final rename failed');
    }
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => writeSkill(options), /final rename failed/);
  } finally {
    renameMock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(await read(existing), 'previous version');

  const restoreMock = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === destination) throw new Error('destination became unavailable');
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => writeSkill(options), (error) => {
      const backup = /Previous copy is at (.+)\. Automatic restoration failed/.exec(error.message)?.[1];
      assert.ok(backup);
      assert.equal(existsSync(join(backup, 'SKILL.md')), true);
      return true;
    });
  } finally {
    restoreMock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('a runtime write failure reports written, failed, and unattempted destinations', async (t) => {
  const out = await sandbox(t);
  const rename = fs.rename;
  const failure = join(out, 'claude-code', 'changelog-writer');
  const renameMock = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === failure) throw new Error('injected destination failure');
    return rename(from, to);
  });
  syncBuiltinESMExports();
  let report;
  try {
    report = await convert({
      path: resolve(ROOT, SIMPLE), from: 'claude-code', to: ['codex-cli', 'claude-code', 'opencode'], out,
    });
  } finally {
    renameMock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(exitCodeForConversion(report, false), 1);
  assert.deepEqual(report.targets.map(({ target, written, skipped }) => ({ target, written, skipped })), [
    { target: 'codex-cli', written: true, skipped: undefined },
    { target: 'claude-code', written: false, skipped: 'injected destination failure' },
    { target: 'opencode', written: false, skipped: 'not attempted because an earlier destination failed' },
  ]);
  assert.equal(existsSync(report.targets[0].destination), true);
  assert.equal(existsSync(report.targets[1].destination), false);
  assert.equal(existsSync(report.targets[2].destination), false);

  for (const formatted of [renderConvert(report), renderConvertMarkdown(report)]) {
    assert.match(formatted, /\(written\)/);
    assert.match(formatted, /injected destination failure/);
    assert.match(formatted, /not attempted because an earlier destination failed/);
  }
});
