// skillhawk factory: repeated requests become workflows; drafts must pass the checks; the billing guard holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { workflows, draft, promote, billingGuard } from '../src/factory.js';

const ask = (text, session, i) => ({ text, session, time: new Date(Date.parse('2026-10-01') + i * 3600e3).toISOString() });

test('workflows: 3+ similar requests in 3+ sessions; corrections made along the way are counted; one-offs ignored', () => {
  const asks = [
    ask('release a new version and update the changelog', 's1', 1), ask('cut a release, bump version, update changelog', 's2', 2),
    ask('please release new version with changelog entry', 's3', 3), ask('fix the flaky login test', 's1', 4), ask('rename the invoice module', 's2', 5),
  ];
  const corrections = [{ said: 'no, tag the release before publishing', asked: 'release a new version and update the changelog' }];
  const wf = workflows(asks, corrections, []);
  assert.equal(wf.length, 1);
  assert.equal(wf[0].count, 3); assert.equal(wf[0].sessions, 3); assert.equal(wf[0].corrections, 1);
  assert.match(wf[0].name, /release|version|changelog/);
  assert.equal(wf[0].covered, null);
  const covered = workflows(asks, corrections, [{ name: 'release-notes', description: 'Release a new version: bump the version, update the changelog, tag the release.', triggers: [] }]);
  assert.equal(covered[0].covered, 'release-notes');
});

test('billing guard: drafting refuses to bill an API key unless allowed', () => {
  assert.throws(() => billingGuard({ ANTHROPIC_API_KEY: 'x' }), /bill that key per token/);
  assert.deepEqual(billingGuard({ ANTHROPIC_API_KEY: 'x' }, true), ['ANTHROPIC_API_KEY']);
  assert.deepEqual(billingGuard({}), []);
});

test('draft -> checked skill in .skillhawk/factory; promote installs it for Claude Code only when it passes', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-factory-'));
  const w = { id: 'abc123', name: 'release-version-changelog', examples: ['release a new version and update the changelog', 'cut a release, bump version, update changelog', 'please release new version with changelog entry'], correctionsSaid: ['no, tag the release before publishing'] };
  const fake = async () => ({ name: 'release-version', job: 'Cut a release of this package: bump the version, update CHANGELOG.md, tag it and publish.', steps: ['Run the tests with npm test and stop if they fail.', 'Bump the version with npm version patch (or minor when new features landed).', 'Add the changes since the last tag to CHANGELOG.md under the new version.', 'Create the git tag before publishing.', 'Publish with npm publish and push the tag.'], rules: ['Tag the release before publishing.', 'Never publish with failing tests.'], output: 'The new version number, the changelog entry and the tag name.', example_request: 'release a new version and update the changelog', must_include: ['version number', 'changelog entry'] });
  const r = await draft(w, { repo, ask: fake });
  assert.equal(r.name, 'release-version');
  assert.ok(fs.existsSync(path.join(repo, '.skillhawk', 'factory', 'release-version', 'SKILL.md')));
  assert.ok(r.check.ok, r.lines.join('; '));
  const dest = promote('release-version', { repo });
  assert.match(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), /Tag the release before publishing/);
  await assert.rejects(draft(w, { repo, ask: async () => ({}) }), /usable steps/);
});
