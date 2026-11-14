/**
 * Property tests.
 *
 * These do not check one input against one expected output. They check that a
 * stated invariant holds for a few hundred generated inputs, which is the only
 * practical way to be confident about string rewriting: the interesting cases
 * are the ones nobody thought to write a fixture for.
 *
 * The generator is seeded, so a failure is reproducible and a green run means
 * the same thing on every machine.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyShellPolicy, loadProfiles, planIdentity } from '../packages/core/dist/index.js';

/** mulberry32: small, fast, and stable across Node versions. */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(random, items) {
  return items[Math.floor(random() * items.length)];
}

/** Identities a real skill might carry, plus the awkward ones. */
function identity(random) {
  const pieces = [
    'changelog',
    'writer',
    'Report',
    'Builder',
    'pdf',
    'v2',
    'ünïcode',
    'a',
    'x'.repeat(30),
    '日本語',
    'has space',
    'has_underscore',
    'has.dot',
    'UPPER',
    '--dashes--',
    'emoji🙂',
    '<tag>',
    'Mixed CASE 42',
    '',
    '.hidden',
    'trailing ',
  ];
  const count = 1 + Math.floor(random() * 3);
  const separator = pick(random, ['-', ' ', '_', '.', '', '/', '\\', '  ']);
  let out = '';
  for (let index = 0; index < count; index += 1) {
    if (index > 0) out += separator;
    out += pick(random, pieces);
  }
  return out;
}

test('property: a normalised name always satisfies the rule that normalised it', async () => {
  const profiles = await loadProfiles();
  const targets = profiles.filter((profile) => profile.name.pattern !== null || profile.name.maxLength !== null);
  assert.ok(targets.length > 0, 'at least one profile must document a name rule for this test to mean anything');

  const random = seeded(20261114);
  for (let round = 0; round < 400; round += 1) {
    const source = identity(random);
    for (const profile of targets) {
      const plan = planIdentity(source, [profile]);
      const label = `${JSON.stringify(source)} -> ${profile.id} gave ${JSON.stringify(plan.name)}`;

      assert.ok(plan.name.length > 0, `a name may never be empty: ${label}`);
      if (profile.name.pattern !== null) {
        assert.match(plan.name, new RegExp(profile.name.pattern), `pattern not satisfied: ${label}`);
      }
      if (profile.name.maxLength !== null) {
        assert.ok(plan.name.length <= profile.name.maxLength, `length not satisfied: ${label}`);
      }

      // A name is used as a directory name, so it must survive that too.
      assert.ok(!plan.name.includes('/'), `a name may not contain a slash: ${label}`);
      assert.ok(!plan.name.includes('\\'), `a name may not contain a backslash: ${label}`);
      assert.ok(!/[\u0000-\u001f\u007f]/.test(plan.name), `a name may not contain control characters: ${label}`);
      assert.ok(!plan.name.startsWith('.'), `a name may not start with a dot: ${label}`);
      assert.ok(plan.name.trim() === plan.name, `a name may not have surrounding spaces: ${label}`);
    }
  }
});

test('property: normalisation is idempotent and deterministic', async () => {
  const profiles = await loadProfiles();
  const targets = profiles.filter((profile) => profile.name.pattern !== null || profile.name.maxLength !== null);

  const random = seeded(7);
  for (let round = 0; round < 300; round += 1) {
    const source = identity(random);
    for (const profile of targets) {
      const once = planIdentity(source, [profile]).name;
      const twice = planIdentity(once, [profile]).name;
      const again = planIdentity(source, [profile]).name;

      assert.equal(twice, once, `normalising twice must not change the answer: ${JSON.stringify(source)} for ${profile.id}`);
      assert.equal(again, once, `normalisation must be deterministic: ${JSON.stringify(source)} for ${profile.id}`);
    }
  }
});

test('property: a name that already satisfies the rule is never rewritten', async () => {
  const profiles = await loadProfiles();
  const target = profiles.find((profile) => profile.id === 'deepseek-harness');
  assert.ok(target);

  const random = seeded(99);
  for (let round = 0; round < 200; round += 1) {
    // Build a name that is already valid, then confirm it survives untouched.
    const words = 1 + Math.floor(random() * 3);
    const parts = [];
    for (let index = 0; index < words; index += 1) {
      parts.push(pick(random, ['alpha', 'beta', 'gamma', 'x', 'v2', 'release', 'notes']));
    }
    const valid = parts.join('-');

    const plan = planIdentity(valid, [target]);
    assert.equal(plan.name, valid);
    assert.equal(plan.ruleChanged, false, `an already-valid name must not be reported as changed: ${valid}`);
  }
});

test('property: a shared group satisfies every member, not just the first', async () => {
  const profiles = await loadProfiles();
  const group = profiles.filter((profile) => profile.name.pattern !== null);
  assert.ok(group.length > 0);

  const random = seeded(1234);
  for (let round = 0; round < 200; round += 1) {
    const source = identity(random);
    const plan = planIdentity(source, group);
    for (const profile of group) {
      assert.match(plan.name, new RegExp(profile.name.pattern), `${profile.id} rejects the shared name ${plan.name}`);
    }
  }
});

test('property: shell rewriting never changes a line ending', () => {
  const random = seeded(4242);
  const bodies = ['!`date`', '```!\nls\n```', 'plain line', '  !`pwd`  ', '```js\ncode\n```', ''];
  const policies = ['neutralize', 'keep', 'strip'];

  for (let round = 0; round < 300; round += 1) {
    const lineCount = 1 + Math.floor(random() * 8);
    const lines = [];
    for (let index = 0; index < lineCount; index += 1) {
      const eol = random() < 0.5 ? '\r\n' : '\n';
      lines.push(pick(random, bodies) + eol);
    }
    const body = lines.join('');
    const inputLines = body.split('\n');

    for (const policy of policies) {
      const result = applyShellPolicy(body, policy);
      const outputLines = result.body.split('\n');

      // The number of carriage returns may only fall when whole lines are
      // removed, never because a `\r\n` was rewritten into a bare `\n`.
      const inputCr = (body.match(/\r/g) ?? []).length;
      const outputCr = (result.body.match(/\r/g) ?? []).length;
      assert.ok(
        outputCr <= inputCr,
        `policy ${policy} invented a carriage return: ${JSON.stringify(body)}`,
      );

      // Every carriage return in the output must still be followed by a newline.
      assert.ok(
        !/\r(?!\n)/.test(result.body),
        `policy ${policy} left a bare carriage return: ${JSON.stringify(result.body)}`,
      );

      if (policy !== 'strip') {
        assert.equal(outputLines.length, inputLines.length, `policy ${policy} changed the line count`);
        for (let index = 0; index < inputLines.length; index += 1) {
          const wanted = inputLines[index].endsWith('\r');
          const got = (outputLines[index] ?? '').endsWith('\r');
          assert.equal(
            got,
            wanted,
            `policy ${policy} changed the ending of line ${index + 1}: ${JSON.stringify(body)}`,
          );
        }
      }
    }
  }
});

test('property: neutralizing removes every executable placeholder and nothing else', () => {
  const random = seeded(31337);
  const commands = ['date', 'ls -la', 'git status --short', 'echo "hi"'];

  for (let round = 0; round < 200; round += 1) {
    const count = 1 + Math.floor(random() * 3);
    const parts = [];
    for (let index = 0; index < count; index += 1) {
      parts.push(`value ${index}: !\`${pick(random, commands)}\``);
    }
    const body = `${parts.join('\n')}\n`;
    const result = applyShellPolicy(body, 'neutralize');

    assert.ok(!result.body.includes('!`'), 'no executable placeholder may survive neutralisation');
    assert.equal(result.occurrences.length, count, 'every placeholder must be reported');
    // The command text is kept as readable prose, which is the point of
    // neutralising rather than stripping.
    for (const command of commands) {
      if (body.includes(command)) assert.ok(result.body.includes(command), 'the command text must survive');
    }
  }
});

test('property: strip never leaves a double space or a trailing space behind', () => {
  const random = seeded(5150);
  const commands = ['date', 'pwd', 'ls'];

  for (let round = 0; round < 200; round += 1) {
    const command = pick(random, commands);
    const shape = Math.floor(random() * 4);
    const body =
      shape === 0
        ? `run !\`${command}\` now\n`
        : shape === 1
          ? `start !\`${command}\`\n`
          : shape === 2
            ? `!\`${command}\` end\n`
            : `only !\`${command}\`\n`;

    const result = applyShellPolicy(body, 'strip');
    for (const line of result.body.split('\n')) {
      assert.ok(!line.includes('  '), `double space left in ${JSON.stringify(line)} from ${JSON.stringify(body)}`);
      assert.ok(line === line.trimEnd(), `trailing space left in ${JSON.stringify(line)} from ${JSON.stringify(body)}`);
      assert.ok(!line.includes('!`'), 'the placeholder must be gone');
    }
  }
});

