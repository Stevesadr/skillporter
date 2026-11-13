import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import Ajv2020 from 'ajv/dist/2020.js';

import {
  applyShellPolicy,
  assertSafeArchiveEntry,
  convertSkill,
  exitCodeForConversion,
  loadProfiles,
  resolveDocumentedPath,
  rootsFor,
  writeSkill,
} from '../packages/core/dist/index.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'index.js');
const GOLDEN = 'fixtures/golden';
const SIMPLE = 'fixtures/skills/simple-prompt';
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
    name: `simple-prompt -> ${agent}`,
    path: SIMPLE,
    from: 'claude-code',
    to: agent,
    golden: `${GOLDEN}/simple-prompt/${agent}/changelog-writer`,
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

  // Every agent still has at least one real project root, so nothing is guessed.
  for (const profile of await loadProfiles()) {
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
