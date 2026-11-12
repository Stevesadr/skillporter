import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
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
  const { code, stdout } = await run(['inspect', 'fixtures/skills/simple-prompt', '--from', 'claude-code']);

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

test('agents lists all five profiles and --json round-trips', async () => {
  const human = await run(['agents']);
  assert.equal(human.code, 0);
  for (const id of ['claude-code', 'codex-cli', 'deepseek-harness', 'kimi-code', 'opencode']) {
    assert.ok(human.stdout.includes(id), `agents output must mention ${id}`);
  }

  const json = await run(['agents', '--json']);
  const profiles = JSON.parse(json.stdout);
  assert.equal(profiles.length, 5);
  assert.deepEqual(
    profiles.map((profile) => profile.id),
    ['claude-code', 'codex-cli', 'deepseek-harness', 'kimi-code', 'opencode'],
  );
});
