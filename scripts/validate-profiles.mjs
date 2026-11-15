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

/**
 * Areas of the profile that lint must be able to cite a source for. Without
 * these a finding could be reported with no URL behind it, which the project
 * treats as guessing.
 */
const REQUIRED_COVERED_AREAS = ['paths', 'discovery', 'identity', 'name', 'description', 'fields'];

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
      if (field.dropReason !== undefined && field.status !== 'unknown') {
        problems.push(
          `${label}: fields.${name} has a dropReason but status is "${field.status}"; ` +
            'a dropReason exists to explain dropping a field whose acceptance is unknown',
        );
      }
      if (field.status === 'unknown' && field.dropReason !== undefined && field.dropReason.length < 40) {
        problems.push(`${label}: fields.${name}.dropReason is too short to explain anything`);
      }
    }

    if (profile.verification !== 'verified' && !profile.notes) {
      problems.push(`${label}: verification is "${profile.verification}" so notes must explain what is unverified`);
    }

    // A pattern that does not compile would make the name rule silently useless.
    if (profile.name.pattern !== null) {
      try {
        new RegExp(profile.name.pattern);
      } catch (error) {
        problems.push(`${label}: name.pattern is not a valid regular expression: ${error.message}`);
      }
    }

    // Extension triggers are the only executable part of the profile. They must
    // name a field the profile actually documents, and compare against a scalar.
    for (const extension of profile.extensions ?? []) {
      const trigger = extension.trigger;
      if (trigger === undefined) continue;
      if (!(trigger.field in profile.fields)) {
        problems.push(
          `${label}: extensions.${extension.id}.trigger.field "${trigger.field}" is not in fields, so the rule could never match`,
        );
      }
      if (trigger.equals !== undefined) {
        const kind = typeof trigger.equals;
        if (kind !== 'string' && kind !== 'number' && kind !== 'boolean') {
          problems.push(`${label}: extensions.${extension.id}.trigger.equals must be a scalar, got ${kind}`);
        }
      }
    }

    const covered = new Set(profile.sources.flatMap((source) => source.covers ?? []));
    for (const area of REQUIRED_COVERED_AREAS) {
      if (!covered.has(area)) {
        problems.push(`${label}: no source declares covers: [${area}], so a lint finding for that area would cite nothing`);
      }
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

    // A delivery mode and a set of discovery roots have to agree. An archive
    // target has nowhere to install to; a directory target must say where it
    // looks, or the converter would have to invent a location.
    const delivery = profile.delivery ?? 'directory';
    const hasProject = profile.paths.project.length > 0;
    const hasGlobal = profile.paths.global.length > 0;
    if (delivery === 'archive') {
      if (hasProject || hasGlobal) {
        problems.push(`${label}: delivery is "archive", so it has no discovery root, but paths is not empty`);
      }
    } else {
      if (!hasProject) problems.push(`${label}: delivery is "directory", so paths.project must name at least one root`);
      if (!hasGlobal) problems.push(`${label}: delivery is "directory", so paths.global must name at least one root`);
    }

    // A reserved word is only useful if it can be checked, and an empty one
    // would match every name.
    for (const word of profile.name.reserved ?? []) {
      if (word.trim() === '') problems.push(`${label}: name.reserved contains an empty string`);
      if (word !== word.toLowerCase()) problems.push(`${label}: name.reserved "${word}" should be lowercase to match`);
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
