import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'index.js');

function run(args) {
  return new Promise((settle) => {
    execFile(process.execPath, [CLI, ...args], { cwd: ROOT, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      settle({ code, stdout, stderr });
    });
  });
}

test('inspect prints a human report and exits 0', async () => {
  const { code, stdout } = await run(['inspect', 'fixtures/skills/changelog-writer', '--from', 'claude-code']);

  assert.equal(code, 0);
  assert.match(stdout, /changelog-writer/);
  assert.match(stdout, /origin\s+Claude Code/);
  assert.match(stdout, /result\s+ok/);
  assert.match(stdout, /tool limits, not agent limits/);
});

test('inspect --json emits the IR and detection', async () => {
  const { code, stdout } = await run(['inspect', 'fixtures/skills/report-builder', '--from', 'claude-code', '--json']);
  assert.equal(code, 0);

  const payload = JSON.parse(stdout);
  assert.equal(payload.ir.irVersion, '1.0');
  assert.equal(payload.ir.identity.name, 'report-builder');
  assert.equal(payload.ir.shellInjection.length, 2);
  assert.ok(Array.isArray(payload.ir.diagnostics));
  assert.equal(payload.detection.agent, null);
});

test('inspect reports the shell injection risk in the human output', async () => {
  const { stdout } = await run(['inspect', 'fixtures/skills/report-builder', '--from', 'claude-code']);

  assert.match(stdout, /SHELL_INJECTION/);
  assert.match(stdout, /none executed/);
  assert.match(stdout, /git rev-parse --short HEAD/);
});

test('a shared root exits 1 and asks for --from', async () => {
  const { code, stderr } = await run(['inspect', 'fixtures/shared-root/.agents/skills/shared-helper']);

  assert.equal(code, 1);
  assert.match(stderr, /cannot tell which agent/);
  assert.match(stderr, /--from/);
  assert.match(stderr, /codex-cli, deepseek-harness, kimi-code/);
  assert.match(stderr, /compatibility source: opencode/);
});

test('a missing path exits 1 with a clear message', async () => {
  const { code, stderr } = await run(['inspect', 'does/not/exist', '--from', 'claude-code']);
  assert.equal(code, 1);
  assert.match(stderr, /no such file or directory/);
});

test('a skill with a hard error exits 1', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skillporter-cli-'));
  await writeFile(join(dir, 'SKILL.md'), '---\nname: [broken\n---\n\nBody.\n', 'utf8');

  const { code, stdout } = await run(['inspect', dir, '--from', 'claude-code']);
  assert.equal(code, 1);
  assert.match(stdout, /FRONTMATTER_INVALID/);
  assert.match(stdout, /result\s+error/);
});

test('--to with no agent name names the flag instead of the list being empty', async () => {
  // An empty value reaches the command as an empty array, and the core error
  // for that ("no target agents given") never says which option was empty.
  const empty = await run(['convert', 'fixtures/skills/changelog-writer', '--to', '', '--from', 'claude-code', '--dry-run']);
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /--to was given no agent name/);
  assert.match(empty.stderr, /--to claude-code,codex-cli/);
  assert.doesNotMatch(empty.stderr, /unknown agent/);

  // Only separators is the same mistake with different punctuation.
  const commas = await run(['convert', 'fixtures/skills/changelog-writer', '--to', ',', '--from', 'claude-code', '--dry-run']);
  assert.equal(commas.code, 1);
  assert.match(commas.stderr, /--to was given no agent name/);
});

test('agents lists every profile and --json round-trips', async () => {
  const expected = ['claude-ai-upload', 'claude-code', 'codex-cli', 'deepseek-harness', 'kimi-code', 'opencode'];

  const human = await run(['agents']);
  assert.equal(human.code, 0);
  for (const id of expected) {
    assert.ok(human.stdout.includes(id), `agents output must mention ${id}`);
  }

  const json = await run(['agents', '--json']);
  const profiles = JSON.parse(json.stdout);
  assert.deepEqual(
    profiles.map((profile) => profile.id),
    expected,
  );

  // An archive target has no discovery root, and the human output must say so
  // rather than print an empty "project" line that reads as missing data.
  assert.match(human.stdout, /delivery\s+uploaded bundle/);
});

test('--version reports the manifest version, not a hard-coded string', async () => {
  const manifest = JSON.parse(await readFile(join(ROOT, 'packages', 'cli', 'package.json'), 'utf8'));
  const result = await run(['--version']);

  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), manifest.version);
  // A version that cannot be bumped is worse than no version at all, so the
  // placeholder is rejected explicitly rather than merely compared.
  assert.notEqual(result.stdout.trim(), '0.0.0');
});

test('--help lists every agent name, with the aliases next to the id', async () => {
  // The list comes from the profiles, so a new profile cannot be forgotten
  // here. What the test guards is that the list is present at all, and that an
  // alias is shown next to the id that owns it rather than as a separate entry.
  const { code, stdout } = await run(['convert', '--help']);
  assert.equal(code, 0);

  for (const id of ['claude-ai-upload', 'claude-code', 'codex-cli', 'deepseek-harness', 'kimi-code', 'opencode']) {
    assert.ok(stdout.includes(id), `--help must list ${id}`);
  }
  assert.match(stdout, /codex-cli \(alias: codex\)/);
  assert.match(stdout, /deepseek-harness \(alias: dsh\)/);
});

test('an alias is accepted wherever an agent id is, and reports the canonical id', async () => {
  const { code, stdout } = await run([
    'lint',
    'fixtures/skills/changelog-writer',
    '--for',
    'dsh',
    '--from',
    'codex',
    '--json',
  ]);

  assert.notEqual(code, 1, 'the alias must resolve, not fail as an unknown agent');
  const payload = JSON.parse(stdout);
  assert.equal(payload.target.id, 'deepseek-harness');
  assert.equal(payload.source.agent, 'codex-cli', 'a report names the id, never the alias that was typed');
});

test('an unknown agent lists the accepted names, aliases included', async () => {
  const { code, stderr } = await run(['lint', 'fixtures/skills/changelog-writer', '--for', 'cursor', '--from', 'claude-code']);
  assert.equal(code, 1);
  assert.match(stderr, /unknown agent "cursor"/);
  assert.match(stderr, /codex-cli \(alias: codex\)/);
});
