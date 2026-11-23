// skillhawk health: deterministic checks on a deliberately bad sample project, and a clean one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { health, render } from '../src/health.js';

function project(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-health-'));
  for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); }
  return d;
}
const SAM = `AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Resources:
  Fn:
    Type: AWS::Serverless::Function
    Properties:
      Runtime: nodejs22.x
      MemorySize: 2048
  Nat:
    Type: AWS::EC2::NatGateway
  Box:
    Type: AWS::EC2::Instance
    Properties:
      InstanceType: t3.large
  Disk:
    Type: AWS::EC2::Volume
    Properties:
      VolumeType: gp2
  Db:
    Type: AWS::RDS::DBInstance
    Properties:
      DBInstanceClass: db.t3.medium
      MultiAZ: true
`;

test('health: a bad project gets high findings in every section, with evidence and fixes', () => {
  const longFn = `export function handle(req) {\n${Array.from({ length: 95 }, (_, i) => `  const v${i} = req.body.x${i};`).join('\n')}\n}\n`;
  const d = project({
    'package.json': JSON.stringify({ name: 'shop', dependencies: { express: '4', stripe: '14', pg: '8', '@anthropic-ai/sdk': '1' }, scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    '.env': 'STRIPE_KEY=sk_live_x\n',
    'src/server.js': `import express from 'express';\nimport { handle } from './a.js';\nconst app = express();\napp.post('/stripe', (req, res) => res.send('ok'));\nconst api = 'https://api.partner.com/v1';\nconst b = 'https://billing.partner.io/x';\nconst c = 'https://hooks.partner.net/y';\n`,
    'src/a.js': `import { b } from './b.js';\n${longFn}`,
    'src/b.js': `import { handle } from './a.js';\nexport const b = 1;\n`,
    'src/ai.js': `import Anthropic from '@anthropic-ai/sdk';\nexport const ask = (c, p) => c.messages.create({ model: 'm', messages: [p] });\n`,
    'infra/template.yaml': SAM,
  });
  const r = health(d);
  const by = (s) => r.findings.filter((x) => x.section === s).map((x) => x.title);
  assert.ok(by('structure').includes('Environment file committed'));
  assert.ok(by('structure').includes('No lockfile'));
  assert.ok(by('structure').includes('Import cycle'));
  assert.ok(by('tests').includes('No tests'));
  assert.ok(by('clean-code').includes('Long function'));
  for (const t of ['No health-check endpoint', 'No rate limiting', 'Database without migrations', 'Payment webhooks without signature checks', 'LLM calls without limits', 'Service URLs hard-coded in source']) assert.ok(by('design').includes(t), t);
  for (const t of ['Lambda on x86', 'Large Lambda memory', '1 NAT gateway(s)', 'EC2 t3.large', 'gp2 storage', 'RDS db.t3.medium', 'Multi-AZ database', 'Logs kept forever']) assert.ok(by('cloud-cost').includes(t), t);
  assert.equal(r.cloud.knownFixedMonthlyUsd, Math.round(32.9 + 60.7 + 49.6));
  assert.ok(r.findings.every((x) => x.evidence && x.fix));
  assert.ok(['D', 'F'].includes(r.grade), r.grade);
  const text = render(r);
  assert.match(text, /^skillhawk health: [DF] /);
  assert.match(text, /about \$143\/month in always-on resources/);
  assert.doesNotMatch(text, /sk_live_x/, 'never prints secret values');
});

test('health: a small tidy project with tests and CI scores A', () => {
  const d = project({
    'README.md': '# tidy\n', '.gitignore': 'node_modules\n',
    'package.json': JSON.stringify({ name: 'tidy', scripts: { test: 'node --test' } }),
    'src/sum.js': 'export const sum = (a, b) => a + b;\n',
    'test/sum.test.js': "import { sum } from '../src/sum.js';\n",
    '.github/workflows/ci.yml': 'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n',
  });
  const r = health(d);
  assert.equal(r.grade, 'A', JSON.stringify(r.findings));
  assert.equal(r.tests.ci, true);
});
