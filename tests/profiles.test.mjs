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

test('phase 0 agents are present and verified', async () => {
  const profiles = await loadProfiles();
  const ids = profiles.map(({ profile }) => profile.id);
  for (const required of ['claude-code', 'deepseek-harness', 'codex-cli']) {
    assert.ok(ids.includes(required), `missing profile for ${required}`);
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
