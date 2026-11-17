import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse as parseYaml } from 'yaml';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const AGENTS_DIR = join(ROOT, 'agents');

async function loadProfiles() {
  const files = (await readdir(AGENTS_DIR)).filter((f) => f.endsWith('.yaml')).sort();
  return Promise.all(
    files.map(async (file) => ({
      file,
      profile: parseYaml(await readFile(join(AGENTS_DIR, file), 'utf8')),
    })),
  );
}

test('the profile schema is a valid JSON Schema', async () => {
  const schema = JSON.parse(await readFile(join(ROOT, 'schema', 'agent-profile.schema.json'), 'utf8'));
  assert.doesNotThrow(() => new Ajv2020({ strict: false }).compile(schema));
});

test('every profile validates against the schema', async () => {
  const schema = JSON.parse(await readFile(join(ROOT, 'schema', 'agent-profile.schema.json'), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

  for (const { file, profile } of await loadProfiles()) {
    const valid = validate(profile);
    assert.ok(valid, `${file}: ${JSON.stringify(validate.errors, null, 2)}`);
  }
});

test('every MVP agent has a profile', async () => {
  const profiles = await loadProfiles();
  const ids = profiles.map(({ profile }) => profile.id);
  const required = ['claude-code', 'deepseek-harness', 'codex-cli', 'opencode', 'kimi-code'];
  for (const id of required) {
    assert.ok(ids.includes(id), `missing profile for ${id}`);
  }
  assert.equal(new Set(ids).size, ids.length, 'duplicate profile ids');
});

test('every fieldAlias resolves to a field that exists', async () => {
  for (const { file, profile } of await loadProfiles()) {
    for (const [alias, target] of Object.entries(profile.fieldAliases ?? {})) {
      assert.ok(target in profile.fields, `${file}: alias ${alias} -> ${target} has no such field`);
      assert.ok(!(alias in profile.fields), `${file}: alias ${alias} collides with a field of the same name`);
    }
  }
});

test('every unknown capability carries a note so the tool can explain itself', async () => {
  for (const { file, profile } of await loadProfiles()) {
    for (const [name, field] of Object.entries(profile.fields)) {
      if (field.status === 'unknown') {
        assert.ok(field.note && field.note.length > 10, `${file}: fields.${name} is unknown without a note`);
      }
    }
  }
});

test('every profile id matches its filename', async () => {
  for (const { file, profile } of await loadProfiles()) {
    assert.equal(profile.id, file.replace(/\.yaml$/, ''), `${file} id mismatch`);
  }
});

test('every profile cites at least one primary source with a retrieval date', async () => {
  for (const { file, profile } of await loadProfiles()) {
    assert.ok(profile.sources.length > 0, `${file} has no sources`);
    for (const source of profile.sources) {
      assert.match(source.url, /^https?:\/\//, `${file}: bad url ${source.url}`);
      assert.match(source.retrieved, /^\d{4}-\d{2}-\d{2}$/, `${file}: bad retrieval date`);
    }
  }
});

test('no profile claims a hard description limit it does not enforce', async () => {
  // A hard limit with truncate enforcement is a contradiction: the agent either
  // rejects or shortens. Keeping these separate is what makes the report honest.
  for (const { file, profile } of await loadProfiles()) {
    const { maxLength, enforcement } = profile.description;
    if (maxLength !== null) {
      assert.notEqual(enforcement, 'truncate', `${file}: description has a hard limit and truncation`);
    }
  }
});

test('aliases are unique and never shadow another profile id', async () => {
  // An alias that collides with an id would make the result depend on file
  // order, which is exactly the kind of silent ambiguity this project refuses.
  const profiles = (await loadProfiles()).map(({ profile }) => profile);
  const ids = new Set(profiles.map((profile) => profile.id));
  const seen = new Map();

  for (const profile of profiles) {
    for (const alias of profile.aliases ?? []) {
      assert.ok(!ids.has(alias) || alias === profile.id, `${profile.id}: alias "${alias}" is another profile's id`);
      assert.ok(!seen.has(alias), `${profile.id}: alias "${alias}" is also claimed by ${seen.get(alias)}`);
      seen.set(alias, profile.id);
    }
  }
});

test('findProfile resolves an alias and prefers the id', async () => {
  const { findProfile, loadProfiles } = await import('../packages/core/dist/index.js');
  const profiles = await loadProfiles();

  assert.equal(findProfile(profiles, 'codex')?.id, 'codex-cli');
  assert.equal(findProfile(profiles, 'dsh')?.id, 'deepseek-harness');
  // The full id still wins, and is never re-routed through an alias.
  assert.equal(findProfile(profiles, 'codex-cli')?.id, 'codex-cli');
  assert.equal(findProfile(profiles, 'codex ').id, 'codex-cli', 'surrounding space is trimmed');
  assert.equal(findProfile(profiles, 'not-an-agent'), undefined);
  assert.equal(findProfile(profiles, ''), undefined);
});

test('a duplicate alias is a load error, not last-one-wins', async () => {
  const { assertUniqueAliases } = await import('../packages/core/dist/index.js');
  const profiles = (await loadProfiles()).map(({ profile }) => profile);

  assert.doesNotThrow(() => assertUniqueAliases(profiles));

  const broken = [
    { id: 'one', aliases: ['shared'] },
    { id: 'two', aliases: ['shared'] },
  ];
  assert.throws(() => assertUniqueAliases(broken), /already the id or alias/);

  const shadowsId = [{ id: 'one' }, { id: 'two', aliases: ['one'] }];
  assert.throws(() => assertUniqueAliases(shadowsId), /already the id or alias/);
});

// ---------------------------------------------------------------------------
// invocation: how a user invokes a skill, which SP026 reads.
//
// The field is optional in the schema so a third-party profile still loads, but
// every profile in this repository has to answer it. "unknown" is an answer;
// silence is not.
// ---------------------------------------------------------------------------

test('every profile states how a skill is invoked, and backs it up', async () => {
  const profiles = await loadProfiles();
  assert.ok(profiles.length > 0);

  for (const { file, profile } of profiles) {
    const invocation = profile.invocation;
    assert.ok(invocation, `${file} has no invocation block`);
    assert.equal(typeof invocation.syntax, 'string', `${file} has no invocation.syntax`);

    if (invocation.syntax === 'unknown') {
      // An unknown has to say what was checked, or the next reader cannot tell
      // "not documented" from "nobody looked".
      assert.ok(invocation.note, `${file} says unknown without a note saying why`);
      assert.equal(invocation.source, undefined, `${file} says unknown but cites a source`);
    } else {
      assert.match(invocation.syntax, /\{name\}/, `${file} syntax has no {name} placeholder`);
      assert.match(String(invocation.source), /^https?:\/\//, `${file} cites no official source`);
    }
  }
});

test('the invocation syntax pattern accepts the documented forms and rejects guesses', async () => {
  const schema = JSON.parse(await readFile(join(ROOT, 'schema', 'agent-profile.schema.json'), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

  const base = (await loadProfiles())[0].profile;
  const withInvocation = (invocation) => ({ ...base, invocation });

  for (const syntax of ['/{name}', '${name}', '@{name}', '/skill:{name}']) {
    assert.ok(
      validate(withInvocation({ syntax, source: 'https://example.com/docs' })),
      `${syntax} should be accepted`,
    );
  }

  // No placeholder: a syntax nobody could render back to a real command.
  assert.equal(validate(withInvocation({ syntax: '/caveman', source: 'https://example.com' })), false);
  // A known syntax with no source: unverifiable by construction.
  assert.equal(validate(withInvocation({ syntax: '/{name}' })), false);
  // Unknown with no note: says nothing about what was checked.
  assert.equal(validate(withInvocation({ syntax: 'unknown' })), false);
  assert.ok(validate(withInvocation({ syntax: 'unknown', note: 'the docs describe no command' })));
});
