import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { parseSkill, sha256, AmbiguousSourceError } from '../packages/core/dist/index.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FIXTURES = join(ROOT, 'fixtures');

async function tempSkill(files) {
  const dir = await mkdtemp(join(tmpdir(), 'skillporter-parse-'));
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  return dir;
}

test('parses a simple directory skill', async () => {
  const { ir, detection } = await parseSkill({
    path: join(FIXTURES, 'skills/simple-prompt'),
    from: 'claude-code',
  });

  assert.equal(ir.irVersion, '1.0');
  assert.equal(ir.identity.name, 'changelog-writer');
  assert.equal(ir.identity.source, 'frontmatter');
  assert.match(ir.description, /Draft a changelog entry/);
  assert.equal(ir.origin.layout, 'directory');
  assert.equal(ir.origin.agent, 'claude-code');
  assert.equal(ir.text.lineEnding, 'lf');
  assert.equal(ir.text.hasBom, false);
  assert.deepEqual(ir.files, []);
  assert.equal(detection.agent, null, 'a bare fixture directory is not inside a known root');
});

test('the body is byte-exact and hashed', async () => {
  const path = join(FIXTURES, 'skills/simple-prompt');
  const { ir } = await parseSkill({ path, from: 'claude-code' });
  const source = await readFile(join(path, 'SKILL.md'), 'utf8');

  assert.ok(source.endsWith(ir.body), 'body must be the exact tail of the file');
  assert.equal(ir.bodyHash, sha256(Buffer.from(ir.body, 'utf8')));
  assert.ok(ir.body.startsWith('\n# Changelog writer'));
});

test('CRLF line endings survive untouched', async () => {
  const content = '---\r\nname: crlf-skill\r\ndescription: Keeps CRLF.\r\n---\r\n\r\nLine one\r\nLine two\r\n';
  const dir = await tempSkill({ 'SKILL.md': content });
  const { ir } = await parseSkill({ path: dir, from: 'claude-code' });

  assert.equal(ir.text.lineEnding, 'crlf');
  assert.equal(ir.body, '\r\nLine one\r\nLine two\r\n');
  assert.ok(ir.body.includes('\r\n'), 'body must not be normalised to LF');
});

test('a UTF-8 BOM is recorded and stripped from the body only', async () => {
  const content = '\uFEFF---\nname: bom-skill\ndescription: Has a BOM.\n---\n\nBody.\n';
  const dir = await tempSkill({ 'SKILL.md': content });
  const { ir } = await parseSkill({ path: dir, from: 'claude-code' });

  assert.equal(ir.text.hasBom, true);
  assert.equal(ir.identity.name, 'bom-skill');
  assert.equal(ir.body, '\nBody.\n');
});

test('unknown frontmatter fields are preserved verbatim with position', async () => {
  const { ir } = await parseSkill({ path: join(FIXTURES, 'skills/report-builder'), from: 'claude-code' });
  const extra = ir.frontmatter.fields.find((field) => field.key === 'x-acme-owner');

  assert.ok(extra, 'x-acme-owner must survive parsing');
  assert.equal(extra.value, 'data-platform');
  assert.equal(extra.status, 'unknown');
  assert.equal(extra.effect, 'unknown');
  assert.equal(extra.line, 5);
  assert.equal(extra.raw, 'x-acme-owner: data-platform');

  const warning = ir.diagnostics.find((item) => item.code === 'UNKNOWN_CAPABILITY' && item.detail?.kind === 'unmapped-field');
  assert.ok(warning, 'an unmapped field must produce UNKNOWN_CAPABILITY');
  assert.equal(warning.severity, 'warning');
  assert.equal(warning.line, 5);
});

test('fields the agent ignores are marked ignored, not unknown', async () => {
  const { ir } = await parseSkill({ path: join(FIXTURES, 'skills/report-builder'), from: 'deepseek-harness' });
  const allowed = ir.frontmatter.fields.find((field) => field.key === 'allowed-tools');

  assert.ok(allowed);
  assert.equal(allowed.status, 'ignored');
  assert.equal(allowed.effect, 'ignored');
  assert.equal(
    ir.diagnostics.some((item) => item.code === 'UNKNOWN_CAPABILITY' && item.detail?.field === 'allowed-tools'),
    false,
    'an ignored field is documented behaviour, not an unknown',
  );
});

test('shell injection is found with file line numbers, both syntaxes', async () => {
  const { ir } = await parseSkill({ path: join(FIXTURES, 'skills/report-builder'), from: 'claude-code' });

  assert.equal(ir.shellInjection.length, 2);
  const [inline, fenced] = ir.shellInjection;
  assert.equal(inline.kind, 'inline-bang');
  assert.equal(inline.line, 23);
  assert.equal(inline.command, 'git rev-parse --short HEAD');
  assert.equal(fenced.kind, 'fenced-bang');
  assert.equal(fenced.line, 27);
  assert.match(fenced.command, /build_report\.py/);

  const warnings = ir.diagnostics.filter((item) => item.code === 'SHELL_INJECTION');
  assert.equal(warnings.length, 2);
  assert.deepEqual(
    warnings.map((item) => item.line),
    [23, 27],
    'diagnostics and the occurrence list must agree on line numbers',
  );
});

test('an agent that does not execute shell syntax produces no SHELL_INJECTION', async () => {
  const { ir } = await parseSkill({ path: join(FIXTURES, 'skills/report-builder'), from: 'kimi-code' });

  assert.equal(ir.shellInjection.length, 2, 'occurrences are still recorded for the report');
  assert.equal(ir.diagnostics.filter((item) => item.code === 'SHELL_INJECTION').length, 0);
});

test('kimi flow skills parse and type is honoured', async () => {
  const { ir } = await parseSkill({ path: join(FIXTURES, 'skills/flow-release'), from: 'kimi-code' });
  const type = ir.frontmatter.fields.find((field) => field.key === 'type');

  assert.ok(type);
  assert.equal(type.value, 'flow');
  assert.equal(type.status, 'supported');
  assert.equal(type.effect, 'honoured');
  assert.match(ir.body, /```mermaid/, 'the diagram body must be preserved as plain text');
});

test('flat .md skills have no bundled files and say so', async () => {
  const { ir } = await parseSkill({
    path: join(FIXTURES, 'shared-root/.agents/skills/flat-helper.md'),
    from: 'kimi-code',
  });

  assert.equal(ir.origin.layout, 'flat');
  assert.equal(ir.identity.name, 'flat-helper');
  assert.equal(ir.identity.source, 'filename');
  assert.deepEqual(ir.files, []);
  assert.ok(ir.diagnostics.some((item) => item.code === 'FLAT_LAYOUT' && item.severity === 'info'));
});

test('identity falls back to the directory name where the agent documents it', async () => {
  const dir = await tempSkill({ 'SKILL.md': '---\ndescription: No name here.\n---\n\nBody.\n' });
  const { ir } = await parseSkill({ path: dir, from: 'claude-code' });

  assert.equal(ir.identity.source, 'directory');
  assert.ok(ir.identity.name.startsWith('skillporter-parse-'));
  assert.ok(ir.diagnostics.some((item) => item.code === 'IDENTITY_DERIVED' && item.severity === 'info'));
  assert.equal(ir.diagnostics.filter((item) => item.severity === 'error').length, 0);
});

test('a missing name is an error where the agent requires one', async () => {
  const dir = await tempSkill({ 'SKILL.md': '---\ndescription: No name here.\n---\n\nBody.\n' });
  const { ir } = await parseSkill({ path: dir, from: 'kimi-code' });

  const error = ir.diagnostics.find((item) => item.code === 'MISSING_REQUIRED_FIELD' && item.severity === 'error');
  assert.ok(error, 'kimi-code requires name in a directory skill');
  assert.equal(error.detail?.field, 'name');
});

test('invalid YAML is an error, not a guess', async () => {
  const dir = await tempSkill({ 'SKILL.md': '---\nname: [unclosed\n---\n\nBody.\n' });
  const { ir } = await parseSkill({ path: dir, from: 'claude-code' });

  assert.ok(ir.diagnostics.some((item) => item.code === 'FRONTMATTER_INVALID' && item.severity === 'error'));
});

test('a file with no frontmatter still parses and says so', async () => {
  const dir = await tempSkill({ 'SKILL.md': '# Just markdown\n\nNo frontmatter.\n' });
  const { ir } = await parseSkill({ path: dir, from: 'claude-code' });

  assert.equal(ir.frontmatter.present, false);
  assert.ok(ir.diagnostics.some((item) => item.code === 'FRONTMATTER_MISSING'));
  assert.equal(ir.body, '# Just markdown\n\nNo frontmatter.\n');
});

test('the IR validates against its published schema', async () => {
  const schema = JSON.parse(await readFile(join(ROOT, 'schema/ir.schema.json'), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

  for (const [path, from] of [
    ['skills/simple-prompt', 'claude-code'],
    ['skills/report-builder', 'claude-code'],
    ['skills/flow-release', 'kimi-code'],
    ['shared-root/.agents/skills/flat-helper.md', 'kimi-code'],
  ]) {
    const { ir } = await parseSkill({ path: join(FIXTURES, path), from });
    const valid = validate(ir);
    assert.ok(valid, `${path}: ${JSON.stringify(validate.errors, null, 2)}`);
  }
});

test('a shared root refuses to pick an agent', async () => {
  await assert.rejects(
    () => parseSkill({ path: join(FIXTURES, 'shared-root/.agents/skills/shared-helper') }),
    (error) => {
      assert.ok(error instanceof AmbiguousSourceError);
      assert.deepEqual(error.detection.candidates, ['codex-cli', 'deepseek-harness', 'kimi-code']);
      assert.deepEqual(error.detection.alsoReadBy, ['opencode']);
      assert.equal(error.detection.matchedRoot, '.agents/skills');
      return true;
    },
  );
});

test('an unknown --from is rejected with the list of agents', async () => {
  await assert.rejects(
    () => parseSkill({ path: join(FIXTURES, 'skills/simple-prompt'), from: 'not-an-agent' }),
    /unknown agent "not-an-agent"\. Known agents: claude-code, codex-cli, deepseek-harness, kimi-code, opencode/,
  );
});
