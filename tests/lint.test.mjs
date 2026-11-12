import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import { LINT_RULES, caseCollisions, clearProfileCache, lintSkill } from '../packages/core/dist/index.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'index.js');
const LINT_ROOT = 'fixtures/lint/.agents/skills';

function run(args) {
  return new Promise((settle) => {
    execFile(process.execPath, [CLI, ...args], { cwd: ROOT, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      settle({ code, stdout, stderr });
    });
  });
}

async function lint(path, options) {
  return lintSkill({ path: resolve(ROOT, path), ...options });
}

function ruleIds(result) {
  return result.findings.map((item) => item.ruleId);
}

function has(result, ruleId) {
  return ruleIds(result).includes(ruleId);
}

// ---------------------------------------------------------------------------
// One pass and one fail case per rule, driven by the real five profiles.
// ---------------------------------------------------------------------------

const RULE_CASES = [
  { rule: 'SP001', fail: ['bad-name', 'deepseek-harness'], pass: ['simple-prompt', 'deepseek-harness'] },
  { rule: 'SP004', fail: ['no-name', 'deepseek-harness'], pass: ['simple-prompt', 'deepseek-harness'] },
  { rule: 'SP005', fail: ['deep/group/skill', 'opencode'], pass: ['simple-prompt', 'claude-code'] },
  { rule: 'SP006', fail: ['no-description', 'deepseek-harness'], pass: ['simple-prompt', 'deepseek-harness'] },
  { rule: 'SP008', fail: ['long-description', 'deepseek-harness'], pass: ['simple-prompt', 'deepseek-harness'] },
  { rule: 'SP009', fail: ['flat-skill.md', 'codex-cli'], pass: ['flat-skill.md', 'deepseek-harness'] },
  { rule: 'SP010', fail: ['deep/group/skill', 'claude-code'], pass: ['deep/group/skill', 'opencode'] },
  { rule: 'SP011', fail: ['ignored-fields', 'deepseek-harness'], pass: ['simple-prompt', 'deepseek-harness'] },
  { rule: 'SP013', fail: ['report-builder', 'claude-code'], pass: ['simple-prompt', 'claude-code'] },
  { rule: 'SP014', fail: ['alias-spelling', 'claude-code'], pass: ['alias-spelling', 'deepseek-harness'] },
  { rule: 'SP015', fail: ['flow-release', 'kimi-code'], pass: ['flow-release', 'claude-code'] },
  { rule: 'SP016', fail: ['report-builder', 'claude-code'], pass: ['simple-prompt', 'claude-code'] },
  { rule: 'SP017', fail: ['report-builder', 'deepseek-harness'], pass: ['simple-prompt', 'deepseek-harness'] },
  { rule: 'SP021', fail: ['dup-one', 'deepseek-harness'], pass: ['bad-name', 'deepseek-harness'] },
  { rule: 'SP023', fail: ['report-builder', 'claude-code', { maxFiles: 1 }], pass: ['report-builder', 'claude-code'] },
  { rule: 'SP024', fail: ['no-frontmatter', 'deepseek-harness'], pass: ['simple-prompt', 'deepseek-harness'] },
];

/** Resolve a short fixture name to a real path, preferring the lint fixtures. */
function fixturePath(name) {
  if (name.startsWith('fixtures/')) return name;
  const inLint = `${LINT_ROOT}/${name}`;
  if (existsSync(resolve(ROOT, inLint))) return inLint;
  const inSkills = `fixtures/skills/${name}`;
  if (existsSync(resolve(ROOT, inSkills))) return inSkills;
  throw new Error(`no fixture named "${name}"`);
}

for (const { rule, fail, pass } of RULE_CASES) {
  test(`${rule} fires on its fail fixture and not on its pass fixture`, async () => {
    const [failPath, failFor, failLimits] = fail;
    const [passPath, passFor, passLimits] = pass;

    const failing = await lint(fixturePath(failPath), {
      for: failFor,
      from: 'claude-code',
      ...(failLimits ? { limits: failLimits } : {}),
    });
    assert.ok(
      has(failing, rule),
      `${rule} should fire on ${failPath} for ${failFor}; got ${ruleIds(failing).join(', ') || '(none)'}`,
    );

    const passing = await lint(fixturePath(passPath), {
      for: passFor,
      from: 'claude-code',
      ...(passLimits ? { limits: passLimits } : {}),
    });
    assert.ok(
      !has(passing, rule),
      `${rule} should not fire on ${passPath} for ${passFor}; got ${ruleIds(passing).join(', ') || '(none)'}`,
    );
  });
}

test('every rule id in the catalogue is exercised by this suite', async () => {
  const covered = new Set(RULE_CASES.map((item) => item.rule));
  // Covered by the fake-profile test and by the dynamic filesystem tests below.
  for (const rule of ['SP002', 'SP003', 'SP007', 'SP012', 'SP018', 'SP019', 'SP020', 'SP022']) covered.add(rule);

  const missing = LINT_RULES.map((rule) => rule.id).filter((id) => !covered.has(id));
  assert.deepEqual(missing, [], `no test covers: ${missing.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Severity must follow the profile, not the agent.
// ---------------------------------------------------------------------------

test('severity follows the enforcement the profile documents', async () => {
  // dsh drops an invalid name from the catalog: an error, not a warning.
  const badName = await lint(`${LINT_ROOT}/bad-name`, { for: 'deepseek-harness', from: 'claude-code' });
  const grammar = badName.findings.find((item) => item.ruleId === 'SP001');
  assert.equal(grammar.severity, 'error');
  assert.match(grammar.hint, /silently never appear/);

  // Claude Code has no name grammar, so the same skill is clean there.
  const claude = await lint(`${LINT_ROOT}/bad-name`, { for: 'claude-code', from: 'claude-code' });
  assert.equal(has(claude, 'SP001'), false);

  // A truncation is display-only: warning, never error.
  const truncated = await lint(`${LINT_ROOT}/long-description`, { for: 'deepseek-harness', from: 'claude-code' });
  assert.equal(truncated.findings.find((item) => item.ruleId === 'SP008').severity, 'warning');
});

test('the same fact produces different severities for different targets', async () => {
  // No frontmatter: fatal where the target needs it, a warning where it does not.
  const dsh = await lint(`${LINT_ROOT}/no-frontmatter`, { for: 'deepseek-harness', from: 'deepseek-harness' });
  const claude = await lint(`${LINT_ROOT}/no-frontmatter`, { for: 'claude-code', from: 'claude-code' });

  assert.equal(dsh.findings.find((item) => item.ruleId === 'SP024').severity, 'error');
  assert.equal(claude.findings.find((item) => item.ruleId === 'SP024').severity, 'warning');
});

test('shell injection severity depends on whether the conversion introduces execution', async () => {
  // Source is Claude Code, which executes; target dsh does not: inert, a warning.
  const inert = await lint('fixtures/skills/report-builder', { for: 'deepseek-harness', from: 'claude-code' });
  assert.equal(inert.findings.find((item) => item.ruleId === 'SP017').severity, 'warning');

  // Source does not execute; target Claude Code does: an error, because the
  // conversion would introduce execution the skill never had.
  const introduced = await lint('fixtures/skills/report-builder', { for: 'claude-code', from: 'deepseek-harness' });
  const executed = introduced.findings.filter((item) => item.ruleId === 'SP016');
  assert.equal(executed.length, 2, 'one finding per occurrence, with a line number');
  for (const item of executed) {
    assert.equal(item.severity, 'error');
    assert.ok(item.line > 0, 'each occurrence carries a line');
    assert.match(item.message, /introduce execution|only displayed/);
  }

  // Source and target both execute: unchanged behaviour, a warning.
  const unchanged = await lint('fixtures/skills/report-builder', { for: 'claude-code', from: 'claude-code' });
  for (const item of unchanged.findings.filter((entry) => entry.ruleId === 'SP016')) {
    assert.equal(item.severity, 'warning');
  }
});

// ---------------------------------------------------------------------------
// Unknown capability: reported, never guessed, suppressible.
// ---------------------------------------------------------------------------

test('an unknown field is reported as UNKNOWN_CAPABILITY, not guessed at', async () => {
  const result = await lint('fixtures/skills/report-builder', { for: 'claude-code', from: 'claude-code' });
  const unknown = result.findings.find((item) => item.code === 'UNKNOWN_CAPABILITY');

  assert.ok(unknown, 'the unmapped x-acme-owner field must be reported');
  assert.equal(unknown.severity, 'warning');
  assert.equal(unknown.ruleId, 'SP013');
  assert.match(unknown.message, /not mentioned anywhere/);
  assert.equal(unknown.detail.reason, 'unmapped');
  assert.ok(unknown.fix, 'every finding carries a suggested fix');
  assert.ok(unknown.source.startsWith('https://'), 'every finding cites a source URL');
});

test('--ignore-unknown suppresses only UNKNOWN_CAPABILITY findings', async () => {
  const base = await lint('fixtures/skills/report-builder', { for: 'claude-code', from: 'claude-code' });
  const suppressed = await lint('fixtures/skills/report-builder', {
    for: 'claude-code',
    from: 'claude-code',
    ignoreUnknown: true,
  });

  const unknownBefore = base.findings.filter((item) => item.code === 'UNKNOWN_CAPABILITY').length;
  assert.ok(unknownBefore > 0);
  assert.equal(suppressed.summary.suppressed, unknownBefore);
  assert.equal(
    suppressed.findings.filter((item) => item.code === 'UNKNOWN_CAPABILITY').length,
    0,
  );
  // Everything that is not an unknown-capability finding survives.
  assert.equal(
    suppressed.findings.length,
    base.findings.length - unknownBefore,
  );
});

// ---------------------------------------------------------------------------
// Optional --from, and ambiguity reported rather than refused.
// ---------------------------------------------------------------------------

test('lint infers the source and reports the inference instead of refusing', async () => {
  const result = await lint(`${LINT_ROOT}/bad-name`, { for: 'deepseek-harness' });

  assert.equal(result.source.assumed, true);
  assert.equal(result.source.explicit, false);
  assert.equal(result.source.detection.ambiguous, true);
  assert.deepEqual(result.source.detection.candidates, ['codex-cli', 'deepseek-harness', 'kimi-code']);
  assert.deepEqual(result.source.detection.alsoReadBy, ['opencode']);
});

test('the assumption is explained in the human output', async () => {
  const { code, stdout } = await run(['lint', `${LINT_ROOT}/bad-name`, '--for', 'deepseek-harness']);

  assert.equal(code, 1);
  assert.match(stdout, /assumed/);
  assert.match(stdout, /read natively by codex-cli, deepseek-harness, kimi-code/);
  assert.match(stdout, /Pass --from to remove the assumption/);
});

test('an explicit --from removes the assumption', async () => {
  const result = await lint(`${LINT_ROOT}/bad-name`, { for: 'deepseek-harness', from: 'codex-cli' });
  assert.equal(result.source.assumed, false);
  assert.equal(result.source.explicit, true);
  assert.equal(result.source.agent, 'codex-cli');
});

// ---------------------------------------------------------------------------
// Exit codes.
// ---------------------------------------------------------------------------

test('exit codes are 0 clean, 1 for an error, 2 for warnings only', async () => {
  const clean = await run(['lint', `${LINT_ROOT}/flat-skill.md`, '--for', 'deepseek-harness', '--from', 'deepseek-harness']);
  assert.equal(clean.code, 0, clean.stdout);

  const error = await run(['lint', `${LINT_ROOT}/flat-skill.md`, '--for', 'codex-cli', '--from', 'deepseek-harness']);
  assert.equal(error.code, 1, error.stdout);

  const warning = await run(['lint', `${LINT_ROOT}/long-description`, '--for', 'deepseek-harness', '--from', 'deepseek-harness']);
  assert.equal(warning.code, 2, warning.stdout);
});

test('--ignore-unknown can turn exit 2 into 0 but never 1 into 0', async () => {
  // Every finding here is a "we do not know" one, so suppressing them leaves nothing.
  const onlyUnknown = await run(['lint', 'fixtures/skills/flow-release', '--for', 'claude-code', '--from', 'kimi-code']);
  assert.equal(onlyUnknown.code, 2, onlyUnknown.stdout);

  const suppressed = await run([
    'lint',
    'fixtures/skills/flow-release',
    '--for',
    'claude-code',
    '--from',
    'kimi-code',
    '--ignore-unknown',
  ]);
  assert.equal(suppressed.code, 0, suppressed.stdout);

  // An error is never suppressible, because it is a verified fact, not a gap.
  const stillError = await run([
    'lint',
    `${LINT_ROOT}/flat-skill.md`,
    '--for',
    'codex-cli',
    '--from',
    'deepseek-harness',
    '--ignore-unknown',
  ]);
  assert.equal(stillError.code, 1, stillError.stdout);
});

test('an unknown agent exits 1 and names the known ones', async () => {
  const { code, stderr } = await run(['lint', `${LINT_ROOT}/bad-name`, '--for', 'nope']);
  assert.equal(code, 1);
  assert.match(stderr, /unknown agent "nope"/);
  assert.match(stderr, /claude-code/);
});

// ---------------------------------------------------------------------------
// JSON output conforms to the published schema.
// ---------------------------------------------------------------------------

test('lint --format json validates against schema/lint-report.schema.json', async () => {
  const schema = JSON.parse(await readFile(join(ROOT, 'schema', 'lint-report.schema.json'), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

  const cases = [
    ['fixtures/skills/report-builder', 'claude-code'],
    [`${LINT_ROOT}/bad-name`, 'deepseek-harness'],
    [`${LINT_ROOT}/flat-skill.md`, 'codex-cli'],
    [`${LINT_ROOT}/alias-spelling`, 'claude-code'],
    ['fixtures/skills/simple-prompt', 'opencode'],
  ];

  for (const [path, target] of cases) {
    const { stdout } = await run(['lint', path, '--for', target, '--format', 'json']);
    const payload = JSON.parse(stdout);
    assert.ok(validate(payload), `${path} for ${target}: ${JSON.stringify(validate.errors)}`);

    for (const finding of payload.findings) {
      assert.match(finding.ruleId, /^SP\d{3}$/);
      assert.ok(finding.fix, 'every finding has a suggested fix');
      assert.match(finding.source, /^https?:\/\//, 'every finding cites a source');
    }
  }
});

test('--json is an alias for --format json', async () => {
  const a = await run(['lint', `${LINT_ROOT}/bad-name`, '--for', 'deepseek-harness', '--json']);
  const b = await run(['lint', `${LINT_ROOT}/bad-name`, '--for', 'deepseek-harness', '--format', 'json']);
  assert.deepEqual(JSON.parse(a.stdout), JSON.parse(b.stdout));
});

// ---------------------------------------------------------------------------
// The proof: a brand-new agent profile needs no new rule code.
// ---------------------------------------------------------------------------

const FAKE_PROFILE = `id: fake-agent
displayName: Fake Agent
format: agent-skills
verification: partial
notes: Synthetic profile. Exists only to prove that lint rules come from profile data.

paths:
  project:
    - path: <projectRoot>/.fake/skills
      scope: project
  global:
    - path: ~/.fake/skills
      scope: user

discovery:
  skillDirDepth: 2
  acceptsFlatMarkdown: false
  followsSymlinks: false
  upwardSearch: false
  duplicateResolution: The later root wins.

identity:
  source: frontmatter
  requiredInDirectoryForm: true
  requiredInFlatForm: true

name:
  pattern: '^[a-z][a-z0-9-]{0,15}$'
  maxLength: 16
  mustMatchDirectory: true
  enforcement: reject

description:
  maxLength: 120
  enforcement: reject
  requiredInDirectoryForm: true
  requiredInFlatForm: true
  truncation:
    at: 60
    unit: characters

bodyExecution:
  shellInjection:
    executed: true
    syntaxes:
      - inline-bang

fields:
  name:
    status: supported
  description:
    status: supported
  experimental:
    status: unsupported
    note: Fake Agent has no experimental mode.
  metadata:
    status: ignored
    note: Accepted and dropped.
  notes:
    status: unknown
    note: Not documented.

extensions:
  - id: fake-quirk
    description: A synthetic extension, triggered by experimental true.
    fidelityImpact: dropped
    trigger:
      field: experimental
      equals: true

sources:
  - url: https://example.invalid/fake-agent
    retrieved: 2026-11-12
    note: Synthetic.
    covers:
      - format
      - paths
      - discovery
      - identity
      - name
      - description
      - fields
      - bodyExecution
`;

const FAKE_SKILL = `---
name: Wrong_Name_That_Is_Too_Long
description: ${'A description long enough to exceed both the hard limit and the display bound for the fake agent. '.repeat(2)}
metadata:
  owner: someone
notes: free text
experimental: true
---

# Fake skill

Run this: !\`git status\`

The body also has a placeholder, which the fake agent executes.
`;

async function withFakeAgent(callback) {
  const dir = await mkdtemp(join(tmpdir(), 'skillporter-fake-'));
  await cp(join(ROOT, 'agents'), join(dir, 'agents'), { recursive: true });
  await cp(join(ROOT, 'schema'), join(dir, 'schema'), { recursive: true });
  await writeFile(join(dir, 'agents', 'fake-agent.yaml'), FAKE_PROFILE, 'utf8');

  const skillDir = join(dir, '.fake', 'skills', 'fake-skill');
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), FAKE_SKILL, 'utf8');

  const previous = process.env.SKILLPORTER_AGENTS_DIR;
  process.env.SKILLPORTER_AGENTS_DIR = join(dir, 'agents');
  clearProfileCache();
  try {
    return await callback({ dir, skillDir });
  } finally {
    if (previous === undefined) delete process.env.SKILLPORTER_AGENTS_DIR;
    else process.env.SKILLPORTER_AGENTS_DIR = previous;
    clearProfileCache();
  }
}

test('a new agent profile brings its rules with it, with no new rule code', async () => {
  await withFakeAgent(async ({ skillDir }) => {
    const result = await lintSkill({ path: skillDir, for: 'fake-agent' });

    assert.equal(result.target.id, 'fake-agent');
    assert.equal(result.target.verification, 'partial');

    const fired = new Set(ruleIds(result));
    // Every one of these is driven purely by the fake profile's data.
    for (const rule of ['SP001', 'SP002', 'SP003', 'SP007', 'SP008', 'SP011', 'SP012', 'SP013', 'SP015', 'SP016']) {
      assert.ok(fired.has(rule), `${rule} should fire for the synthetic profile; fired: ${[...fired].join(', ')}`);
    }

    // Name grammar and length come from name.pattern and name.maxLength.
    const grammar = result.findings.find((item) => item.ruleId === 'SP001');
    assert.match(grammar.message, /\^\[a-z\]\[a-z0-9-\]\{0,15\}\$/);
    assert.equal(grammar.severity, 'error', 'enforcement: reject is an error');

    // A synthetic extension, matched by a declarative trigger.
    const extension = result.findings.find((item) => item.ruleId === 'SP015');
    assert.match(extension.message, /fake-quirk/);
    assert.equal(extension.severity, 'warning', 'fidelityImpact: dropped is a warning');

    // A status no real profile currently uses.
    assert.ok(result.findings.some((item) => item.ruleId === 'SP012'));
  });
});

test('the synthetic profile also drives layout and depth rules', async () => {
  await withFakeAgent(async ({ dir }) => {
    const flat = join(dir, '.fake', 'skills', 'flat-one.md');
    await writeFile(flat, '---\nname: flat-one\ndescription: A flat skill.\n---\n\nBody.\n', 'utf8');

    const flatResult = await lintSkill({ path: flat, for: 'fake-agent' });
    assert.ok(has(flatResult, 'SP009'), 'acceptsFlatMarkdown: false makes a flat skill an error');
    assert.equal(flatResult.findings.find((item) => item.ruleId === 'SP009').severity, 'error');

    const deepDir = join(dir, '.fake', 'skills', 'a', 'b', 'c');
    await mkdir(deepDir, { recursive: true });
    await writeFile(join(deepDir, 'SKILL.md'), '---\nname: c\ndescription: Deep.\n---\n\nBody.\n', 'utf8');

    const deepResult = await lintSkill({ path: deepDir, for: 'fake-agent' });
    assert.ok(has(deepResult, 'SP010'), 'skillDirDepth: 2 must reject depth 3');
    assert.match(deepResult.findings.find((item) => item.ruleId === 'SP010').message, /3 directories below/);
  });
});

// ---------------------------------------------------------------------------
// Filesystem facts: symlinks and case collisions.
// ---------------------------------------------------------------------------

test('a symlink escaping the skill root is reported, not followed silently', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skillporter-symlink-'));
  const skillDir = join(dir, '.fake', 'skills', 'linked');
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: linked\ndescription: Has a link.\n---\n\nBody.\n', 'utf8');

  const outside = join(dir, 'outside.txt');
  await writeFile(outside, 'secret\n', 'utf8');
  await symlink(outside, join(skillDir, 'escape.txt'));

  const result = await lintSkill({ path: skillDir, for: 'claude-code' });
  const finding = result.findings.find((item) => item.ruleId === 'SP018');

  assert.ok(finding, 'SP018 must fire for a symlink pointing outside the root');
  assert.equal(finding.code, 'SYMLINK_OUTSIDE_ROOT');
  assert.equal(finding.file, 'escape.txt');
  assert.match(finding.hint ?? '', /not read/i);
});

test('a broken symlink is reported', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skillporter-broken-'));
  const skillDir = join(dir, '.fake', 'skills', 'broken');
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: broken\ndescription: Has a dead link.\n---\n\nBody.\n', 'utf8');
  await symlink(join(dir, 'does-not-exist'), join(skillDir, 'dead.txt'));

  const result = await lintSkill({ path: skillDir, for: 'claude-code' });
  const finding = result.findings.find((item) => item.ruleId === 'SP019');
  assert.ok(finding, 'SP019 must fire for a dangling link');
  assert.equal(finding.code, 'SYMLINK_BROKEN');
});

test('a skill reached through a symlink is checked against the target symlink policy', async () => {
  await withFakeAgent(async ({ dir }) => {
    const real = join(dir, 'real-skill');
    await mkdir(real, { recursive: true });
    await writeFile(join(real, 'SKILL.md'), '---\nname: real\ndescription: Linked into place.\n---\n\nBody.\n', 'utf8');

    const link = join(dir, '.fake', 'skills', 'real');
    await symlink(real, link);

    // The synthetic profile sets followsSymlinks: false.
    const fake = await lintSkill({ path: link, for: 'fake-agent' });
    const finding = fake.findings.find((item) => item.ruleId === 'SP020');
    assert.ok(finding, 'SP020 must fire when the skill root is a symlink');
    assert.equal(finding.severity, 'error', 'followsSymlinks: false is an error');
    assert.equal(finding.code, 'SYMLINK_ROOT');

    // OpenCode records followsSymlinks as null, which is undocumented, not denied.
    const opencode = await lintSkill({ path: link, for: 'opencode' });
    const undocumented = opencode.findings.find((item) => item.ruleId === 'SP020');
    assert.ok(undocumented);
    assert.equal(undocumented.severity, 'warning');
    assert.match(undocumented.hint ?? '', /undocumented, not denied/);
  });
});

test('case-collision detection is correct on every platform', () => {
  assert.deepEqual(caseCollisions(['SKILL.md', 'scripts/run.sh']), []);
  assert.deepEqual(caseCollisions(['notes.md', 'Notes.md']), [['notes.md', 'Notes.md']]);
  assert.deepEqual(caseCollisions(['SKILL.md', 'skill.md']), [['SKILL.md', 'skill.md']]);
  assert.deepEqual(caseCollisions(['a.md', 'A.md', 'b.md', 'B.md']), [
    ['a.md', 'A.md'],
    ['b.md', 'B.md'],
  ]);
  // The same path twice is not a collision.
  assert.deepEqual(caseCollisions(['a.md', 'a.md']), []);
});

test('bundled files that differ only by case are reported', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'skillporter-case-'));
  const skillDir = join(dir, '.fake', 'skills', 'case-clash');
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: case-clash\ndescription: Two files.\n---\n\nBody.\n', 'utf8');
  await writeFile(join(skillDir, 'notes.md'), 'lower\n', 'utf8');

  try {
    await writeFile(join(skillDir, 'Notes.md'), 'upper\n', 'utf8');
  } catch {
    t.skip('this filesystem cannot hold two names differing only by case');
    return;
  }

  // A case-insensitive filesystem may accept the second write and silently
  // replace the first; check that both names really exist before asserting.
  const probe = await readFile(join(skillDir, 'notes.md'), 'utf8').catch(() => null);
  if (probe === null || probe.trim() !== 'lower') {
    t.skip('this filesystem is case-insensitive');
    return;
  }

  const result = await lintSkill({ path: skillDir, for: 'claude-code' });
  const finding = result.findings.find((item) => item.ruleId === 'SP022');
  assert.ok(finding, 'SP022 must fire for a case-only collision');
  assert.equal(finding.code, 'FILE_ANOMALY');
  assert.deepEqual([...finding.detail.paths].sort(), ['Notes.md', 'notes.md'].sort());
});

// ---------------------------------------------------------------------------
// Duplicate names, and the tool-limit distinction.
// ---------------------------------------------------------------------------

test('a duplicate name in the same root quotes the target resolution policy', async () => {
  const result = await lint(`${LINT_ROOT}/dup-one`, { for: 'deepseek-harness', from: 'claude-code' });
  const finding = result.findings.find((item) => item.ruleId === 'SP021');

  assert.ok(finding);
  assert.deepEqual(finding.detail.duplicates, ['dup-two']);
  assert.match(finding.hint, /Lowest rank number wins/);

  // A target with no documented policy says so instead of inventing one.
  const codex = await lint(`${LINT_ROOT}/dup-one`, { for: 'codex-cli', from: 'claude-code' });
  const codexFinding = codex.findings.find((item) => item.ruleId === 'SP021');
  assert.match(codexFinding.hint, /both skills can appear|not merged|does not document/i);
});

test('a tool limit is reported as a tool limit, never as an agent limit', async () => {
  const result = await lint('fixtures/skills/report-builder', {
    for: 'claude-code',
    from: 'claude-code',
    limits: { maxFiles: 1 },
  });

  const finding = result.findings.find((item) => item.ruleId === 'SP023');
  assert.ok(finding, 'SP023 must fire when the tool stops reading');
  assert.equal(finding.detail.scope, 'tool');
  assert.match(finding.message, /stopped after 1 files|not read/);
});

test('the skill itself is never reported as its own duplicate', async () => {
  const result = await lint(`${LINT_ROOT}/ignored-fields`, { for: 'deepseek-harness', from: 'claude-code' });
  assert.equal(has(result, 'SP021'), false);
});

// ---------------------------------------------------------------------------
// Rule catalogue integrity.
// ---------------------------------------------------------------------------

test('the rule catalogue is well formed', () => {
  const ids = LINT_RULES.map((rule) => rule.id);
  assert.deepEqual(new Set(ids).size, ids.length, 'rule ids must be unique');
  assert.deepEqual(ids, [...ids].sort(), 'rule ids must be in order');

  for (const rule of LINT_RULES) {
    assert.match(rule.id, /^SP\d{3}$/);
    assert.match(rule.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(rule.fix.length > 10, `${rule.id} needs an actionable fix`);
    assert.ok(rule.description.length > 20, `${rule.id} needs a description`);
    assert.ok(['profile', 'tool'].includes(rule.derivation));
  }
});

test('docs/lint-rules.md matches the catalogue', async () => {
  const output = await new Promise((settle) => {
    execFile(process.execPath, [join(ROOT, 'scripts', 'generate-rule-catalog.mjs'), '--check'], (error, stdout, stderr) => {
      settle({ code: error === null ? 0 : 1, stdout, stderr });
    });
  });
  assert.equal(output.code, 0, output.stderr || output.stdout);
});
