#!/usr/bin/env node
/**
 * Validate every capability profile in `agents/` against the JSON Schema, then
 * run the semantic checks a schema cannot express.
 *
 * Exit code 0 = all profiles valid, 1 = at least one problem.
 */
import { readFile, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse as parseYaml } from 'yaml';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const AGENTS_DIR = join(ROOT, 'agents');
const SCHEMA_PATH = join(ROOT, 'schema', 'agent-profile.schema.json');

/** Fields the converter relies on being described by every profile. */
const REQUIRED_FIELD_KEYS = ['name', 'description'];

async function main() {
  const schema = JSON.parse(await readFile(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);

  const files = (await readdir(AGENTS_DIR)).filter((f) => f.endsWith('.yaml')).sort();
  if (files.length === 0) {
    console.error('No profiles found in agents/.');
    process.exit(1);
  }

  const problems = [];
  const seenIds = new Map();

  for (const file of files) {
    const path = join(AGENTS_DIR, file);
    const stem = basename(file, '.yaml');
    const label = `agents/${file}`;

    let profile;
    try {
      profile = parseYaml(await readFile(path, 'utf8'));
    } catch (error) {
      problems.push(`${label}: YAML parse error: ${error.message}`);
      continue;
    }

    if (!validate(profile)) {
      for (const err of validate.errors ?? []) {
        const at = err.instancePath || '(root)';
        problems.push(`${label}: schema ${at} ${err.message}`);
      }
      continue;
    }

    if (profile.id !== stem) {
      problems.push(`${label}: id "${profile.id}" must equal the filename stem "${stem}"`);
    }
    if (seenIds.has(profile.id)) {
      problems.push(`${label}: duplicate id "${profile.id}" (also in ${seenIds.get(profile.id)})`);
    }
    seenIds.set(profile.id, label);

    for (const key of REQUIRED_FIELD_KEYS) {
      if (!(key in profile.fields)) {
        problems.push(`${label}: fields.${key} is missing; every profile must describe it`);
      }
    }

    for (const [alias, target] of Object.entries(profile.fieldAliases ?? {})) {
      if (!(target in profile.fields)) {
        problems.push(`${label}: fieldAliases.${alias} points at "${target}", which is not in fields`);
      }
      if (alias in profile.fields) {
        problems.push(`${label}: fieldAliases.${alias} shadows an existing field of the same name`);
      }
    }

    // Honesty checks: anything the tool would have to guess must be labelled.
    for (const [name, field] of Object.entries(profile.fields)) {
      if (field.status === 'unknown' && !field.note) {
        problems.push(`${label}: fields.${name} is "unknown" but has no note explaining the gap`);
      }
      if (field.mapsTo === name) {
        problems.push(`${label}: fields.${name} mapsTo itself; drop mapsTo`);
      }
      if (field.mapsTo && !(field.mapsTo in profile.fields)) {
        problems.push(`${label}: fields.${name} mapsTo "${field.mapsTo}", which is not in fields`);
      }
    }

    if (profile.verification !== 'verified' && !profile.notes) {
      problems.push(`${label}: verification is "${profile.verification}" so notes must explain what is unverified`);
    }

    const today = new Date().toISOString().slice(0, 10);
    for (const source of profile.sources) {
      if (source.retrieved > today) {
        problems.push(`${label}: source ${source.url} has a future retrieval date ${source.retrieved}`);
      }
    }

    // Every path must be absolute-ish (~ or / or <placeholder>) or clearly repo-relative.
    for (const [scope, entries] of Object.entries(profile.paths)) {
      for (const entry of entries) {
        if (/\.\./.test(entry.path)) {
          problems.push(`${label}: paths.${scope} entry "${entry.path}" contains ".." which is ambiguous`);
        }
      }
    }

    const supported = Object.values(profile.fields).filter((f) => f.status === 'supported').length;
    const unknown = Object.values(profile.fields).filter((f) => f.status === 'unknown').length;
    console.log(
      `ok  ${profile.id.padEnd(20)} ${String(supported).padStart(2)} supported, ` +
        `${String(unknown).padStart(2)} unknown, ${profile.sources.length} sources [${profile.verification}]`,
    );
  }

  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  console.log(`\n${files.length} profile(s) valid.`);
}

await main();
