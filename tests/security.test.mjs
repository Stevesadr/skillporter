import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { checkSafeRelativePath, lintSkill, parseSkill } from '../packages/core/dist/index.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FIXTURES = join(ROOT, 'fixtures');

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test('no skill content is ever executed', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'skillporter-exec-'));
  const skill = join(parent, 'skill');
  await mkdir(join(skill, 'scripts'), { recursive: true });

  const marker = 'PWNED-BY-SKILLPORTER';
  await writeFile(
    join(skill, 'SKILL.md'),
    [
      '---',
      'name: evil-skill',
      'description: Contains executable content that must never run.',
      '---',
      '',
      `Inline: !\`touch ${marker}\``,
      '',
      '```!',
      `touch ${marker}-fenced`,
      '```',
      '',
      '```bash',
      `# example: !\`touch ${marker}-codefence\``,
      '```',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(join(skill, 'scripts', 'pwn.sh'), `#!/bin/sh\ntouch ${marker}-script\n`, 'utf8');

  const { ir } = await parseSkill({ path: skill, from: 'claude-code' });

  // The content was read and reported...
  assert.equal(ir.shellInjection.length, 3, 'inline, fenced and inside-a-code-fence placeholders must all be detected');
  assert.equal(
    ir.shellInjection.filter((occurrence) => occurrence.insideCodeFence).length,
    2,
    'a placeholder inside an ordinary code fence is still executable, so it is still reported',
  );
  assert.ok(ir.files.some((file) => file.path === 'scripts/pwn.sh'), 'the script is enumerated as data');

  // ...and nothing ran. Check every plausible working directory.
  for (const directory of [parent, skill, process.cwd(), tmpdir()]) {
    for (const suffix of ['', '-fenced', '-codefence', '-script']) {
      const path = join(directory, `${marker}${suffix}`);
      assert.equal(await exists(path), false, `${path} must not exist: skill content was executed`);
    }
  }
});

test('lint never executes skill content either', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'skillporter-lint-exec-'));
  const skill = join(parent, 'skill');
  await mkdir(join(skill, 'scripts'), { recursive: true });

  const marker = 'PWNED-BY-LINT';
  await writeFile(
    join(skill, 'SKILL.md'),
    [
      '---',
      'name: lint-evil',
      'description: Executable content that lint must read but never run.',
      '---',
      '',
      `Inline: !\`touch ${marker}\``,
      '',
      '```!',
      `touch ${marker}-fenced`,
      '```',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(join(skill, 'scripts', 'pwn.sh'), `#!/bin/sh\ntouch ${marker}-script\n`, 'utf8');

  // Lint it for the one agent that would execute those placeholders.
  const result = await lintSkill({ path: skill, for: 'claude-code', from: 'claude-code' });

  assert.ok(
    result.findings.some((item) => item.ruleId === 'SP016'),
    'lint must report that the target would execute this',
  );

  for (const directory of [parent, skill, process.cwd(), tmpdir()]) {
    for (const suffix of ['', '-fenced', '-script']) {
      const path = join(directory, `${marker}${suffix}`);
      assert.equal(await exists(path), false, `${path} must not exist: lint executed skill content`);
    }
  }
});

test('a symlink escaping the skill root is skipped and reported', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'skillporter-link-'));
  const skill = join(parent, 'skill');
  await mkdir(skill, { recursive: true });
  await writeFile(join(parent, 'outside.txt'), 'secret\n', 'utf8');
  await writeFile(join(skill, 'SKILL.md'), '---\nname: linky\ndescription: Has a link.\n---\n\nBody.\n', 'utf8');

  try {
    await symlink(join(parent, 'outside.txt'), join(skill, 'escape.txt'));
  } catch (error) {
    t.skip(`symlinks unavailable on this platform: ${error.code}`);
    return;
  }

  const { ir } = await parseSkill({ path: skill, from: 'claude-code' });

  const warning = ir.diagnostics.find((item) => item.code === 'SYMLINK_OUTSIDE_ROOT');
  assert.ok(warning, 'skipping a symlink must never be silent');
  assert.equal(warning.severity, 'warning');
  assert.equal(warning.file, 'escape.txt');
  assert.equal(ir.files.some((file) => file.path === 'escape.txt'), false, 'the target must not be read');
});

test('a symlink staying inside the skill root is followed', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'skillporter-link-in-'));
  const skill = join(parent, 'skill');
  await mkdir(join(skill, 'references'), { recursive: true });
  await writeFile(join(skill, 'SKILL.md'), '---\nname: linky\ndescription: Has an internal link.\n---\n\nBody.\n', 'utf8');
  await writeFile(join(skill, 'references', 'notes.md'), 'notes\n', 'utf8');

  try {
    await symlink(join(skill, 'references', 'notes.md'), join(skill, 'alias.md'));
  } catch (error) {
    t.skip(`symlinks unavailable on this platform: ${error.code}`);
    return;
  }

  const { ir } = await parseSkill({ path: skill, from: 'claude-code' });

  assert.equal(ir.diagnostics.some((item) => item.code === 'SYMLINK_OUTSIDE_ROOT'), false);
  assert.ok(ir.files.some((file) => file.path === 'alias.md'));
  assert.ok(ir.files.some((file) => file.path === 'references/notes.md'));
});

test('tool limits stop the walk and are labelled as tool limits', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'skillporter-limits-'));
  const skill = join(parent, 'skill');
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, 'SKILL.md'), '---\nname: many-files\ndescription: Several files.\n---\n\nBody.\n', 'utf8');
  for (const name of ['a.txt', 'b.txt', 'c.txt']) {
    await writeFile(join(skill, name), 'x'.repeat(64), 'utf8');
  }

  const { ir } = await parseSkill({ path: skill, from: 'claude-code', limits: { maxFiles: 2 } });
  const hit = ir.diagnostics.find((item) => item.code === 'LIMIT_EXCEEDED');

  assert.ok(hit);
  assert.equal(hit.detail?.scope, 'tool');
  assert.equal(hit.detail?.limit, 'maxFiles');
  assert.equal(ir.files.length, 2);
  assert.equal(ir.limits.scope, 'tool');
});

test('a file over the size limit is skipped and reported', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'skillporter-big-'));
  const skill = join(parent, 'skill');
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, 'SKILL.md'), '---\nname: big-file\ndescription: One big file.\n---\n\nBody.\n', 'utf8');
  await writeFile(join(skill, 'big.bin'), 'x'.repeat(2048), 'utf8');

  const { ir } = await parseSkill({ path: skill, from: 'claude-code', limits: { maxFileBytes: 128 } });
  const hit = ir.diagnostics.find((item) => item.code === 'LIMIT_EXCEEDED' && item.detail?.limit === 'maxFileBytes');

  assert.ok(hit);
  assert.equal(ir.files.length, 0);
});

test('nesting deeper than the depth limit is reported, not silently ignored', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'skillporter-deep-'));
  const skill = join(parent, 'skill');
  await mkdir(join(skill, 'a', 'b'), { recursive: true });
  await writeFile(join(skill, 'SKILL.md'), '---\nname: deep\ndescription: Nested.\n---\n\nBody.\n', 'utf8');
  await writeFile(join(skill, 'a', 'b', 'deep.md'), 'deep\n', 'utf8');

  const { ir } = await parseSkill({ path: skill, from: 'claude-code', limits: { maxDepth: 1 } });
  const hit = ir.diagnostics.find((item) => item.code === 'LIMIT_EXCEEDED' && item.detail?.limit === 'maxDepth');

  assert.ok(hit);
  assert.equal(ir.files.some((file) => file.path === 'a/b/deep.md'), false);
});

test('path traversal and absolute paths are rejected before they reach the IR', () => {
  assert.equal(checkSafeRelativePath('references/notes.md').ok, true);
  assert.equal(checkSafeRelativePath('a/../b.md').ok, false);
  assert.equal(checkSafeRelativePath('../escape.md').ok, false);
  assert.equal(checkSafeRelativePath('/etc/passwd').ok, false);
  assert.equal(checkSafeRelativePath('C:/Windows/system32').ok, false);
  assert.equal(checkSafeRelativePath('').ok, false);

  const traversal = checkSafeRelativePath('../escape.md');
  assert.equal(traversal.diagnostic?.code, 'PATH_TRAVERSAL_REJECTED');
  const absolute = checkSafeRelativePath('/etc/passwd');
  assert.equal(absolute.diagnostic?.code, 'ABSOLUTE_PATH_REJECTED');
});

test('the realistic fixture keeps Persian text byte-exact', async () => {
  const { ir } = await parseSkill({ path: join(FIXTURES, 'skills/report-builder'), from: 'claude-code' });
  const source = await readFile(join(FIXTURES, 'skills/report-builder', 'SKILL.md'), 'utf8');

  assert.ok(ir.body.includes('این مهارت یک گزارش HTML مستقل'));
  assert.ok(ir.body.includes('جداکنندهٔ هزارگان'));
  assert.equal(ir.bodyHash, ir.bodyHash.toLowerCase());
  assert.ok(source.endsWith(ir.body));
});
