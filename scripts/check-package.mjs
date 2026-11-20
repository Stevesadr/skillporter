#!/usr/bin/env node
/**
 * Install the packed tarballs into a clean project and use the CLI from there.
 *
 * Everything else in the repository runs against the source tree, where
 * `agents/` and `schema/` happen to sit two directories above `dist/`. A
 * published package has no source tree, so the only way to know the tool works
 * after `npm install` is to actually do it. This check packs both workspaces,
 * installs them somewhere empty, and drives the four commands a user would.
 *
 * Run with `npm run check:package`. Exits 1 on the first failed expectation.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** Agents that must be listed by an installed CLI. */
const EXPECTED_AGENTS = [
  'claude-ai-upload',
  'claude-code',
  'codex-cli',
  'deepseek-harness',
  'kimi-code',
  'opencode',
];

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function ok(message) {
  console.log(`ok   ${message}`);
}

/**
 * npm is a JavaScript entry point, so it is invoked through the same `node`
 * that is running this script. That avoids the `.cmd` shim on Windows and the
 * shebang lookup on POSIX, both of which differ between the three CI systems.
 */
function npm(args, cwd) {
  const entry = process.env.npm_execpath;
  const result = entry
    ? spawnSync(process.execPath, [entry, ...args], { cwd, encoding: 'utf8' })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd, encoding: 'utf8', shell: false });
  if (result.error) fail(`could not run npm ${args.join(' ')}: ${result.error.message}`);
  return result;
}

const work = mkdtempSync(join(tmpdir(), 'skillporter-package-'));
const tarballs = join(work, 'tarballs');
mkdirSync(tarballs, { recursive: true });

try {
  // ---- pack ---------------------------------------------------------------
  const packed = {};
  for (const workspace of ['core', 'cli']) {
    const dir = join(root, 'packages', workspace);
    const result = npm(['pack', '--json', '--pack-destination', tarballs], dir);
    if (result.status !== 0) fail(`npm pack failed in packages/${workspace}\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    const entry = Array.isArray(report) ? report[0] : report;
    if (!entry || typeof entry.filename !== 'string') fail(`npm pack in packages/${workspace} produced no filename`);
    packed[workspace] = { file: join(tarballs, entry.filename), files: entry.files ?? [] };
    ok(`packed ${entry.filename} (${entry.files?.length ?? 0} files, ${entry.size ?? '?'} bytes)`);
  }

  // A tarball that carries the repository is a tarball that carries the tests,
  // the fixtures and any local state. Only the declared `files` belong in it.
  const cliPaths = packed.cli.files.map((entry) => entry.path);
  if (!cliPaths.includes('dist/index.js')) fail('the cli tarball does not contain dist/index.js');
  for (const forbidden of ['tests/', 'fixtures/', 'node_modules/', 'src/']) {
    if (cliPaths.some((path) => path.startsWith(forbidden))) fail(`the cli tarball contains ${forbidden}`);
  }
  const corePaths = packed.core.files.map((entry) => entry.path);
  for (const required of ['dist/index.js', 'agents/claude-code.yaml', 'schema/agent-profile.schema.json']) {
    if (!corePaths.includes(required)) fail(`the core tarball is missing ${required}, so an installed CLI cannot load profiles`);
  }
  ok('both tarballs carry exactly the declared files');

  // ---- install into an empty project --------------------------------------
  const app = join(work, 'app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'package.json'), `${JSON.stringify({ name: 'consumer', private: true, version: '1.0.0' }, null, 2)}\n`);

  const install = npm(
    ['install', packed.core.file, packed.cli.file, '--no-audit', '--no-fund', '--loglevel', 'error'],
    app,
  );
  if (install.status !== 0) fail(`installing the tarballs failed\n${install.stderr}`);
  ok('installed both tarballs into an empty project');

  const cli = join(app, 'node_modules', '@skillporter', 'cli', 'dist', 'index.js');
  if (!existsSync(cli)) fail('node_modules/@skillporter/cli/dist/index.js is missing after install');

  function run(args) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: app, encoding: 'utf8' });
    if (result.error) fail(`could not run skillporter ${args.join(' ')}: ${result.error.message}`);
    return result;
  }

  // ---- agents -------------------------------------------------------------
  const agents = run(['agents', '--json']);
  if (agents.status !== 0) fail(`agents exited ${agents.status}\n${agents.stderr}`);
  const listed = JSON.parse(agents.stdout).map((entry) => entry.id);
  const missing = EXPECTED_AGENTS.filter((id) => !listed.includes(id));
  if (missing.length > 0) fail(`agents did not list ${missing.join(', ')} — the profiles were not found after install`);
  ok(`agents listed all ${EXPECTED_AGENTS.length} profiles from the installed package`);

  // ---- a skill to work on -------------------------------------------------
  const skill = join(app, 'skills', 'changelog-writer');
  cpSync(join(root, 'fixtures', 'skills', 'changelog-writer'), skill, { recursive: true });

  const inspect = run(['inspect', skill, '--from', 'claude-code', '--json']);
  if (inspect.status !== 0) fail(`inspect exited ${inspect.status}\n${inspect.stderr}`);
  const inspected = JSON.parse(inspect.stdout);
  const identity = inspected.ir?.identity?.name;
  if (typeof identity !== 'string') fail('inspect returned no ir.identity.name');
  ok(`inspect read the skill as "${identity}"`);

  const lint = run(['lint', skill, '--for', 'opencode']);
  if (![0, 1, 2].includes(lint.status)) fail(`lint exited ${lint.status}, which is not a documented code\n${lint.stderr}`);
  if (!lint.stdout.includes('result')) fail('lint printed no summary');
  ok(`lint ran and exited ${lint.status} (a documented code)`);

  const out = join(app, 'out');
  const convert = run(['convert', skill, '--from', 'claude-code', '--to', 'codex-cli,claude-ai-upload', '--out', out]);
  if (convert.status !== 0) fail(`convert exited ${convert.status}\n${convert.stderr}`);
  for (const expected of [join(out, 'codex-cli', 'changelog-writer', 'SKILL.md'), join(out, 'claude-ai-upload', 'changelog-writer', 'SKILL.md')]) {
    if (!existsSync(expected)) fail(`convert did not write ${expected}`);
  }
  ok('convert wrote both targets from the installed package');

  // ---- a usage error is a usage error, not a crash -------------------------
  const unknown = run(['lint', skill, '--for', 'not-an-agent']);
  if (unknown.status !== 1) fail(`an unknown agent should exit 1, got ${unknown.status}`);
  ok('an unknown agent is refused with exit 1');

  console.log('\nthe packed tarballs work from an empty project');
} finally {
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    console.warn(`note: could not remove ${work}`);
  }
}
